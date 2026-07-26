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
import { compileAll, hasMatchBits, primeMatchCache } from "@/lib/engine";
import type { CompiledFilter, Filter } from "@/types";

export interface ScanSpec {
  /** `RegExp.source` verbatim — the cache key both sides must agree on. */
  source: string;
  /** Whether the regex carries the `i` flag. */
  ci: boolean;
}

/** Dedupe the compiled filters into the patterns worth scanning, in filter order. */
export function scanSpecs(compiled: CompiledFilter[]): ScanSpec[] {
  const seen = new Set<string>();
  const out: ScanSpec[] = [];
  for (const c of compiled) {
    if (!c.re || c.empty || !c.ok) continue;
    const key = c.re.source + " " + c.re.flags;
    if (seen.has(key)) continue; // same source+flags shares one cache entry
    seen.add(key);
    out.push({ source: c.re.source, ci: c.re.flags.includes("i") });
  }
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

export interface PrimeResult {
  /** Patterns whose bit sets are now cached. */
  primed: number;
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
  specs: ScanSpec[],
): Promise<PrimeResult | null> {
  if (!specs.length)
    return {
      primed: 0,
      fallback: 0,
      rejected: 0,
      readMs: 0,
      splitMs: 0,
      scanMs: 0,
    };
  let buf: ArrayBuffer;
  try {
    const res = await invoke<ArrayBuffer>("scan_lines", {
      path,
      encoding,
      patterns: specs,
    });
    // Not running under the real shell (e2e mock, browser dev) → nothing to use.
    if (!(res instanceof ArrayBuffer) || res.byteLength < HEADER) return null;
    buf = res;
  } catch {
    return null;
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
  if (nLines !== lines.length || nPat !== specs.length) return null;

  let off = HEADER;
  const fb = new Set<number>();
  for (let k = 0; k < nFallback; k++, off += 4) fb.add(dv.getUint32(off, true));
  const counts: number[] = new Array(nPat);
  for (let k = 0; k < nPat; k++, off += 4) counts[k] = dv.getUint32(off, true);
  if (off + nPat * bytesLen > buf.byteLength) return null;

  const u8 = new Uint8Array(buf);
  const entries: {
    source: string;
    flags: string;
    bits: Uint8Array;
    count: number;
  }[] = [];
  let rejected = 0;
  for (let k = 0; k < nPat; k++) {
    if (fb.has(k)) continue;
    const flags = specs[k].ci ? "gi" : "g";
    // `slice` (not subarray): the entry outlives `buf`, and a view would pin the
    // whole multi-megabyte blob in memory for as long as the file stays open.
    const bits = u8.slice(off + k * bytesLen, off + (k + 1) * bytesLen);
    let re: RegExp;
    try {
      re = new RegExp(specs[k].source, flags);
    } catch {
      rejected++;
      continue;
    }
    if (!verify(lines, re, bits)) {
      rejected++;
      continue;
    }
    entries.push({ source: specs[k].source, flags, bits, count: counts[k] });
  }
  primeMatchCache(lines, entries);
  return {
    primed: entries.length,
    fallback: nFallback,
    rejected,
    readMs,
    splitMs,
    scanMs,
  };
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
  const specs = scanSpecs(
    compileAll(filters).filter((c) => c.re && !hasMatchBits(lines, c.re)),
  );
  if (!specs.length) return { requested: 0, result: null };
  onScanStart?.();
  try {
    return {
      requested: specs.length,
      result: await scanAndPrime(path, encoding ?? undefined, lines, specs),
    };
  } catch {
    return { requested: specs.length, result: null };
  }
}
