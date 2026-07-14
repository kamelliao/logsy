import { test, expect } from "bun:test";
import { fuzzyMatch } from "@/lib/fuzzy";

/** Best-first ranking of `names` for `query` (non-matches dropped). */
function rank(query: string, names: string[]): string[] {
  return names
    .map((name) => ({ name, hit: fuzzyMatch(query, name) }))
    .filter((r) => r.hit)
    .sort((a, b) => b.hit!.score - a.hit!.score)
    .map((r) => r.name);
}

test("a contiguous substring outranks a scattered subsequence", () => {
  // Both match "boot" — but only the first one actually contains it.
  expect(rank("boot", ["boot.log", "b-o-o-t-x.log"])[0]).toBe("boot.log");
});

test("an earlier / word-start match outranks a later one", () => {
  expect(rank("wifi", ["wifi-scan.log", "dev-wifi.log"])[0]).toBe(
    "wifi-scan.log",
  );
});

test("a substring hit highlights exactly the matched run", () => {
  const hit = fuzzyMatch("scan", "wifi-scan.log");
  expect(hit?.idx).toEqual([5, 6, 7, 8]);
});

test("a subsequence still matches when no substring does", () => {
  const hit = fuzzyMatch("wsc", "wifi-scan.log");
  expect(hit).not.toBeNull();
  expect(hit!.idx).toEqual([0, 5, 6]); // w…s c
});

test("characters out of order never match", () => {
  expect(fuzzyMatch("csw", "wifi-scan.log")).toBeNull();
});

test("matching is case-insensitive", () => {
  expect(fuzzyMatch("ERROR", "error-dump.log")).not.toBeNull();
});
