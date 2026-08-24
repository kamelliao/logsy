// Splitting a line into matched / unmatched runs, for painting it — and the edit
// modal's live preview.
//
// NOT part of the match pipeline: that answers "which lines", in bit sets, and these
// need "which characters", which a bit set deliberately cannot say. They run per
// VISIBLE row, so their cost is bounded by the viewport rather than by the file.
import type { Segment } from "@/types";

export function countMatches(lines: string[], re: RegExp): number {
  let c = 0;
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) c++;
  }
  return c;
}

export function segments(text: string, re: RegExp | null): Segment[] {
  if (!re) return [{ t: text, hit: false }];
  re.lastIndex = 0;
  const out: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ t: text.slice(last, m.index), hit: false });
    if (m[0].length) out.push({ t: m[0], hit: true });
    last = m.index + (m[0].length || 0);
    if (m[0].length === 0) re.lastIndex++;
    if (++guard > 5000) break;
  }
  if (last < text.length) out.push({ t: text.slice(last), hit: false });
  if (!out.length) out.push({ t: text, hit: false });
  return out;
}

// --- Edit-modal live preview ------------------------------------------------

export interface MatchSample {
  n: number;
  text: string;
}

/** One pass over the file: total match count plus the first `limit` hits. */
export function scanMatches(
  lines: string[],
  re: RegExp,
  limit = 200,
): { count: number; samples: MatchSample[] } {
  let count = 0;
  const samples: MatchSample[] = [];
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (!re.test(lines[i])) continue;
    count++;
    if (samples.length < limit) samples.push({ n: i + 1, text: lines[i] });
  }
  return { count, samples };
}

export interface GroupSegment {
  t: string;
  hit: boolean;
  group?: number;
}

/**
 * Like `segments`, but spans belonging to a named capture group carry that
 * group's index (position in `groupOrder`) so the preview can color-code each
 * field. `re` must be compiled with the `d` (indices) flag. Overlapping named
 * groups paint in pattern order, so an inner (later) group wins.
 */
export function groupSegments(
  text: string,
  re: RegExp,
  groupOrder: string[],
): GroupSegment[] {
  if (!text.length) return [{ t: text, hit: false }];
  // Per-character paint: 0 = plain, 1 = hit, 2+k = named group k.
  const paint = new Uint16Array(text.length);
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(text)) !== null) {
    const ind = m.indices;
    const span = ind?.[0] ?? [m.index, m.index + m[0].length];
    paint.fill(1, span[0], span[1]);
    if (ind?.groups) {
      for (let k = 0; k < groupOrder.length; k++) {
        const r = ind.groups[groupOrder[k]];
        if (r) paint.fill(2 + k, r[0], r[1]);
      }
    }
    if (m[0].length === 0) re.lastIndex++;
    if (++guard > 5000) break;
  }
  const out: GroupSegment[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i < text.length && paint[i] === paint[start]) continue;
    const p = paint[start];
    const t = text.slice(start, i);
    out.push(
      p === 0
        ? { t, hit: false }
        : p === 1
          ? { t, hit: true }
          : { t, hit: true, group: p - 2 },
    );
    start = i;
  }
  return out;
}
