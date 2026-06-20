import { test, expect } from "bun:test";
import { scanMatches, groupSegments } from "@/logic";

// --- scanMatches -------------------------------------------------------------

test("scanMatches counts every hit but caps samples at the limit", () => {
  const lines = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? `err ${i}` : `ok ${i}`));
  const { count, samples } = scanMatches(lines, /err/g, 10);
  expect(count).toBe(25);
  expect(samples.length).toBe(10);
  expect(samples[0]).toEqual({ n: 1, text: "err 0" });
  expect(samples[9]).toEqual({ n: 19, text: "err 18" });
});

test("scanMatches resets lastIndex between lines (g-flag regex)", () => {
  // Without the reset a sticky lastIndex would skip alternating lines.
  const lines = ["abc", "abc", "abc"];
  expect(scanMatches(lines, /b/g).count).toBe(3);
});

test("scanMatches on no hits returns empty", () => {
  expect(scanMatches(["x", "y"], /z/g)).toEqual({ count: 0, samples: [] });
});

// --- groupSegments -----------------------------------------------------------

const joined = (segs: { t: string }[]) => segs.map((s) => s.t).join("");

test("groupSegments tags named-group spans with their palette index", () => {
  const re = /err=(?<code>0x[0-9A-F]+) at (?<ts>\d+)/gd;
  const text = "boot err=0x1A at 123 done";
  const segs = groupSegments(text, re, ["code", "ts"]);
  expect(joined(segs)).toBe(text);
  expect(segs).toEqual([
    { t: "boot ", hit: false },
    { t: "err=", hit: true },
    { t: "0x1A", hit: true, group: 0 },
    { t: " at ", hit: true },
    { t: "123", hit: true, group: 1 },
    { t: " done", hit: false },
  ]);
});

test("groupSegments handles multiple matches per line", () => {
  const re = /id=(?<id>\d+)/gd;
  const segs = groupSegments("id=1 x id=2", re, ["id"]);
  expect(segs.filter((s) => s.group === 0).map((s) => s.t)).toEqual(["1", "2"]);
});

test("groupSegments with no named groups degrades to plain hit spans", () => {
  const segs = groupSegments("a err b", /err/gd, []);
  expect(segs).toEqual([
    { t: "a ", hit: false },
    { t: "err", hit: true },
    { t: " b", hit: false },
  ]);
});

test("groupSegments survives optional groups that did not participate", () => {
  const re = /a(?<x>\d+)?b/gd;
  const segs = groupSegments("ab", re, ["x"]);
  expect(joined(segs)).toBe("ab");
  expect(segs.some((s) => s.group !== undefined)).toBe(false);
});

test("groupSegments does not loop on zero-width matches", () => {
  const segs = groupSegments("abc", /(?<e>)/gd, ["e"]);
  expect(joined(segs)).toBe("abc");
});

test("nested named groups: inner (later) group wins the overlap", () => {
  const re = /(?<outer>a(?<inner>\d+)z)/gd;
  const segs = groupSegments("-a42z-", re, ["outer", "inner"]);
  expect(segs).toEqual([
    { t: "-", hit: false },
    { t: "a", hit: true, group: 0 },
    { t: "42", hit: true, group: 1 },
    { t: "z", hit: true, group: 0 },
    { t: "-", hit: false },
  ]);
});

test("groupSegments on empty text", () => {
  expect(groupSegments("", /x/gd, [])).toEqual([{ t: "", hit: false }]);
});
