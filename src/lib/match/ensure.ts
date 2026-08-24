// Phase A of the match pipeline: make sure every filter in a set has a match bit set
// for a given lines array. See docs/design-match.md.
//
// This is the ONLY entry point. Before it existed, "scan what needs scanning" was
// spelled out separately on the open path, the filter-set switch and (not at all) on
// add/update — nothing defined what "Phase A is complete" meant, so a caller could
// silently implement half of it. Every filter operation now goes through here.
//
// It never throws: Phase A is an optimisation over `resolve` reporting the filter as
// pending, so a failure has to leave callers slower, not broken.
import { primeFilters, scanRemainingInJs } from "@/lib/scanPrime";
import type { Filter } from "@/types";

export interface EnsureResult {
  /** Distinct patterns handed to the fast scanner (0 when everything was cached). */
  requested: number;
  primed: number;
  fallback: number;
  rejected: number;
  /** Patterns the fast scanner refused, scanned here in slices instead. */
  jsScanned: number;
  /** Rust-side stages, reported back in the scan blob's header. */
  readMs: number;
  splitMs: number;
  scanMs: number;
  /** The `scan_lines` round trip, verification and cache priming. */
  primeMs: number;
  /** The sliced JS scan of whatever the fast scanner refused. */
  jsScanMs: number;
  /** A cancel was observed; some filters are still without bit sets. */
  cancelled: boolean;
}

const NOTHING: EnsureResult = {
  requested: 0,
  primed: 0,
  fallback: 0,
  rejected: 0,
  jsScanned: 0,
  readMs: 0,
  splitMs: 0,
  scanMs: 0,
  primeMs: 0,
  jsScanMs: 0,
  cancelled: false,
};

export interface EnsureOptions {
  /** Polled between slices; true abandons the rest of the work. */
  cancelled?: () => boolean;
  /**
   * Called when new bit sets have landed and a re-resolve would show more. Throttled,
   * because the JS leg finishes one pattern at a time and a 119-filter set would
   * otherwise ask for 119 renders.
   */
  onProgress?: () => void;
  /** Shown only when there is real work, so a cache-hit call doesn't flash a spinner. */
  onScanStart?: () => void;
}

/** How often `onProgress` may fire, in ms. One frame's worth of coalescing. */
const PROGRESS_THROTTLE_MS = 120;

// One ensure at a time per lines array. Two panes on the same document, or a filter
// edit landing while the open scan is still running, would otherwise both see a cold
// cache and scan the same patterns twice — the cache check inside `primeFilters` can
// only see what has already finished.
const inFlight = new WeakMap<readonly string[], Promise<EnsureResult>>();

export async function ensureMatched(
  path: string | null | undefined,
  encoding: string | null | undefined,
  lines: string[],
  filters: Filter[],
  opts: EnsureOptions = {},
): Promise<EnsureResult> {
  if (!lines.length || !filters.length) return NOTHING;
  // Chain onto whatever is already running for this lines array — awaiting it and THEN
  // registering would let two late callers both queue behind the same predecessor and
  // then run concurrently, which is the duplicate scan this exists to prevent. Building
  // the chain synchronously, before any await, is what makes it a queue.
  const prev = inFlight.get(lines) ?? Promise.resolve(NOTHING);
  const run = prev
    .catch(() => NOTHING) // an earlier caller owns reporting its own failure
    .then(() => ensureOnce(path, encoding, lines, filters, opts));
  inFlight.set(lines, run);
  try {
    return await run;
  } finally {
    // Only the last link clears it; an earlier one finishing must not drop a queue
    // that still has callers waiting behind it.
    if (inFlight.get(lines) === run) inFlight.delete(lines);
  }
}

async function ensureOnce(
  path: string | null | undefined,
  encoding: string | null | undefined,
  lines: string[],
  filters: Filter[],
  opts: EnsureOptions,
): Promise<EnsureResult> {
  let lastProgress = 0;
  const progress = (force = false) => {
    const now = performance.now();
    if (!force && now - lastProgress < PROGRESS_THROTTLE_MS) return;
    lastProgress = now;
    opts.onProgress?.();
  };

  // An enabled exclude with no bit set yet is worse than a missing colour: the view
  // shows lines that should be hidden, which is wrong rather than incomplete. Scanning
  // them first shortens the window in which that is true.
  const ordered = [...filters].sort(
    (a, b) => Number(b.exclude && b.enabled) - Number(a.exclude && a.enabled),
  );

  const t0 = performance.now();
  const { requested, result } = await primeFilters(
    path,
    encoding,
    lines,
    ordered,
    opts.onScanStart,
  );
  const primeMs = performance.now() - t0;
  // Only when bit sets actually landed. `requested` merely says work was asked for —
  // with no shell nothing comes back, and reporting progress there would spend a
  // re-resolve to display exactly what is already on screen.
  if (result && result.primed > 0) progress(true);
  if (opts.cancelled?.())
    return { ...NOTHING, requested, primeMs, cancelled: true };

  // Whatever the fast scanner refused, sliced so the window keeps painting.
  const tJs = performance.now();
  const js = await scanRemainingInJs(lines, ordered, {
    cancelled: opts.cancelled,
    onPattern: () => progress(),
  });
  const jsScanMs = performance.now() - tJs;
  progress(true);

  const scanned = { jsScanned: js.scanned, jsScanMs, cancelled: js.cancelled };
  if (!requested) return { ...NOTHING, ...scanned, primeMs };
  // A null result means the scan was unusable (no shell, a line-count disagreement)
  // and the JS pass above did the whole thing — report every pattern as a fallback so
  // the open log line says that, rather than a misleading zero.
  return result
    ? { requested, ...result, primeMs, ...scanned }
    : { ...NOTHING, requested, fallback: requested, primeMs, ...scanned };
}
