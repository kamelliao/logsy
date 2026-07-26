import { test, expect, beforeEach } from "bun:test";
import { useStore } from "@/store";
import { initialState, normalizeState, makeFilter } from "@/lib/defaults";
import type { AppState, FilterSet } from "@/types";

// Switching filter sets pre-scans the incoming set's patterns before activating it,
// so the render that follows doesn't do the cold O(lines × filters) scan on the main
// thread. That only holds if the switch AWAITS the scan — priming afterwards is a
// render too late, and the failure is invisible: the view is still correct, just
// slow again. These pin the ordering.

function setOf(id: string, pattern: string): FilterSet {
  return {
    id,
    name: id,
    filters: [makeFilter(pattern)],
    groups: [],
    order: [],
  };
}

const setActiveSetId = (): string | null | undefined =>
  useStore.getState().doc.files[0]?.activeSetId;

beforeEach(() => {
  const base = normalizeState(initialState());
  const doc: AppState = {
    ...base,
    files: [
      {
        id: "f1",
        name: "a.log",
        path: "/a.log",
        lineCount: 3,
        activeSetId: "s1",
      },
    ],
    activeFileId: "f1",
    filterSets: [setOf("s1", "alpha"), setOf("s2", "beta")],
  };
  useStore.setState({ doc });
});

test("switchSet waits for the pre-scan before activating the set", async () => {
  let release!: () => void;
  const asked: string[] = [];
  useStore.getState().setRuntime({
    primeSet: (id) => {
      asked.push(id);
      return new Promise<void>((r) => {
        release = r;
      });
    },
  });

  const done = useStore.getState().switchSet("s2");
  // Scan requested for the INCOMING set, and the selection has not moved yet —
  // if it had, the next render would scan those filters cold.
  expect(asked).toEqual(["s2"]);
  expect(setActiveSetId()).toBe("s1");

  release();
  await done;
  expect(setActiveSetId()).toBe("s2");
});

test("a later switch wins even if an earlier scan finishes after it", async () => {
  const release: Record<string, () => void> = {};
  useStore.getState().setRuntime({
    primeSet: (id) =>
      new Promise<void>((r) => {
        release[id] = r;
      }),
  });

  const first = useStore.getState().switchSet("s2");
  const second = useStore.getState().switchSet("s1");

  // The slow first scan lands last; applying it would yank the user off the set
  // they picked second.
  release["s1"]();
  await second;
  release["s2"]();
  await first;

  expect(setActiveSetId()).toBe("s1");
});

test("switchSet still works with no primeSet bound", async () => {
  // Nothing binds it outside the app (tests, e2e); the switch must not hang.
  useStore.setState({ primeSet: undefined });
  await useStore.getState().switchSet("s2");
  expect(setActiveSetId()).toBe("s2");
});
