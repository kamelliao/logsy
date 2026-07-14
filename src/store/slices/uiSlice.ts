import type { StoreSet } from "@/store";
import type { EditingState } from "@/store/slices/filterSlice";

/** Non-persisted, transient UI state that several panels/modals read off the store. */
export interface UiSlice {
  /** The draft open in the filter editor modal (null when closed). */
  editing: EditingState | null;
  setEditing: (e: EditingState | null) => void;
  /** "View this filter only" — ephemeral focus on a single filter's matches. */
  soloFilterId: string | null;
  setSoloFilterId: (id: string | null) => void;
  /**
   * Filter ids to flash briefly in the panel — e.g. the rows just inserted from
   * a pack. Transient: set then auto-cleared, never persisted.
   */
  flashFilterIds: string[];
  /** Flash these filter rows, then clear after a beat (no-op for an empty set). */
  flashFilters: (ids: string[]) => void;
  /** Filter-packs drawer open state. Lives here (not in `doc`) so the top menubar
   *  and the panel's toolbar button can both toggle it without prop-drilling, and
   *  it resets to closed on reload. */
  packsOpen: boolean;
  setPacksOpen: (v: boolean) => void;
  togglePacks: () => void;
  /** Label for a store-driven loading overlay (reading a filter/pack file from
   *  disk), or null when idle. Mirrors useLogFiles' `busy` for the file-open
   *  overlay, but for actions that live in the store rather than that hook. */
  loadingLabel: string | null;
  setLoadingLabel: (v: string | null) => void;
  /** File ids, most-recently-viewed first — Quick Open's default ordering. Session
   *  state, not persisted: after a reload the file order stands in for it. */
  fileMru: string[];
  touchFileMru: (id: string) => void;
}

export function createUiSlice(set: StoreSet): UiSlice {
  return {
    editing: null,
    setEditing: (e) => set({ editing: e }),
    soloFilterId: null,
    setSoloFilterId: (id) => set({ soloFilterId: id }),
    flashFilterIds: [],
    flashFilters: (ids) => {
      if (ids.length === 0) return;
      set({ flashFilterIds: ids });
      // Clear only if a newer flash hasn't replaced this one in the meantime.
      setTimeout(() => {
        set((s) => (s.flashFilterIds === ids ? { flashFilterIds: [] } : {}));
      }, 1100);
    },
    packsOpen: false,
    setPacksOpen: (v) => set({ packsOpen: v }),
    togglePacks: () => set((s) => ({ packsOpen: !s.packsOpen })),
    loadingLabel: null,
    setLoadingLabel: (v) => set({ loadingLabel: v }),
    fileMru: [],
    touchFileMru: (id) =>
      set((s) =>
        s.fileMru[0] === id
          ? {}
          : { fileMru: [id, ...s.fileMru.filter((x) => x !== id)] },
      ),
  };
}
