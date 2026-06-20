import type { AppState, LogFile, Marker, MarkerIcon } from "@/types";
import { withFile } from "@/state/selectors";

interface Deps {
  file: LogFile | null;
  patchState: (
    fn: (s: AppState) => void,
    opts?: { undoable?: boolean; coalesce?: string },
  ) => void;
}

/**
 * User bookmarks pinned to log lines. Persisted with the file (in `file.markers`)
 * but kept off the undo stack. Navigation to a bookmark (`jumpToMarker`) lives in
 * App since it also touches the log view's mode.
 */
export function useBookmarks({ file, patchState }: Deps): {
  markers: Marker[];
  setMarker: (n: number, icon: MarkerIcon, note: string) => void;
  removeMarker: (n: number) => void;
  clearMarkers: () => void;
} {
  const markers = file?.markers ?? [];
  // Upsert a bookmark on a line (persisted with the file; not on the undo stack).
  const setMarker = (n: number, icon: MarkerIcon, note: string) =>
    patchState(
      (s) => {
        if (!file) return;
        const f = withFile(s, file.id);
        if (!Array.isArray(f.markers)) f.markers = [];
        const m = f.markers.find((x) => x.n === n);
        if (m) {
          m.icon = icon;
          m.note = note;
        } else f.markers.push({ n, icon, note });
        f.markers.sort((a, b) => a.n - b.n);
      },
      { undoable: false },
    );
  const removeMarker = (n: number) =>
    patchState(
      (s) => {
        if (!file) return;
        const f = withFile(s, file.id);
        if (Array.isArray(f.markers))
          f.markers = f.markers.filter((m) => m.n !== n);
      },
      { undoable: false },
    );
  const clearMarkers = () =>
    patchState(
      (s) => {
        if (!file) return;
        withFile(s, file.id).markers = [];
      },
      { undoable: false },
    );

  return { markers, setMarker, removeMarker, clearMarkers };
}
