/**
 * Matching for the Quick Open palette and the sidebar's filter box.
 *
 * Two tiers, so results stay predictable: a CONTIGUOUS substring always beats a
 * scattered subsequence match. Typing "boot" thus lands on `boot.log` rather than
 * on `b-something-o-o-t.log`, which a plain subsequence scorer happily ranks first.
 * The looser subsequence pass is kept as a fallback (it's what makes "wsc" find
 * `wifi-scan.log`) but can never outrank a real substring hit.
 */
export interface FuzzyHit {
  score: number;
  /** Indices in the haystack that the query matched — for highlighting. */
  idx: number[];
}

/** Substring hits scored above every subsequence hit, whatever the latter's bonuses. */
const SUBSTRING_TIER = 1000;

const isBoundary = (ch: string): boolean => /[^A-Za-z0-9]/.test(ch);

/**
 * Tier 1 alone: the query must appear as a CONTIGUOUS run. This is all a long haystack
 * like a file path gets — over a path, a subsequence match is nearly always available
 * (the letters of "scan" are scattered through `logs/deviceA/sensor.log`, which then
 * matches and highlights nothing meaningful), so it's pure noise there.
 */
export function substringMatch(query: string, text: string): FuzzyHit | null {
  if (!query) return { score: 0, idx: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at < 0) return null;
  // Earlier is better; starting the string or a word (after `-`, `_`, `.`, `/`) better still.
  let score = SUBSTRING_TIER - at;
  if (at === 0) score += 60;
  else if (isBoundary(t[at - 1])) score += 30;
  const idx: number[] = [];
  for (let i = 0; i < q.length; i++) idx.push(at + i);
  return { score: score - text.length * 0.01, idx };
}

/** Match `query` against `text` (case-insensitive). null when it doesn't match. */
export function fuzzyMatch(query: string, text: string): FuzzyHit | null {
  if (!query) return { score: 0, idx: [] };
  const sub = substringMatch(query, text);
  if (sub) return sub;

  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Tier 2: every query character in order, anywhere. Runs of adjacent characters and
  // word-boundary hits score higher; a match spread across the whole string scores low.
  const idx: number[] = [];
  let score = 0;
  let ti = 0;
  let run = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const hit = t.indexOf(q[qi], ti);
    if (hit < 0) return null;
    if (hit === ti && qi > 0) run += 1;
    else run = 0;
    score += 1 + run * 2;
    if (hit === 0 || isBoundary(t[hit - 1])) score += 3;
    idx.push(hit);
    ti = hit + 1;
  }
  // Penalise how far the match sprawls, so tight matches come first.
  score -= (idx[idx.length - 1] - idx[0] - q.length + 1) * 0.5;
  return { score: score - text.length * 0.01, idx };
}
