import type {
  Filter, CompiledFilter, ViewResult, ViewRow, Segment,
  FieldType, FieldDef, FieldValue,
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

/** Coerce raw matched text per field type; fall back to the raw string on NaN. */
export function coerceValue(raw: string, type: FieldType): number | string {
  let v: number;
  switch (type) {
    case "int":   v = parseInt(raw, 10); break;
    case "hex":   v = parseInt(raw.replace(/^0x/i, ""), 16); break;
    case "float": v = parseFloat(raw); break;
    case "time":  v = parseTime(raw); break;
    default:      return raw;
  }
  return Number.isNaN(v) ? raw : v;
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
  // always show a number.
  const counts: Record<string, number> = {};
  for (const c of compiled) counts[c.f.id] = 0;

  const rows: ViewRow[] = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    let winner: CompiledFilter | null = null;
    let excluded = false;
    let fieldsFromId: string | undefined;
    // Single pass over every usable filter: test once, count the hit, then (for
    // enabled filters) assign the row's role. Counting disabled filters too lets
    // their badges show potential matches.
    for (const c of usable) {
      c.re!.lastIndex = 0;
      if (!c.re!.test(text)) continue;
      counts[c.f.id]++;
      if (!c.f.enabled) continue;
      if (c.f.exclude) { excluded = true; continue; }
      if (winner === null) winner = c;
      if (fieldsFromId === undefined && c.f.fields && c.f.fields.length > 0) fieldsFromId = c.f.id;
    }
    rows[i] = { n: i + 1, text, winner, excluded, fieldsFromId };
  }

  // Extract a row's fields on demand from the provider that claimed it.
  const fieldsFor = (n: number): Record<string, FieldValue> | undefined => {
    const row = rows[n - 1];
    if (!row || row.fieldsFromId === undefined) return undefined;
    const p = providers.get(row.fieldsFromId);
    if (!p) return undefined;
    return extractFields(p.re, p.defs, row.text);
  };

  return { rows, counts, hasHighlights, hasExcludes, fieldsFor };
}
