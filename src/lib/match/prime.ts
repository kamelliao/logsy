// The Rust side of Phase A: hand `scan_lines` a file's patterns and prime the match
// cache with the packed bit sets it returns. See docs/design-match.md.
//
// Rust scans one Regex per pattern across worker threads — 97 ms for 92k lines × 119
// patterns, against seconds for the same work in a backtracking JS engine, which is
// the entire reason this bridge exists.
//
// Every failure path here is a downgrade, never an error: a missing Tauri shell, a
// line-count disagreement, an unsupported pattern or a failed spot-check just leaves
// those bit sets uncomputed. `resolve` then reports the filter as pending and
// `scanRemainingInJs` picks it up — nothing is ever wrong, only slower.
import { invoke } from "@tauri-apps/api/core";
import { cacheKey, hasMatchBits, primeMatchCache } from "@/lib/match/cache";
import { compileAll } from "@/lib/match/compile";
import { yieldToEventLoop } from "@/lib/paint";
import type { CompiledFilter, Filter } from "@/types";

export interface ScanSpec {
  /** `RegExp.source` verbatim — the cache key both sides must agree on. */
  source: string;
  /** Whether the regex carries the `i` flag. */
  ci: boolean;
}

export interface ScanPlan {
  specs: ScanSpec[];
}

/**
 * Dedupe the compiled filters into the distinct patterns to scan, in filter order.
 *
 * A pattern is sent as the user wrote it. What it takes to RUN it — spelling `\d` out,
 * splitting a lookahead conjunction into branches — belongs to the translation on the
 * other side, which is the only place that knows what a JS regex means.
 */
export function scanPlan(compiled: CompiledFilter[]): ScanPlan {
  const seen = new Set<string>();
  const specs: ScanSpec[] = [];
  for (const c of compiled) {
    if (!c.re || c.empty || !c.ok) continue;
    const key = cacheKey(c.re.source, c.re.flags);
    if (seen.has(key)) continue; // same source+flags shares one cache entry
    seen.add(key);
    specs.push({ source: c.re.source, ci: c.re.flags.includes("i") });
  }
  return { specs };
}

/** Dedupe the compiled filters into the patterns worth scanning, in filter order. */
export function scanSpecs(compiled: CompiledFilter[]): ScanSpec[] {
  return scanPlan(compiled).specs;
}

// --- which patterns Rust could not take -------------------------------------
// Keyed by the lines array, exactly like the match cache in match/cache.ts, so a closed
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
 * `lines` must be the array `resolve` will run on (the cache is keyed by array
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
  const { specs } = plan;
  if (!specs.length)
    return {
      primed: 0,
      fallback: 0,
      rejected: 0,
      readMs: 0,
      splitMs: 0,
      scanMs: 0,
    };
  // Every bail-out below leaves the WHOLE batch to the JS scanner, so record that
  // before returning: a caller that only sees `null` cannot tell which patterns are
  // now going to cost it seconds.
  const allToJs = () => {
    // The branches AND the conjunctions they stand for: `specs` holds only the former,
    // but the key the engine looks a conjunction up by is the latter. Marking only
    // `specs` gave every ordinary filter the badge and none of the expensive ones —
    // in exactly the case (no shell, line-count mismatch) where everything is JS-scanned.
    markJsScanned(lines, specs);
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
  primeMatchCache(lines, entries);

  markJsScanned(lines, toJs);
  return {
    primed: entries.length,
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
 * This is the same work `resolve` used to do inline — but a resolve runs
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
  opts: {
    cancelled?: () => boolean;
    yieldTo?: () => Promise<void>;
    /** One pattern's bits just landed — the caller may want to re-resolve. */
    onPattern?: () => void;
  } = {},
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
    opts.onPattern?.();
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
 * the JS scanner to do itself.
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
  const requested = plan.specs.length;
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
