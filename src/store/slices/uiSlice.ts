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
}

export function createUiSlice(set: StoreSet): UiSlice {
  return {
    editing: null,
    setEditing: (e) => set({ editing: e }),
    soloFilterId: null,
    setSoloFilterId: (id) => set({ soloFilterId: id }),
  };
}
