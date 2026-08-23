import { test, expect, mock } from "bun:test";
import {
  cacheKey,
  compileAll,
  scanAndResolve,
  primeMatchCache,
  hasMatchBits,
} from "@/lib/engine";
import {
  decomposeAnd,
  jsScannedFilters,
  scanPlan,
  scanRemainingInJs,
  scanSpecs,
} from "@/lib/scanPrime";
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

/** A `scan_lines` blob for `specs`, in the wire format `scan_text` emits. */
function blobFor(
  lines: string[],
  specs: { source: string; ci: boolean }[],
): ArrayBuffer {
  const nBytes = (lines.length + 7) >> 3;
  const buf = new ArrayBuffer(28 + specs.length * 4 + specs.length * nBytes);
  const dv = new DataView(buf);
  dv.setUint32(0, lines.length, true);
  dv.setUint32(4, specs.length, true);
  dv.setUint32(8, nBytes, true);
  dv.setUint32(12, 0, true); // no fallbacks
  const u8 = new Uint8Array(buf);
  const off = 28 + specs.length * 4;
  specs.forEach((sp, k) => {
    const bits = bitsFor(lines, new RegExp(sp.source, sp.ci ? "gi" : "g"));
    let count = 0;
    for (const b of bits) for (let i = 0; i < 8; i++) if (b & (1 << i)) count++;
    dv.setUint32(28 + k * 4, count, true);
    u8.set(bits, off + k * nBytes);
  });
  return buf;
}

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
  const { scanAndPrime } = await import("@/lib/scanPrime");
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
  const { specs, compositions } = scanPlan(compileAll(filters));
  expect(specs).toEqual([
    { source: "ERROR", ci: true },
    { source: "warn", ci: true },
  ]);
  expect(compositions).toEqual([]);
});

test("a pattern the shell can't scan is named back to the user", async () => {
  // The whole point of the badge: a downgrade is invisible in the resulting view
  // (same rows, same colours — just seconds slower), so the only way a user can act
  // on it is if the filter that caused it says so.
  mock.module("@tauri-apps/api/core", () => ({
    invoke: () => Promise.reject(new Error("no such command")),
  }));
  const { scanAndPrime } = await import("@/lib/scanPrime");
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

test("decomposeAnd accepts only what is exactly equivalent", () => {
  expect(decomposeAnd("(?=.*a)(?=.*b)")).toEqual(["a", "b"]);
  expect(decomposeAnd("(?=.*a)(?=.*b)(?=.*c)")).toEqual(["a", "b", "c"]);
  expect(decomposeAnd("(?=.*a)(?=.*b).*")).toEqual(["a", "b"]); // a bare `.*` tail is a no-op
  expect(decomposeAnd("(?=.*(a|b))(?=.*c)")).toEqual(["(a|b)", "c"]); // nested groups
  expect(decomposeAnd("(?=.*[)])(?=.*b)")).toEqual(["[)]", "b"]); // `)` inside a class
  // …and the rejections, each of which would be a WRONG bit set if accepted.
  expect(decomposeAnd("(?=.*a)")).toBeNull(); // one branch is not a conjunction
  expect(decomposeAnd("^(?=.*a)(?=.*b)")).toBeNull(); // anchored: p = 0 no longer free
  expect(decomposeAnd("(?=.*a)(?=.*b)tail")).toBeNull(); // a consuming tail
  expect(decomposeAnd(String.raw`(?=.*(a))(?=.*\1)`)).toBeNull(); // backref can't span a split
  expect(decomposeAnd("(?=.*^a)(?=.*b)")).toBeNull(); // re-anchored inside a branch
  expect(decomposeAnd("(?=.*a)(?=.*b")).toBeNull(); // unbalanced
  expect(decomposeAnd("plain")).toBeNull();
  // A top-level `|` breaks the "p = 0 is the weakest position" argument outright:
  // /(?=.*a|b)(?=.*c|d)/ does NOT match "cb", but the AND of /a|b/ and /c|d/ does.
  expect(decomposeAnd("(?=.*a|b)(?=.*c|d)")).toBeNull();
  expect(decomposeAnd("(?=.*wifi|wlan)(?=.*down)")).toBeNull();
  // …but a `|` nested inside a group or a class is still covered by the `.*`.
  expect(decomposeAnd("(?=.*(a|b))(?=.*c)")).toEqual(["(a|b)", "c"]);
  expect(decomposeAnd("(?=.*[a|b])(?=.*c)")).toEqual(["[a|b]", "c"]);
  // Lazy `.*?` is the same yes/no answer, so it is taken — with the `?` consumed,
  // not left on the front of the branch.
  expect(decomposeAnd("(?=.*?a)(?=.*b)")).toEqual(["a", "b"]);
  expect(decomposeAnd("(?=.**a)(?=.*b)")).toBeNull();
});

test("a lookahead conjunction is assembled from its branches, not scanned", async () => {
  // The branches come back from the scanner; the conjunction never goes to it at all.
  // Its bits have to be the AND — and they have to land under the key the ENGINE looks
  // the original pattern up by, or scanAndResolve just silently rescans it.
  const lines = [...LINES];
  const both = makeFilter("(?=.*error)(?=.*three)", { regex: true });
  const compiled = compileAll([both]);
  const plan = scanPlan(compiled);
  expect(plan.specs).toEqual([
    { source: "error", ci: true },
    { source: "three", ci: true },
  ]);
  expect(plan.compositions).toHaveLength(1);

  mock.module("@tauri-apps/api/core", () => ({
    invoke: (
      _cmd: string,
      args: { patterns: { source: string; ci: boolean }[] },
    ) => Promise.resolve(blobFor(lines, args.patterns)),
  }));
  const { scanAndPrime } = await import("@/lib/scanPrime");
  const res = await scanAndPrime("/x.log", undefined, lines, plan);
  expect(res?.composed).toBe(1);
  expect(jsScannedFilters(lines, [both]).size).toBe(0);

  // "error" hits lines 1 and 3; "three" hits line 3; the AND is line 3 alone.
  const view = scanAndResolve(lines, compiled);
  expect(view.counts[both.id]).toBe(1);
  expect(view.rows[2].winner?.f.id).toBe(both.id);
  expect(view.rows[0].winner).toBeNull();
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

test("a branch that is also a filter of its own is not treated as branch-only", () => {
  // Branch bit sets are kept out of the shared cache, so getting this wrong would
  // silently stop caching a real filter — and the LRU it protects is the reason the
  // distinction exists at all.
  const plan = scanPlan(
    compileAll([
      makeFilter("(?=.*wifi)(?=.*down)", { regex: true }),
      makeFilter("wifi"), // the same pattern, wanted directly
    ]),
  );
  expect(plan.branchOnly).toEqual(new Set([cacheKey("down", "gi")]));
});

test("a line separator in the file refuses the composition instead of over-matching", async () => {
  // `.` never crosses U+2028, so `(?=.*a)(?=.*b)` is FALSE on "a<U+2028>b" while both
  // branches are true. Composing there would set a bit the filter does not match, and
  // verify() samples — it would not reliably catch it.
  const SEP = String.fromCharCode(0x2028);
  const lines = ["alpha" + SEP + "beta", "alpha beta", "neither"];
  const both = makeFilter("(?=.*alpha)(?=.*beta)", { regex: true });
  const compiled = compileAll([both]);
  const plan = scanPlan(compiled);
  expect(plan.compositions).toHaveLength(1);

  mock.module("@tauri-apps/api/core", () => ({
    invoke: (
      _cmd: string,
      args: { patterns: { source: string; ci: boolean }[] },
    ) => Promise.resolve(blobFor(lines, args.patterns)),
  }));
  const { scanAndPrime } = await import("@/lib/scanPrime");
  const res = await scanAndPrime("/x.log", undefined, lines, plan);
  expect(res?.composed).toBe(0);
  // …and it is reported as JS-scanned, so the badge tells the user why.
  expect(jsScannedFilters(lines, [both])).toEqual(new Set([both.id]));
  // The engine then scans it itself and gets the right answer: line 2 only.
  expect(scanAndResolve(lines, compiled).counts[both.id]).toBe(1);
});
