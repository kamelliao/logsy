import { test, expect } from "bun:test";
import { tokenize, buildPattern, assignNames, type GenToken } from "../lib/generalize";

const kinds = (s: string) => tokenize(s).map((t) => `${t.kind}:${t.raw}`);

// --- tokenize: detection & precedence ----------------------------------------

test("firmware-ish line tokenizes into typed runs", () => {
  expect(kinds("err=0x1A2B retry 3 at 12:30:01.442")).toEqual([
    "text:err=", "hex:0x1A2B", "ws: ", "text:retry", "ws: ",
    "int:3", "ws: ", "text:at", "ws: ", "time:12:30:01.442",
  ]);
});

test("timestamp wins over int (12:30 is one token)", () => {
  expect(kinds("12:30 ok")).toEqual(["time:12:30", "ws: ", "text:ok"]);
});

test("float wins over int", () => {
  expect(kinds("3.14V")).toEqual(["float:3.14", "text:V"]);
});

test("bare hex needs ≥4 chars and at least one letter", () => {
  expect(kinds("deadBEEF")).toEqual(["hex:deadBEEF"]);
  expect(kinds("1234")).toEqual(["int:1234"]); // all digits → int
  expect(kinds("fee")).toEqual(["text:fee"]); // too short → text
});

test("adjacent literal chars merge into one text token", () => {
  expect(kinds("[wifi]")).toEqual(["text:[wifi]"]);
});

test("no MAC/IP special-casing: dotted quad is ints and dots", () => {
  expect(kinds("10.0.0.1")).toEqual(["float:10.0", "text:.", "float:0.1"]);
});

// --- defaults ------------------------------------------------------------------

test("data tokens start generalized, text starts exact", () => {
  const toks = tokenize("err 42");
  expect(toks.map((t) => t.state)).toEqual(["exact", "general", "general"]);
});

// --- buildPattern ---------------------------------------------------------------

test("generalized pattern matches sibling lines, not just the original", () => {
  const toks = tokenize("err=0x1A2B retry 3");
  const re = new RegExp(buildPattern(toks));
  expect(re.test("err=0x1A2B retry 3")).toBe(true);
  expect(re.test("err=0xFF retry 12")).toBe(true);
  expect(re.test("warn=0xFF retry 12")).toBe(false);
});

test("whitespace generalizes to \\s+ so alignment changes still match", () => {
  const re = new RegExp(buildPattern(tokenize("a 1")));
  expect(re.test("a    42")).toBe(true);
});

test("exact state escapes regex metacharacters", () => {
  const toks = tokenize("a+b (c)");
  expect(new RegExp(buildPattern(toks)).test("a+b (c)")).toBe(true);
});

test("exact state on a data token pins the literal value", () => {
  const toks = tokenize("err=0x1A");
  toks[1].state = "exact";
  const re = new RegExp(buildPattern(toks));
  expect(re.test("err=0x1A")).toBe(true);
  expect(re.test("err=0xFF")).toBe(false);
});

test("capture state emits a working named group", () => {
  const toks = tokenize("err=0x1A retry 3");
  toks[1].state = "capture"; // hex
  toks[5].state = "capture"; // int
  const pattern = buildPattern(toks);
  expect(pattern).toBe("err=(?<hex>0x[0-9A-Fa-f]+)\\s+retry\\s+(?<num>\\d+)");
  const m = new RegExp(pattern).exec("err=0xFF retry 12");
  expect(m?.groups).toEqual({ hex: "0xFF", num: "12" });
});

test("timestamp keeps separators, generalizes digits", () => {
  const toks = tokenize("12:30:01.442");
  expect(buildPattern(toks)).toBe("\\d+:\\d+:\\d+\\.\\d+");
});

// --- assignNames ----------------------------------------------------------------

test("default capture names dedupe with numeric suffixes", () => {
  const toks = tokenize("1 2 3");
  for (const t of toks) if (t.kind === "int") t.state = "capture";
  expect(assignNames(toks).filter(Boolean)).toEqual(["num", "num2", "num3"]);
});

test("user names are kept when valid, replaced when invalid", () => {
  const mk = (name?: string): GenToken => ({ raw: "7", kind: "int", state: "capture", name });
  expect(assignNames([mk("addr")])).toEqual(["addr"]);
  expect(assignNames([mk("9bad")])).toEqual(["num"]); // invalid → default
  expect(assignNames([mk("a"), mk("a")])).toEqual(["a", "a2"]); // collision
});
