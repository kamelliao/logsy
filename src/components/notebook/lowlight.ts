// Curated lowlight instance for the notebook code block. We register only the
// languages worth shipping (firmware / AOSP workflows lean on c/cpp/python/bash/
// json + build files) to keep the bundle lean instead of pulling in
// highlight.js's full `common` set.
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import makefile from "highlight.js/lib/languages/makefile";
import type { HLJSApi, Language } from "highlight.js";

// ── custom grammars (not in highlight.js core) ───────────────────────────────

/** Linux Device Tree source (.dts/.dtsi). Modeled on the vscode-devicetree
 *  TextMate grammar: highlight labels, node names, &references, cell values and
 *  directives — property names stay plain (they aren't a scope there). */
function devicetree(hljs: HLJSApi): Language {
  const NUMBER = { className: "number", begin: /\b0x[0-9a-fA-F]+\b|\b\d+\b/ };
  const REFERENCE = { className: "variable", begin: /&[0-9A-Za-z,._+-]+/ };
  // ALL_CAPS macros/constants (GIC_SPI, IRQ_TYPE_LEVEL_HIGH, …) inside cells.
  const MACRO = { className: "built_in", begin: /\b[A-Z_][A-Z0-9_]*\b/ };
  return {
    name: "Device Tree",
    aliases: ["dts", "dtsi"],
    contains: [
      hljs.C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE,
      // C preprocessor — explicit directives only, so property names that start
      // with '#' (#address-cells, #size-cells, #interrupt-cells) stay plain.
      {
        className: "meta",
        begin:
          /#\s*(include|define|undef|ifndef|ifdef|if|elif|else|endif|error|warning|pragma|line)\b/,
        end: /$/,
        contains: [
          { className: "string", begin: /</, end: />/ },
          hljs.QUOTE_STRING_MODE,
          hljs.C_LINE_COMMENT_MODE,
        ],
      },
      // DTS directives: /dts-v1/; /include/ "…"; /memreserve/; /delete-node/ …
      {
        className: "meta",
        begin:
          /\/(dts-v1|include|memreserve|delete-node|delete-property|omit-if-no-ref|plugin)\//,
      },
      hljs.QUOTE_STRING_MODE,
      // labels:  `label:`  at the start of a line
      { className: "symbol", begin: /^\s*[0-9A-Za-z_+,.-]+:/ },
      // node name:  name@unit-address {   or the root  / {
      {
        className: "title",
        begin: /(\/|[0-9A-Za-z_,.+-]+(@[0-9a-fA-F,]+)?)(?=\s*\{)/,
      },
      // cell block  < … >  (references, numbers, macros)
      { begin: /</, end: />/, contains: [REFERENCE, NUMBER, MACRO] },
      // top level: only references (numbers live inside cells, matching the
      // reference grammar — so digits in property names like `pinctrl-0` stay
      // plain rather than being mis-highlighted).
      REFERENCE,
    ],
  };
}

/** Soong Blueprint (Android.bp): `module_type { prop: value, … }`. */
function androidbp(hljs: HLJSApi): Language {
  return {
    name: "Android.bp",
    aliases: ["bp", "soong"],
    keywords: { literal: "true false" },
    contains: [
      hljs.C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE,
      hljs.QUOTE_STRING_MODE,
      hljs.NUMBER_MODE,
      // module type: identifier immediately before `{`
      { className: "type", begin: /\b[A-Za-z_]\w*(?=\s*\{)/ },
      // property name before `:`
      { className: "attr", begin: /[A-Za-z_]\w*(?=\s*:)/ },
    ],
  };
}

export const lowlight = createLowlight();

lowlight.register({
  bash,
  c,
  cpp,
  json,
  python,
  makefile,
  devicetree,
  androidbp,
});
// Bazel BUILD/.bzl files are Starlark — a Python dialect — so reuse python.
lowlight.register({ bazel: python });

/** Dropdown options for the code-block language picker. `value` must match a
 *  registered language name (or "plaintext" for no highlighting). */
export const CODE_LANGUAGES: { value: string; label: string }[] = [
  { value: "plaintext", label: "Plain text" },
  { value: "bash", label: "Bash / Shell" },
  { value: "c", label: "C" },
  { value: "cpp", label: "C++" },
  { value: "python", label: "Python" },
  { value: "json", label: "JSON" },
  { value: "makefile", label: "Makefile" },
  { value: "devicetree", label: "Device Tree (DTS)" },
  { value: "androidbp", label: "Android.bp (Soong)" },
  { value: "bazel", label: "Bazel / Starlark" },
];
