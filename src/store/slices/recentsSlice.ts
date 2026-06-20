import type { StoreSet } from "@/store";

export type RecentKey = "recentFiles" | "recentFilterFiles";

/** Most-recently-used file / filter-file paths. Persisted, off the undo stack. */
export interface RecentsActions {
  pushRecent: (key: RecentKey, path: string) => void;
  clearRecent: (key: RecentKey) => void;
}

export function createRecentsActions(set: StoreSet): RecentsActions {
  return {
    pushRecent: (key, path) =>
      set((st) => {
        const cur = (st.doc[key] ?? []).filter((p) => p !== path);
        cur.unshift(path);
        return { doc: { ...st.doc, [key]: cur.slice(0, 10) } };
      }),
    clearRecent: (key) => set((st) => ({ doc: { ...st.doc, [key]: [] } })),
  };
}
