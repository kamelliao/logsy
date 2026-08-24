// Phase B of the match pipeline: bit sets + a filter list -> the view.
// See docs/design-match.md.
import { cachedMatchBits, isUsable, scanAll } from "@/lib/match/cache";
import { extractFields } from "@/lib/fields";
import type {
  CompiledFilter,
  FieldDef,
  FieldValue,
  Filter,
  ViewResult,
  ViewRow,
} from "@/types";

/**
 * Phase B of the match pipeline: turn cached match bit sets plus a filter list into
 * the view. See docs/design-match.md.
 *
 * **Pure, and it never scans.** A filter whose bit set is missing is reported in
 * `pending`, not computed here. That is the whole point of the split: scanning inside
 * a render is what froze the window for seconds, and every mitigation for it —
 * slicing, yielding, cancellation — had to be threaded through code that only wanted
 * to resolve. Filling the cache is `ensureMatched`'s job, before this runs.
 *
 * Everything here depends only on what a filter OPERATION changes (order, enabled,
 * exclude, colour), which is why reordering and toggling cost a resolve and no IPC.
 */
export function resolve(
  lines: string[],
  compiled: CompiledFilter[],
): ViewResult {
  // Every filter with a usable regex. List order is significant: the colour
  // winner and field provider go to the first match in this order.
  const usable = compiled.filter(isUsable);
  // Existence flags reflect which enabled filters exist, not per-line matches.
  const hasHighlights = usable.some((c) => c.f.enabled && !c.f.exclude);
  const hasExcludes = usable.some((c) => c.f.enabled && c.f.exclude);

  // Field providers keyed by filter id, for lazy on-demand extraction.
  const providers = new Map<string, { re: RegExp; defs: FieldDef[] }>();
  for (const c of usable) {
    if (c.f.enabled && !c.f.exclude && c.f.fields && c.f.fields.length > 0) {
      providers.set(c.f.id, { re: c.re!, defs: c.f.fields });
    }
  }

  // Init counts for every compiled filter (incl. disabled / empty) so badges
  // always show a number. Counting disabled filters too lets their badges show
  // potential matches.
  const counts: Record<string, number> = {};
  for (const c of compiled) counts[c.f.id] = 0;

  const n = lines.length;
  // Per-line roles, composed from the cached bit sets. "First match wins" is
  // realised by walking the filters in reverse and letting earlier (higher
  // priority) filters overwrite later ones.
  const winnerIdx = new Int32Array(n).fill(-1);
  const fieldsIdx = new Int32Array(n).fill(-1);
  const excludedArr = new Uint8Array(n);
  // Keep each usable filter's match bit set so a row can later report *all* the
  // highlight filters it matched (not just the colour winner) on demand.
  const usableBits: Uint8Array[] = new Array(usable.length);
  // Stands in for a pending filter's bits: shared and never written, so a filter that
  // has not been scanned yet reads as "matches nothing" everywhere downstream while
  // `pending` carries the fact that that is not an answer.
  const NO_BITS = new Uint8Array((n + 7) >> 3);
  const pending = new Set<string>();
  let pendingExcludes = false;
  for (let u = usable.length - 1; u >= 0; u--) {
    const c = usable[u];
    const hit = cachedMatchBits(lines, c.re!.source, c.re!.flags);
    if (!hit) {
      pending.add(c.f.id);
      if (c.f.enabled && c.f.exclude) pendingExcludes = true;
      usableBits[u] = NO_BITS;
      continue;
    }
    const { bits, count } = hit;
    usableBits[u] = bits;
    counts[c.f.id] = count;
    if (!c.f.enabled) continue;
    const isExclude = c.f.exclude;
    const hasFields = !isExclude && !!c.f.fields && c.f.fields.length > 0;
    for (let b = 0; b < bits.length; b++) {
      const v = bits[b];
      if (!v) continue;
      for (let k = 0; k < 8; k++) {
        if (!(v & (1 << k))) continue;
        const i = (b << 3) + k;
        if (isExclude) {
          excludedArr[i] = 1;
          continue;
        }
        winnerIdx[i] = u;
        if (hasFields) fieldsIdx[i] = u;
      }
    }
  }

  const rows: ViewRow[] = new Array(n);
  let matchedCount = 0;
  let excludedCount = 0;
  for (let i = 0; i < n; i++) {
    const winner = winnerIdx[i] >= 0 ? usable[winnerIdx[i]] : null;
    const excluded = excludedArr[i] === 1;
    if (excluded) excludedCount++;
    else if (winner) matchedCount++;
    rows[i] = {
      n: i + 1,
      text: lines[i],
      winner,
      excluded,
      fieldsFromId: fieldsIdx[i] >= 0 ? usable[fieldsIdx[i]].f.id : undefined,
    };
  }

  // Extract a row's fields on demand from the provider that claimed it.
  const fieldsFor = (n: number): Record<string, FieldValue> | undefined => {
    const row = rows[n - 1];
    if (!row || row.fieldsFromId === undefined) return undefined;
    const p = providers.get(row.fieldsFromId);
    if (!p) return undefined;
    return extractFields(p.re, p.defs, row.text);
  };

  // Every enabled highlight (non-exclude) filter that matches line `n`, in filter
  // order (so the colour winner is first). Computed on demand from the cached
  // bit sets — used by the log row's hover tooltip.
  const matchedFiltersFor = (n: number): Filter[] => {
    const i = n - 1;
    if (i < 0 || i >= lines.length) return [];
    const out: Filter[] = [];
    const byte = i >> 3,
      bit = 1 << (i & 7);
    for (let u = 0; u < usable.length; u++) {
      const c = usable[u];
      if (!c.f.enabled || c.f.exclude) continue;
      if (usableBits[u][byte] & bit) out.push(c.f);
    }
    return out;
  };

  return {
    rows,
    counts,
    hasHighlights,
    hasExcludes,
    matchedCount,
    excludedCount,
    fieldsFor,
    matchedFiltersFor,
    pending,
    pendingExcludes,
  };
}

/**
 * Scan whatever is missing, then resolve — Phase A and Phase B back to back.
 *
 * **For tests and benchmarks only.** The app never calls this: scanning inside a
 * render is the thing `resolve`'s purity exists to prevent, and Phase A is driven by
 * `ensureMatched` where it can be sliced, cancelled and reported on. The deliberately
 * awkward name is the reminder — reaching for "computeView" should not get you a
 * function that blocks for seconds.
 */
export function scanAndResolve(
  lines: string[],
  compiled: CompiledFilter[],
): ViewResult {
  scanAll(lines, compiled);
  return resolve(lines, compiled);
}
