import type { Store, StoreGet } from "@/store";
import type { Marker, MarkerIcon } from "@/types";
import { activeFile } from "@/state/selectors";

const EMPTY_MARKERS: Marker[] = [];

/** Bookmarks pinned to the active file. Persisted via patchState, off the undo stack. */
export interface BookmarkActions {
  setMarker: (n: number, icon: MarkerIcon, note: string) => void;
  removeMarker: (n: number) => void;
  clearMarkers: () => void;
}

export function createBookmarkActions(get: StoreGet): BookmarkActions {
  return {
    setMarker: (n, icon, note) =>
      get().patchState(
        (s) => {
          const f = activeFile(s);
          if (!f) return;
          if (!Array.isArray(f.markers)) f.markers = [];
          const m = f.markers.find((x) => x.n === n);
          if (m) {
            m.icon = icon;
            m.note = note;
          } else f.markers.push({ n, icon, note });
          f.markers.sort((a, b) => a.n - b.n);
        },
        { undoable: false },
      ),
    removeMarker: (n) =>
      get().patchState(
        (s) => {
          const f = activeFile(s);
          if (f && Array.isArray(f.markers))
            f.markers = f.markers.filter((m) => m.n !== n);
        },
        { undoable: false },
      ),
    clearMarkers: () =>
      get().patchState(
        (s) => {
          const f = activeFile(s);
          if (f) f.markers = [];
        },
        { undoable: false },
      ),
  };
}

/** Markers of the active file (stable empty array when none, to avoid render loops). */
export const selectActiveMarkers = (s: Store): Marker[] =>
  activeFile(s.doc)?.markers ?? EMPTY_MARKERS;
