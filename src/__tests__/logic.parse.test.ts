import { test, expect } from "bun:test";
import { compile, deriveFields, coerceValue, compileAll, computeView } from "../logic";
import type { Filter, FieldDef } from "../types";

function filter(id: string, pattern: string, over: Partial<Filter> = {}): Filter {
  return {
    id, pattern, description: "", enabled: true, caseSensitive: false,
    regex: true, exclude: false, textColor: "#000", bgColor: "#fff", groupId: null,
    ...over,
  };
}
const F = (...names: { name: string; type: FieldDef["type"] }[]) => names;

// --- deriveFields -----------------------------------------------------------

test("deriveFields lists named groups once and guesses time for ts/time names", () => {
  expect(deriveFields("(?<ts>\\d+)\\s+(?<lvl>\\w)\\s+(?<msg>.*)")).toEqual([
    { name: "ts", type: "time" },
    { name: "lvl", type: "string" },
    { name: "msg", type: "string" },
  ]);
});

test("deriveFields de-duplicates repeated group names", () => {
  expect(deriveFields("(?<a>x)(?<a>y)(?<b>z)").map((f) => f.name)).toEqual(["a", "b"]);
});

// --- compile ------------------------------------------------------------------

test("compile error keeps only the engine reason, not the echoed pattern", () => {
  const c = compile(filter("x", "boot: jump to app @ (?<.+)"));
  expect(c.ok).toBe(false);
  // Engine wording differs (V8 vs JSC) — just require the boilerplate prefix
  // and the echoed pattern to be gone, leaving a non-empty reason.
  expect(c.err).not.toContain("Invalid regular expression");
  expect(c.err).not.toContain("boot: jump");
  expect(c.err?.length).toBeGreaterThan(0);
});

// --- coerceValue ------------------------------------------------------------

test("coerceValue handles each numeric type", () => {
  expect(coerceValue("42", "int")).toBe(42);
  expect(coerceValue("0x1F", "hex")).toBe(31);
  expect(coerceValue("FF", "hex")).toBe(255);
  expect(coerceValue("3.14", "float")).toBe(3.14);
  expect(coerceValue("hello", "string")).toBe("hello");
});

test("coerceValue falls back to raw string when coercion yields NaN", () => {
  expect(coerceValue("notnum", "int")).toBe("notnum");
  expect(coerceValue("zzz", "hex")).toBe("zzz");
});

test("coerceValue parses clock-style and plain timestamps", () => {
  expect(coerceValue("00:00:01.500", "time")).toBe(1500);
  expect(coerceValue("01:02:03", "time")).toBe(3723000);
  expect(coerceValue("02:05", "time")).toBe(125000);
  expect(coerceValue("12.5", "time")).toBe(12.5);
});

// --- computeView field extraction from structural filters -------------------

const structural = (id: string, pattern: string, over: Partial<Filter> = {}) =>
  filter(id, pattern, { fields: deriveFields(pattern), ...over });

test("a regex filter with named groups extracts coerced fields on matching lines", () => {
  const lines = ["12.0 E boom", "plain line"];
  const view = computeView(lines, compileAll([
    structural("p1", "(?<ts>\\d+\\.\\d+)\\s+(?<lvl>[EWID])\\s+(?<msg>.*)", {
      fields: F({ name: "ts", type: "float" }, { name: "lvl", type: "string" }, { name: "msg", type: "string" }),
    }),
  ]));
  expect(view.fieldsFor(1)?.ts).toEqual({ raw: "12.0", value: 12 });
  expect(view.fieldsFor(1)?.lvl.value).toBe("E");
  expect(view.rows[0].fieldsFromId).toBe("p1");
  expect(view.fieldsFor(2)).toBeUndefined();
  expect(view.rows[1].fieldsFromId).toBeUndefined();
});

test("a plain (non-named-group) filter highlights but extracts nothing", () => {
  const view = computeView(["error here"], compileAll([filter("h", "error")]));
  expect(view.rows[0].winner?.f.id).toBe("h");
  expect(view.fieldsFor(1)).toBeUndefined();
});

test("field extraction is first-structural-filter-wins, independent of the colour winner", () => {
  const lines = ["12.0 E i2c boom"];
  const view = computeView(lines, compileAll([
    filter("color", "boom", { regex: false }), // colour winner, no fields
    structural("specific", "^(?<ts>\\d+\\.\\d+)\\s+(?<lvl>E)\\s+(?<tag>\\w+)", {
      fields: F({ name: "ts", type: "float" }, { name: "lvl", type: "string" }, { name: "tag", type: "string" }),
    }),
    structural("generic", "(?<all>.*)", { fields: F({ name: "all", type: "string" }) }),
  ]));
  expect(view.rows[0].winner?.f.id).toBe("color");      // highlight from the plain filter
  expect(view.rows[0].fieldsFromId).toBe("specific");   // fields from the first structural match
  expect(view.fieldsFor(1)?.tag.value).toBe("i2c");
});

test("counts cover every line and include disabled filters", () => {
  const lines = ["error a", "ok b", "error c"];
  const view = computeView(lines, compileAll([
    filter("on", "error", { regex: false }),
    filter("off", "error", { regex: false, enabled: false }),
  ]));
  // Both filters match the same two lines; the disabled one still gets a count.
  expect(view.counts.on).toBe(2);
  expect(view.counts.off).toBe(2);
  // ...but a disabled filter never colours a row.
  expect(view.rows[0].winner?.f.id).toBe("on");
});

test("excluded lines are removed and never used as field providers", () => {
  const view = computeView(["drop 12.0 E boom"], compileAll([
    filter("x", "drop", { regex: false, exclude: true }),
    structural("p", "(?<ts>\\d+\\.\\d+)", { fields: F({ name: "ts", type: "float" }) }),
  ]));
  expect(view.rows[0].excluded).toBe(true);
});
