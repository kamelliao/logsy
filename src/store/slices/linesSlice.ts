import type { StoreSet } from "@/store";
import { activeFile } from "@/state/selectors";

// Compare/timeline pinned lines: persisted per file, NOT on the undo stack. Both
// edit a `{ [fileId]: number[] }` map on the active file via this shared mutator.
type LinesKey = "compareLinesByFile" | "timelineLinesByFile";

function mutateLines(
  set: StoreSet,
  key: LinesKey,
  fn: (cur: Set<number>) => void,
) {
  set((st) => {
    const fid = activeFile(st.doc)?.id;
    if (!fid) return {};
    const cur = new Set(st.doc[key]?.[fid] ?? []);
    fn(cur);
    return {
      doc: { ...st.doc, [key]: { ...(st.doc[key] ?? {}), [fid]: [...cur] } },
    };
  });
}

// Per-lane timeline opt-outs (see `timelineExcludedByFile`): a string set per file,
// each entry `line filterId timeField` (built with `timelineExcludeKey`).
function mutateTimelineExcluded(set: StoreSet, fn: (cur: Set<string>) => void) {
  set((st) => {
    const fid = activeFile(st.doc)?.id;
    if (!fid) return {};
    const cur = new Set(st.doc.timelineExcludedByFile?.[fid] ?? []);
    fn(cur);
    return {
      doc: {
        ...st.doc,
        timelineExcludedByFile: {
          ...(st.doc.timelineExcludedByFile ?? {}),
          [fid]: [...cur],
        },
      },
    };
  });
}

/** Drop every opt-out whose line is in `ns` — used when those lines leave the
 *  timeline (or are re-added), so a stale opt-out can't hide a later re-add. */
function pruneExcludedForLines(cur: Set<string>, ns: number[]) {
  const gone = new Set(ns);
  for (const k of [...cur])
    if (gone.has(Number(k.slice(0, k.indexOf(" "))))) cur.delete(k);
}

/** Compare- and timeline-panel pinned lines, per file. Persisted, off the undo stack. */
export interface LinesActions {
  addToCompare: (ns: number[]) => void;
  removeFromCompare: (ns: number[]) => void;
  clearCompare: () => void;
  addToTimeline: (ns: number[]) => void;
  removeFromTimeline: (ns: number[]) => void;
  clearTimeline: () => void;
  /** Add per-lane opt-outs (keys from `timelineExcludeKey`) — a line off ONE lane. */
  addTimelineExcluded: (keys: string[]) => void;
  /** Clear per-lane opt-outs (e.g. when a line is re-added to a lane). */
  removeTimelineExcluded: (keys: string[]) => void;
}

export function createLinesActions(set: StoreSet): LinesActions {
  return {
    addToCompare: (ns) => {
      mutateLines(set, "compareLinesByFile", (c) =>
        ns.forEach((n) => c.add(n)),
      );
      // Surface the comparison: focus its tab on whichever dock it currently lives
      // on — the main one, or the popped-out side dock.
      set((st) =>
        st.doc.poppedPanels?.includes("compare")
          ? {
              doc: {
                ...st.doc,
                poppedCollapsed: false,
                poppedActiveTab: "compare" as const,
              },
            }
          : {
              doc: {
                ...st.doc,
                activePanelTab: "compare" as const,
                filterCollapsed: false,
              },
            },
      );
    },
    removeFromCompare: (ns) =>
      mutateLines(set, "compareLinesByFile", (c) =>
        ns.forEach((n) => c.delete(n)),
      ),
    clearCompare: () =>
      mutateLines(set, "compareLinesByFile", (c) => c.clear()),

    addToTimeline: (ns) =>
      mutateLines(set, "timelineLinesByFile", (c) =>
        ns.forEach((n) => c.add(n)),
      ),
    removeFromTimeline: (ns) => {
      mutateLines(set, "timelineLinesByFile", (c) =>
        ns.forEach((n) => c.delete(n)),
      );
      // A line off the timeline entirely carries no lane opt-outs.
      mutateTimelineExcluded(set, (c) => pruneExcludedForLines(c, ns));
    },
    clearTimeline: () => {
      mutateLines(set, "timelineLinesByFile", (c) => c.clear());
      mutateTimelineExcluded(set, (c) => c.clear());
    },
    addTimelineExcluded: (keys) =>
      mutateTimelineExcluded(set, (c) => keys.forEach((k) => c.add(k))),
    removeTimelineExcluded: (keys) =>
      mutateTimelineExcluded(set, (c) => keys.forEach((k) => c.delete(k))),
  };
}
