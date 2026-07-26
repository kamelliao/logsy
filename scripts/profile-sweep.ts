#!/usr/bin/env bun
// Sweep `scripts/profile.ts` across a (lines × filters) grid and build a
// self-contained interactive report from the result.
//
// `profile.ts` answers "what does opening THIS shape of file cost". This answers
// the shape question itself: how the cost moves as a log gets longer and a filter
// set gets bigger, on both paths at once. One profiler run is one cell here.
//
//   bun run scripts/sweep.ts                          # the default 6×5 grid
//   bun run scripts/sweep.ts --lines 1000,200000      # a smaller grid
//   bun run scripts/sweep.ts --from-json out.json     # re-render, no re-run
//
// The report is one HTML file with the measurements inlined — no server, no
// fetch, no CDN — so it can be opened from disk or handed to someone as an
// attachment. It draws two panels sharing one y axis (JS only, Rust-primed),
// x = lines, one line per filter count, and the y axis toggles log/linear.
//
// Why both scales are worth having: the measurements span four orders of
// magnitude, so on a linear axis more than half the points sit inside the bottom
// few pixels and nothing below ~300 ms is readable. Log fixes that and, because
// x is log too, turns a power law into a straight line whose slope IS the
// exponent — that is what makes "cost is O(lines × filters)" a thing you read off
// the chart rather than assert. What log costs you is the sense of scale, which
// is exactly what the linear view gives back.
//
// EACH CELL IS ITS OWN PROCESS, deliberately. The match cache, the JIT's state
// and the generated log are all per-process; sharing any of them would mean a
// later cell measures a warmer machine than an earlier one. That costs a process
// spawn and a cargo no-op build per cell, which is noise next to the benchmarks.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import chalk, { chalkStderr } from "chalk";
import { Command, InvalidArgumentError } from "commander";

// --- args -------------------------------------------------------------------

/** `1000,10000,50000` → `[1000, 10000, 50000]`, rejecting anything that isn't. */
function intList(raw: string): number[] {
  const out = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const v = Number(s);
      if (!Number.isInteger(v) || v < 1)
        throw new InvalidArgumentError(`"${s}" is not a positive integer.`);
      return v;
    });
  if (!out.length)
    throw new InvalidArgumentError("expected at least one value.");
  return [...new Set(out)].sort((a, b) => a - b);
}

function positiveInt(raw: string): number {
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1)
    throw new InvalidArgumentError("expected a positive integer.");
  return v;
}

const program = new Command()
  .name("sweep")
  .description(
    "Run scripts/profile.ts across a grid of log sizes and filter counts, then\n" +
      "write a self-contained interactive report of the result.",
  )
  .option(
    "--lines <list>",
    "comma-separated line counts",
    intList,
    [1_000, 5_000, 10_000, 50_000, 100_000, 500_000],
  )
  .option(
    "--filters <list>",
    "comma-separated filter-set sizes",
    intList,
    [5, 10, 50, 100, 200],
  )
  .option(
    "--runs <n>",
    "timed runs per benchmark, passed through to the profiler",
    positiveInt,
    5,
  )
  .option("--seed <n>", "PRNG seed, for a reproducible log", positiveInt, 1)
  .option(
    "--out <path>",
    "report to write (.json alongside it)",
    "profile-sweep.html",
  )
  .option(
    "--from-json <path>",
    "re-render the report from an earlier sweep instead of measuring again",
  )
  .option("-q, --quiet", "no per-cell progress (the report is unaffected)")
  .showHelpAfterError()
  .parse();

const opts = program.opts<{
  lines: number[];
  filters: number[];
  runs: number;
  seed: number;
  out: string;
  fromJson?: string;
  quiet?: boolean;
}>();

const OUT_HTML = resolve(opts.out);
const OUT_JSON = OUT_HTML.replace(/\.html?$/i, "") + ".json";

// --- shapes -----------------------------------------------------------------

interface Stat {
  name: string;
  runs: number;
  min: number;
  median: number;
  mean: number;
  max: number;
}

/** The subset of `profile.ts --json` this script reads. */
interface Report {
  config: {
    lines: number;
    filters: number;
    distinctPatterns: number;
    runs: number;
    coldRuns: number;
    seed: number;
    bytes: number;
  };
  stats: Stat[];
  rust: { primed: number; fallback: number } | null;
  notes: string[];
}

/** One grid cell: the two path totals plus the stages worth showing. */
interface Cell {
  lines: number;
  /** As requested. The profiler may raise it — see `distinctPatterns`. */
  filters: number;
  /** What the cold scan actually costs, after the profiler's source+flags dedupe. */
  distinctPatterns: number;
  bytes: number;
  jsTotal: number;
  primedTotal: number | null;
  split: number;
  scan: number;
  compose: number;
  rustSplit: number | null;
  rustScan: number | null;
  verify: number | null;
  prime: number | null;
  notes: string[];
}

interface Meta {
  runs: number;
  seed: number;
  runtime: string;
  generated: string;
  command: string;
  /** Wall time of the sweep, or null when the report was re-rendered from JSON. */
  minutes: number | null;
}

/** What lands on disk next to the report. Re-readable by `--from-json`. */
interface SweepFile {
  meta: Meta | null;
  cells: Cell[];
}

// --- measuring ---------------------------------------------------------------

const round = (v: number): number => +v.toFixed(2);

/**
 * Add the profiler's two path totals from its own stage medians.
 *
 * Deliberately the same sum `profile.ts` prints rather than a number it exports:
 * the stage rows are the contract between the two scripts, so a stage renamed
 * there fails loudly here instead of quietly dropping out of a total.
 */
function totals(
  report: Report,
): Omit<Cell, "lines" | "filters" | "distinctPatterns" | "bytes" | "notes"> {
  const median = (name: string): number | null =>
    report.stats.find((s) => s.name === name)?.median ?? null;
  const need = (name: string): number => {
    const v = median(name);
    if (v === null)
      throw new Error(
        `profile.ts reported no "${name}" row — the stage names the two scripts share have drifted.`,
      );
    return v;
  };

  const split = need("js: splitLines");
  const scan = need("js: match scan");
  const compose = need("js: computeView (compose)");
  // The Rust stages are absent whenever cargo could not build; that is a
  // downgrade to a JS-only cell, not a failure of the sweep.
  const rustSplit = median("rust: split_lines");
  const rustScan = median("rust: RegexSet scan (rayon)");
  const verify = median("js: verify (spot-check)");
  const prime = median("js: primeMatchCache");
  const hasRust =
    rustSplit !== null &&
    rustScan !== null &&
    verify !== null &&
    prime !== null;

  return {
    split: round(split),
    scan: round(scan),
    compose: round(compose),
    rustSplit: rustSplit === null ? null : round(rustSplit),
    rustScan: rustScan === null ? null : round(rustScan),
    verify: verify === null ? null : round(verify),
    prime: prime === null ? null : round(prime),
    jsTotal: round(split + scan + compose),
    primedTotal: hasRust
      ? round(split + rustSplit! + rustScan! + verify! + prime! + compose)
      : null,
  };
}

const short = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;

function measure(): { cells: Cell[]; minutes: number } {
  const cells: Cell[] = [];
  const total = opts.lines.length * opts.filters.length;
  const started = Date.now();
  let n = 0;

  for (const lines of opts.lines) {
    for (const filters of opts.filters) {
      n++;
      const head = `[${n}/${total}] lines=${lines.toLocaleString()} filters=${filters}`;
      if (!opts.quiet) process.stderr.write(chalkStderr.dim(`${head} … `));
      const cellStart = Date.now();
      const r = spawnSync(
        process.execPath,
        [
          "run",
          resolve(import.meta.dir, "profile.ts"),
          "--json",
          `--lines=${lines}`,
          `--filters=${filters}`,
          `--runs=${opts.runs}`,
          `--seed=${opts.seed}`,
        ],
        { encoding: "utf8", maxBuffer: 1 << 28 },
      );
      if (r.status !== 0)
        throw new Error(
          `profile.ts exited ${r.status} on ${lines} × ${filters}:\n${r.stderr}`,
        );

      const report = JSON.parse(r.stdout) as Report;
      const cell: Cell = {
        lines,
        filters,
        distinctPatterns: report.config.distinctPatterns,
        bytes: report.config.bytes,
        ...totals(report),
        notes: report.notes,
      };
      cells.push(cell);

      if (!opts.quiet)
        process.stderr.write(
          chalkStderr.dim(
            `js ${short(cell.jsTotal)}  primed ` +
              `${cell.primedTotal === null ? "—" : short(cell.primedTotal)}  ` +
              `(${((Date.now() - cellStart) / 1000).toFixed(1)}s)\n`,
          ),
        );
      // Written every cell, so an interrupted sweep still leaves usable data.
      // `meta` is only knowable once the whole thing has run, so it lands last.
      writeFileSync(
        OUT_JSON,
        JSON.stringify({ meta: null, cells } satisfies SweepFile, null, 2),
      );
    }
  }
  return { cells, minutes: (Date.now() - started) / 60000 };
}

// --- the report: style -------------------------------------------------------
// The page is a dressed-up terminal report, so the display face is the mono the
// profiler itself prints in and prose is a serif, which keeps analysis from
// reading as more output. Hue encodes the implementation (warm = JS, cool = the
// app's own accent blue); lightness within a hue encodes the filter count.

const CSS = `
  :root {
    --bg: #f6f7f9; --surface: #ffffff;
    --ink: #14171c; --ink-2: #4a5260; --ink-3: #8b93a1;
    --rule: #dfe3e9; --grid: #e9ecf1;
    --accent: #2c6ce6; --warn: #b4341f;
    --js-1: #e0a63f; --js-2: #d1801f; --js-3: #bc5d13; --js-4: #9d3d0d; --js-5: #742307;
    --rs-1: #8bb8f0; --rs-2: #5a92e8; --rs-3: #2c6ce6; --rs-4: #1d4fae; --rs-5: #16397c;
    --font-mono: ui-monospace, "Cascadia Mono", "SF Mono", "JetBrains Mono",
      Consolas, "Liberation Mono", monospace;
    --font-serif: "Iowan Old Style", "Palatino Linotype", Palatino,
      "Book Antiqua", Georgia, serif;
  }
  /* Dark is defined once as a token block and applied three ways: the OS
     preference, and each explicit choice from the viewer's own theme toggle,
     which has to win over the media query in both directions. */
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1217; --surface: #161a20;
      --ink: #e7eaef; --ink-2: #98a1b0; --ink-3: #6b7484;
      --rule: #272d37; --grid: #1e242c;
      --accent: #5a92e8; --warn: #e5675a;
      --js-1: #f7d98f; --js-2: #f0bb5c; --js-3: #e59a3a; --js-4: #d67728; --js-5: #c25620;
      --rs-1: #b3d0f6; --rs-2: #a0c6f6; --rs-3: #6ea6ef; --rs-4: #4585e4; --rs-5: #2c6ce6;
    }
  }
  :root[data-theme="light"] {
    --bg: #f6f7f9; --surface: #ffffff;
    --ink: #14171c; --ink-2: #4a5260; --ink-3: #8b93a1;
    --rule: #dfe3e9; --grid: #e9ecf1;
    --accent: #2c6ce6; --warn: #b4341f;
    --js-1: #e0a63f; --js-2: #d1801f; --js-3: #bc5d13; --js-4: #9d3d0d; --js-5: #742307;
    --rs-1: #8bb8f0; --rs-2: #5a92e8; --rs-3: #2c6ce6; --rs-4: #1d4fae; --rs-5: #16397c;
  }
  :root[data-theme="dark"] {
    --bg: #0f1217; --surface: #161a20;
    --ink: #e7eaef; --ink-2: #98a1b0; --ink-3: #6b7484;
    --rule: #272d37; --grid: #1e242c;
    --accent: #5a92e8; --warn: #e5675a;
    --js-1: #f7d98f; --js-2: #f0bb5c; --js-3: #e59a3a; --js-4: #d67728; --js-5: #c25620;
    --rs-1: #b3d0f6; --rs-2: #a0c6f6; --rs-3: #6ea6ef; --rs-4: #4585e4; --rs-5: #2c6ce6;
  }

  body {
    background: var(--bg); color: var(--ink);
    font-family: var(--font-serif); font-size: 16px; line-height: 1.65;
    -webkit-font-smoothing: antialiased;
  }
  .page {
    max-width: 1180px; margin: 0 auto; padding: 40px 24px 96px;
    display: flex; flex-direction: column; gap: 40px;
  }

  .masthead {
    display: flex; flex-direction: column; gap: 14px;
    border-bottom: 1px solid var(--rule); padding-bottom: 26px;
  }
  .eyebrow {
    font-family: var(--font-mono); font-size: 11px;
    letter-spacing: 0.16em; text-transform: uppercase; color: var(--ink-3);
  }
  h1 {
    font-family: var(--font-mono); font-size: clamp(24px, 3.4vw, 38px);
    font-weight: 700; letter-spacing: -0.02em; line-height: 1.15;
    text-wrap: balance; margin: 0;
  }
  .standfirst { color: var(--ink-2); font-size: 17px; }
  .runmeta {
    font-family: var(--font-mono); font-size: 12px; color: var(--ink-3);
    display: flex; flex-wrap: wrap; gap: 6px 18px;
    font-variant-numeric: tabular-nums;
  }
  .runmeta b { color: var(--ink-2); font-weight: 600; }

  .charts {
    background: var(--surface); border: 1px solid var(--rule); border-radius: 3px;
    padding: 22px 22px 18px; display: flex; flex-direction: column; gap: 18px;
  }
  .charthead {
    display: flex; flex-wrap: wrap; align-items: baseline;
    justify-content: space-between; gap: 12px;
  }
  .charthead h2 {
    font-family: var(--font-mono); font-size: 14px; font-weight: 700;
    letter-spacing: 0.02em; margin: 0;
  }
  .axisnote {
    font-family: var(--font-mono); font-size: 11px;
    color: var(--ink-3); letter-spacing: 0.04em;
  }

  .scalectl { display: flex; align-items: center; gap: 10px; }
  .scalectl > .lab {
    font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--ink-3);
  }
  .seg {
    display: inline-flex; border: 1px solid var(--rule);
    border-radius: 2px; overflow: hidden;
  }
  .seg button {
    font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.08em;
    text-transform: uppercase; padding: 4px 11px; background: transparent;
    color: var(--ink-3); border: 0; border-left: 1px solid var(--rule);
    cursor: pointer;
  }
  .seg button:first-child { border-left: 0; }
  .seg button:hover { color: var(--ink); }
  .seg button[aria-pressed="true"] { background: var(--accent); color: var(--surface); }

  .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
  @media (max-width: 880px) {
    .panels { grid-template-columns: 1fr; gap: 20px; }
  }
  .panel { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .paneltitle {
    font-family: var(--font-mono); font-size: 12px; letter-spacing: 0.1em;
    text-transform: uppercase; display: flex; align-items: baseline; gap: 9px;
  }
  .paneltitle .sub {
    font-size: 11px; letter-spacing: 0.02em; text-transform: none; color: var(--ink-3);
  }
  .swatchdot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  svg { display: block; width: 100%; height: auto; overflow: visible; }

  .legend {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px;
    border-top: 1px solid var(--rule); padding-top: 14px;
    font-family: var(--font-mono); font-size: 11px; color: var(--ink-2);
  }
  .legend .lab { color: var(--ink-3); letter-spacing: 0.1em; text-transform: uppercase; }
  .ramp { display: flex; align-items: center; gap: 5px; }
  .ramp i { width: 22px; height: 4px; border-radius: 2px; display: inline-block; }
  .ramp span { font-variant-numeric: tabular-nums; }

  /* Pinned under its panel rather than floating: a tooltip that follows the
     pointer would cover the curves it is describing. */
  .readout {
    font-family: var(--font-mono); font-size: 11.5px; color: var(--ink-2);
    font-variant-numeric: tabular-nums; min-height: 1.5em; letter-spacing: 0.01em;
  }
  .readout b { color: var(--ink); font-weight: 700; }
  .readout .dim { color: var(--ink-3); }

  .tablewrap {
    overflow-x: auto; border: 1px solid var(--rule);
    border-radius: 3px; background: var(--surface);
  }
  table {
    border-collapse: collapse; width: 100%; font-family: var(--font-mono);
    font-size: 12px; font-variant-numeric: tabular-nums;
  }
  caption {
    text-align: left; font-family: var(--font-mono); font-size: 11px;
    letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3);
    padding: 12px 14px; border-bottom: 1px solid var(--rule);
  }
  th, td { padding: 5px 12px; text-align: right; white-space: nowrap; }
  thead th {
    font-weight: 600; color: var(--ink-3); font-size: 11px;
    letter-spacing: 0.06em; border-bottom: 1px solid var(--rule);
  }
  tbody th { text-align: left; font-weight: 600; color: var(--ink-2); }
  tbody tr:hover { background: color-mix(in srgb, var(--accent) 7%, transparent); }
  .grouptop td, .grouptop th { border-top: 1px solid var(--rule); }
  .gain-up { color: var(--accent); font-weight: 700; }
  .gain-down { color: var(--warn); font-weight: 700; }

  footer {
    font-family: var(--font-mono); font-size: 11px; color: var(--ink-3);
    line-height: 1.8; border-top: 1px solid var(--rule); padding-top: 18px;
    display: flex; flex-direction: column; gap: 10px;
  }
  footer b { color: var(--ink-2); }
  footer ul { margin: 0; padding-left: 18px; }

  a { color: var(--accent); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

// --- the report: markup ------------------------------------------------------
// Static shell only. Everything that depends on a measurement is filled in by
// the script below, so this stays the same whatever grid was swept.

const BODY = `
  <div class="page">
    <header class="masthead">
      <div class="eyebrow" id="eyebrow"></div>
      <h1>What a cold file open costs: JS only vs Rust primed</h1>
      <p class="standfirst">
        One pipeline, two ways through it. On the left <code>computeView</code> does its
        own scanning; on the right a Rust RegexSet scans first and pours the bitsets into
        the match cache, leaving only the compose. x is lines on a log₁₀ scale, one curve
        per filter count, and both panels share a single y axis — so how far the right
        panel drops is exactly what priming buys. y is logarithmic by default (equal
        distance means equal ratio, so a slope reads off as an exponent); switch it to
        linear to see the gap in absolute terms.
      </p>
      <div class="runmeta" id="runmeta"></div>
    </header>

    <section class="charts">
      <div class="charthead">
        <h2>Total open time (median, ms)</h2>
        <div class="scalectl">
          <span class="lab">y axis</span>
          <span class="seg" id="scale">
            <button type="button" data-scale="log" aria-pressed="true">log</button>
            <button type="button" data-scale="linear" aria-pressed="false">linear</button>
          </span>
        </div>
      </div>
      <div class="axisnote" id="axisnote"></div>
      <div class="panels">
        <div class="panel">
          <div class="paneltitle">
            <span class="swatchdot" style="background: var(--js-4)"></span>
            <span>JS only</span>
            <span class="sub">splitLines + match scan + compose</span>
          </div>
          <svg id="svg-js" role="img"
            aria-label="JS only: open time against lines on a log x axis, one curve per filter count"></svg>
          <div class="readout" id="ro-js">&nbsp;</div>
        </div>
        <div class="panel">
          <div class="paneltitle">
            <span class="swatchdot" style="background: var(--rs-3)"></span>
            <span>Rust primed</span>
            <span class="sub">+ rust split/scan + verify + prime</span>
          </div>
          <svg id="svg-rs" role="img"
            aria-label="Rust primed: open time against lines on a log x axis, one curve per filter count"></svg>
          <div class="readout" id="ro-rs">&nbsp;</div>
        </div>
      </div>
      <div class="legend">
        <span class="lab">filters</span>
        <span class="ramp" id="legend-js"></span>
        <span class="ramp" id="legend-rs"></span>
      </div>
    </section>

    <div class="tablewrap">
      <table id="table">
        <caption>Median per cell, with JS ÷ primed as a speedup</caption>
      </table>
    </div>

    <footer id="foot"></footer>
  </div>
`;

// --- the report: behaviour ---------------------------------------------------

/**
 * The page's own code, written as a function and serialized with `toString()`
 * rather than kept in a template literal.
 *
 * The page is full of template literals of its own, and inside a build-time
 * template literal every one of their `${…}` would have to be escaped — miss one
 * and it either fails the build or, worse, silently interpolates a same-named
 * variable from this script into the page. Serializing a real function removes
 * that entire class of bug: what is written here is exactly what ships, and it
 * stays lintable and formattable as ordinary code.
 *
 * It therefore closes over nothing — everything it needs arrives as arguments.
 */
function reportScript(DATA: Cell[], NOTES: string[], META: Meta): void {
  const LINES = [...new Set(DATA.map((d) => d.lines))].sort((a, b) => a - b);
  const FILTERS = [...new Set(DATA.map((d) => d.filters))].sort(
    (a, b) => a - b,
  );

  const JS_RAMP = ["--js-1", "--js-2", "--js-3", "--js-4", "--js-5"];
  const RS_RAMP = ["--rs-1", "--rs-2", "--rs-3", "--rs-4", "--rs-5"];
  // More filter counts than ramp steps just cycles; the end labels still name
  // each line, so a repeated colour is a readability cost, not an ambiguity.
  const colorOf = (ramp: string[], i: number) =>
    "var(" + ramp[i % ramp.length] + ")";

  const at = (lines: number, filters: number) =>
    DATA.find((d) => d.lines === lines && d.filters === filters);
  const valueOf = (cell: Cell | undefined, key: "jsTotal" | "primedTotal") =>
    cell ? cell[key] : null;

  const allY = DATA.flatMap((d) => [d.jsTotal, d.primedTotal]).filter(
    (v): v is number => typeof v === "number" && v > 0,
  );
  const yMin = Math.min(...allY);
  const yMax = Math.max(...allY);

  // Both panels share one domain, rounded out to whole decades so the two sets
  // of ticks are identical. That sharing is the point of the layout: the primed
  // panel is meant to read as low, not to be rescaled until it looks busy again.
  const dLo = Math.floor(Math.log10(yMin));
  const dHi = Math.ceil(Math.log10(yMax));
  const Y_LO = Math.pow(10, dLo);
  const Y_HI = Math.pow(10, dHi);
  const Y_TICKS_LOG: number[] = [];
  for (let d = dLo; d <= dHi; d++)
    for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, d);
      if (v >= Y_LO && v <= Y_HI) Y_TICKS_LOG.push(v);
    }

  const niceStep = (raw: number) => {
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    return ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  };
  const LIN_STEP = niceStep(yMax / 6);
  const LIN_TOP = Math.ceil(yMax / LIN_STEP) * LIN_STEP;
  const Y_TICKS_LIN: number[] = [];
  for (let v = 0; v <= LIN_TOP + 1e-9; v += LIN_STEP)
    Y_TICKS_LIN.push(+v.toFixed(6));

  let SCALE: "log" | "linear" = "log";

  const fmtMs = (v: number) => {
    if (v >= 1000)
      return (v / 1000) % 1 === 0
        ? v / 1000 + " s"
        : (v / 1000).toFixed(1) + " s";
    if (v >= 10) return String(Math.round(v));
    if (v >= 1) return v.toFixed(1);
    return v.toFixed(2);
  };
  // The table stays in milliseconds throughout. Switching the big cells to
  // seconds the way the axis labels do would put "6.0 s" and "639" in one
  // column, which is the one place the numbers exist to be compared.
  const fmtCell = (v: number) =>
    v >= 100
      ? Math.round(v).toLocaleString()
      : v >= 10
        ? v.toFixed(1)
        : v.toFixed(2);
  const fmtLines = (n: number) =>
    n >= 1_000_000
      ? n / 1_000_000 + "M"
      : n >= 1000
        ? n / 1000 + "k"
        : String(n);
  const fmtTick = (v: number) => (v >= 1000 ? v / 1000 + " s" : String(v));

  const M = { t: 14, r: 52, b: 34, l: 46 };
  const H = 360;

  // What the linear view actually costs, counted rather than asserted: on this
  // domain one pixel is LIN_TOP/ih ms, so anything below that is drawn on top of
  // the axis itself. The axis note reports the number.
  const LIN_BURIED = allY.filter((v) => v < LIN_TOP / (H - M.t - M.b)).length;

  function draw(
    svgEl: SVGSVGElement,
    key: "jsTotal" | "primedTotal",
    ramp: string[],
    readoutEl: HTMLElement,
  ) {
    const W = Math.max(
      280,
      svgEl.clientWidth || svgEl.parentElement!.clientWidth,
    );
    const iw = W - M.l - M.r;
    const ih = H - M.t - M.b;

    const lx0 = Math.log10(LINES[0]);
    const lx1 = Math.log10(LINES[LINES.length - 1]);
    // A one-column grid has no x range to map onto; pin it to the left edge.
    const x = (v: number) =>
      lx1 === lx0 ? M.l : M.l + ((Math.log10(v) - lx0) / (lx1 - lx0)) * iw;

    const log = SCALE === "log";
    const ly0 = Math.log10(Y_LO);
    const ly1 = Math.log10(Y_HI);
    const y = (v: number) =>
      log
        ? M.t + ih - ((Math.log10(v) - ly0) / (ly1 - ly0)) * ih
        : M.t + ih - (v / LIN_TOP) * ih;
    const Y_TICKS = log ? Y_TICKS_LOG : Y_TICKS_LIN;

    const ns = "http://www.w3.org/2000/svg";
    const el = (
      name: string,
      attrs: Record<string, string | number>,
      txt?: string,
    ) => {
      const e = document.createElementNS(ns, name);
      for (const k in attrs) e.setAttribute(k, String(attrs[k]));
      if (txt != null) e.textContent = txt;
      return e;
    };

    svgEl.setAttribute("viewBox", "0 0 " + W + " " + H);
    svgEl.replaceChildren();
    const g = el("g", {});
    svgEl.append(g);

    for (const t of Y_TICKS) {
      const major = !log || Math.abs(Math.log10(t) % 1) < 1e-9;
      g.append(
        el("line", {
          x1: M.l,
          x2: M.l + iw,
          y1: y(t),
          y2: y(t),
          stroke: "var(--grid)",
          "stroke-width": 1,
          opacity: major ? 1 : 0.55,
        }),
      );
      if (major)
        g.append(
          el(
            "text",
            {
              x: M.l - 8,
              y: y(t) + 3.5,
              "text-anchor": "end",
              "font-family": "var(--font-mono)",
              "font-size": 10,
              fill: "var(--ink-3)",
            },
            fmtTick(t),
          ),
        );
    }

    g.append(
      el("line", {
        x1: M.l,
        x2: M.l + iw,
        y1: M.t + ih,
        y2: M.t + ih,
        stroke: "var(--rule)",
        "stroke-width": 1,
      }),
    );
    for (const v of LINES) {
      g.append(
        el("line", {
          x1: x(v),
          x2: x(v),
          y1: M.t + ih,
          y2: M.t + ih + 4,
          stroke: "var(--rule)",
        }),
      );
      g.append(
        el(
          "text",
          {
            x: x(v),
            y: M.t + ih + 16,
            "text-anchor": "middle",
            "font-family": "var(--font-mono)",
            "font-size": 10,
            fill: "var(--ink-3)",
          },
          fmtLines(v),
        ),
      );
    }
    // The scale is named on the axis itself, not just in the note above the
    // panels: ticks one ×5 apart and ticks one ×2 apart are both equally spaced
    // here, which reads as a broken axis until you know it is log.
    g.append(
      el(
        "text",
        {
          x: M.l + iw,
          y: M.t + ih + 30,
          "text-anchor": "end",
          "font-family": "var(--font-mono)",
          "font-size": 9.5,
          "letter-spacing": "0.1em",
          fill: "var(--ink-3)",
        },
        "LINES (log₁₀)",
      ),
    );

    // End labels are collected rather than drawn in place: on the primed panel
    // the curves finish within a few tens of ms of each other, so at this scale
    // their labels would land on top of one another.
    const endLabels: {
      f: number;
      col: string;
      x: number;
      py: number;
      base: number;
      y: number;
    }[] = [];
    FILTERS.forEach((f, i) => {
      const pts = LINES.map((L) => {
        const v = valueOf(at(L, f), key);
        return v && v > 0 ? { L, v } : null;
      }).filter((p): p is { L: number; v: number } => p !== null);
      if (!pts.length) return;
      const col = colorOf(ramp, i);
      const d = pts
        .map(
          (p, k) =>
            (k ? "L" : "M") + x(p.L).toFixed(1) + "," + y(p.v).toFixed(1),
        )
        .join("");
      g.append(
        el("path", {
          d,
          fill: "none",
          stroke: col,
          "stroke-width": 1.75,
          "stroke-linejoin": "round",
        }),
      );
      for (const p of pts)
        g.append(el("circle", { cx: x(p.L), cy: y(p.v), r: 2.6, fill: col }));
      const last = pts[pts.length - 1];
      const base = y(last.v) + 3.5; // optically centred baseline
      endLabels.push({ f, col, x: x(last.L), py: y(last.v), base, y: base });
    });

    const GAP = 12;
    endLabels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < endLabels.length; i++)
      endLabels[i].y = Math.max(endLabels[i].y, endLabels[i - 1].y + GAP);
    const overhang = endLabels.length
      ? endLabels[endLabels.length - 1].y - (M.t + ih)
      : 0;
    if (overhang > 0) for (const l of endLabels) l.y -= overhang;
    for (const l of endLabels) {
      // A nudged label gets a leader back to its point, so it still says which
      // curve it belongs to.
      if (Math.abs(l.y - l.base) > 1.5)
        g.append(
          el("path", {
            d:
              "M" +
              (l.x + 3.5) +
              "," +
              l.py +
              "L" +
              (l.x + 6.5) +
              "," +
              (l.y - 3.5),
            stroke: l.col,
            "stroke-width": 1,
            fill: "none",
            opacity: 0.55,
          }),
        );
      g.append(
        el(
          "text",
          {
            x: l.x + 8,
            y: l.y,
            "font-family": "var(--font-mono)",
            "font-size": 10.5,
            "font-weight": 600,
            fill: l.col,
          },
          String(l.f),
        ),
      );
    }

    // Hover reads out the whole column at once: comparing filter counts at one
    // file size is the question, and per-point tooltips answer it one at a time.
    const bandW = LINES.length > 1 ? iw / (LINES.length - 1) : iw;
    for (const L of LINES) {
      const guide = el("line", {
        x1: x(L),
        x2: x(L),
        y1: M.t,
        y2: M.t + ih,
        stroke: "var(--ink-3)",
        "stroke-width": 1,
        opacity: 0,
      });
      const rect = el("rect", {
        x: x(L) - bandW / 2,
        y: M.t,
        width: bandW,
        height: ih,
        fill: "transparent",
        style: "cursor:crosshair",
      });
      rect.addEventListener("pointerenter", () => {
        guide.setAttribute("opacity", "0.35");
        const parts = FILTERS.map((f) => {
          const v = valueOf(at(L, f), key);
          return v ? f + "f <b>" + fmtMs(v) + "</b>" : null;
        }).filter(Boolean);
        readoutEl.innerHTML =
          '<span class="dim">' +
          L.toLocaleString() +
          " lines · </span>" +
          parts.join('<span class="dim"> · </span>');
      });
      rect.addEventListener("pointerleave", () => {
        guide.setAttribute("opacity", "0");
        readoutEl.innerHTML = "&nbsp;";
      });
      g.append(guide, rect);
    }
  }

  function legend(elId: string, ramp: string[]) {
    const wrap = document.getElementById(elId)!;
    wrap.replaceChildren();
    FILTERS.forEach((f, i) => {
      const item = document.createElement("span");
      item.className = "ramp";
      const bar = document.createElement("i");
      bar.style.background = colorOf(ramp, i);
      const t = document.createElement("span");
      t.textContent = String(f);
      item.append(bar, t);
      wrap.append(item);
    });
  }

  function table() {
    const t = document.getElementById("table")!;
    const thead = document.createElement("thead");
    thead.innerHTML =
      '<tr><th style="text-align:left">lines</th><th style="text-align:left">filters</th>' +
      "<th>distinct</th><th>JS only</th><th>Rust primed</th><th>gain</th>" +
      "<th>js scan</th><th>rust scan</th><th>compose</th></tr>";
    const tb = document.createElement("tbody");
    for (const L of LINES)
      FILTERS.forEach((f, i) => {
        const d = at(L, f);
        if (!d) return;
        const tr = document.createElement("tr");
        if (i === 0) tr.className = "grouptop";
        const gain = d.primedTotal ? d.jsTotal / d.primedTotal : null;
        const gcls = gain === null ? "" : gain >= 1 ? "gain-up" : "gain-down";
        tr.innerHTML =
          "<th>" +
          (i === 0 ? L.toLocaleString() : "") +
          "</th>" +
          '<td style="text-align:left">' +
          f +
          "</td>" +
          "<td>" +
          d.distinctPatterns +
          "</td>" +
          "<td>" +
          fmtCell(d.jsTotal) +
          "</td>" +
          "<td>" +
          (d.primedTotal ? fmtCell(d.primedTotal) : "—") +
          "</td>" +
          '<td class="' +
          gcls +
          '">' +
          (gain ? gain.toFixed(2) + "×" : "—") +
          "</td>" +
          "<td>" +
          fmtCell(d.scan) +
          "</td>" +
          "<td>" +
          (d.rustScan !== null ? fmtCell(d.rustScan) : "—") +
          "</td>" +
          "<td>" +
          fmtCell(d.compose) +
          "</td>";
        tb.append(tr);
      });
    t.append(thead, tb);
  }

  // --- the masthead numbers, derived rather than typed -----------------------

  const biggest = at(LINES[LINES.length - 1], FILTERS[FILTERS.length - 1])!;

  document.getElementById("eyebrow")!.textContent =
    "Logsy · profile sweep · " + DATA.length + " cells";

  document.getElementById("runmeta")!.innerHTML = [
    "<b>grid</b> " +
      LINES.length +
      "×" +
      FILTERS.length +
      " = " +
      DATA.length +
      " cells",
    "<b>lines</b> " + LINES.map(fmtLines).join(" · "),
    "<b>filters</b> " + FILTERS.join(" · "),
    "<b>largest</b> " +
      biggest.lines.toLocaleString() +
      " lines / " +
      (biggest.bytes / 1e6).toFixed(0) +
      " MB",
    "<b>runtime</b> " + META.runtime,
    "<b>seed</b> " + META.seed,
    "<b>swept</b> " + META.generated,
  ].join("");

  document.getElementById("foot")!.innerHTML =
    "<div><code>" +
    META.command +
    "</code></div>" +
    "<div>Every cell is its own process (the match cache, the JIT's state and the " +
    "generated log are all per-process; sharing any of them would let a later cell " +
    "measure a warmer machine). Times are medians; cold benchmarks get 3 runs each, " +
    "the rest " +
    META.runs +
    ", all after warmup. Rust runs through the release crosscheck binary — the " +
    "JSON-over-stdin round trip is harness cost and is not counted. " +
    (META.minutes === null
      ? ""
      : "The whole sweep took " + META.minutes.toFixed(1) + " minutes.") +
    "</div>" +
    (NOTES.length
      ? "<div><b>Caveats the profiler raised for this grid</b> (the <code>distinct</code> " +
        "column is the number of patterns actually scanned, which need not equal " +
        "<code>filters</code>):<ul>" +
        NOTES.map((n) => "<li>" + n + "</li>").join("") +
        "</ul></div>"
      : "");

  // --- go -------------------------------------------------------------------

  const svgJs = document.getElementById("svg-js") as unknown as SVGSVGElement;
  const svgRs = document.getElementById("svg-rs") as unknown as SVGSVGElement;
  const roJs = document.getElementById("ro-js")!;
  const roRs = document.getElementById("ro-rs")!;
  const note = document.getElementById("axisnote")!;

  const render = () => {
    draw(svgJs, "jsTotal", JS_RAMP, roJs);
    draw(svgRs, "primedTotal", RS_RAMP, roRs);
    note.textContent =
      SCALE === "log"
        ? "x log₁₀ · y log₁₀ · both panels share one y axis · equal distance = equal ratio, so the slope is the exponent"
        : "x log₁₀ · y linear 0–" +
          fmtMs(LIN_TOP) +
          " · both panels share one y axis · " +
          LIN_BURIED +
          " of " +
          allY.length +
          " points fall inside the bottom pixel — which is exactly why log is the default";
  };

  document.getElementById("scale")!.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
      "button[data-scale]",
    );
    if (!btn || btn.dataset.scale === SCALE) return;
    SCALE = btn.dataset.scale as "log" | "linear";
    for (const b of (e.currentTarget as HTMLElement).querySelectorAll("button"))
      b.setAttribute("aria-pressed", String(b.dataset.scale === SCALE));
    render();
  });

  render();
  legend("legend-js", JS_RAMP);
  legend("legend-rs", RS_RAMP);
  table();
  window.addEventListener("resize", render);
}

// --- assembling the file -----------------------------------------------------

/**
 * JSON destined for a `<script>` body. `<` is escaped because a `</script>` in
 * any string would end the block early — the notes are the profiler's own text
 * today, but a value that can close the tag is a hole regardless of who writes it.
 */
const embed = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c");

function renderReport(cells: Cell[], meta: Meta): string {
  // Deduped, in the order the sweep produced them: the same caveat fires on
  // every cell with that shape, and one copy is the useful number of copies.
  const notes = [...new Set(cells.flatMap((c) => c.notes))];
  return [
    "<title>Logsy — cold open cost: JS only vs Rust primed</title>",
    "<style>" + CSS + "</style>",
    BODY,
    "<script>(" +
      reportScript.toString() +
      ")(" +
      [embed(cells), embed(notes), embed(meta), "0"].join(", ") +
      ");</script>",
  ].join("\n");
}

// --- run ---------------------------------------------------------------------

const command =
  "bun run scripts/sweep.ts --lines " +
  opts.lines.join(",") +
  " --filters " +
  opts.filters.join(",") +
  " --runs " +
  opts.runs +
  " --seed " +
  opts.seed;

let cells: Cell[];
let minutes: number | null = null;
/**
 * Carried over on `--from-json`, because the flags in play now are not the ones
 * the data was measured under — re-rendering last week's sweep must not relabel
 * it with today's `--runs`.
 */
let inherited: Meta | null = null;

if (opts.fromJson) {
  const parsed = JSON.parse(readFileSync(resolve(opts.fromJson), "utf8")) as
    | SweepFile
    | Cell[];
  // Accept a bare array too: that is what an interrupted early version wrote,
  // and what anyone hand-assembling a grid is most likely to produce.
  cells = Array.isArray(parsed) ? parsed : parsed.cells;
  // Whole-meta inheritance already carries the original duration; a bare array
  // has none, and `minutes` is correctly left null there.
  inherited = Array.isArray(parsed) ? null : parsed.meta;
  if (!cells?.length) throw new Error(`${opts.fromJson} holds no cells.`);
  if (!opts.quiet)
    console.log(
      chalk.dim(`re-rendering ${cells.length} cells from ${opts.fromJson}`),
    );
} else {
  if (!opts.quiet)
    console.log(
      chalk.bold("Logsy sweep") +
        chalk.dim(
          ` — ${opts.lines.length} × ${opts.filters.length} = ` +
            `${opts.lines.length * opts.filters.length} cells, ` +
            `${opts.runs} runs each (seed ${opts.seed})\n`,
        ),
    );
  const swept = measure();
  cells = swept.cells;
  minutes = swept.minutes;
}

const meta: Meta = inherited ?? {
  runs: opts.runs,
  seed: opts.seed,
  // JSC, not the V8 the app actually runs on — the absolute numbers are Bun's.
  runtime: `Bun ${process.versions.bun ?? "?"} / JSC`,
  generated: new Date().toISOString().slice(0, 10),
  command,
  minutes,
};

mkdirSync(dirname(OUT_HTML), { recursive: true });
writeFileSync(OUT_HTML, renderReport(cells, meta));
if (!opts.fromJson)
  writeFileSync(
    OUT_JSON,
    JSON.stringify({ meta, cells } satisfies SweepFile, null, 2),
  );

if (!opts.quiet) {
  console.log(
    "\n" +
      chalk.bold("report  ") +
      OUT_HTML +
      chalk.dim(`\n${chalk.bold("data    ")}${OUT_JSON}`) +
      chalk.dim(
        "\n\nre-render without measuring again:" +
          `\n  bun run scripts/sweep.ts --from-json ${OUT_JSON} --out ${opts.out}`,
      ),
  );
}
