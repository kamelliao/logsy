#!/usr/bin/env bun
// Performance profiler for Logsy's hot path — the pure log-processing pipeline
// in src/lib/engine.ts. The UI stays responsive only if these functions can chew
// through a large firmware log across many filters in well under a frame, so
// this script benchmarks them in isolation (no React, no Tauri) and reports
// timings + throughput.
//
// The report ends with the question it exists to answer — what opening a file
// costs, stage by stage, with the two paths side by side:
//
//   JS only      splitLines → match scan → compose        (no cache priming)
//   Rust-primed  splitLines → rust split + RegexSet scan
//                           → verify + prime → compose
//
// Only the scan differs; every other stage is the same work in both columns. The
// match scan is measured directly (`scanAll`) rather than derived by subtracting a
// warm `computeView` from a cold one, which buys a cross-check the report prints:
// `scan + compose` and a cold `computeView` are three separately measured numbers
// that have to agree, and a subtraction could never disagree.
//
// The `computeView` split matters because its two costs differ by ~60× and map to
// two different things a user does — the cold path is opening a file or adding a
// filter (O(lines × filters)), the compose path is toggling or recolouring one. The
// cache is keyed by the lines array's *identity*, so every cold benchmark hands its
// run a fresh copy, made outside the timer. Getting that wrong is how an earlier
// version of this script reported 55 ms for work that takes ~1.2 s.
//
// Sections print bottom-up: the terminal is scrolled to the END when a run finishes,
// so the last thing written is the first thing read. The summary therefore goes last,
// under the raw min/median/mean/max samples (stability, not cost) and the engine's
// other hot paths (rendering, field extraction, the edit-modal preview — none of them
// on the open path). Anything qualifying the numbers is printed above the summary so
// the summary stays the final block on screen.
//
// `--no-rust` drops the second column when you are iterating on engine.ts alone.
//
//   bun run scripts/profile.ts                       # defaults
//   bun run scripts/profile.ts --lines=500000        # bigger log
//   bun run scripts/profile.ts --filters=100         # bigger filter set
//   bun run scripts/profile.ts --no-rust             # JS only, no cargo
//   bun run scripts/profile.ts --json                # machine-readable output
//
// `--help` lists every flag; the option table below is the one source for them.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import chalk, { Chalk, chalkStderr } from "chalk";
import { Command, InvalidArgumentError, Option } from "commander";

import {
  compileAll,
  computeView,
  scanAll,
  segments,
  scanMatches,
  deriveFields,
  primeMatchCache,
} from "../src/lib/engine.ts";
import { splitLines } from "../src/lib/lines.ts";
import { scanSpecs, verify } from "../src/lib/scanPrime.ts";
import type { ScanSpec } from "../src/lib/scanPrime.ts";
import { makeFilter } from "../src/lib/defaults.ts";
import type { Filter } from "../src/types.ts";

// --- args -------------------------------------------------------------------

/** A count that must be a positive integer — anything else is a typo, not a default. */
function positiveInt(raw: string): number {
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1)
    throw new InvalidArgumentError("expected a positive integer.");
  return v;
}

const program = new Command()
  .name("profile")
  .description(
    "Benchmark Logsy's log-processing pipeline against a synthetic firmware log.\n" +
      "computeView is reported cold (no cached match bits — opening a file) and warm\n" +
      "(bits cached — toggling a filter); the Rust scanner runs too, so the open-a-file\n" +
      "model reflects what a user actually waits for.",
  )
  .option(
    "--lines <n>",
    "synthetic log lines to generate",
    positiveInt,
    200_000,
  )
  .option("--filters <n>", "filters in the working set", positiveInt, 20)
  .option(
    "--runs <n>",
    "timed runs per benchmark (odd → a real median)",
    positiveInt,
    7,
  )
  .addOption(
    new Option(
      "--cold-runs <n>",
      "timed runs for the cold benchmark, which costs ~30× a warm one",
    )
      .argParser(positiveInt)
      .default(undefined, "min(runs, 3)"),
  )
  .option("--warmup <n>", "untimed JIT-warming runs", positiveInt, 2)
  .option("--seed <n>", "PRNG seed, for a reproducible log", positiveInt, 1)
  .option("--no-rust", "skip the Rust scanner and the open-a-file model")
  .option("-q, --quiet", "no progress line (results are unaffected)")
  .option("--json", "print results as JSON, nothing else")
  .showHelpAfterError()
  .parse();

const opts = program.opts<{
  lines: number;
  filters: number;
  runs: number;
  coldRuns?: number;
  warmup: number;
  seed: number;
  rust: boolean;
  quiet?: boolean;
  json?: boolean;
}>();

const LINES = opts.lines;
const FILTERS = opts.filters;
const RUNS = opts.runs;
const COLD_RUNS = opts.coldRuns ?? Math.min(RUNS, 3);
const WARMUP = opts.warmup;
const SEED = opts.seed;
const JSON_OUT = !!opts.json;
const WITH_RUST = opts.rust;

const notes: string[] = [];
const note = (s: string): void => {
  notes.push(s);
};

// --- colour ------------------------------------------------------------------
// Used for hierarchy, not decoration: bold marks a section, dim retires anything
// that isn't a result (separators, footnotes, sub-millisecond rows), and yellow is
// reserved for the one thing that means "read me" — a failed cross-check or a note
// that qualifies the numbers. Nothing is coloured by whether a number is good or
// bad: a slow cold scan is the finding, not a fault, and red would say otherwise.
//
// chalk decides for itself whether the terminal takes colour (TTY, NO_COLOR, CI) —
// which bun's built-in `util.styleText` does not, it emits escapes even into a pipe.
// `--json` forces plain on top of that, so a coloured byte can never reach a parser.
//
// ONE RULE when using these: pad first, colour second. Padding counts the invisible
// escape bytes, so colouring a cell before aligning it silently wrecks every column.
const c = JSON_OUT ? new Chalk({ level: 0 }) : chalk;

// --- progress ----------------------------------------------------------------
// A default run takes ~21 s at 500k × 100, and 13 s of that is one benchmark whose
// three runs are each 3.3 s of unbroken synchronous work. Without a word on screen
// that reads as a hang.
//
// It is deliberately a plain overwritten line rather than a spinner. Every run holds
// the event loop for its whole duration — a 2 s synchronous loop lets exactly zero
// interval callbacks fire — so an animation would freeze during precisely the wait
// it is meant to cover, which looks *more* hung than silence. What actually answers
// "is this stuck?" is the remaining time, so that is what the line carries: once a
// run has been timed, every later update states the per-run cost and what is left.
//
// Written to stderr, so stdout stays exactly the report (`--json` included, and
// piping is unaffected). Off when stdout isn't a terminal, under --json, or --quiet.

const PROGRESS = !JSON_OUT && !opts.quiet && !!process.stderr.isTTY;
// Benchmark phases: 8 JS ones, plus the Rust scan (one phase, two rows) and the two
// priming benches it feeds. A failed cargo build just stops the count short.
const PHASES = WITH_RUST ? 11 : 8;
let phase = 0;

const cols = (): number => (process.stderr.columns ?? 80) - 1;

function status(line: string): void {
  if (!PROGRESS) return;
  const w = cols();
  // Dim: it is scaffolding that gets erased, not a result. `chalkStderr` because
  // colour support is a property of the stream, and this one is not stdout.
  process.stderr.write("\r" + chalkStderr.dim(line.slice(0, w).padEnd(w)));
}

/** Wipe the line so the report never lands next to a half-erased status. */
function clearStatus(): void {
  if (!PROGRESS) return;
  process.stderr.write("\r" + " ".repeat(cols()) + "\r");
}

/** Compact duration for the status line: "3.3 s" / "450 ms". */
function short(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
}

/**
 * Open a numbered phase. The returned function updates its status line; call it
 * before each unit of work, never after, so the line describes what is running now.
 */
function beginPhase(name: string): (detail?: string) => void {
  const head = `[${++phase}/${PHASES}] ${name}`;
  return (detail) => status(detail ? `${head}  ${detail}` : head);
}

/**
 * `label`, plus an estimate once anything has been timed. `seen` is every duration
 * observed in this phase so far (warmups included — they are the same work, and on
 * the cold benchmark the warmup is the first 3 s of silence); `remaining` counts the
 * unit about to start.
 */
function eta(label: string, seen: number[], remaining: number): string {
  if (!seen.length) return label;
  const per = seen.reduce((a, b) => a + b, 0) / seen.length;
  const left = per * remaining;
  // Below this the phase is over before the line can be read, and "~0 ms left" is
  // just noise on the six benchmarks that are effectively instant.
  if (left < 500) return label;
  return `${label}  ~${short(per)} each, ~${short(left)} left`;
}

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
// The literal prefix of each message, for building filter patterns that really
// occur in the corpus (see `patternPool`). Index-aligned with MSGS.
const MSG_PREFIX = [
  "connected to AP",
  "heap free",
  "task watchdog",
  "battery ",
  "packet dropped",
  "calibration done",
  "flash write",
  "irq latency",
  "state ->",
  "checksum mismatch",
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

/**
 * distinct filters to pad a filter set with, broadest first.
 *
 * They must be *distinct*: the match cache is keyed by regex source + flags, so a
 * set that repeats patterns is scanned once per distinct pattern, not once per
 * filter. Padding with a 20-entry list on a cycle (which this script used to do)
 * made `--filters=100` cost what 27 filters cost — a 3× understatement of the cold
 * path on top of everything else.
 *
 * Broadest first so a small `--filters` still gets a realistic match density: the
 * compose pass walks set bits, so a set of nothing but 1%-hit patterns would make
 * the warm number look better than any real filter set does.
 */
function patternPool(): string[] {
  const pool: string[] = [];
  for (const t of TAGS) pool.push(t); // ~10% of lines each
  for (const l of LEVELS) pool.push(`[${l}]`); // ~20% each
  for (const m of MSG_PREFIX) pool.push(m); // ~10% each
  for (const t of TAGS) for (const m of MSG_PREFIX) pool.push(`${t}: ${m}`); // ~1% each
  return pool;
}

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

  // The base shapes are what the other benchmarks need (an exclude, a regex, a
  // field provider), so they are a floor rather than something to slice away.
  if (n < base.length)
    note(
      `--filters=${n} is below the ${base.length} base filter shapes; using ${base.length}.`,
    );

  const out = base.slice();
  const seen = new Set(out.map((f) => f.pattern));
  for (const p of patternPool()) {
    if (out.length >= n) break;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(makeFilter(p));
  }
  // Past the pool there are no more realistic patterns to invent. Pad with
  // distinct literals that match nothing: the cold scan still pays for them in
  // full (a literal that misses is still a whole pass over the file), but they
  // contribute no set bits, so the warm compose number is optimistic from here on.
  if (out.length < n) {
    note(
      `only ${out.length} distinct realistic patterns available; padded to ${n} ` +
        `with non-matching literals (cold cost realistic, warm compose optimistic).`,
    );
    let k = 0;
    while (out.length < n) out.push(makeFilter(`zzz_no_match_${k++}`));
  }
  return out;
}

// --- benchmark harness ------------------------------------------------------

interface Stat {
  name: string;
  runs: number;
  min: number;
  median: number;
  mean: number;
  max: number;
}

/**
 * Reduce raw per-run samples to the reported shape.
 *
 * Separate from `bench` so a stage this process does not execute itself can still
 * be reported identically: the Rust scan's timings arrive in the blob header rather
 * than off a `performance.now()` pair, and a Rust row printed as a lone number next
 * to JS rows with a spread is not something you can compare.
 */
function summarize(name: string, samples: number[]): Stat {
  const t = samples.slice().sort((a, b) => a - b);
  return {
    name,
    runs: t.length,
    min: t[0],
    median: t[t.length >> 1],
    mean: t.reduce((a, b) => a + b, 0) / t.length,
    max: t[t.length - 1],
  };
}

interface BenchOpts<T> {
  /**
   * Untimed per-run setup, whose result is passed to the timed function. This is
   * what makes a cold benchmark possible: hand each run a fresh `lines` copy so
   * the identity-keyed match cache misses, without paying for the copy in the
   * measurement.
   */
  setup?: () => T;
  runs?: number;
  warmup?: number;
}

function bench<T = void>(
  name: string,
  fn: (arg: T) => void,
  opts: BenchOpts<T> = {},
): Stat {
  const runs = opts.runs ?? RUNS;
  const warmup = opts.warmup ?? WARMUP;
  const setup = opts.setup ?? (() => undefined as T);
  const tick = beginPhase(name);
  // Warmups are timed as well. They are not reported — a JIT-cold sample would skew
  // the stats — but they are the same work, so they are what makes the estimate on
  // the first *reported* run possible instead of blank.
  const seen: number[] = [];
  const time = (arg: T): number => {
    const s = performance.now();
    fn(arg);
    const d = performance.now() - s;
    seen.push(d);
    return d;
  };
  for (let i = 0; i < warmup; i++) {
    tick(eta(`warmup ${i + 1}/${warmup}`, seen, warmup - i + runs));
    time(setup());
  }
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    tick(eta(`run ${i + 1}/${runs}`, seen, runs - i));
    t.push(time(setup()));
  }
  clearStatus();
  return summarize(name, t);
}

const ms = (n: number) => `${n.toFixed(2)} ms`;

// --- the Rust scanner: setup -------------------------------------------------
// Same patterns, same lines, through `scan_text` in src-tauri/src/scan.rs — the
// code the app actually primes the match cache from. Driven through the existing
// `crosscheck` binary (stdin JSON → the raw blob), so no Rust change is needed.

const TAURI = join(import.meta.dir, "..", "src-tauri");
const EXE = join(
  TAURI,
  "target",
  "release",
  process.platform === "win32" ? "crosscheck.exe" : "crosscheck",
);

interface PrimeEntry {
  source: string;
  flags: string;
  bits: Uint8Array;
  count: number;
  re: RegExp;
}
interface RustResult {
  /** Rust: splitting the text into lines. One sample per run, ms. */
  split: number[];
  /** Rust: the RegexSet + rayon scan itself. One sample per run, ms. */
  scan: number[];
  /** Whole `crosscheck` round trip incl. JSON — a harness cost, not an app cost. */
  wall: number[];
  fallback: number;
  entries: PrimeEntry[];
}

/**
 * Build the helper, every run. Not "build it if the binary is missing": an existing
 * binary can be older than `scan.rs`, and the failure mode there is a scan number
 * quietly measured against code that no longer exists. A no-op incremental build
 * costs ~0.5 s, which is cheaper than one wrong benchmark.
 *
 * Must be `--release`: `regex` is unoptimised in debug and the scan comes out ~10×
 * slower, which would understate the Rust side badly enough to invert the comparison.
 */
function buildRustHelper(): boolean {
  if (!JSON_OUT) process.stdout.write("building rust scanner… ");
  const r = spawnSync(
    "cargo",
    ["build", "--release", "--features", "crosscheck", "--bin", "crosscheck"],
    { cwd: TAURI, stdio: "pipe" },
  );
  if (r.status !== 0 || !existsSync(EXE)) {
    if (!JSON_OUT) console.log(c.yellow("failed"));
    note(
      "cargo build failed — no Rust comparison. Run with --no-rust to skip it, or\n" +
        "      see the error: cargo build --release --features crosscheck --bin crosscheck",
    );
    return false;
  }
  if (!JSON_OUT) console.log(c.dim("ok"));
  return true;
}

// --- run --------------------------------------------------------------------

if (!JSON_OUT) {
  console.log(
    c.bold("Logsy profiler") +
      c.dim(
        ` — ${LINES.toLocaleString()} lines, ${FILTERS} filters, ${RUNS} runs (seed ${SEED})\n`,
      ),
  );
}

// Built before anything is measured: a missing toolchain should be the first thing
// you see, not something reported after a minute of benchmarks.
const rustReady = WITH_RUST && buildRustHelper();

if (!JSON_OUT) process.stdout.write(c.dim("generating log… "));

const genStart = performance.now();
const lines = genLog(LINES, SEED);
const filters = genFilters(FILTERS);
const bytes = lines.reduce((a, l) => a + l.length, 0);
if (!JSON_OUT)
  console.log(
    c.dim(
      `${ms(performance.now() - genStart)}  (${(bytes / 1e6).toFixed(1)} MB)\n`,
    ),
  );

// Pre-compile once for the benches that need a compiled set as input.
const compiled = compileAll(filters);
// The patterns actually scanned: `scanSpecs` applies the same source+flags dedupe
// the match cache does, so this — not the filter count — is what the cold path costs.
const specs: ScanSpec[] = scanSpecs(compiled);

// Sample line + filter shape (sanity check the synthetic data is realistic).
if (!JSON_OUT) {
  console.log(c.dim(`  e.g. ${lines[0]}`));
  console.log(
    c.dim(
      `  filters: ${filters.length} (${specs.length} distinct filters, ` +
        `${filters.filter((f) => f.regex).length} regex, ${filters.filter((f) => f.exclude).length} exclude)\n`,
    ),
  );
}

// Row names, defined once. Every stage is labelled with the side that runs it, and
// the open-a-file comparison below reuses these exact strings — so a row there can be
// traced to its distribution in the table, and neither can drift from the other.
const NAME = {
  split: "js: splitLines",
  compile: "js: compileAll",
  scan: "js: match scan",
  cold: "js: computeView (cold)",
  warm: "js: computeView (compose)",
  fields: "js: fieldsFor × all rows",
  segments: "js: segments × 1000 rows",
  preview: "js: scanMatches (preview)",
  rustSplit: "rust: split_lines",
  rustScan: "rust: RegexSet scan (rayon)",
  verify: "js: verify (spot-check)",
  prime: "js: primeMatchCache",
} as const;

const stats: Stat[] = [];

// The file as one string, the shape it arrives in from `read_text_file`. Also what
// the Rust helper is fed, so it is built once here.
const text = lines.join("\n") + "\n";

// 1. splitLines — text → lines[], on the open path before anything else. Small next
//    to a cold scan, but on the primed path it is one of the larger remaining stages.
stats.push(
  bench(NAME.split, () => {
    splitLines(text);
  }),
);

// 2. compileAll — building RegExp objects for the whole set (cheap, but real).
stats.push(
  bench(NAME.compile, () => {
    compileAll(filters);
  }),
);

// 3. The scan phase on its own — the O(lines × filters) half of a cold computeView,
//    measured directly rather than derived, so `scan + compose ≈ cold` below is a
//    check that can actually fail. Fresh array per run to miss the cache.
stats.push(
  bench<string[]>(
    NAME.scan,
    (fresh) => {
      scanAll(fresh, compiled);
    },
    {
      setup: () => lines.slice(),
      runs: COLD_RUNS,
      warmup: Math.min(WARMUP, 1),
    },
  ),
);

// 4. computeView with a cold cache — scan + compose in one call, which is what the
//    app pays when nothing primed it. Kept as its own row so it can be checked
//    against the two stages measured separately.
stats.push(
  bench<string[]>(
    NAME.cold,
    (fresh) => {
      computeView(fresh, compiled);
    },
    {
      setup: () => lines.slice(),
      runs: COLD_RUNS,
      warmup: Math.min(WARMUP, 1),
    },
  ),
);

// Prime `lines` itself, then measure the compose-only pass over cached bits.
const view = computeView(lines, compiled);

// 5. computeView over a warm cache — the compose pass alone. This is what the app
//    pays per open once Rust has primed, and per filter toggle thereafter.
stats.push(
  bench(NAME.warm, () => {
    computeView(lines, compiled);
  }),
);

// 6. fieldsFor — lazy field extraction; cost if every visible row is expanded.
stats.push(
  bench(NAME.fields, () => {
    for (let n = 1; n <= lines.length; n++) view.fieldsFor(n);
  }),
);

// 7. segments — per-line highlight segmentation for the rendered window
//    (virtualized list shows ~60 rows; we time a generous 1000-row window).
const winRe =
  compiled.find((c) => c.re && c.f.pattern === "wifi")?.re ?? compiled[0].re!;
const window = lines.slice(0, Math.min(1000, lines.length));
stats.push(
  bench(NAME.segments, () => {
    for (const l of window) segments(l, winRe);
  }),
);

// 8. scanMatches — edit-modal live preview: one pass, count + first 200 hits.
const previewRe = /rssi=-\d+/g;
stats.push(
  bench(NAME.preview, () => {
    scanMatches(lines, previewRe);
  }),
);

// --- the Rust scanner, for comparison ---------------------------------------

/**
 * Scan `lines` for `specs` through the helper built above, `runs` times, and decode
 * the last blob.
 *
 * Run repeatedly for the same reason the JS benchmarks are: one sample has no spread,
 * and a lone Rust number set against a JS min/median/mean/max is not a comparison.
 * The timings come from the blob header — `scan_text`'s own `Instant`s — so they
 * measure the same work the app pays for, with none of this harness's process spawn
 * or JSON in them.
 */
function runRust(runs: number): RustResult | null {
  const tick = beginPhase("rust: scanning");
  // Rust reads the file itself in the app; here it takes the text over stdin, so
  // the join and the JSON are harness overhead — reported separately, never folded
  // into the scan number. Serialized once and reused across runs.
  tick("serializing input");
  const input = JSON.stringify({ text, patterns: specs });
  const split: number[] = [];
  const scan: number[] = [];
  const wall: number[] = [];
  let last: Buffer | null = null;
  for (let i = 0; i < runs; i++) {
    tick(eta(`run ${i + 1}/${runs}`, wall, runs - i));
    const wallStart = performance.now();
    const r = spawnSync(EXE, { input, maxBuffer: 1 << 30 });
    wall.push(performance.now() - wallStart);
    if (r.status !== 0) {
      clearStatus();
      note(`rust scanner exited ${r.status} — skipping the comparison.`);
      return null;
    }
    const h = new DataView(r.stdout.buffer, r.stdout.byteOffset, 28);
    split.push(h.getUint32(20, true) / 1000);
    scan.push(h.getUint32(24, true) / 1000);
    last = r.stdout;
  }

  tick("decoding blob");
  const b = last!;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const nLines = dv.getUint32(0, true);
  const nPat = dv.getUint32(4, true);
  const bytesLen = dv.getUint32(8, true);
  const nFallback = dv.getUint32(12, true);
  if (nLines !== lines.length || nPat !== specs.length) {
    clearStatus();
    note(
      `rust/js disagree on shape (lines ${nLines} vs ${lines.length}, ` +
        `patterns ${nPat} vs ${specs.length}) — skipping the comparison.`,
    );
    return null;
  }
  let off = 28; // header: 4 counts + 3 timings
  const fb = new Set<number>();
  for (let k = 0; k < nFallback; k++, off += 4) fb.add(dv.getUint32(off, true));
  const counts: number[] = new Array(nPat);
  for (let k = 0; k < nPat; k++, off += 4) counts[k] = dv.getUint32(off, true);
  const u8 = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  const entries: PrimeEntry[] = [];
  for (let k = 0; k < nPat; k++) {
    if (fb.has(k)) continue;
    const flags = specs[k].ci ? "gi" : "g";
    // `slice`, like scanPrime does: the entry outlives the blob.
    entries.push({
      source: specs[k].source,
      flags,
      bits: u8.slice(off + k * bytesLen, off + (k + 1) * bytesLen),
      count: counts[k],
      re: new RegExp(specs[k].source, flags),
    });
  }
  clearStatus();
  return { split, scan, wall, fallback: nFallback, entries };
}

const rust = rustReady ? runRust(RUNS) : null;

if (rust) {
  // 7-8. The Rust stages, from the blob header, summarized exactly like a JS row.
  stats.push(summarize(NAME.rustSplit, rust.split));
  stats.push(summarize(NAME.rustScan, rust.scan));
  // 9. verify — the JS spot-check that stands between Rust's bits and the cache.
  stats.push(
    bench(NAME.verify, () => {
      for (const e of rust.entries) verify(lines, e.re, e.bits);
    }),
  );
  // 10. primeMatchCache — writing the bit sets in. Fresh array per run, or the
  //     second run would find every key already present and do nothing.
  stats.push(
    bench<string[]>(
      NAME.prime,
      (fresh) => {
        primeMatchCache(fresh, rust.entries);
      },
      { setup: () => lines.slice() },
    ),
  );
}

// --- report -----------------------------------------------------------------

const pick = (name: string): Stat => stats.find((s) => s.name === name)!;
const cold = pick(NAME.cold);
const warm = pick(NAME.warm);

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        config: {
          lines: LINES,
          filters: filters.length,
          distinctPatterns: specs.length,
          runs: RUNS,
          coldRuns: COLD_RUNS,
          seed: SEED,
          bytes,
        },
        // The Rust stages are rows in `stats` like every other stage; what's left
        // here is the scan outcome plus the harness overhead they exclude.
        stats,
        rust: rust && {
          primed: rust.entries.length,
          fallback: rust.fallback,
          harnessWall: summarize("harness: json stdin round trip", rust.wall),
        },
        notes,
      },
      null,
      2,
    ),
  );
} else {
  const pad = (s: string, w: number) => s.padEnd(w);
  const padN = (s: string, w: number) => s.padStart(w);
  const NAMEW = 30;
  const COLW = 13;
  const stage = (name: string) => pick(name).median;

  // Section order is bottom-up: the terminal is scrolled to the END when the run
  // finishes, so the last thing printed is the first thing read. The summary is
  // therefore printed last, and the supporting detail before it.

  // A stage costing under a millisecond is not where any time goes. Dimming those
  // rows is the single biggest readability win in the raw table: without it a
  // 1190 ms row and a 0.03 ms row carry exactly the same visual weight.
  const NOISE_MS = 1;
  const byWeight = (row: string, median: number) =>
    median < NOISE_MS ? c.dim(row) : row;

  // --- 1. raw samples -------------------------------------------------------
  // First, because it is reference material: not "what does this cost" but "how
  // stable is that number". Scroll up for it.
  const RAWW = NAMEW + 11 * 4 + 7;
  console.log(c.bold("raw samples") + "\n");
  console.log(
    c.dim(
      pad("benchmark", NAMEW) +
        padN("min", 11) +
        padN("median", 11) +
        padN("mean", 11) +
        padN("max", 11) +
        padN("runs", 7),
    ),
  );
  console.log(c.dim("─".repeat(RAWW)));
  for (const s of stats)
    console.log(
      byWeight(
        pad(s.name, NAMEW) +
          padN(ms(s.min), 11) +
          padN(ms(s.median), 11) +
          padN(ms(s.mean), 11) +
          padN(ms(s.max), 11) +
          padN(String(s.runs), 7),
        s.median,
      ),
    );

  const mem = process.memoryUsage?.();
  // Current RSS at exit, not a high-water mark — every run's `rows` array is
  // garbage by now, so treat this as a floor on what the pipeline touched.
  if (mem)
    console.log(c.dim(`\nrss at exit: ${(mem.rss / 1e6).toFixed(0)} MB`));

  // --- 2. other hot paths ---------------------------------------------------
  // Everything the engine does that is not part of opening: rendering a window,
  // expanding rows, the edit modal's live preview.
  const OTHER = [NAME.compile, NAME.fields, NAME.segments, NAME.preview];
  console.log(
    "\n\n" +
      c.bold("other engine hot paths") +
      c.dim(" (not on the open path)") +
      "\n",
  );
  for (const n of OTHER)
    console.log(
      byWeight("  " + pad(n, NAMEW) + padN(ms(stage(n)), COLW), stage(n)),
    );

  // Anything that qualifies the numbers goes above the summary, so the summary
  // itself is the last block on screen.
  for (const n of notes) console.log(`\n${c.yellow("note:")} ${n}`);

  // --- 3. opening a file: the two paths, side by side -----------------------
  // The question this report exists to answer, so it lands where the eye does. One
  // row per pipeline stage, one column per path, medians throughout. A dash means
  // the path does not have that stage at all.
  //
  // Both paths read the file and split it in JS, so those rows are identical and
  // carried in both columns rather than dropped — the goal is "where does opening
  // go", not only "where do the paths differ".
  // Dimmed, so the eye reads the two columns as "this stage exists only on that
  // side" instead of tripping over a row of punctuation.
  const dash = c.dim(padN("—", COLW));
  const cell = (v: number | null) => (v === null ? dash : padN(ms(v), COLW));
  const cmp = (label: string, js: number | null, primed: number | null) => {
    const row = "  " + pad(label, NAMEW) + cell(js) + cell(primed);
    // Dim a stage that costs nothing on whichever side actually runs it.
    const cost = Math.max(js ?? 0, primed ?? 0);
    return cost < NOISE_MS ? c.dim(row) : row;
  };

  const splitMs = stage(NAME.split);
  const scanMs = stage(NAME.scan);
  const composeMs = warm.median;
  const jsTotal = splitMs + scanMs + composeMs;
  const primedTotal = rust
    ? splitMs +
      stage(NAME.rustSplit) +
      stage(NAME.rustScan) +
      stage(NAME.verify) +
      stage(NAME.prime) +
      composeMs
    : null;

  const rule = c.dim("  " + "─".repeat(NAMEW + COLW * 2));
  console.log(
    "\n\n" +
      c.bold(
        `══ opening a ${(bytes / 1e6).toFixed(1)} MB log — ` +
          `${LINES.toLocaleString()} lines × ${specs.length} distinct filters ══`,
      ) +
      "\n",
  );
  console.log(
    c.dim(
      "  " +
        pad("stage", NAMEW) +
        padN("JS only", COLW) +
        padN("Rust-primed", COLW),
    ),
  );
  console.log(rule);
  console.log(cmp(NAME.split, splitMs, splitMs));
  console.log(cmp(NAME.scan, scanMs, null));
  if (rust) {
    console.log(cmp(NAME.rustSplit, null, stage(NAME.rustSplit)));
    console.log(cmp(NAME.rustScan, null, stage(NAME.rustScan)));
    console.log(cmp(NAME.verify, null, stage(NAME.verify)));
    console.log(cmp(NAME.prime, null, stage(NAME.prime)));
  }
  console.log(cmp(NAME.warm, composeMs, composeMs));
  console.log(rule);
  // The one row worth finding at a glance, so it is the only bold data row — and
  // the primed column is the answer, so it carries the accent.
  console.log(
    "  " +
      c.bold(pad("total", NAMEW)) +
      c.bold(padN(ms(jsTotal), COLW)) +
      (primedTotal === null
        ? dash
        : c.bold.green(padN(ms(primedTotal), COLW))) +
      (primedTotal
        ? c.bold.green(`   ${(jsTotal / primedTotal).toFixed(1)}× faster`)
        : ""),
  );

  // The stages this harness cannot see. Naming them is the point: a total that
  // silently omits the disk read invites being read as the whole wait.
  console.log(
    c.dim(
      "\n  not measured here (same on both paths): file read + decode, and the IPC\n" +
        "  that carries the text and the bit sets — see docs/perf-large-file-open.md",
    ),
  );
  if (rust) {
    const wall = summarize("", rust.wall);
    console.log(
      c.dim(
        `\n  ${rust.entries.length}/${specs.length} patterns primed by Rust` +
          (rust.fallback ? `, ${rust.fallback} fell back to JS` : "") +
          `\n  harness only, not in the app path: ${ms(wall.median)} for the JSON stdin` +
          ` round trip\n  (the app passes a path and Rust reads the file itself)`,
      ),
    );
  } else if (!WITH_RUST) {
    console.log(
      c.yellow(
        "\n  --no-rust: the JS column is the whole report. That is not what opening a\n" +
          "  file costs — the app primes the match cache from Rust. Drop the flag.",
      ),
    );
  }

  // Cross-check: the scan and compose stages are measured on their own, and a cold
  // `computeView` does both in one call. They should agree. When they don't, one of
  // the three numbers is measuring something other than what its name says — so a
  // drift is the one result in this report that is worth an attention colour.
  const parts = scanMs + composeMs;
  const drift = Math.abs(parts - cold.median) / cold.median;
  const check =
    `  cross-check: scan + compose = ${ms(parts)} vs computeView (cold) ` +
    `${ms(cold.median)}`;
  console.log(
    "\n" +
      (drift > 0.1
        ? check + c.bold.yellow(`  ⚠ ${(drift * 100).toFixed(0)}% apart`)
        : c.dim(check)),
  );
}
