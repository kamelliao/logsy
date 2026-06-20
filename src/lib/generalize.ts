// "Filter as pattern": turn a piece of selected log text into a regex by
// tokenizing it into typed runs (timestamps, hex, numbers, whitespace, text)
// and generalizing each run. The EditModal chips UI lets the user cycle each
// token between exact text, a generalized pattern, and a named capture group.

import { escapeRegex } from "@/lib/engine";

export type GenKind =
  | "text"
  | "ws"
  | "int"
  | "float"
  | "hex"
  | "time"
  | "merged";

/** exact = escaped literal · general = type pattern · capture = named group. */
export type GenState = "exact" | "general" | "capture";

export interface GenToken {
  raw: string;
  kind: GenKind;
  state: GenState;
  /** Capture-group name; when unset a default is assigned at build time. */
  name?: string;
  /** The tokens a "merged" chip was built from; splitting restores them. */
  parts?: GenToken[];
}

// Detection rules, tried in order at each position. Longer/more-specific
// kinds come first so e.g. "12:30:01.442" is one time token, not ints + text.
const RULES: { kind: GenKind; re: RegExp }[] = [
  // Clock-ish timestamps: 12:30, 12:30:01, 12:30:01.442 / ,442
  { kind: "time", re: /^\d+:\d{2}(?::\d{2})?(?:[.,]\d+)?/ },
  { kind: "hex", re: /^0[xX][0-9a-fA-F]+/ },
  // Bare hex: ≥4 hex chars with at least one letter (else it's a number).
  { kind: "hex", re: /^(?=[0-9]*[a-fA-F])[0-9a-fA-F]{4,}\b/ },
  { kind: "float", re: /^\d+\.\d+/ },
  { kind: "int", re: /^\d+/ },
  { kind: "ws", re: /^\s+/ },
];

/** Default state per kind: data-ish tokens start generalized, text stays exact. */
function defaultState(kind: GenKind): GenState {
  return kind === "text" ? "exact" : "general";
}

/** Split selected text into typed tokens (adjacent literal chars merge into one). */
export function tokenize(raw: string): GenToken[] {
  const out: GenToken[] = [];
  let i = 0;
  let lit = "";
  const flushLit = () => {
    if (lit) {
      out.push({ raw: lit, kind: "text", state: "exact" });
      lit = "";
    }
  };
  outer: while (i < raw.length) {
    const rest = raw.slice(i);
    for (const r of RULES) {
      const m = r.re.exec(rest);
      if (m) {
        flushLit();
        out.push({ raw: m[0], kind: r.kind, state: defaultState(r.kind) });
        i += m[0].length;
        continue outer;
      }
    }
    lit += raw[i];
    i++;
  }
  flushLit();
  return out;
}

/** The generalized pattern for a token (what "general" and "capture" emit). */
export function generalPattern(t: GenToken): string {
  switch (t.kind) {
    // Keep the timestamp's separators/structure, generalize only digit runs.
    case "time":
      return escapeRegex(t.raw).replace(/\d+/g, "\\d+");
    case "hex":
      return /^0[xX]/.test(t.raw) ? "0x[0-9A-Fa-f]+" : "[0-9A-Fa-f]+";
    case "float":
      return "\\d+\\.\\d+";
    case "int":
      return "\\d+";
    case "ws":
      return "\\s+";
    // A merged run mixes kinds, so the only honest generalization is "anything".
    case "merged":
      return ".+";
    default:
      return escapeRegex(t.raw);
  }
}

const DEFAULT_NAMES: Record<GenKind, string> = {
  time: "ts",
  hex: "hex",
  int: "num",
  float: "val",
  text: "txt",
  ws: "ws",
  merged: "msg",
};

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Capture-group name for each token (undefined for non-captures). User-given
 * names are sanitized; defaults derive from the kind and dedupe with 2, 3, ….
 */
export function assignNames(tokens: GenToken[]): (string | undefined)[] {
  const used = new Set<string>();
  return tokens.map((t) => {
    if (t.state !== "capture") return undefined;
    const base =
      t.name && VALID_NAME.test(t.name) ? t.name : DEFAULT_NAMES[t.kind];
    let name = base;
    for (let i = 2; used.has(name); i++) name = base + i;
    used.add(name);
    return name;
  });
}

/**
 * Merge tokens[from..to] (inclusive, either order) into one "merged" chip.
 * Starts exact so the rebuilt pattern still matches the sample literally;
 * the originals ride along in `parts` so splitToken can restore them.
 */
export function mergeTokens(
  tokens: GenToken[],
  from: number,
  to: number,
): GenToken[] {
  const [a, b] = from <= to ? [from, to] : [to, from];
  if (b - a < 1 || a < 0 || b >= tokens.length) return tokens;
  const parts = tokens.slice(a, b + 1);
  const merged: GenToken = {
    raw: parts.map((t) => t.raw).join(""),
    kind: "merged",
    state: "exact",
    parts,
  };
  return [...tokens.slice(0, a), merged, ...tokens.slice(b + 1)];
}

/** Undo a merge: replace tokens[i] with the parts it was built from. */
export function splitToken(tokens: GenToken[], i: number): GenToken[] {
  const t = tokens[i];
  if (!t?.parts) return tokens;
  return [...tokens.slice(0, i), ...t.parts, ...tokens.slice(i + 1)];
}

/** Compose the regex source the current chip states describe. */
export function buildPattern(tokens: GenToken[]): string {
  const names = assignNames(tokens);
  return tokens
    .map((t, i) => {
      if (t.state === "exact") return escapeRegex(t.raw);
      const g = generalPattern(t);
      return t.state === "capture" ? `(?<${names[i]}>${g})` : g;
    })
    .join("");
}
