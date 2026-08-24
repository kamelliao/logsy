import { test, expect, mock } from "bun:test";
import { compileAll } from "@/lib/match/compile";
import { resolve } from "@/lib/match/resolve";
import { makeFilter } from "@/lib/defaults";

// Phase A's driver (docs/design-match.md). No Tauri shell here, so everything falls to
// the sliced JS scan — which is the interesting path anyway: it is the one that can be
// interrupted, duplicated or left half-done.
mock.module("@tauri-apps/api/core", () => ({
  invoke: () => Promise.reject(new Error("no shell")),
}));

const LINES = [
  "wifi connected",
  "pmic battery low",
  "wifi disconnected",
  "usb attached",
];

test("ensureMatched leaves nothing pending", async () => {
  const { ensureMatched } = await import("@/lib/match/ensure");
  const lines = [...LINES];
  const filters = [makeFilter("wifi"), makeFilter("pmic"), makeFilter("usb")];
  expect(resolve(lines, compileAll(filters)).pending.size).toBe(3);

  await ensureMatched("/x.log", undefined, lines, filters);
  const view = resolve(lines, compileAll(filters));
  expect(view.pending.size).toBe(0);
  expect(view.counts[filters[0].id]).toBe(2);
});

test("concurrent ensures over one document do the work once", async () => {
  // Two panes on the same file, or a filter edit landing mid-open. Without a queue
  // both see a cold cache and scan the same patterns — the check inside `primeFilters`
  // can only see what has already FINISHED.
  const { ensureMatched } = await import("@/lib/match/ensure");
  const lines = [...LINES];
  const filters = [makeFilter("wifi"), makeFilter("usb")];

  const [a, b, c] = await Promise.all([
    ensureMatched("/x.log", undefined, lines, filters),
    ensureMatched("/x.log", undefined, lines, filters),
    ensureMatched("/x.log", undefined, lines, filters),
  ]);
  expect(a.jsScanned).toBe(2);
  expect(b.jsScanned).toBe(0);
  expect(c.jsScanned).toBe(0);
  expect(resolve(lines, compileAll(filters)).pending.size).toBe(0);
});

test("an enabled exclude is scanned before the highlights", async () => {
  // A pending highlight costs a colour; a pending exclude shows lines that should be
  // hidden. Ordering is how the second window is kept short, so it is worth pinning.
  const { ensureMatched } = await import("@/lib/match/ensure");
  const lines = [...LINES];
  const hide = makeFilter("usb", { exclude: true });
  const filters = [makeFilter("wifi"), makeFilter("pmic"), hide];

  let sawExcludeFirst = false;
  let checked = false;
  await ensureMatched("/x.log", undefined, lines, filters, {
    onProgress: () => {
      if (checked) return;
      checked = true;
      // First report: the exclude must already be resolvable.
      sawExcludeFirst = !resolve(lines, compileAll(filters)).pendingExcludes;
    },
  });
  expect(sawExcludeFirst).toBe(true);
});

test("a cancelled ensure reports it and leaves the rest pending", async () => {
  const { ensureMatched } = await import("@/lib/match/ensure");
  const lines = [...LINES];
  const filters = [makeFilter("wifi"), makeFilter("pmic"), makeFilter("usb")];

  const res = await ensureMatched("/x.log", undefined, lines, filters, {
    cancelled: () => true,
  });
  expect(res.cancelled).toBe(true);
  // Cancelled before any pattern finished, so the view still reports them all — never
  // as "no matches", which is the distinction the whole `pending` set exists for.
  expect(resolve(lines, compileAll(filters)).pending.size).toBe(3);
});
