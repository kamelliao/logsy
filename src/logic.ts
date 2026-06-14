import type {
  Filter, CompiledFilter, ViewResult, ViewRow, Segment,
  FieldType, FieldDef, FieldValue, TimeUnit, TimelineSource, EventMark,
} from "./types";

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compile(f: Filter): CompiledFilter {
  if (!f.pattern || !f.pattern.length) return { f, re: null, ok: true, empty: true };
  try {
    const src = f.regex ? f.pattern : escapeRegex(f.pattern);
    const flags = f.caseSensitive ? "g" : "gi";
    return { f, re: new RegExp(src, flags), ok: true };
  } catch (e) {
    // Keep only the engine's reason — the pattern is already on screen. V8
    // says "Invalid regular expression: /…/gi: reason" (echoing the whole
    // source); JSC (bun tests) says "Invalid regular expression: reason".
    const msg = (e as Error).message;
    const m = /^Invalid regular expression: (?:\/[\s\S]*\/[a-z]*: )?([\s\S]+)$/.exec(msg);
    return { f, re: null, ok: false, err: m ? m[1] : msg };
  }
}

export function compileAll(filters: Filter[]): CompiledFilter[] {
  return filters.map(compile);
}

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

export interface MatchSample { n: number; text: string }

/** One pass over the file: total match count plus the first `limit` hits. */
export function scanMatches(
  lines: string[], re: RegExp, limit = 200,
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

export interface GroupSegment { t: string; hit: boolean; group?: number }

/**
 * Like `segments`, but spans belonging to a named capture group carry that
 * group's index (position in `groupOrder`) so the preview can color-code each
 * field. `re` must be compiled with the `d` (indices) flag. Overlapping named
 * groups paint in pattern order, so an inner (later) group wins.
 */
export function groupSegments(text: string, re: RegExp, groupOrder: string[]): GroupSegment[] {
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
    out.push(p === 0 ? { t, hit: false } : p === 1 ? { t, hit: true } : { t, hit: true, group: p - 2 });
    start = i;
  }
  return out;
}

// --- Parsing: extract structured fields from each line ---------------------

const NAMED_GROUP_RE = /\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g;

/** Guess a field's type from its capture-group name (the UI lets users override). */
function guessType(name: string): FieldType {
  const n = name.toLowerCase();
  if (/^(ts|time|timestamp|clock|uptime)$/.test(n)) return "time";
  return "string";
}

/** List the named capture groups in a regex source, as default field defs. */
export function deriveFields(regexSource: string): FieldDef[] {
  const fields: FieldDef[] = [];
  const seen = new Set<string>();
  NAMED_GROUP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAMED_GROUP_RE.exec(regexSource)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    fields.push({ name: m[1], type: guessType(m[1]) });
  }
  return fields;
}

/** Parse a clock-style ("H:M:S.mmm") or plain-numeric timestamp into a number. */
function parseTime(raw: string): number {
  let m = /^(\d+):(\d{2}):(\d{2})(?:[.,](\d+))?$/.exec(raw);
  if (m) {
    const frac = m[4] ? Number("0." + m[4]) : 0;
    return ((+m[1] * 60 + +m[2]) * 60 + +m[3] + frac) * 1000;
  }
  m = /^(\d+):(\d{2})(?:[.,](\d+))?$/.exec(raw);
  if (m) {
    const frac = m[3] ? Number("0." + m[3]) : 0;
    return (+m[1] * 60 + +m[2] + frac) * 1000;
  }
  return Number(raw.replace(",", "."));
}

/** Nanoseconds per whole unit, for normalizing plain-number time fields. */
const NS_PER: Record<Exclude<TimeUnit, "hms">, number> = {
  s: 1e9, ms: 1e6, us: 1e3, ns: 1,
};

/**
 * Coerce a `time` field to a number.
 * - No `unit` (legacy): clock formats → milliseconds via `parseTime`, plain
 *   numbers pass through unchanged. Used by the compare table.
 * - With `unit`: result is normalized to **nanoseconds**. `"hms"` parses the
 *   clock (ms) and scales to ns; a numeric unit scales the plain number.
 * Returns the raw string when the text isn't a number.
 */
export function coerceTime(raw: string, unit?: TimeUnit): number | string {
  if (unit === undefined) {
    const v = parseTime(raw);
    return Number.isNaN(v) ? raw : v;
  }
  if (unit === "hms") {
    const v = parseTime(raw);
    return Number.isNaN(v) ? raw : v * 1e6;
  }
  const v = parseFloat(raw);
  return Number.isNaN(v) ? raw : v * NS_PER[unit];
}

/** Coerce raw matched text per field type; fall back to the raw string on NaN. */
export function coerceValue(raw: string, type: FieldType, unit?: TimeUnit): number | string {
  let v: number;
  switch (type) {
    case "int":   v = parseInt(raw, 10); break;
    case "hex":   v = parseInt(raw.replace(/^0x/i, ""), 16); break;
    case "float": v = parseFloat(raw); break;
    case "time":  return coerceTime(raw, unit);
    default:      return raw;
  }
  return Number.isNaN(v) ? raw : v;
}

/**
 * Default time unit guessed for a field; the user can override in the panel.
 * The name's unit suffix wins (`*_ns`/`*_us`/`*_ms`/`*_s`). With no suffix we
 * fall back to the shape of a sample value: a clock string (has ":") is `hms`,
 * a plain number is seconds (e.g. a dmesg-style "5.143152"). Absent a sample we
 * default to `hms`.
 */
export function guessUnit(name: string, sample?: string): TimeUnit {
  const n = name.toLowerCase();
  if (/(^|_)ns$/.test(n) || /nanos?/.test(n)) return "ns";
  if (/(^|_)us$/.test(n) || /micros?/.test(n)) return "us";
  if (/(^|_)ms$/.test(n) || /millis?/.test(n)) return "ms";
  if (/(^|_)s(ec(onds?)?)?$/.test(n)) return "s";
  if (sample !== undefined) {
    if (sample.includes(":")) return "hms";
    if (sample.trim() !== "" && Number.isFinite(Number(sample))) return "s";
  }
  return "hms";
}

/**
 * Whether a field's raw matched value looks like a timestamp the timeline can
 * plot: an integer, hex (`0x…`), decimal, or a clock (`H:MM:SS.mmm` / `M:SS`).
 * Judged on the matched VALUE rather than the regex source — a char-set test on
 * the pattern is unreliable because real numeric patterns use quantifiers, char
 * classes, escapes, and hex (`\d+`, `[0-9]{2}`, `0x[0-9a-f]+`).
 */
const TIME_LIKE_RE = /^\s*(?:0[xX][0-9a-fA-F]+|[+-]?\d+(?:[.,]\d+)?|\d{1,3}(?::\d{2}){1,2}(?:[.,]\d+)?)\s*$/;
export function isTimeLike(raw: string): boolean {
  return TIME_LIKE_RE.test(raw);
}

/** Extract a compiled structural filter's named groups from a line, coerced by type. */
function extractFields(re: RegExp, defs: FieldDef[], line: string): Record<string, FieldValue> {
  re.lastIndex = 0;
  const m = re.exec(line);
  const groups = m?.groups ?? {};
  const out: Record<string, FieldValue> = {};
  for (const def of defs) {
    const raw = groups[def.name];
    if (raw === undefined) continue;
    out[def.name] = { raw, value: coerceValue(raw, def.type) };
  }
  return out;
}

// --- per-filter match cache --------------------------------------------------
// Which lines a regex matches depends only on the lines array and the regex, so
// the result is cached as a bit set: outer key is the lines array itself (a
// WeakMap, so a closed file's entries are garbage-collected with it), inner key
// is the regex source+flags. Toggling/recoloring filters then recomposes the
// view from cached bits instead of re-running every regex over every line —
// that re-run is O(lines × filters) and takes seconds at 100+ filters on a
// large log.

interface MatchBits { bits: Uint8Array; count: number }
const matchCache = new WeakMap<readonly string[], Map<string, MatchBits>>();
// Per-file LRU cap. Bit sets cost lines/8 bytes each, so even 300 entries on a
// million-line log stay under ~40 MB.
const MATCH_CACHE_MAX = 300;

function matchBitsFor(lines: string[], re: RegExp): MatchBits {
  let perFile = matchCache.get(lines);
  if (!perFile) { perFile = new Map(); matchCache.set(lines, perFile); }
  const key = re.source + " " + re.flags;
  const hit = perFile.get(key);
  if (hit) {
    perFile.delete(key); // re-insert to refresh LRU recency
    perFile.set(key, hit);
    return hit;
  }
  const bits = new Uint8Array((lines.length + 7) >> 3);
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) { bits[i >> 3] |= 1 << (i & 7); count++; }
  }
  const entry = { bits, count };
  perFile.set(key, entry);
  if (perFile.size > MATCH_CACHE_MAX) perFile.delete(perFile.keys().next().value!);
  return entry;
}

export function computeView(lines: string[], compiled: CompiledFilter[]): ViewResult {
  // Every filter with a usable regex. List order is significant: the colour
  // winner and field provider go to the first match in this order.
  const usable = compiled.filter((c) => c.re && !c.empty && c.ok);
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
  for (let u = usable.length - 1; u >= 0; u--) {
    const c = usable[u];
    const { bits, count } = matchBitsFor(lines, c.re!);
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
        if (isExclude) { excludedArr[i] = 1; continue; }
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
      n: i + 1, text: lines[i], winner, excluded,
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
    const byte = i >> 3, bit = 1 << (i & 7);
    for (let u = 0; u < usable.length; u++) {
      const c = usable[u];
      if (!c.f.enabled || c.f.exclude) continue;
      if (usableBits[u][byte] & bit) out.push(c.f);
    }
    return out;
  };

  return { rows, counts, hasHighlights, hasExcludes, matchedCount, excludedCount, fieldsFor, matchedFiltersFor };
}

// --- Timeline: extract events from the lines the user added ----------------
// Events come from a user-curated set of log lines (like the compare panel),
// not from whole-filter matches. For each added line we read its parsed fields
// (via the same fieldsFor provider) and, per configured time-field track, emit
// an event. A line can emit several events (one per track present on it). Times
// normalize to nanoseconds.

/** Palette for auto-assigned lane colors (light tints, matched in the canvas). */
const LANE_COLORS = [
  "#dbeafe", "#dcfce7", "#fef9c3", "#fce7f3", "#e0e7ff", "#ffedd5", "#ccfbf1", "#fee2e2",
];

/** Next auto palette color for a new track, given how many tracks exist already. */
export function laneColor(index: number): string {
  return LANE_COLORS[index % LANE_COLORS.length];
}

/**
 * A filter's fields that can back a timeline track. Any parsed field qualifies —
 * its raw text is coerced by the track's unit (`coerceTime`), so we don't require
 * the field to be typed `time`/numeric (most named groups default to `string`).
 */
export function trackFieldsOf(filter: Filter): FieldDef[] {
  return filter.fields ?? [];
}

/**
 * Build timeline events for the given added line numbers. `view` supplies the
 * parsed fields (lazy) and line text; `tracks` is the user-owned track list.
 *
 * A line feeds a track only when the line's first-match filter (`fieldsFromId`)
 * is the track's `filterId` and the line exposes `timeField`. One line can feed
 * several tracks (a filter with several numeric fields), but only tracks bound to
 * that one first-matched filter.
 */
export function buildTimeline(
  view: ViewResult, lineNumbers: Iterable<number>, tracks: TimelineSource[],
): EventMark[] {
  const visible = tracks.filter((t) => !t.hidden);
  const out: EventMark[] = [];
  if (!visible.length) return out;
  const sorted = [...lineNumbers].sort((a, b) => a - b);
  for (const n of sorted) {
    const row = view.rows[n - 1];
    const fid = row?.fieldsFromId;
    if (!fid) continue;
    const fields = view.fieldsFor(n);
    if (!fields) continue;
    const text = row.text;
    for (const tr of visible) {
      if (tr.filterId !== fid) continue;
      const sv = fields[tr.timeField];
      if (!sv) continue;
      const t = coerceTime(sv.raw, tr.unit);
      if (typeof t !== "number") continue;
      let end: number | undefined;
      if (tr.kind === "span" && tr.endField) {
        const e = fields[tr.endField] ? coerceTime(fields[tr.endField].raw, tr.unit) : undefined;
        if (typeof e === "number") end = e;
      }
      out.push({ lane: tr.lane, t, end, lineN: n, label: text, color: tr.color, shape: tr.shape, fields });
    }
  }
  return out;
}
