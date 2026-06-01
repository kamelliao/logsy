import { test, expect } from "bun:test";
import {
  deriveFields, coerceValue, compileProfile, parseLine, computeView, compileAll,
} from "./logic";
import type { LinePattern, ParseProfile, Filter } from "./types";

function pattern(id: string, regex: string, over: Partial<LinePattern> = {}): LinePattern {
  return { id, regex, enabled: true, fields: deriveFields(regex), ...over };
}
function profile(...patterns: LinePattern[]): ParseProfile {
  return { id: "prof", name: "p", patterns };
}
function filter(id: string, pattern: string, over: Partial<Filter> = {}): Filter {
  return {
    id, pattern, description: "", enabled: true, caseSensitive: false,
    regex: false, exclude: false, textColor: "#000", bgColor: "#fff", sectionId: null,
    ...over,
  };
}

// --- deriveFields -----------------------------------------------------------

test("deriveFields lists named groups once and guesses time for ts/time names", () => {
  const fields = deriveFields("(?<ts>\\d+)\\s+(?<lvl>\\w)\\s+(?<msg>.*)");
  expect(fields).toEqual([
    { name: "ts", type: "time" },
    { name: "lvl", type: "string" },
    { name: "msg", type: "string" },
  ]);
});

test("deriveFields de-duplicates repeated group names", () => {
  expect(deriveFields("(?<a>x)(?<a>y)(?<b>z)").map((f) => f.name)).toEqual(["a", "b"]);
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
  expect(coerceValue("12.5", "time")).toBe(12.5); // plain numeric, log-native unit
});

// --- compileProfile ---------------------------------------------------------

test("compileProfile reports invalid regex without throwing", () => {
  const cp = compileProfile(profile(pattern("p1", "(unterminated")));
  expect(cp.patterns[0].ok).toBe(false);
  expect(cp.patterns[0].re).toBeNull();
  expect(cp.patterns[0].err).toBeTruthy();
});

test("compileProfile skips disabled patterns", () => {
  const cp = compileProfile(profile(pattern("p1", "(?<a>x)", { enabled: false })));
  expect(cp.patterns[0].re).toBeNull();
  expect(cp.patterns[0].ok).toBe(true);
});

// --- parseLine --------------------------------------------------------------

test("parseLine extracts and coerces fields by their defined types", () => {
  const cp = compileProfile(profile(
    pattern("p1", "(?<ts>\\d+\\.\\d+)\\s+(?<lvl>[EWID])\\s+(?<msg>.*)", {
      fields: [
        { name: "ts", type: "float" },
        { name: "lvl", type: "string" },
        { name: "msg", type: "string" },
      ],
    }),
  ));
  const r = parseLine("12.340218 E timeout addr=0x50", cp);
  expect(r?.patternId).toBe("p1");
  expect(r?.fields.ts).toEqual({ raw: "12.340218", value: 12.340218 });
  expect(r?.fields.lvl).toEqual({ raw: "E", value: "E" });
  expect(r?.fields.msg).toEqual({ raw: "timeout addr=0x50", value: "timeout addr=0x50" });
});

test("parseLine is first-match-wins across ordered patterns", () => {
  const cp = compileProfile(profile(
    pattern("specific", "^ERR (?<code>\\d+)", { fields: [{ name: "code", type: "int" }] }),
    pattern("generic", "(?<msg>.*)"),
  ));
  expect(parseLine("ERR 7 boom", cp)?.patternId).toBe("specific");
  expect(parseLine("just a line", cp)?.patternId).toBe("generic");
});

test("parseLine returns null when nothing matches", () => {
  const cp = compileProfile(profile(pattern("p1", "^ONLY THIS$")));
  expect(parseLine("something else", cp)).toBeNull();
});

test("parseLine omits a field whose optional group did not participate", () => {
  const cp = compileProfile(profile(
    pattern("p1", "(?<a>x)(?<b>y)?", {
      fields: [{ name: "a", type: "string" }, { name: "b", type: "string" }],
    }),
  ));
  const r = parseLine("x", cp);
  expect(r?.fields.a).toEqual({ raw: "x", value: "x" });
  expect("b" in (r?.fields ?? {})).toBe(false);
});

// --- computeView integration -----------------------------------------------

test("computeView attaches fields/patternId only when a profile is passed", () => {
  const lines = ["12.0 E boom", "plain line"];
  const compiled = compileAll([filter("f1", "boom")]);
  const cp = compileProfile(profile(
    pattern("p1", "(?<ts>\\d+\\.\\d+)\\s+(?<lvl>[EWID])\\s+(?<msg>.*)", {
      fields: [
        { name: "ts", type: "float" },
        { name: "lvl", type: "string" },
        { name: "msg", type: "string" },
      ],
    }),
  ));

  const withProfile = computeView(lines, compiled, cp);
  expect(withProfile.rows[0].fields?.lvl.value).toBe("E");
  expect(withProfile.rows[0].patternId).toBe("p1");
  // unmatched line: no fields
  expect(withProfile.rows[1].fields).toBeUndefined();
  expect(withProfile.rows[1].patternId).toBeUndefined();
  // filter matching is unaffected by parsing
  expect(withProfile.rows[0].winner?.f.id).toBe("f1");

  const withoutProfile = computeView(lines, compiled);
  expect(withoutProfile.rows[0].fields).toBeUndefined();
  expect(withoutProfile.rows[0].winner?.f.id).toBe("f1");
});
