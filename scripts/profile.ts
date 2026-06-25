#!/usr/bin/env bun
// Performance profiler for Logsy's hot path — the pure log-processing pipeline
// in src/logic.ts. The UI stays responsive only if these functions can chew
// through a large firmware log across many filters in well under a frame, so
// this script benchmarks them in isolation (no React, no Tauri) and reports
// timings + throughput.
//
//   bun run scripts/profile.ts                       # defaults
//   bun run scripts/profile.ts --lines=500000        # bigger log
//   bun run scripts/profile.ts --filters=40 --runs=9 # more filters / samples
//   bun run scripts/profile.ts --json                # machine-readable output
//
// Flags:
//   --lines=N     synthetic log lines to generate      (default 200000)
//   --filters=N   filters in the working set           (default 20)
//   --runs=N      timed runs per benchmark (odd → median) (default 7)
//   --warmup=N    untimed JIT-warming runs             (default 2)
//   --seed=N      PRNG seed for reproducible logs       (default 1)
//   --json        print results as JSON, nothing else

import {
  compileAll,
  computeView,
  segments,
  scanMatches,
  deriveFields,
} from "../src/lib/engine.ts";
import { makeFilter } from "../src/lib/defaults.ts";
import type { Filter } from "../src/types.ts";

// --- args -------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string, def: number): number => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return def;
  const v = Number(hit.split("=")[1]);
  return Number.isFinite(v) ? v : def;
};
const LINES = flag("lines", 200_000);
const FILTERS = flag("filters", 20);
const RUNS = flag("runs", 7);
const WARMUP = flag("warmup", 2);
const SEED = flag("seed", 1);
const JSON_OUT = args.includes("--json");

// --- deterministic PRNG (mulberry32) so runs are comparable -----------------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- synthetic firmware log -------------------------------------------------

const LEVELS = ["ERROR", "WARN ", "INFO ", "DEBUG", "TRACE"];
const TAGS = [
  "wifi",
  "ble",
  "pmu",
  "sensor",
  "ota",
  "fs",
  "rtc",
  "uart",
  "i2c",
  "cpu",
];
const MSGS = [
  "connected to AP rssi=-{n} ch={c}",
  "heap free {n} bytes, largest block {c}",
  "task watchdog reset core {c}",
  "battery {n}% temp {c}C",
  "packet dropped seq={n} retries={c}",
  "calibration done offset={n}",
  "flash write addr=0x{h} len={n}",
  "irq latency {n}us handler={tag}",
  "state -> {tag} after {n}ms",
  "checksum mismatch want=0x{h} got=0x{h}",
];

function genLog(n: number, seed: number): string[] {
  const r = rng(seed);
  const pick = <T>(a: T[]): T => a[(r() * a.length) | 0];
  const num = (max: number) => ((r() * max) | 0).toString();
  const hex = () => ((r() * 0xffffff) | 0).toString(16).padStart(6, "0");
  const lines = new Array<string>(n);
  let ms = 0;
  for (let i = 0; i < n; i++) {
    ms += (r() * 50) | 0;
    const t = ms / 1000;
    const hh = ((t / 3600) | 0).toString().padStart(2, "0");
    const mm = (((t / 60) | 0) % 60).toString().padStart(2, "0");
    const ss = ((t | 0) % 60).toString().padStart(2, "0");
    const mmm = (ms % 1000).toString().padStart(3, "0");
    const body = pick(MSGS)
      .replace(/\{n\}/g, () => num(9999))
      .replace(/\{c\}/g, () => num(64))
      .replace(/\{h\}/g, hex)
      .replace(/\{tag\}/g, () => pick(TAGS));
    lines[i] =
      `${hh}:${mm}:${ss}.${mmm} [${pick(LEVELS)}] ${pick(TAGS)}: ${body}`;
  }
  return lines;
}

// --- a representative working set of filters --------------------------------

function genFilters(n: number): Filter[] {
  const base: Filter[] = [
    makeFilter("ERROR", { bgColor: "#fce4e4", textColor: "#b42318" }),
    makeFilter("WARN", { bgColor: "#fef7c3" }),
    makeFilter("wifi", { bgColor: "#dbeafe" }),
    makeFilter("TRACE", { exclude: true }), // an exclude
    makeFilter("rssi=-\\d+", { regex: true }), // simple regex
    makeFilter("0x[0-9a-f]+", { regex: true, caseSensitive: false }),
  ];
  // One structural filter with named groups → exercises field extraction.
  const structural = makeFilter(
    "^(?<ts>\\d+:\\d{2}:\\d{2}\\.\\d{3}) \\[(?<level>\\w+)\\s*\\] (?<tag>\\w+):",
    { regex: true },
  );
  structural.fields = deriveFields(structural.pattern).map((f) => ({
    ...f,
    type: f.name === "ts" ? "time" : "string",
  }));
  base.push(structural);

  // Pad out to the requested count with cheap literal tag filters so the
  // per-line inner loop has a realistic number of regexes to test.
  const fillers = [
    "ble",
    "pmu",
    "sensor",
    "ota",
    "fs",
    "rtc",
    "uart",
    "i2c",
    "cpu",
    "heap",
    "reset",
    "battery",
    "packet",
    "calibration",
    "flash",
    "irq",
    "state",
    "checksum",
    "watchdog",
    "latency",
  ];
  let i = 0;
  while (base.length < n) base.push(makeFilter(fillers[i++ % fillers.length]));
  return base.slice(0, Math.max(n, base.length));
}

// --- benchmark harness ------------------------------------------------------

interface Stat {
  name: string;
  min: number;
  median: number;
  mean: number;
  ops: number;
}

function bench(
  name: string,
  fn: () => void,
  runs = RUNS,
  warmup = WARMUP,
): Stat {
  for (let i = 0; i < warmup; i++) fn();
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    fn();
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  const sum = t.reduce((a, b) => a + b, 0);
  const median = t[t.length >> 1];
  return { name, min: t[0], median, mean: sum / runs, ops: 1000 / median };
}

const ms = (n: number) => `${n.toFixed(2)} ms`;

// --- run --------------------------------------------------------------------

if (!JSON_OUT) {
  console.log(
    `Logsy profiler — ${LINES.toLocaleString()} lines, ${FILTERS} filters, ${RUNS} runs (seed ${SEED})\n`,
  );
  process.stdout.write("generating log… ");
}

const genStart = performance.now();
const lines = genLog(LINES, SEED);
const filters = genFilters(FILTERS);
const bytes = lines.reduce((a, l) => a + l.length, 0);
if (!JSON_OUT)
  console.log(
    `${ms(performance.now() - genStart)}  (${(bytes / 1e6).toFixed(1)} MB)\n`,
  );

// Sample line + filter shape (sanity check the synthetic data is realistic).
if (!JSON_OUT) {
  console.log(`  e.g. ${lines[0]}`);
  console.log(
    `  filters: ${filters.length} (${filters.filter((f) => f.regex).length} regex, ${filters.filter((f) => f.exclude).length} exclude)\n`,
  );
}

// Pre-compile once for the benches that need a compiled set as input.
const compiled = compileAll(filters);
const view = computeView(lines, compiled);

const stats: Stat[] = [];

// 1. compileAll — building RegExp objects for the whole set (cheap, but real).
stats.push(
  bench("compileAll", () => {
    compileAll(filters);
  }),
);

// 2. computeView — THE hot path: every line tested against every usable filter.
stats.push(
  bench("computeView (full file)", () => {
    computeView(lines, compiled);
  }),
);

// 3. fieldsFor — lazy field extraction; cost if every visible row is expanded.
stats.push(
  bench("fieldsFor × all rows", () => {
    for (let n = 1; n <= lines.length; n++) view.fieldsFor(n);
  }),
);

// 4. segments — per-line highlight segmentation for the rendered window
//    (virtualized list shows ~60 rows; we time a generous 1000-row window).
const winRe =
  compiled.find((c) => c.re && c.f.pattern === "wifi")?.re ?? compiled[0].re!;
const window = lines.slice(0, Math.min(1000, lines.length));
stats.push(
  bench("segments × 1000 rows", () => {
    for (const l of window) segments(l, winRe);
  }),
);

// 5. scanMatches — edit-modal live preview: one pass, count + first 200 hits.
const previewRe = /rssi=-\d+/g;
stats.push(
  bench("scanMatches (preview)", () => {
    scanMatches(lines, previewRe);
  }),
);

// --- report -----------------------------------------------------------------

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        config: {
          lines: LINES,
          filters: FILTERS,
          runs: RUNS,
          seed: SEED,
          bytes,
        },
        stats,
      },
      null,
      2,
    ),
  );
} else {
  const pad = (s: string, w: number) => s.padEnd(w);
  const padN = (s: string, w: number) => s.padStart(w);
  console.log(
    pad("benchmark", 26) +
      padN("min", 11) +
      padN("median", 11) +
      padN("mean", 11) +
      padN("ops/s", 9),
  );
  console.log("─".repeat(68));
  for (const s of stats) {
    console.log(
      pad(s.name, 26) +
        padN(ms(s.min), 11) +
        padN(ms(s.median), 11) +
        padN(ms(s.mean), 11) +
        padN(s.ops.toFixed(1), 9),
    );
  }

  // Throughput for the headline number: full-file computeView.
  const cv = stats.find((s) => s.name.startsWith("computeView"))!;
  const linesPerSec = LINES / (cv.median / 1000);
  const mbPerSec = bytes / 1e6 / (cv.median / 1000);
  console.log(
    "\ncomputeView throughput: " +
      `${(linesPerSec / 1e6).toFixed(2)} M lines/s · ${mbPerSec.toFixed(0)} MB/s`,
  );

  const mem = process.memoryUsage?.();
  if (mem) console.log(`peak heap (rss): ${(mem.rss / 1e6).toFixed(0)} MB`);
}
