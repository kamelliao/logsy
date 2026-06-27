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
  };
}
