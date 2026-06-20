// Inverse of buildPattern (src/lib/generalize.ts): reconstruct the chip tokens
// from a regex the builder itself emitted, so an existing filter can be edited
// with the Pattern builder again. This deliberately only understands
// buildPattern's restricted grammar — a flat concatenation of escaped literals,
// the per-kind general forms, and `(?<name>general)` captures. Anything outside
// it (a hand-edited or foreign regex) makes parse() return null, and the caller
// simply shows no builder. A round-trip check (buildPattern(out) === src) is the
// safety net: we never hand back tokens that would silently change the pattern.
//
// Why this is well-defined where general "regex → chips parsing" is not: every
// general form uses *unescaped* regex metacharacters (`\d`, `\s`, a bare `.`,
// `[`, `(?<`), while exact literals always escape them (`\.`, `\[`, `\(`, `\\`).
// So a literal run can never be mistaken for a general form.

import { escapeRegex } from "@/logic";
import { GenToken, GenKind, buildPattern, generalPattern } from "@/lib/generalize";

interface Seg { kind: GenKind; raw: string; len: number; }

// Match one generalized run at src[p]. `raw` is a synthetic value chosen so
// generalPattern() reproduces the matched string exactly (verified by the caller
// via the round-trip check); realizeRaws() later swaps in real sample text.
function matchGeneral(src: string, p: number): Seg | null {
  const s = src.slice(p);
  let m: RegExpExecArray | null;

  // 0x[0-9A-Fa-f]+  (generalPattern always emits lowercase "0x")
  if ((m = /^0x\[0-9A-Fa-f\]\+/.exec(s))) return { kind: "hex", raw: "0x0", len: m[0].length };
  // [0-9A-Fa-f]+
  if ((m = /^\[0-9A-Fa-f\]\+/.exec(s))) return { kind: "hex", raw: "0", len: m[0].length };

  // Numeric structure: \d+ (sep \d+)* with sep ∈ { : , \. }. A ':' or ',' marks
  // a timestamp (tokenize's time rule requires a colon); a lone '\.' is a float;
  // a lone '\d+' is an int.
  if ((m = /^\\d\+(?:(?::|,|\\\.)\\d\+)*/.exec(s))) {
    const g = m[0];
    if (/[:,]/.test(g)) return { kind: "time", raw: g.replace(/\\d\+/g, "0").replace(/\\\./g, "."), len: g.length };
    if (g.includes("\\.")) return { kind: "float", raw: "0.0", len: g.length };
    return { kind: "int", raw: "0", len: g.length };
  }

  if ((m = /^\\s\+/.exec(s))) return { kind: "ws", raw: " ", len: m[0].length };     // \s+
  if ((m = /^\.\+/.exec(s))) return { kind: "merged", raw: "x", len: m[0].length };  // .+  (parts unrecoverable)
  return null;
}

/** Inverse of buildPattern, or null if `src` is outside the builder's grammar. */
export function parsePattern(src: string): GenToken[] | null {
  const out: GenToken[] = [];
  let i = 0;
  let lit = "";
  const flush = () => { if (lit) { out.push({ raw: lit, kind: "text", state: "exact" }); lit = ""; } };

  while (i < src.length) {
    // (?<name> general )
    const cap = /^\(\?<([A-Za-z_]\w*)>/.exec(src.slice(i));
    if (cap) {
      const g = matchGeneral(src, i + cap[0].length);
      if (!g || src[i + cap[0].length + g.len] !== ")") return null;
      flush();
      out.push({ raw: g.raw, kind: g.kind, state: "capture", name: cap[1] });
      i += cap[0].length + g.len + 1;
      continue;
    }
    // bare general run
    const g = matchGeneral(src, i);
    if (g) { flush(); out.push({ raw: g.raw, kind: g.kind, state: "general" }); i += g.len; continue; }
    // one escaped-literal character
    if (src[i] === "\\") { if (i + 1 >= src.length) return null; lit += src[i + 1]; i += 2; }
    else { lit += src[i]; i += 1; }
  }
  flush();

  return buildPattern(out) === src ? out : null;
}

/**
 * Replace each token's synthetic `raw` with the real substring it matched in
 * `line`, so the chips read like a fresh "Filter as pattern…" seed. Done with a
 * probe regex that wraps every token's sub-pattern in its own named group, so
 * one match yields every token's span. Best-effort: if the probe fails to match
 * or the swap would change buildPattern's output, the tokens are left untouched.
 */
export function realizeRaws(tokens: GenToken[], line: string, flags: string): GenToken[] {
  const before = buildPattern(tokens);
  const probe = tokens
    .map((t, i) => `(?<g${i}>${t.state === "exact" ? escapeRegex(t.raw) : generalPattern(t)})`)
    .join("");
  let groups: Record<string, [number, number] | undefined> | undefined;
  try {
    const m = new RegExp(probe, flags.replace(/[gd]/g, "") + "d").exec(line);
    groups = (m as { indices?: { groups?: Record<string, [number, number] | undefined> } } | null)?.indices?.groups;
  } catch { return tokens; }
  if (!groups) return tokens;

  const next = tokens.map((t, i) => {
    const span = groups![`g${i}`];
    return span ? { ...t, raw: line.slice(span[0], span[1]) } : t;
  });
  // Real text re-generalizes to the same form by construction, but verify so a
  // pathological line can never desync the chips from the pattern.
  return buildPattern(next) === before ? next : tokens;
}

/** Convenience: parse + (optionally) realize raws from a matching sample line. */
export function reparsePattern(pattern: string, line: string | null, flags = ""): GenToken[] | null {
  const toks = parsePattern(pattern);
  if (!toks || !line) return toks;
  return realizeRaws(toks, line, flags);
}
