import type {
  Filter, CompiledFilter, ViewResult, Segment,
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
    return { f, re: null, ok: false, err: (e as Error).message };
  }
}

export function compileAll(filters: Filter[]): CompiledFilter[] {
  return filters.map(compile);
}

function testRe(re: RegExp, line: string): boolean {
  re.lastIndex = 0;
  return re.test(line);
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
  const active = compiled.filter((c) => c.f.enabled && !c.empty && c.ok && c.re);
  const excludes = active.filter((c) => c.f.exclude);
  // `extractOnly` filters parse but never colour a line, so they're not winners.
  const highlights = active.filter((c) => !c.f.exclude && !c.f.extractOnly);
  // Structural filters (regex with named groups) that supply parsed fields.
  const fieldProviders = active.filter((c) => !c.f.exclude && c.f.fields && c.f.fields.length > 0);

  const counts: Record<string, number> = {};
  for (const c of compiled) {
    counts[c.f.id] = c.re ? countMatches(lines, c.re) : 0;
  }

  const rows = lines.map((text, i) => {
    let excluded = false;
    for (const e of excludes) {
      if (testRe(e.re!, text)) { excluded = true; break; }
    }
    let winner: CompiledFilter | null = null;
    for (const h of highlights) {
      if (testRe(h.re!, text)) { winner = h; break; }
    }
    // First structural filter (in order) that matches supplies this line's fields.
    let fields: Record<string, FieldValue> | undefined;
    let fieldsFromId: string | undefined;
    for (const p of fieldProviders) {
      if (!testRe(p.re!, text)) continue;
      fields = extractFields(p.re!, p.f.fields!, text);
      fieldsFromId = p.f.id;
      break;
    }
    return { n: i + 1, text, winner, excluded, fields, fieldsFromId };
  });

  return {
    rows,
    counts,
    hasHighlights: highlights.length > 0,
    hasExcludes: excludes.length > 0,
  };
}
