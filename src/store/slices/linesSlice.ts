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

/** Compare- and timeline-panel pinned lines, per file. Persisted, off the undo stack. */
export interface LinesActions {
  addToCompare: (ns: number[]) => void;
  removeFromCompare: (ns: number[]) => void;
  clearCompare: () => void;
  addToTimeline: (ns: number[]) => void;
  removeFromTimeline: (ns: number[]) => void;
  clearTimeline: () => void;
}

export function createLinesActions(set: StoreSet): LinesActions {
  return {
    addToCompare: (ns) => {
      mutateLines(set, "compareLinesByFile", (c) =>
        ns.forEach((n) => c.add(n)),
      );
      // Surface the comparison: focus its tab, or expand it if it's popped out.
      set((st) =>
        st.doc.comparePopped
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
    removeFromTimeline: (ns) =>
      mutateLines(set, "timelineLinesByFile", (c) =>
        ns.forEach((n) => c.delete(n)),
      ),
    clearTimeline: () =>
      mutateLines(set, "timelineLinesByFile", (c) => c.clear()),
  };
}
