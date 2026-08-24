import { test, expect, mock } from "bun:test";
import { hasMatchBits, primeMatchCache } from "@/lib/match/cache";
import { compileAll } from "@/lib/match/compile";
import { scanAndResolve } from "@/lib/match/resolve";
import {
  jsScannedFilters,
  scanPlan,
  scanRemainingInJs,
  scanSpecs,
} from "@/lib/match/prime";
import { makeFilter } from "@/lib/defaults";
import type { Filter } from "@/types";

// The Rust `scan_lines` command hands back match bit sets that stand in for running
// each filter's RegExp over each line. These tests pin the contract the two sides
// share: the cache key, the bit layout, and that a bad hand-off downgrades rather
// than corrupting the view.

const LINES = [
  "alpha ERROR one",
  "beta warn two",
  "GAMMA error three",
  "delta",
];

function bitsFor(lines: string[], re: RegExp): Uint8Array {
  const bits = new Uint8Array((lines.length + 7) >> 3);
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) bits[i >> 3] |= 1 << (i & 7);
  }
  return bits;
}

test("primed bit sets drive scanAndResolve without re-scanning", () => {
  const lines = [...LINES];
  const f: Filter = makeFilter("error");
  const compiled = compileAll([f]);
  const re = compiled[0].re!;

  // The count is a SENTINEL, deliberately not the true match count (2). Priming
  // and looking up have to agree on the cache key, and passing the true count
  // would make this test pass even when they don't — the engine would just
  // re-scan and arrive at the same number. Only a real cache hit reports 42.
  primeMatchCache(lines, [
    { source: re.source, flags: re.flags, bits: bitsFor(lines, re), count: 42 },
  ]);
  expect(hasMatchBits(lines, re)).toBe(true);

  const view = scanAndResolve(lines, compiled);
  expect(view.counts[f.id]).toBe(42);
  // The bits themselves are real, so the per-row verdicts stay correct:
  // case-insensitive "error" wins lines 1 and 3.
  expect(view.rows[0].winner?.f.id).toBe(f.id);
  expect(view.rows[1].winner).toBeNull();
  expect(view.rows[2].winner?.f.id).toBe(f.id);
  expect(view.matchedCount).toBe(2);
});

test("hasMatchBits agrees with what scanAndResolve actually looks up", () => {
  // These two read the same cache through different call paths; when their key
  // formats drifted apart, hasMatchBits reported hits the engine never got.
  const lines = [...LINES];
  const f = makeFilter("beta", { caseSensitive: true });
  const compiled = compileAll([f]);
  const re = compiled[0].re!;

  expect(hasMatchBits(lines, re)).toBe(false);
  scanAndResolve(lines, compiled); // engine scans and caches under its own key
  expect(hasMatchBits(lines, re)).toBe(true);
});

test("a primed cache produces the same view as a cold scan", () => {
  const filters = [
    makeFilter("ERROR", { caseSensitive: true }),
    makeFilter("^beta", { regex: true }),
    makeFilter("warn", { exclude: true }),
  ];
  const compiled = compileAll(filters);

  const cold = scanAndResolve([...LINES], compiled);

  const primed = [...LINES];
  primeMatchCache(
    primed,
    compiled.map((c) => ({
      source: c.re!.source,
      flags: c.re!.flags,
      bits: bitsFor(primed, c.re!),
      count: 0, // counts are reported straight through; checked separately below
    })),
  );
  const warm = scanAndResolve(primed, compiled);

  expect(warm.rows.map((r) => r.winner?.f.id ?? null)).toEqual(
    cold.rows.map((r) => r.winner?.f.id ?? null),
  );
  expect(warm.rows.map((r) => r.excluded)).toEqual(
    cold.rows.map((r) => r.excluded),
  );
  expect(warm.matchedCount).toBe(cold.matchedCount);
  expect(warm.excludedCount).toBe(cold.excludedCount);
});

test("bit sets of the wrong length are ignored, not trusted", () => {
  const lines = [...LINES];
  const f = makeFilter("error");
  const compiled = compileAll([f]);
  const re = compiled[0].re!;

  // A scan of a different-length file: accepting it would shift every highlight.
  primeMatchCache(lines, [
    { source: re.source, flags: re.flags, bits: new Uint8Array(99), count: 4 },
  ]);
  expect(hasMatchBits(lines, re)).toBe(false);
  // The engine still gets the right answer by scanning itself.
  expect(scanAndResolve(lines, compiled).counts[f.id]).toBe(2);
});

test("priming never overwrites a bit set the engine computed itself", () => {
  const lines = [...LINES];
  const f = makeFilter("error");
  const compiled = compileAll([f]);
  const re = compiled[0].re!;

  scanAndResolve(lines, compiled); // engine scans and caches
  primeMatchCache(lines, [
    { source: re.source, flags: re.flags, bits: new Uint8Array(1), count: 999 },
  ]);
  expect(scanAndResolve(lines, compiled).counts[f.id]).toBe(2); // not 999
});

test("the cache is keyed by lines identity, so another file is unaffected", () => {
  const a = [...LINES];
  const b = [...LINES];
  const f = makeFilter("error");
  const compiled = compileAll([f]);
  const re = compiled[0].re!;
  primeMatchCache(a, [
    { source: re.source, flags: re.flags, bits: bitsFor(a, re), count: 2 },
  ]);
  expect(hasMatchBits(a, re)).toBe(true);
  expect(hasMatchBits(b, re)).toBe(false);
});

test("scanSpecs sends each source+flags once, skipping unusable filters", () => {
  const filters: Filter[] = [
    makeFilter("ERROR"),
    makeFilter("ERROR"), // duplicate → one cache entry, one scan
    makeFilter("ERROR", { caseSensitive: true }), // different flags → its own scan
    makeFilter(""), // empty → nothing to match
    makeFilter("(unclosed", { regex: true }), // invalid → no compiled regex
  ];
  const specs = scanSpecs(compileAll(filters));
  expect(specs).toEqual([
    { source: "ERROR", ci: true },
    { source: "ERROR", ci: false },
  ]);
});

test("scanAndPrime downgrades to a JS scan when the shell has no scan_lines", async () => {
  // Outside the desktop shell (e2e mock, browser dev) invoke rejects or answers
  // null — priming must return null and leave the cache untouched.
  mock.module("@tauri-apps/api/core", () => ({
    invoke: () => Promise.reject(new Error("no such command")),
  }));
  const { scanAndPrime } = await import("@/lib/match/prime");
  const lines = [...LINES];
  const f = makeFilter("error");
  const compiled = compileAll([f]);
  expect(
    await scanAndPrime("/x.log", undefined, lines, scanPlan(compiled)),
  ).toBeNull();
  expect(hasMatchBits(lines, compiled[0].re!)).toBe(false);
  expect(scanAndResolve(lines, compiled).counts[f.id]).toBe(2);
});

test("scanPlan scans a shared pattern once", () => {
  const filters = [
    makeFilter("ERROR"),
    makeFilter("warn"),
    makeFilter("ERROR"), // same source+flags as the first
  ];
  const { specs } = scanPlan(compileAll(filters));
  expect(specs).toEqual([
    { source: "ERROR", ci: true },
    { source: "warn", ci: true },
  ]);
});

test("a pattern the shell can't scan is named back to the user", async () => {
  // The whole point of the badge: a downgrade is invisible in the resulting view
  // (same rows, same colours — just seconds slower), so the only way a user can act
  // on it is if the filter that caused it says so.
  mock.module("@tauri-apps/api/core", () => ({
    invoke: () => Promise.reject(new Error("no such command")),
  }));
  const { scanAndPrime } = await import("@/lib/match/prime");
  const lines = [...LINES];
  const filters = [makeFilter("error"), makeFilter("warn")];
  const compiled = compileAll(filters);

  // Nothing scanned yet: absence of a record must read as "unknown", not "slow".
  expect(jsScannedFilters(lines, filters).size).toBe(0);

  await scanAndPrime("/x.log", undefined, lines, scanPlan(compiled));
  expect(jsScannedFilters(lines, filters)).toEqual(
    new Set([filters[0].id, filters[1].id]),
  );
  // Keyed by the lines array, exactly like the match cache — a different file that
  // happens to hold equal strings must not inherit the verdict.
  expect(jsScannedFilters([...LINES], filters).size).toBe(0);
});

// A pattern that is slow on purpose: an unbounded quantified class that can never
// reach its literal, over long lines. It is the shape that froze the window for
// seconds, so it is the one worth testing the slicing against.
const SLOW =
  "[" + String.fromCharCode(92) + "w" + String.fromCharCode(92) + "s]+zzz";
const LONG = Array.from({ length: 500 }, (_, i) =>
  ("line " + i + " ").repeat(40),
);

test("the JS fallback scan slices, yielding between slices", async () => {
  const f = makeFilter(SLOW, { regex: true });
  let yields = 0;
  const res = await scanRemainingInJs(LONG.slice(), [f], {
    yieldTo: async () => {
      yields++;
    },
  });
  expect(res).toEqual({ scanned: 1, cancelled: false });
  // The point of the exercise: it did NOT run to completion in one blocking go.
  expect(yields).toBeGreaterThan(0);
});

test("a cancelled JS scan caches nothing rather than a half-scanned bit set", async () => {
  // Half a bit set is worse than none: it would report the pattern as matching only
  // the lines scanned before the cancel, silently, for as long as the file is open.
  const lines = LONG.slice();
  const f = makeFilter(SLOW, { regex: true });
  const compiled = compileAll([f]);
  let cancelled = false;
  const res = await scanRemainingInJs(lines, [f], {
    yieldTo: async () => {
      cancelled = true;
    },
    cancelled: () => cancelled,
  });
  expect(res).toEqual({ scanned: 0, cancelled: true });
  expect(hasMatchBits(lines, compiled[0].re!)).toBe(false);
});

test("the JS fallback scan agrees with a straight scan", async () => {
  const lines = [...LINES];
  const f = makeFilter("error");
  const compiled = compileAll([f]);
  await scanRemainingInJs(lines, [f]);
  expect(hasMatchBits(lines, compiled[0].re!)).toBe(true);
  expect(scanAndResolve(lines, compiled).counts[f.id]).toBe(2);
});
