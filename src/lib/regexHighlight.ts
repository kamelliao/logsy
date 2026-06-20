// Tiny single-pass tokenizer for highlighting a regular-expression *pattern*
// (a bare pattern string, not a `/…/g` literal). It aims to be forgiving: any
// byte it doesn't recognise falls through as a literal, so a half-typed regex
// still renders sensibly rather than throwing.

export type RegexTokenType =
  | "literal"
  | "escape" // \d  \w  \.  \\  …
  | "class" // [ …contents… ]  brackets + body
  | "group" // ( ) (?: (?= (?! (?<= (?<! (?< >
  | "groupname" // the NAME in (?<name>…)
  | "anchor" // ^  $
  | "quant" // *  +  ?  {n,m}  (plus a trailing lazy ?)
  | "alt" // |
  | "meta"; // .

export interface RegexToken {
  t: RegexTokenType;
  s: string;
}

const QUANT_BRACE = /^\{\d+(?:,\d*)?\}/;

/** Break a regex pattern into typed tokens for colourised rendering. */
export function tokenizeRegex(src: string): RegexToken[] {
  const toks: RegexToken[] = [];
  const push = (t: RegexTokenType, s: string) => {
    if (s) toks.push({ t, s });
  };
  const n = src.length;
  let i = 0;
  let inClass = false;

  while (i < n) {
    const c = src[i];

    // An escape consumes the backslash + the next char, everywhere (incl. classes).
    if (c === "\\") {
      const next = src[i + 1] ?? "";
      push("escape", c + next);
      i += next ? 2 : 1;
      continue;
    }

    if (inClass) {
      if (c === "]") {
        push("class", c);
        inClass = false;
      } else push("class", c);
      i++;
      continue;
    }

    switch (c) {
      case "[": {
        let s = "[";
        i++;
        if (src[i] === "^") {
          s += "^";
          i++;
        }
        push("class", s);
        inClass = true;
        continue;
      }
      case "(": {
        let j = i + 1;
        let s = "(";
        if (src[j] === "?") {
          s += "?";
          j++;
          const k = src[j];
          if (k === ":" || k === "=" || k === "!") {
            s += k;
            j++;
          } else if (k === "<") {
            s += "<";
            j++;
            if (src[j] === "=" || src[j] === "!") {
              s += src[j];
              j++;
            } else {
              // Named capture group: (?<name>…)
              push("group", s);
              let name = "";
              while (j < n && src[j] !== ">") {
                name += src[j];
                j++;
              }
              push("groupname", name);
              if (src[j] === ">") {
                push("group", ">");
                j++;
              }
              i = j;
              continue;
            }
          }
        }
        push("group", s);
        i = j;
        continue;
      }
      case ")":
        push("group", c);
        i++;
        continue;
      case "|":
        push("alt", c);
        i++;
        continue;
      case "^":
      case "$":
        push("anchor", c);
        i++;
        continue;
      case ".":
        push("meta", c);
        i++;
        continue;
      case "*":
      case "+":
      case "?": {
        let s = c;
        i++;
        if (src[i] === "?" || src[i] === "+") {
          s += src[i];
          i++;
        } // lazy / possessive
        push("quant", s);
        continue;
      }
      case "{": {
        const m = QUANT_BRACE.exec(src.slice(i));
        if (m) {
          let s = m[0];
          i += m[0].length;
          if (src[i] === "?") {
            s += "?";
            i++;
          }
          push("quant", s);
          continue;
        }
        push("literal", c);
        i++;
        continue;
      }
      default:
        push("literal", c);
        i++;
        continue;
    }
  }

  return toks;
}
