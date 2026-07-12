import { test, expect } from "bun:test";
import { initialState, normalizeState } from "@/lib/defaults";
import type { AppState, LogFile, SplitView } from "@/types";

function makeFile(id: string, name = id + ".log"): LogFile {
  return { id, name, path: `/logs/${name}`, lineCount: 0 } as LogFile;
}

/** A persisted workspace with `files` open and whatever splitView is handed in. */
function stateWith(
  files: LogFile[],
  splitView?: unknown,
  activeFileId?: string | null,
): AppState {
  return {
    ...initialState(),
    files,
    activeFileId: activeFileId ?? files[0]?.id ?? null,
    splitView: splitView as SplitView | undefined,
  };
}

const sv = (s: AppState) => s.splitView!;

test("a workspace with no saved layout gets one pane holding the active file", () => {
  const s = normalizeState(stateWith([makeFile("f1")], undefined));
  expect(sv(s).panes).toHaveLength(1);
  expect(sv(s).panes[0].tabs).toEqual(["f1"]);
  expect(sv(s).panes[0].active).toBe("f1");
  expect(sv(s).activePaneId).toBe(sv(s).panes[0].id);
});

test("a restored layout keeps its panes, tabs and focus", () => {
  const s = normalizeState(
    stateWith([makeFile("f1"), makeFile("f2"), makeFile("f3")], {
      dir: "v",
      panes: [
        { id: "p1", tabs: ["f1", "f2"], active: "f2" },
        { id: "p2", tabs: ["f3"], active: "f3" },
      ],
      activePaneId: "p2",
      sizes: { p1: 60, p2: 40 },
    }),
  );
  expect(sv(s).dir).toBe("v");
  expect(sv(s).panes.map((p) => p.id)).toEqual(["p1", "p2"]);
  expect(sv(s).activePaneId).toBe("p2");
  expect(sv(s).sizes).toEqual({ p1: 60, p2: 40 });
  // The focused pane's active tab wins: it IS the app's active file.
  expect(s.activeFileId).toBe("f3");
});

test("tabs for logs that are no longer open are pruned", () => {
  const s = normalizeState(
    stateWith([makeFile("f1")], {
      dir: "h",
      panes: [{ id: "p1", tabs: ["f1", "gone"], active: "gone" }],
      activePaneId: "p1",
    }),
  );
  expect(sv(s).panes[0].tabs).toEqual(["f1"]);
  // The active tab pointed at the closed log → falls back to a surviving one.
  expect(sv(s).panes[0].active).toBe("f1");
});

test("a pane whose every log is gone is dropped, and its size with it", () => {
  const s = normalizeState(
    stateWith([makeFile("f1")], {
      dir: "h",
      panes: [
        { id: "p1", tabs: ["f1"], active: "f1" },
        { id: "p2", tabs: ["gone"], active: "gone" },
      ],
      activePaneId: "p2",
      sizes: { p1: 50, p2: 50 },
    }),
  );
  expect(sv(s).panes.map((p) => p.id)).toEqual(["p1"]);
  // Focus was on the dropped pane → re-homed onto the survivor, as is the file.
  expect(sv(s).activePaneId).toBe("p1");
  expect(s.activeFileId).toBe("f1");
  expect(sv(s).sizes).toEqual({ p1: 50 });
});

test("one pane always survives, even when every log it held is closed", () => {
  const s = normalizeState(
    stateWith([], {
      dir: "h",
      panes: [{ id: "p1", tabs: ["gone"], active: "gone" }],
      activePaneId: "p1",
    }),
  );
  expect(sv(s).panes).toHaveLength(1);
  expect(sv(s).panes[0].tabs).toEqual([]);
  expect(sv(s).activePaneId).toBe(sv(s).panes[0].id);
});

test("a malformed layout is repaired rather than trusted", () => {
  const s = normalizeState(
    stateWith([makeFile("f1"), makeFile("f2")], {
      dir: "sideways",
      panes: [
        { id: "p1", tabs: ["f1", "f1", "f2"], active: 42 }, // dupe tab, bad active
        { id: "p1", tabs: ["f2"], active: "f2" }, // duplicate pane id
        null,
      ],
      activePaneId: "nope", // points at no pane
      sizes: { p1: -5, ghost: 30 }, // invalid + orphaned size
    }),
  );
  expect(sv(s).dir).toBe("h"); // unknown axis → the default
  expect(sv(s).panes).toHaveLength(1);
  expect(sv(s).panes[0].tabs).toEqual(["f1", "f2"]);
  expect(sv(s).panes[0].active).toBe("f2"); // non-string active → last tab
  expect(sv(s).activePaneId).toBe("p1");
  expect(sv(s).sizes).toBeUndefined(); // nothing valid survived
});

test("the retired splitRatio field is dropped from a restored workspace", () => {
  const s = normalizeState({
    ...stateWith([makeFile("f1")]),
    splitRatio: 0.5,
  } as AppState & { splitRatio: number });
  expect("splitRatio" in s).toBe(false);
});
