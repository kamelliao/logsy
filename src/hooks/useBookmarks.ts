import type { Marker, MarkerIcon } from "@/types";
import { useStore, selectActiveMarkers } from "@/store";

/**
 * User bookmarks pinned to log lines, backed by the store's bookmark slice.
 * Persisted with the active file (in `file.markers`) but kept off the undo stack.
 * Navigation to a bookmark (`jumpToMarker`) lives in App since it also touches the
 * log view's mode. Components that only need bookmarks can subscribe to the store
 * directly (see BookmarksPanel) instead of receiving these as props.
 */
export function useBookmarks(): {
  markers: Marker[];
  setMarker: (n: number, icon: MarkerIcon, note: string) => void;
  removeMarker: (n: number) => void;
  clearMarkers: () => void;
} {
  const markers = useStore(selectActiveMarkers);
  const setMarker = useStore((s) => s.setMarker);
  const removeMarker = useStore((s) => s.removeMarker);
  const clearMarkers = useStore((s) => s.clearMarkers);
  return { markers, setMarker, removeMarker, clearMarkers };
}
