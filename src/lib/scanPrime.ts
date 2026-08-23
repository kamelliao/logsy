// Bridge to the Rust `scan_lines` command: run a file's filters through one
// RegexSet pass on worker threads and prime the JS match cache with the packed bit
// sets, so the first `computeView` over that file never does the cold
// O(lines × filters) scan. That scan is the single dominant cost of opening a large
// log (measured ~1.3 s for 200k lines × 100 filters, against ~21 ms in Rust).
//
// Every failure path here is a downgrade, never an error: a missing Tauri shell, a
// line-count disagreement, an unsupported pattern or a failed spot-check just
// leaves those bit sets uncomputed and `computeView` scans them itself.
import { invoke } from "@tauri-apps/api/core";
import {
  cacheKey,
  cachedMatchBits,
  compileAll,
  hasMatchBits,
  primeMatchCache,
} from "@/lib/engine";
import { yieldToEventLoop } from "@/lib/paint";
import type { CompiledFilter, Filter } from "@/types";

export interface ScanSpec {
  /** `RegExp.source` verbatim — the cache key both sides must agree on. */
  source: string;
  /** Whether the regex carries the `i` flag. */
  ci: boolean;
}

/**
 * A pattern whose bits are ASSEMBLED from other patterns' bits rather than scanned.
 *
 * Only one shape qualifies today: a conjunction of lookaheads, `(?=.*A)(?=.*B)…` —
 * how users spell "this line contains all of these". Rust's engine can never take a
 * lookahead, and a backtracking JS engine is at its worst on exactly this shape
 * (1779 ms for ONE such filter over 92k × 180-char lines), so it was the last
 * expensive thing left on the JS scanner.
 *
 * The rewrite is exact, not an approximation. For an unanchored boolean test,
 * `(?=.*B₁)…(?=.*Bₙ)` matches iff there is SOME start p at which every `.*Bᵢ`
 * matches — and p = 0 is the weakest such position, so it succeeds iff every Bᵢ
 * occurs anywhere in the line. That is the AND of the branches' bit sets.
 */
export interface Composition {
  /** The pattern the user wrote — the cache key the assembled bits are stored under. */
  source: string;
  flags: string;
  /** The branch patterns, each scanned as an ordinary spec. */
  parts: { source: string; flags: string }[];
}

export interface ScanPlan {
  specs: ScanSpec[];
  /** Patterns to assemble from `specs` once those are primed. */
  compositions: Composition[];
  /**
   * Cache keys that exist ONLY to feed a composition. They are never looked up by
   * `computeView`, so they must not enter the shared per-file match cache — its LRU
   * holds 300 entries, and a set with many conjunctions would evict the bit sets of
   * real filters (which the JS pass would then re-scan, evicting more).
   */
  branchOnly: Set<string>;
}

/**
 * Whether `src` has a `|` outside any group or character class.
 *
 * This is the guard the whole rewrite rests on. `(?=.*B)` is equivalent to "B occurs
 * somewhere" only because the `.*` covers ALL of B — and a top-level `|` splits it, so
 * the `.*` reaches only the first alternative. `(?=.*a|b)` means "a occurs somewhere,
 * OR b matches right here", which depends on the position the way the rest of the
 * shape deliberately does not.
 *
 * Concretely: `/(?=.*a|b)(?=.*c|d)/.test("cb")` is false, but the AND of `/a|b/` and
 * `/c|d/` over "cb" is true. That is a bit set claiming lines the filter does not
 * match — and `verify()` samples, so it would not reliably catch it.
 */
function hasTopLevelAlternation(src: string): boolean {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "|" && depth === 0) return true;
  }
  return false;
}

/**
 * Split `(?=.*A)(?=.*B)…` into its branch bodies, or null when the pattern is not
 * exactly that shape.
 *
 * Deliberately narrow: anything it accepts has to be EXACTLY equivalent as a boolean
 * test, and a rejection costs only what the pattern costs today. So it wants two or
 * more `(?=.*…)` groups, an optional `.*` tail, and nothing else — no leading anchor
 * (which would break the "take p = 0" argument), no backreference (which cannot span
 * a split), and no `^` inside a body.
 */
export function decomposeAnd(source: string): string[] | null {
  const bodies: string[] = [];
  let i = 0;
  while (source.startsWith("(?=.*", i)) {
    // Walk to the `)` that closes this group, skipping escapes and character classes
    // so a `)` written inside either doesn't end it early.
    let depth = 0;
    let j = i;
    let inClass = false;
    for (; j < source.length; j++) {
      const c = source[j];
      if (c === "\\") {
        j++;
        continue;
      }
      if (inClass) {
        if (c === "]") inClass = false;
        continue;
      }
      if (c === "[") inClass = true;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) break;
    }
    if (j >= source.length) return null; // unbalanced
    // `.*?` is the same set of matches as `.*` for a yes/no test, so take the lazy
    // form too — but only that one. Slicing a fixed `"(?=.*".length` left the `?` on
    // the front of the branch, which is not a pattern at all.
    let start = i + "(?=.*".length;
    if (source[start] === "?") start++;
    else if ("*+{".includes(source[start] ?? "")) return null;
    const body = source.slice(start, j);
    // `^` re-anchors inside the lookahead; a backreference cannot survive the split;
    // a top-level `|` breaks the whole argument (see `hasTopLevelAlternation`).
    if (
      !body.length ||
      body.includes("^") ||
      /\\[1-9]/.test(body) ||
      hasTopLevelAlternation(body)
    )
      return null;
    bodies.push(body);
    i = j + 1;
  }
  if (bodies.length < 2) return null; // not the AND idiom
  const tail = source.slice(i);
  if (tail !== "" && tail !== ".*") return null;
  return bodies;
}

/**
 * Dedupe the compiled filters into what actually has to be scanned, in filter order,
 * plus the patterns to be assembled from those afterwards.
 *
 * A conjunction of lookaheads contributes its branches to `specs` and itself to
 * `compositions`, so it is never sent to a scanner that cannot take it.
 */
// JS `.` matches anything EXCEPT a line terminator, and a line already split on
// CR/LF can still contain U+2028 or U+2029. `.*B` from position 0 cannot reach past
// one, so `(?=.*B)` stops meaning "B occurs anywhere" and the AND over-matches:
// `/(?=.*alpha)(?=.*beta)/` is FALSE on "alpha\u2028beta" while both branches are
// true. (Astral characters are fine — `.` matches each surrogate half, so containment
// still holds.) Neither `contains(B)` nor `^.*B` is exact once a separator is present,
// so the composition is simply refused for such a file. Costs 2-4 ms over 92k lines,
// once, and only when there is a composition to protect.
const separatorScan = new WeakMap<readonly string[], boolean>();

function hasLineSeparator(lines: string[]): boolean {
  const seen = separatorScan.get(lines);
  if (seen !== undefined) return seen;
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.indexOf("\u2028") >= 0 || l.indexOf("\u2029") >= 0) {
      found = true;
      break;
    }
  }
  separatorScan.set(lines, found);
  return found;
}

export function scanPlan(compiled: CompiledFilter[]): ScanPlan {
  const seen = new Set<string>();
  const specs: ScanSpec[] = [];
  const compositions: Composition[] = [];
  const composed = new Set<string>();
  // A key can be wanted both ways — `wifi` as a filter of its own and as a branch of
  // `(?=.*wifi)(?=.*down)` — so "branch only" is the difference, taken at the end.
  const asFilter = new Set<string>();
  const asBranch = new Set<string>();
  // A spec the plan needs, shared with any filter that already asked for it. Branch
  // patterns go through here too, so a branch that duplicates an ordinary filter
  // (`wifi` alongside `(?=.*wifi)(?=.*down)`) is scanned once, not twice.
  const want = (source: string, flags: string): void => {
    const key = cacheKey(source, flags);
    if (seen.has(key)) return;
    seen.add(key);
    specs.push({ source, ci: flags.includes("i") });
  };
  for (const c of compiled) {
    if (!c.re || c.empty || !c.ok) continue;
    const { source, flags } = c.re;
    const bodies = decomposeAnd(source);
    if (bodies) {
      // The pattern itself is never sent to Rust — its branches are, and its bits are
      // assembled from theirs afterwards.
      for (const b of bodies) {
        want(b, flags);
        asBranch.add(cacheKey(b, flags));
      }
      if (!composed.has(cacheKey(source, flags))) {
        composed.add(cacheKey(source, flags));
        compositions.push({
          source,
          flags,
          parts: bodies.map((b) => ({ source: b, flags })),
        });
      }
      continue;
    }
    want(source, flags);
    asFilter.add(cacheKey(source, flags));
  }
  const branchOnly = new Set([...asBranch].filter((k) => !asFilter.has(k)));
  return { specs, compositions, branchOnly };
}

/** Dedupe the compiled filters into the patterns worth scanning, in filter order. */
export function scanSpecs(compiled: CompiledFilter[]): ScanSpec[] {
  return scanPlan(compiled).specs;
}

// --- which patterns Rust could not take -------------------------------------
// Keyed by the lines array, exactly like the match cache in engine.ts, so a closed
// file's record is garbage-collected with it. This is the only way to know a pattern
// is being scanned in JS: Rust reports it by INDEX in a blob that is thrown away
// immediately, and the resulting view looks identical either way — only slower.

const jsScanned = new WeakMap<readonly string[], Set<string>>();

function markJsScanned(lines: string[], specs: ScanSpec[]): void {
  if (!specs.length) return;
  let set = jsScanned.get(lines);
  if (!set) {
    set = new Set();
    jsScanned.set(lines, set);
  }
  for (const s of specs) set.add(cacheKey(s.source, s.ci ? "gi" : "g"));
}

/**
 * The ids of `filters` whose pattern was left to the JS scanner on the last scan of
 * `lines` — the ones that cost seconds where the rest cost nothing.
 *
 * A filter never scanned at all (edited since, or opened before this shipped) is not
 * reported: absence of a record means "unknown", not "fine".
 */
export function jsScannedFilters(
  lines: string[],
  filters: Filter[],
): Set<string> {
  const out = new Set<string>();
  const set = jsScanned.get(lines);
  if (!set) return out;
  for (const c of compileAll(filters))
    if (c.re && set.has(cacheKey(c.re.source, c.re.flags))) out.add(c.f.id);
  return out;
}

// How many lines to re-check per pattern with the real JS RegExp. Rust's engine is
// not JS's: `unicode(false)` aligns \d/\w, and unsupported syntax is reported as a
// fallback, but the guarantee we actually want is empirical. Spot-checking is cheap
// (~1 ms for 100 patterns) and turns any residual disagreement into a silent
// downgrade instead of a wrong highlight colour.
const SPREAD_SAMPLES = 48;
const HIT_SAMPLES = 16;

/**
 * Whether `bits` agrees with what `re` actually matches, on a sample of `lines`.
 *
 * Exported only so `scripts/profile.ts` can time the real thing: verification is part
 * of what the Rust-primed open path costs, and a profiler that measured a re-typed
 * copy of this loop would be quoting a number the product never pays.
 */
export function verify(lines: string[], re: RegExp, bits: Uint8Array): boolean {
  const n = lines.length;
  if (!n) return true;
  const agrees = (i: number): boolean => {
    re.lastIndex = 0;
    return re.test(lines[i]) === (((bits[i >> 3] >> (i & 7)) & 1) === 1);
  };
  // Spread over the whole file: catches a wholesale offset (a line-splitting
  // disagreement) and any pattern that over-matches.
  const step = Math.max(1, Math.floor(n / SPREAD_SAMPLES));
  for (let i = 0; i < n; i += step) if (!agrees(i)) return false;
  // Then the first lines Rust claims as hits: an all-zero bit set would sail
  // through the spread check on a low-match pattern, but not through this.
  let seen = 0;
  for (let b = 0; b < bits.length && seen < HIT_SAMPLES; b++) {
    if (!bits[b]) continue;
    for (let k = 0; k < 8 && seen < HIT_SAMPLES; k++) {
      if (!(bits[b] & (1 << k))) continue;
      const i = (b << 3) + k;
      if (i >= n) break;
      if (!agrees(i)) return false;
      seen++;
    }
  }
  return true;
}

// Set bits per byte value, for counting an assembled bit set without a loop per bit.
const POPCOUNT = new Uint8Array(256);
for (let i = 1; i < 256; i++) POPCOUNT[i] = POPCOUNT[i >> 1] + (i & 1);

export interface PrimeResult {
  /** Patterns whose bit sets are now cached. */
  primed: number;
  /** Of those, how many were ASSEMBLED from branch bit sets rather than scanned. */
  composed: number;
  /** Patterns Rust reported it could not scan (unsupported syntax). */
  fallback: number;
  /** Patterns whose bit sets failed the spot-check and were dropped. */
  rejected: number;
  /** Rust: reading + decoding the file, in ms. */
  readMs: number;
  /** Rust: splitting into lines, in ms. */
  splitMs: number;
  /** Rust: the RegexSet scan, in ms. */
  scanMs: number;
}

/** Header size in bytes — must match `scan_text`'s in `src-tauri/src/scan.rs`. */
const HEADER = 28;

/**
 * Scan `path` for `specs` and prime the match cache for `lines`.
 *
 * `lines` must be the array `computeView` will run on (the cache is keyed by array
 * identity) and `encoding` must be what `read_text_file` was given, so Rust decodes
 * and splits identically. Returns null when nothing could be primed — the caller
 * carries on and lets the JS engine scan.
 */
export async function scanAndPrime(
  path: string,
  encoding: string | undefined,
  lines: string[],
  plan: ScanPlan,
): Promise<PrimeResult | null> {
  const { specs, compositions, branchOnly } = plan;
  if (!specs.length)
    return {
      primed: 0,
      composed: 0,
      fallback: 0,
      rejected: 0,
      readMs: 0,
      splitMs: 0,
      scanMs: 0,
    };
  // Every bail-out below leaves the WHOLE batch to `computeView`, so record that
  // before returning: a caller that only sees `null` cannot tell which patterns are
  // now going to cost it seconds.
  const allToJs = () => {
    // The branches AND the conjunctions they stand for: `specs` holds only the former,
    // but the key `computeView` looks a conjunction up by is the latter. Marking only
    // `specs` gave every ordinary filter the badge and none of the expensive ones —
    // in exactly the case (no shell, line-count mismatch) where everything is JS-scanned.
    markJsScanned(lines, [
      ...specs,
      ...compositions.map((c) => ({
        source: c.source,
        ci: c.flags.includes("i"),
      })),
    ]);
    return null;
  };
  let buf: ArrayBuffer;
  try {
    const res = await invoke<ArrayBuffer>("scan_lines", {
      path,
      encoding,
      patterns: specs,
    });
    // Not running under the real shell (e2e mock, browser dev) → nothing to use.
    if (!(res instanceof ArrayBuffer) || res.byteLength < HEADER)
      return allToJs();
    buf = res;
  } catch {
    return allToJs();
  }

  const dv = new DataView(buf);
  const nLines = dv.getUint32(0, true);
  const nPat = dv.getUint32(4, true);
  const bytesLen = dv.getUint32(8, true);
  const nFallback = dv.getUint32(12, true);
  const readMs = dv.getUint32(16, true) / 1000;
  const splitMs = dv.getUint32(20, true) / 1000;
  const scanMs = dv.getUint32(24, true) / 1000;
  // The file changed under us, or the two sides disagree on line splitting: every
  // bit index would be shifted, so discard the whole batch.
  if (nLines !== lines.length || nPat !== specs.length) return allToJs();

  let off = HEADER;
  const fb = new Set<number>();
  for (let k = 0; k < nFallback; k++, off += 4) fb.add(dv.getUint32(off, true));
  const counts: number[] = new Array(nPat);
  for (let k = 0; k < nPat; k++, off += 4) counts[k] = dv.getUint32(off, true);
  if (off + nPat * bytesLen > buf.byteLength) return allToJs();

  const u8 = new Uint8Array(buf);
  const entries: {
    source: string;
    flags: string;
    bits: Uint8Array;
    count: number;
  }[] = [];
  let rejected = 0;
  // Fallbacks and spot-check rejections both end up on the same slow path, so they
  // are recorded together — the badge means "JS scans this", not "Rust said no".
  const toJs: ScanSpec[] = [];
  for (let k = 0; k < nPat; k++) {
    if (fb.has(k)) {
      toJs.push(specs[k]);
      continue;
    }
    const flags = specs[k].ci ? "gi" : "g";
    // `slice` (not subarray): the entry outlives `buf`, and a view would pin the
    // whole multi-megabyte blob in memory for as long as the file stays open.
    const bits = u8.slice(off + k * bytesLen, off + (k + 1) * bytesLen);
    let re: RegExp;
    try {
      re = new RegExp(specs[k].source, flags);
    } catch {
      rejected++;
      toJs.push(specs[k]);
      continue;
    }
    if (!verify(lines, re, bits)) {
      rejected++;
      toJs.push(specs[k]);
      continue;
    }
    entries.push({ source: specs[k].source, flags, bits, count: counts[k] });
  }
  // Branch bit sets are read once, right below, and then never again — keeping them
  // out of the shared cache is what stops a conjunction-heavy set from evicting the
  // filters the view actually reads.
  const branchBits = new Map<string, { bits: Uint8Array; count: number }>();
  const toPrime = entries.filter((e) => {
    const key = cacheKey(e.source, e.flags);
    if (!branchOnly.has(key)) return true;
    branchBits.set(key, { bits: e.bits, count: e.count });
    return false;
  });
  primeMatchCache(lines, toPrime);

  // Assemble the composed patterns from the branches just primed (or already cached).
  // A branch that fell back leaves its conjunction unassembled — `computeView` then
  // scans the pattern the user wrote, exactly as it did before.
  let composed = 0;
  // One separator anywhere in the file invalidates every conjunction in it (see
  // `hasLineSeparator`), so the check is hoisted out of the loop.
  const unsound = compositions.length > 0 && hasLineSeparator(lines);
  for (const comp of compositions) {
    const spec = { source: comp.source, ci: comp.flags.includes("i") };
    if (unsound) {
      toJs.push(spec);
      continue;
    }
    const parts = comp.parts.map(
      (p) =>
        branchBits.get(cacheKey(p.source, p.flags)) ??
        cachedMatchBits(lines, p.source, p.flags),
    );
    if (parts.some((b) => !b)) {
      toJs.push(spec);
      continue;
    }
    const bits = parts[0]!.bits.slice();
    for (let k = 1; k < parts.length; k++) {
      const b = parts[k]!.bits;
      for (let i = 0; i < bits.length; i++) bits[i] &= b[i];
    }
    let count = 0;
    for (let i = 0; i < bits.length; i++) count += POPCOUNT[bits[i]];
    let re: RegExp;
    try {
      re = new RegExp(comp.source, comp.flags);
    } catch {
      toJs.push(spec);
      continue;
    }
    // The same spot-check every scanned pattern gets. It is what turns the rewrite
    // from an argument into a checked claim: if the decomposition were ever wrong for
    // a shape `decomposeAnd` accepts, this downgrades instead of mis-highlighting.
    if (!verify(lines, re, bits)) {
      rejected++;
      toJs.push(spec);
      continue;
    }
    primeMatchCache(lines, [
      { source: comp.source, flags: comp.flags, bits, count },
    ]);
    composed++;
  }
  markJsScanned(lines, toJs);
  return {
    primed: toPrime.length + composed,
    composed,
    fallback: nFallback,
    rejected,
    readMs,
    splitMs,
    scanMs,
  };
}

// --- the patterns Rust could not take, scanned WITHOUT freezing the window --------

// Lines scanned between clock checks: small enough that one batch can't overshoot the
// slice budget by much, large enough that the check itself is noise.
const JS_SCAN_BATCH = 256;
// How long one uninterrupted slice may hold the main thread. Under a frame, so the
// overlay keeps painting and a click on Cancel is actually delivered.
const JS_SLICE_MS = 12;

export interface JsScanResult {
  /** Patterns scanned here — the ones Rust reported it could not take. */
  scanned: number;
  /** A cancel was seen; the pattern in flight was discarded, not half-cached. */
  cancelled: boolean;
}

/**
 * Scan the patterns still missing from the match cache, in slices, yielding between
 * them.
 *
 * This is the same work `computeView` would otherwise do — but `computeView` runs
 * inside a render, synchronously, so a filter set holding one pattern Rust can't take
 * froze the window for as long as that scan took (measured 1779 ms for a single
 * lookahead over 92k lines, and there is no upper bound: it is the user's regex). A
 * frozen main thread cannot deliver the click on Cancel either, so the loading overlay
 * had a button that could not be pressed exactly when it was needed.
 *
 * Doing it HERE — before the lines reach the store, alongside the Rust priming — means
 * the render that follows always finds a warm cache. The total work is unchanged; what
 * changes is that it is interruptible, and that the window keeps painting.
 *
 * A cancel discards the pattern in flight rather than caching a half-scanned bit set,
 * which would report missing matches for as long as the file stayed open.
 */
export async function scanRemainingInJs(
  lines: string[],
  filters: Filter[],
  opts: { cancelled?: () => boolean; yieldTo?: () => Promise<void> } = {},
): Promise<JsScanResult> {
  const yieldTo = opts.yieldTo ?? yieldToEventLoop;
  const n = lines.length;
  let scanned = 0;
  if (!n) return { scanned, cancelled: false };
  for (const c of compileAll(filters)) {
    if (!c.re || c.empty || !c.ok) continue;
    if (hasMatchBits(lines, c.re)) continue;
    const re = c.re;
    const bits = new Uint8Array((n + 7) >> 3);
    let count = 0;
    let i = 0;
    while (i < n) {
      const started = performance.now();
      while (i < n && performance.now() - started < JS_SLICE_MS) {
        const end = Math.min(n, i + JS_SCAN_BATCH);
        for (; i < end; i++) {
          re.lastIndex = 0;
          if (re.test(lines[i])) {
            bits[i >> 3] |= 1 << (i & 7);
            count++;
          }
        }
      }
      if (i < n) {
        await yieldTo();
        if (opts.cancelled?.()) return { scanned, cancelled: true };
      }
    }
    primeMatchCache(lines, [
      { source: re.source, flags: re.flags, bits, count },
    ]);
    scanned++;
  }
  return { scanned, cancelled: false };
}

export interface PrimeOutcome {
  /** Patterns actually sent to Rust (0 when everything was cached already). */
  requested: number;
  /** The scan result, or null when nothing was sent or the scan was unusable. */
  result: PrimeResult | null;
}

/**
 * Warm the match cache for `filters` over `lines` — the one entry point every caller
 * should use.
 *
 * Scans only the patterns not already cached, so switching to a set that shares
 * patterns with the current one (or back to a previously used one) costs nothing and
 * does no IPC at all. The cache is keyed per pattern, not per filter set.
 *
 * **Never throws.** Priming is an optimisation: callers await it on the critical path
 * of opening a file or switching a set, and a failure here must leave them slower,
 * not broken. Anything that goes wrong simply leaves those bit sets uncomputed for
 * `computeView` to scan itself.
 *
 * `onScanStart` fires only when there is real work — it lets a caller show a
 * progress affordance without flashing it on a switch that was a pure cache hit.
 */
export async function primeFilters(
  // Both take their `LogFile` shapes directly (a file may have no path, and a null
  // encoding means auto-detect), so no caller has to translate before calling.
  path: string | null | undefined,
  encoding: string | null | undefined,
  lines: string[],
  filters: Filter[],
  onScanStart?: () => void,
): Promise<PrimeOutcome> {
  if (!path || !lines.length || !filters.length)
    return { requested: 0, result: null };
  const plan = scanPlan(
    compileAll(filters).filter((c) => c.re && !hasMatchBits(lines, c.re)),
  );
  if (!plan.specs.length) return { requested: 0, result: null };
  // Conjunctions never reach the scanner, but they are patterns the user has and
  // `primed` counts them — leaving them out made the log line read `primed` > `filters`.
  const requested = plan.specs.length + plan.compositions.length;
  onScanStart?.();
  try {
    return {
      requested,
      result: await scanAndPrime(path, encoding ?? undefined, lines, plan),
    };
  } catch {
    return { requested, result: null };
  }
}
