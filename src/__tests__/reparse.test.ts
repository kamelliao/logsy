import { test, expect } from "bun:test";
import { tokenize, buildPattern, type GenToken } from "@/lib/generalize";
import { parsePattern, realizeRaws, reparsePattern } from "@/lib/reparse";

// The core contract: parsePattern is a left-inverse of buildPattern *up to* the
// emitted regex — parsePattern(buildPattern(t)) need not reproduce t's kinds, but
// must reproduce its pattern. Everything else builds on that round-trip.
function roundTrips(pattern: string) {
  const toks = parsePattern(pattern);
  expect(toks).not.toBeNull();
  expect(buildPattern(toks!)).toBe(pattern);
  return toks!;
}

// --- round-trip on builder output -------------------------------------------

test("inverts a fully-generalized firmware line", () => {
  const pattern = buildPattern(tokenize("err=0x1A2B retry 3 at 12:30:01.442"));
  roundTrips(pattern);
});

test("inverts a pattern with named captures", () => {
  const toks = tokenize("err=0x1A retry 3");
  toks[1].state = "capture"; // hex
  toks[5].state = "capture"; // int
  const pattern = buildPattern(toks);
  const back = roundTrips(pattern);
  const caps = back.filter((t) => t.state === "capture");
  expect(caps.map((t) => t.name)).toEqual(["hex", "num"]);
  expect(caps.map((t) => t.kind)).toEqual(["hex", "int"]);
});

test("disambiguates time vs float vs int", () => {
  expect(parsePattern("\\d+:\\d+:\\d+\\.\\d+")![0].kind).toBe("time");
  expect(parsePattern("\\d+\\.\\d+")![0].kind).toBe("float");
  expect(parsePattern("\\d+")![0].kind).toBe("int");
});

test("recognizes both hex forms and whitespace", () => {
  expect(parsePattern("0x[0-9A-Fa-f]+")![0].kind).toBe("hex");
  expect(parsePattern("[0-9A-Fa-f]+")![0].kind).toBe("hex");
  expect(parsePattern("\\s+")![0].kind).toBe("ws");
});

test("a merged capture (.+) round-trips as a merged chip", () => {
  const raw = tokenize("wifi connect failed");
  const toks = [
    raw[0],
    raw[1],
    { raw: "x", kind: "merged", state: "capture", name: "msg" } as GenToken,
  ];
  const pattern = buildPattern(toks); // wifi\s+(?<msg>.+)
  const back = roundTrips(pattern);
  expect(back[2].kind).toBe("merged");
  expect(back[2].name).toBe("msg");
});

test("literal text with regex metacharacters is not mistaken for a general form", () => {
  // escapeRegex turns these into \.-\[-\( etc; the parser must keep them literal.
  roundTrips(buildPattern(tokenize("a+b (c) [d] e.f \\g")));
});

// --- bail-out on foreign / hand-edited regex --------------------------------

test("returns null for regex outside the builder grammar", () => {
  expect(parsePattern("\\w+")).toBeNull(); // \w isn't an emitted form
  expect(parsePattern("foo(bar)?")).toBeNull(); // unescaped group + quantifier
  expect(parsePattern("\\d+|\\w")).toBeNull(); // alternation
  expect(parsePattern("a.*b")).toBeNull(); // bare .* (only .+ is emitted)
});

// --- realizeRaws: dress chips with real sample text -------------------------

test("realizeRaws swaps synthetic raws for the line's real substrings", () => {
  const pattern = "err=(?<hex>0x[0-9A-Fa-f]+)\\s+retry\\s+(?<num>\\d+)";
  const toks = parsePattern(pattern)!;
  const dressed = realizeRaws(toks, "err=0xFF  retry 12", "");
  const byRaw = dressed.map((t) => t.raw);
  expect(byRaw).toContain("0xFF");
  expect(byRaw).toContain("12");
  expect(byRaw).toContain("retry");
  // Real text must re-generalize to the exact same pattern.
  expect(buildPattern(dressed)).toBe(pattern);
});

test("realizeRaws leaves tokens untouched when the line doesn't match", () => {
  const toks = parsePattern("err=\\d+")!;
  expect(realizeRaws(toks, "nothing here", "")).toBe(toks);
});

test("reparsePattern end-to-end with a sample line", () => {
  const pattern = buildPattern(tokenize("temp 3.14 at 12:30"));
  const toks = reparsePattern(pattern, "temp 27.5 at 09:45");
  expect(toks).not.toBeNull();
  expect(buildPattern(toks!)).toBe(pattern);
  expect(toks!.map((t) => t.raw)).toContain("27.5");
});

test("reparsePattern returns null for a non-builder pattern even with a line", () => {
  expect(reparsePattern("\\w+", "anything")).toBeNull();
});
