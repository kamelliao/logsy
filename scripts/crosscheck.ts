#!/usr/bin/env bun
// Verifies that the Rust match scanner (src-tauri/src/scan.rs) agrees with real JS
// `RegExp` semantics, bit for bit.
//
// Why this exists: opening a log primes the JS match cache with bit sets computed in
// Rust (see docs/perf-large-file-open.md). If the two engines ever disagree about
// which lines a pattern matches, the symptom is silently wrong highlight colours —
// no error, no crash, and the runtime spot-check in scanPrime.ts only downgrades
// quietly on the user's machine. `scan.rs`'s pattern translation (ASCII vs Unicode
// mode) is the part most likely to drift, so it needs a test that fails loudly here.
//
//   bun run scripts/crosscheck.ts                  # default: 8 seeds, ~2k lines each
//   bun run scripts/crosscheck.ts --seeds=40       # more randomised rounds
//   bun run scripts/crosscheck.ts --lines=20000    # bigger logs per round
//   bun run scripts/crosscheck.ts --quiet          # only report failures
//
// Exits non-zero on any disagreement, so it can gate a release.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// The app's own splitter, not a copy of it — a copy that drifted would make this
// whole comparison agree with the wrong thing.
import { splitLines } from "../src/lib/lines.ts";

const args = process.argv.slice(2);
const flag = (name: string, def: number): number => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  const v = hit ? Number(hit.split("=")[1]) : NaN;
  return Number.isFinite(v) ? v : def;
};
const SEEDS = flag("seeds", 8);
const LINES = flag("lines", 2000);
const QUIET = args.includes("--quiet");

// --- build + drive the Rust half -------------------------------------------

const TAURI = join(import.meta.dir, "..", "src-tauri");
// A cargo *example*, not a bin: bin targets get picked up by the Tauri bundler.
const EXE = join(
  TAURI,
  "target",
  "release",
  "examples",
  process.platform === "win32" ? "crosscheck.exe" : "crosscheck",
);

function buildRustHelper(): void {
  process.stdout.write("building crosscheck helper… ");
  const r = spawnSync(
    "cargo",
    ["build", "--release", "--example", "crosscheck"],
    { cwd: TAURI, stdio: QUIET ? "pipe" : ["ignore", "pipe", "inherit"] },
  );
  if (r.status !== 0) {
    console.error("\ncargo build failed");
    process.exit(1);
  }
  if (!existsSync(EXE)) {
    console.error(`\nbuilt, but no binary at ${EXE}`);
    process.exit(1);
  }
  console.log("ok\n");
}

interface Spec {
  source: string;
  ci: boolean;
}
interface Scan {
  nLines: number;
  fallback: Set<number>;
  counts: number[];
  bits: Uint8Array[];
}

/** Run the Rust scanner and decode its blob. Layout mirrors `scan_text`. */
function rustScan(text: string, patterns: Spec[]): Scan {
  const r = spawnSync(EXE, {
    input: JSON.stringify({ text, patterns }),
    maxBuffer: 1 << 28,
  });
  if (r.status !== 0)
    throw new Error("crosscheck helper failed: " + r.stderr?.toString());
  const b = r.stdout;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const nLines = dv.getUint32(0, true);
  const nPat = dv.getUint32(4, true);
  const bytesLen = dv.getUint32(8, true);
  const nFb = dv.getUint32(12, true);
  let off = 28; // header, incl. the three timing fields
  const fallback = new Set<number>();
  for (let k = 0; k < nFb; k++, off += 4) fallback.add(dv.getUint32(off, true));
  const counts: number[] = [];
  for (let k = 0; k < nPat; k++, off += 4) counts.push(dv.getUint32(off, true));
  const bits: Uint8Array[] = [];
  for (let k = 0; k < nPat; k++)
    bits.push(
      new Uint8Array(b.buffer, b.byteOffset + off + k * bytesLen, bytesLen),
    );
  return { nLines, fallback, counts, bits };
}

// --- comparison -------------------------------------------------------------

let failures = 0;
let bitsChecked = 0;
let primed = 0;
let fellBack = 0;

function compare(label: string, text: string, patterns: Spec[]): void {
  const lines = splitLines(text);
  const got = rustScan(text, patterns);
  // A line-count disagreement shifts every bit index, so report it on its own.
  if (got.nLines !== lines.length) {
    console.error(
      `✗ ${label}: line count differs — rust ${got.nLines}, js ${lines.length}`,
    );
    failures++;
    return;
  }
  for (let k = 0; k < patterns.length; k++) {
    const p = patterns[k];
    if (got.fallback.has(k)) {
      fellBack++;
      continue; // JS will scan it — nothing to agree about
    }
    primed++;
    const re = new RegExp(p.source, p.ci ? "gi" : "g");
    let jsCount = 0;
    let mismatches = 0;
    let firstBad = -1;
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      const js = re.test(lines[i]);
      if (js) jsCount++;
      const rust = ((got.bits[k][i >> 3] >> (i & 7)) & 1) === 1;
      bitsChecked++;
      if (js !== rust && mismatches++ === 0) firstBad = i;
    }
    if (mismatches) {
      console.error(
        `✗ ${label}  /${p.source}/${p.ci ? "gi" : "g"}\n` +
          `  ${mismatches} line(s) disagree; first at #${firstBad}: ${JSON.stringify(lines[firstBad])}\n` +
          `  js says ${re.test(lines[firstBad])}, rust says ${!re.test(lines[firstBad])}`,
      );
      failures++;
    } else if (jsCount !== got.counts[k]) {
      console.error(
        `✗ ${label}  /${p.source}/: bits agree but count differs — rust ${got.counts[k]}, js ${jsCount}`,
      );
      failures++;
    }
  }
}

/** Patterns Rust must refuse rather than guess at. */
function expectFallback(label: string, text: string, patterns: Spec[]): void {
  const got = rustScan(text, patterns);
  const scanned = patterns
    .map((p, k) => (got.fallback.has(k) ? null : p.source))
    .filter(Boolean);
  if (scanned.length) {
    console.error(
      `✗ ${label}: expected fallback but Rust scanned: ${scanned.join(", ")}`,
    );
    failures++;
  } else if (!QUIET) {
    console.log(`✓ ${label} — ${patterns.length} unsupported patterns refused`);
  }
}

// --- case generation --------------------------------------------------------

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

const TAGS = [
  "wifi",
  "ble",
  "pmu",
  "sensor",
  "ota",
  "fs",
  "rtc",
  "uart",
  "cpu",
];
const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"];

/**
 * A synthetic log seeded to include the things that break naive implementations:
 * mixed CRLF/LF, blank lines, trailing whitespace, non-ASCII and full-width digits.
 */
function genLog(n: number, seed: number): string {
  const r = rng(seed);
  const pick = <T>(a: T[]): T => a[(r() * a.length) | 0];
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const eol = r() < 0.15 ? "\r\n" : "\n";
    const extra =
      r() < 0.08
        ? " 溫度 ３７°C"
        : r() < 0.08
          ? "   " // trailing whitespace
          : r() < 0.05
            ? " naïve café résumé"
            : "";
    parts.push(
      `${String(i).padStart(6, "0")} [${pick(LEVELS)}] ${pick(TAGS)}: ` +
        `value=${(r() * 9999) | 0} addr=0x${((r() * 0xffffff) | 0).toString(16)}${extra}${eol}`,
    );
    if (r() < 0.04) parts.push(eol); // blank line
  }
  return parts.join("");
}

/** Pattern fragments combined into randomised patterns per seed. */
const FRAGMENTS = [
  String.raw`ERROR`,
  String.raw`\d+`,
  String.raw`\w+`,
  String.raw`\s`,
  String.raw`[A-Z]{3,}`,
  String.raw`0x[0-9a-f]+`,
  String.raw`value=\d+`,
  String.raw`^\d{6}`,
  String.raw`\bwifi\b`,
  String.raw`(?:pmu|ble|ota)`,
  String.raw`sensor|uart`,
  String.raw`.`,
  String.raw`.*`,
  String.raw`[^a]`,
  String.raw`\s+$`,
  String.raw`^$`,
  String.raw`溫度`,
  String.raw`３７`,
  String.raw`café`,
  String.raw`(?<n>\d+)`, // named group — must not prevent scanning
  String.raw`(?<lvl>[A-Z]+)\]`,
];

function genPatterns(seed: number, count: number): Spec[] {
  const r = rng(seed * 7919 + 13);
  const out: Spec[] = [];
  for (let i = 0; i < count; i++) {
    const a = FRAGMENTS[(r() * FRAGMENTS.length) | 0];
    // Half plain, half a two-fragment combination — combinations are where the
    // ASCII/Unicode mode choice in rust_source has to make a real decision.
    const src = r() < 0.5 ? a : a + FRAGMENTS[(r() * FRAGMENTS.length) | 0];
    try {
      new RegExp(src); // skip anything JS itself rejects
      out.push({ source: src, ci: r() < 0.5 });
    } catch {
      /* not a usable pattern on either side */
    }
  }
  return out;
}

// --- run --------------------------------------------------------------------

buildRustHelper();

for (let seed = 1; seed <= SEEDS; seed++) {
  const text = genLog(LINES, seed);
  const pats = genPatterns(seed, 20);
  compare(
    `seed ${seed} (${LINES} lines × ${pats.length} patterns)`,
    text,
    pats,
  );
}

// Boundary cases: line splitting is the one disagreement that would shift every
// bit at once, so each newline shape is pinned explicitly.
compare("empty file", "", [{ source: "x", ci: false }]);
compare("only newlines", "\n\n\n", [
  { source: "^$", ci: false },
  { source: ".", ci: false },
]);
compare("no trailing newline", "a\nb", [{ source: "b", ci: false }]);
compare("lone CR", "a\rb\rc\r", [{ source: "^[abc]$", ci: false }]);
compare("CRLF mixed with LF", "a\r\nb\nc\r\n", [
  { source: "^\\w$", ci: false },
]);
compare("multi-byte", "日本語ログ\n한국어\nemoji 🚀 here\n", [
  { source: "ログ", ci: false },
  { source: "🚀", ci: false },
  { source: ".", ci: false },
  { source: "^.{3}$", ci: false },
]);
compare("case folding", "Straße\nSTRASSE\nİstanbul\nistanbul\nÉCOLE\nécole\n", [
  { source: "strasse", ci: true },
  { source: "istanbul", ci: true },
  { source: "école", ci: true },
  { source: "ÉCOLE", ci: true },
]);
compare("ASCII class semantics", "ID ３７\nID 37\nname_1\n名前\ntab\there\n", [
  { source: "\\d+", ci: false },
  { source: "\\w+", ci: false },
  { source: "\\s", ci: false },
  { source: "\\bID\\b", ci: false },
]);
// The escapes `rewrite_js_classes` spells out, on the characters where a plausible
// translation drifts. `\s` is the one that bites hardest: JS's set is
// WhiteSpace ∪ LineTerminator, so it contains U+00A0/U+3000 (which ASCII `\s` misses)
// AND U+FEFF (which Rust's Unicode `\s` = \p{White_Space} misses). Every pattern here
// mixes an ASCII escape with a `.` or a negated class, which is exactly the
// combination that used to be handed back to JS.
compare(
  "rewritten ASCII classes",
  "err 42ms\n\u{a0}err 1\n\u{feff}err 2\n\u{3000}err 3\n\u{2028}err 4\n" +
    "３ms\nérr err 5\n名前 err 6\ntab\terr 0\nname_1.err\n",
  [
    { source: "\\d+.*ms", ci: false },
    { source: ".*err.*\\d+", ci: true },
    { source: "\\w+.*err", ci: false },
    { source: "[\\w\\s]+err", ci: false },
    { source: "\\s+err.*\\d", ci: true },
    { source: "\\S+.*err", ci: false },
    { source: "\\Dx|\\W+.*err", ci: false },
    { source: "[^\\d]+err", ci: false },
  ],
);
// More lines than SCAN_CHUNK (8192), so the per-chunk bit sets must merge at the
// right byte offsets.
compare(
  "spanning chunks",
  Array.from({ length: 8192 * 2 + 37 }, (_, i) =>
    i % 5 === 0 ? "hit" : "miss",
  ).join("\n") + "\n",
  [
    { source: "hit", ci: false },
    { source: "^miss$", ci: true },
  ],
);

// Lookahead CONJUNCTIONS are scanned now — decomposed into their branches on the Rust
// side — so they belong in the agreement check rather than the refusal list. The AND
// rewrite is exact only for this shape, which is why the near-misses sit beside it.
compare(
  "lookahead conjunctions",
  "wifi is down\nwifi is up\nbt is down\nneither here\nwifi down wifi\n",
  [
    { source: "(?=.*wifi)(?=.*down)", ci: true },
    { source: "(?=.*wifi)(?=.*down)(?=.*is)", ci: true },
    { source: "(?=.*wifi)(?=.*down).*", ci: true },
    { source: "(?=.*(wifi|bt))(?=.*down)", ci: true },
    { source: "(?=.*?wifi)(?=.*down)", ci: true },
  ],
);

// The protection has to be shown to fire, not merely to exist: if these ever get
// scanned instead of refused, the guarantee above is worthless.
expectFallback("unsupported syntax", "foobar\nxy\naa\nword here\n", [
  { source: "foo(?=bar)", ci: false }, // lookahead
  { source: "(?<=x)y", ci: false }, // lookbehind
  { source: "(a)\\1", ci: false }, // backreference
  // `\b` is the one ASCII escape with no Unicode-mode spelling: `\w`/`\d`/`\s` are
  // rewritten into explicit classes, but an ASCII word boundary can't be. It is also
  // the cheapest of them to leave with JS (~4ms over 92k lines, against ~14s for the
  // `\w+.*` it used to drag down with it).
  { source: "\\bfoo\\b.*", ci: false },
  { source: "\\p{L}.*", ci: false }, // JS reads a literal `p`; Rust reads a class
  { source: "[a[b].*", ci: false }, // JS: literal `[`. Rust: a nested class
  { source: "[a&&b].*", ci: false }, // JS: literal `&`. Rust: intersection
  // Shapes the conjunction rewrite must NOT take: each would give a different answer.
  { source: "(?=.*a|b)(?=.*c|d)", ci: false }, // top-level `|` escapes the `.*`
  { source: "^(?=.*a)(?=.*b)", ci: false }, // anchored: position 0 is no longer free
  { source: "(?=.*a)(?=.*b)tail", ci: false }, // a consuming tail
]);

// --- report -----------------------------------------------------------------

console.log(
  `\ncompared ${bitsChecked.toLocaleString()} (line × pattern) bits · ` +
    `${primed} patterns scanned by Rust, ${fellBack} left to JS`,
);
if (failures) {
  console.error(`✗ ${failures} disagreement(s)`);
  process.exit(1);
}
console.log("✓ Rust and JS agree everywhere");
