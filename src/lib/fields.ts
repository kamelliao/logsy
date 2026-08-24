// Structured fields: the named capture groups a filter pulls out of a line, and the
// time formats they get coerced through.
//
// Downstream of matching and independent of it — a bit set says a line matched, this
// says what the line CONTAINS. Extraction is lazy, per row the UI actually shows.
import { escapeRegex } from "@/lib/match/compile";
import type { FieldType, FieldDef, FieldValue, TimeUnit } from "@/types";

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
const NS_PER: Record<Exclude<TimeUnit, "hms" | "date" | "custom">, number> = {
  s: 1e9,
  ms: 1e6,
  us: 1e3,
  ns: 1,
};

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};
// Assumed year for stamps that omit it (Android logcat, syslog). A leap year so
// "Feb 29" parses; the exact value is irrelevant — the timeline plots relative
// positions, so all marks just need a consistent year. Parsed as UTC throughout
// so results don't depend on the machine's timezone.
const ASSUMED_YEAR = 2026;

/** Build nanoseconds from UTC calendar parts plus an optional fractional-second string. */
function utcNs(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  frac?: string,
): number {
  const ms = Date.UTC(y, mo, d, h, mi, s);
  if (Number.isNaN(ms)) return NaN;
  const fracNs = frac ? Math.round(Number("0." + frac) * 1e9) : 0;
  return ms * 1e6 + fracNs;
}

// Absolute date+time shapes the timeline can plot. Matched on the VALUE so the
// field qualifies as a time axis (used by `isDateLike`) and the unit auto-guesses.
//   - Android logcat:  "MM-DD HH:MM:SS(.frac)"            (no year)
//   - ISO 8601:        "YYYY-MM-DD(T| )HH:MM:SS(.frac)(Z|±hh:mm)"
//   - syslog:          "Mon DD HH:MM:SS(.frac)"           (no year)
const RE_ISO =
  /^\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d+))?\s*(Z|[+-]\d{2}:?\d{2})?\s*$/;
const RE_MMDD =
  /^\s*(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d+))?\s*$/;
const RE_SYSLOG =
  /^\s*([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d+))?\s*$/;

/**
 * Parse an absolute date+time stamp to **nanoseconds**, auto-detecting the shape
 * (Android logcat, ISO 8601, syslog). Year-less stamps assume `ASSUMED_YEAR`.
 * Falls back to `Date.parse` (ms precision) for anything else, then NaN.
 */
export function parseDateTime(raw: string): number {
  let m = RE_MMDD.exec(raw);
  if (m)
    return utcNs(ASSUMED_YEAR, +m[1] - 1, +m[2], +m[3], +m[4], +m[5], m[6]);
  m = RE_ISO.exec(raw);
  if (m) {
    let ns = utcNs(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7]);
    const tz = m[8];
    if (!Number.isNaN(ns) && tz && tz !== "Z") {
      const sign = tz[0] === "-" ? -1 : 1;
      const oh = +tz.slice(1, 3);
      const om = +tz.slice(-2);
      ns -= sign * (oh * 60 + om) * 60 * 1e9; // shift local → UTC
    }
    return ns;
  }
  m = RE_SYSLOG.exec(raw);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo !== undefined)
      return utcNs(ASSUMED_YEAR, mo, +m[2], +m[3], +m[4], +m[5], m[6]);
  }
  const t = Date.parse(raw);
  return Number.isNaN(t) ? NaN : t * 1e6;
}

/** Whether a value matches one of the absolute date+time shapes `parseDateTime` handles. */
export function isDateLike(raw: string): boolean {
  return RE_ISO.test(raw) || RE_MMDD.test(raw) || RE_SYSLOG.test(raw);
}

// --- custom time format ------------------------------------------------------
// The escape hatch for stamps the auto-parsers (`parseDateTime`) miss: the user
// supplies a moment/dayjs-style pattern on the track and we compile it to a
// regex + an ordered list of which calendar part each capture group fills.
//   YYYY year(4)  YY year(2→20xx)  MMM month name  MM/M month  DD/D day
//   HH/H hour     mm/m minute      ss/s second     S… fractional seconds (any len)
// Every other character matches literally. Parts the pattern omits default like
// the auto-parsers (year ⇒ ASSUMED_YEAR, others ⇒ 0/1), so a year-less Android
// pattern still plots. Parsed as UTC, so it's timezone-independent.

interface FmtToken {
  tok: string;
  kind: "Y4" | "Y2" | "Mon" | "M" | "D" | "H" | "mi" | "s";
  re: string;
}
// Longest tokens first so `startsWith` matches greedily (YYYY before YY, MMM
// before MM before M, HH before H, …). The `S` run is handled separately.
const FORMAT_TOKENS: FmtToken[] = [
  { tok: "YYYY", kind: "Y4", re: "(\\d{4})" },
  { tok: "YY", kind: "Y2", re: "(\\d{2})" },
  { tok: "MMM", kind: "Mon", re: "([A-Za-z]{3})" },
  { tok: "MM", kind: "M", re: "(\\d{2})" },
  { tok: "DD", kind: "D", re: "(\\d{2})" },
  { tok: "HH", kind: "H", re: "(\\d{2})" },
  { tok: "mm", kind: "mi", re: "(\\d{2})" },
  { tok: "ss", kind: "s", re: "(\\d{2})" },
  { tok: "M", kind: "M", re: "(\\d{1,2})" },
  { tok: "D", kind: "D", re: "(\\d{1,2})" },
  { tok: "H", kind: "H", re: "(\\d{1,2})" },
  { tok: "m", kind: "mi", re: "(\\d{1,2})" },
  { tok: "s", kind: "s", re: "(\\d{1,2})" },
];

type CompiledFormat = { re: RegExp; kinds: (FmtToken["kind"] | "frac")[] };
// Compiling a pattern is pure in the pattern string, and `buildTimeline` reuses
// one format across every added line, so memoize. `null` = un-parseable pattern.
const formatCache = new Map<string, CompiledFormat | null>();

function compileFormat(format: string): CompiledFormat | null {
  if (formatCache.has(format)) return formatCache.get(format)!;
  let src = "";
  const kinds: CompiledFormat["kinds"] = [];
  let i = 0;
  outer: while (i < format.length) {
    if (format[i] === "S") {
      let j = i;
      while (j < format.length && format[j] === "S") j++;
      src += "(\\d+)";
      kinds.push("frac");
      i = j;
      continue;
    }
    for (const t of FORMAT_TOKENS) {
      if (format.startsWith(t.tok, i)) {
        src += t.re;
        kinds.push(t.kind);
        i += t.tok.length;
        continue outer;
      }
    }
    src += escapeRegex(format[i]);
    i++;
  }
  // A pattern with no recognized field can't yield a time.
  let compiled: CompiledFormat | null = null;
  if (kinds.length) {
    try {
      compiled = { re: new RegExp("^\\s*" + src + "\\s*$"), kinds };
    } catch {
      compiled = null;
    }
  }
  formatCache.set(format, compiled);
  return compiled;
}

/**
 * Whether a custom `format` pattern is usable: non-empty, has at least one
 * recognized field token, and compiles to a valid regex. The track UI shows a
 * warning when this is false (or when a valid pattern still fails to parse the
 * field's actual values).
 */
export function isValidFormat(format: string): boolean {
  return !!format && compileFormat(format) !== null;
}

/**
 * Parse `raw` against a user `format` pattern to **nanoseconds** (UTC). Returns
 * NaN when the pattern is empty/un-parseable, the text doesn't match, or a month
 * name is unknown — callers fall back to the raw string and skip the mark.
 */
export function parseFormat(raw: string, format: string): number {
  const c = compileFormat(format);
  if (!c) return NaN;
  const m = c.re.exec(raw);
  if (!m) return NaN;
  let Y = ASSUMED_YEAR;
  let Mo = 0;
  let D = 1;
  let H = 0;
  let Mi = 0;
  let S = 0;
  let frac: string | undefined;
  for (let k = 0; k < c.kinds.length; k++) {
    const v = m[k + 1];
    switch (c.kinds[k]) {
      case "Y4":
        Y = +v;
        break;
      case "Y2":
        Y = 2000 + +v;
        break;
      case "Mon": {
        const mo = MONTHS[v.toLowerCase()];
        if (mo === undefined) return NaN;
        Mo = mo;
        break;
      }
      case "M":
        Mo = +v - 1;
        break;
      case "D":
        D = +v;
        break;
      case "H":
        H = +v;
        break;
      case "mi":
        Mi = +v;
        break;
      case "s":
        S = +v;
        break;
      case "frac":
        frac = v;
        break;
    }
  }
  return utcNs(Y, Mo, D, H, Mi, S, frac);
}

/**
 * Coerce a `time` field to a number.
 * - No `unit` (legacy): clock formats → milliseconds via `parseTime`, plain
 *   numbers pass through unchanged. Used by the compare table.
 * - With `unit`: result is normalized to **nanoseconds**. `"hms"` parses the
 *   clock (ms) and scales to ns; `"date"` auto-parses an absolute stamp; a
 *   numeric unit scales the plain number; `"custom"` applies `format`.
 * Returns the raw string when the text isn't a number.
 */
export function coerceTime(
  raw: string,
  unit?: TimeUnit,
  format?: string,
): number | string {
  if (unit === undefined) {
    const v = parseTime(raw);
    return Number.isNaN(v) ? raw : v;
  }
  if (unit === "hms") {
    const v = parseTime(raw);
    return Number.isNaN(v) ? raw : v * 1e6;
  }
  if (unit === "date") {
    const v = parseDateTime(raw);
    return Number.isNaN(v) ? raw : v;
  }
  if (unit === "custom") {
    if (!format) return raw;
    const v = parseFormat(raw, format);
    return Number.isNaN(v) ? raw : v;
  }
  const v = parseFloat(raw);
  return Number.isNaN(v) ? raw : v * NS_PER[unit];
}

/** Coerce raw matched text per field type; fall back to the raw string on NaN. */
export function coerceValue(
  raw: string,
  type: FieldType,
  unit?: TimeUnit,
): number | string {
  let v: number;
  switch (type) {
    case "int":
      v = parseInt(raw, 10);
      break;
    case "hex":
      v = parseInt(raw.replace(/^0x/i, ""), 16);
      break;
    case "float":
      v = parseFloat(raw);
      break;
    case "time":
      return coerceTime(raw, unit);
    default:
      return raw;
  }
  return Number.isNaN(v) ? raw : v;
}

/**
 * Default time unit guessed for a field; the user can override in the panel.
 * The name's unit suffix wins (`*_ns`/`*_us`/`*_ms`/`*_s`). With no suffix we
 * fall back to the shape of a sample value: an absolute date+time stamp (Android
 * logcat / ISO / syslog) is `date`, a clock string (has ":") is `hms`, a plain
 * number is seconds (e.g. a dmesg-style "5.143152"). Absent a sample we default
 * to `hms`.
 */
export function guessUnit(name: string, sample?: string): TimeUnit {
  const n = name.toLowerCase();
  if (/(^|_)ns$/.test(n) || /nanos?/.test(n)) return "ns";
  if (/(^|_)us$/.test(n) || /micros?/.test(n)) return "us";
  if (/(^|_)ms$/.test(n) || /millis?/.test(n)) return "ms";
  if (/(^|_)s(ec(onds?)?)?$/.test(n)) return "s";
  if (sample !== undefined) {
    if (isDateLike(sample)) return "date";
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
const TIME_LIKE_RE =
  /^\s*(?:0[xX][0-9a-fA-F]+|[+-]?\d+(?:[.,]\d+)?|\d{1,3}(?::\d{2}){1,2}(?:[.,]\d+)?)\s*$/;
export function isTimeLike(raw: string): boolean {
  return TIME_LIKE_RE.test(raw) || isDateLike(raw);
}

/** Extract a compiled structural filter's named groups from a line, coerced by type. */
export function extractFields(
  re: RegExp,
  defs: FieldDef[],
  line: string,
): Record<string, FieldValue> {
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
