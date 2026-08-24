import { test, expect } from "bun:test";
import { scanAll } from "@/lib/match/cache";
import { compileAll } from "@/lib/match/compile";
import { resolve, scanAndResolve } from "@/lib/match/resolve";
import { makeFilter } from "@/lib/defaults";
import type { Filter } from "@/types";

// Phase B of the match pipeline (docs/design-match.md): bit sets + filter list -> view.
// The contract worth pinning is not "it returns a view" but the two halves of the split:
// resolve NEVER scans, and given a warm cache it agrees with what the filters actually
// match — checked against an independent oracle rather than against the previous
// implementation, so a shared misunderstanding can't pass.

const LINES = [
  "00:00:01.000 [INFO ] wifi: connected to AP rssi=-42",
  "00:00:02.000 [ERROR] pmic: battery 3300mV 42% temp=31C",
  "00:00:03.000 [WARN ] wifi: packet dropped seq=17 retries=3",
  "00:00:04.000 [DEBUG] usb: state -> idle after 12ms",
  "00:00:05.000 [ERROR] wifi: checksum mismatch want=0xab got=0xcd",
  "plain line with no structure at all",
];

/**
 * What the view MUST say, computed the slow obvious way: walk the filters in order,
 * first enabled non-exclude match wins the colour, any enabled exclude hides the line.
 */
function oracle(lines: string[], filters: Filter[]) {
  const hit = (f: Filter, line: string) =>
    new RegExp(
      f.regex ? f.pattern : f.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      f.caseSensitive ? "" : "i",
    ).test(line);
  const winners: (string | null)[] = [];
  const excluded: boolean[] = [];
  const counts: Record<string, number> = {};
  for (const f of filters) counts[f.id] = 0;
  for (const line of lines) {
    let winner: string | null = null;
    let hide = false;
    for (const f of filters) {
      if (!f.pattern) continue;
      if (!hit(f, line)) continue;
      counts[f.id]++;
      if (!f.enabled) continue;
      if (f.exclude) hide = true;
      else if (winner === null) winner = f.id;
    }
    winners.push(winner);
    excluded.push(hide);
  }
  return { winners, excluded, counts };
}

function check(filters: Filter[], label: string) {
  const lines = [...LINES];
  const compiled = compileAll(filters);
  const view = scanAndResolve(lines, compiled);
  const want = oracle(lines, filters);
  expect(
    view.pending.size,
    `${label}: nothing should be pending after a scan`,
  ).toBe(0);
  for (let i = 0; i < lines.length; i++) {
    expect(
      view.rows[i].winner?.f.id ?? null,
      `${label}: winner on line ${i}`,
    ).toBe(want.winners[i]);
    expect(view.rows[i].excluded, `${label}: excluded on line ${i}`).toBe(
      want.excluded[i],
    );
  }
  for (const f of filters)
    expect(view.counts[f.id], `${label}: count for ${f.pattern}`).toBe(
      want.counts[f.id],
    );
}

const base = (): Filter[] => [
  makeFilter("wifi"),
  makeFilter("ERROR"),
  makeFilter("\\d+mV", { regex: true }),
  makeFilter("DEBUG", { exclude: true }),
  makeFilter("no-such-text"),
];

test("resolve agrees with an independent oracle across filter arrangements", () => {
  check(base(), "base");

  // Order decides the colour winner, and only the order — the bit sets are identical.
  const reordered = base();
  reordered.reverse();
  check(reordered, "reordered");

  // Disabling must not change any count (badges show potential matches) but must
  // remove the filter from winner/exclude selection.
  const disabled = base();
  disabled[0].enabled = false;
  disabled[3].enabled = false;
  check(disabled, "wifi + the exclude disabled");

  // A highlight promoted to an exclude, and vice versa.
  const flipped = base();
  flipped[1].exclude = true;
  flipped[3].exclude = false;
  check(flipped, "ERROR excludes, DEBUG highlights");

  // Every filter off: no winners, no exclusions, counts still populated.
  const allOff = base().map((f) => ({ ...f, enabled: false }));
  check(allOff, "all disabled");
});

test("resolve reports a missing bit set instead of computing it", () => {
  // The invariant the whole split exists for. `resolve` on a cold cache must not scan:
  // it reports the filter as pending and contributes nothing for it.
  const lines = [...LINES];
  const filters = base();
  const compiled = compileAll(filters);

  const cold = resolve(lines, compiled);
  expect(cold.pending.size).toBe(filters.filter((f) => f.pattern).length);
  expect(cold.rows.every((r) => r.winner === null)).toBe(true);
  expect(cold.rows.every((r) => !r.excluded)).toBe(true);
  expect(cold.matchedCount).toBe(0);

  // …and once the cache is warm, the same call resolves fully. Nothing else changed.
  scanAll(lines, compiled);
  const warm = resolve(lines, compiled);
  expect(warm.pending.size).toBe(0);
  expect(warm.matchedCount).toBeGreaterThan(0);
});

test("a partially scanned set resolves the filters it has", () => {
  // What progressive rendering will actually look like: some bit sets present, the
  // rest pending. The present ones must resolve exactly as if they were the whole set.
  const lines = [...LINES];
  const filters = base();
  const compiled = compileAll(filters);
  scanAll(lines, [compiled[1]]); // only "ERROR"

  const view = resolve(lines, compiled);
  expect(view.pending.has(filters[1].id)).toBe(false);
  expect(view.pending.has(filters[0].id)).toBe(true);
  // "ERROR" wins every line it matches, because nothing above it has been scanned.
  expect(view.rows[1].winner?.f.id).toBe(filters[1].id);
  expect(view.rows[4].winner?.f.id).toBe(filters[1].id);
  expect(view.rows[0].winner).toBeNull();
  expect(view.counts[filters[1].id]).toBe(2);
  expect(view.counts[filters[0].id]).toBe(0); // pending: a placeholder, not a result
});

test("a pending exclude is called out separately from a pending highlight", () => {
  // The two are different kinds of wrong: a pending highlight leaves the view
  // incomplete, a pending exclude leaves it INCORRECT (lines that should be hidden are
  // on screen). The header says so only for the second.
  const lines = [...LINES];
  const filters = base();
  const compiled = compileAll(filters);

  expect(resolve(lines, compiled).pendingExcludes).toBe(true);

  // Scan only the exclude: highlights stay pending, but nothing is being shown that
  // should be hidden any more.
  scanAll(lines, [compiled[3]]);
  const partial = resolve(lines, compiled);
  expect(partial.pending.size).toBeGreaterThan(0);
  expect(partial.pendingExcludes).toBe(false);
  expect(partial.excludedCount).toBe(1);

  // A DISABLED exclude cannot hide anything, so it never counts.
  const off = base();
  off[3].enabled = false;
  expect(resolve([...LINES], compileAll(off)).pendingExcludes).toBe(false);
});
