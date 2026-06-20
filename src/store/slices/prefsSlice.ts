import type { StoreSet } from "@/store";
import { FONT_DEFAULT, FONT_STEP, clampFont } from "@/config";

/** Log-view font zoom (Ctrl +/−/0 and Ctrl+wheel). Persisted, off the undo stack. */
export interface PrefsActions {
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
}

export function createPrefsActions(set: StoreSet): PrefsActions {
  return {
    zoomIn: () =>
      set((st) => ({
        doc: {
          ...st.doc,
          fontSize: clampFont((st.doc.fontSize ?? FONT_DEFAULT) + FONT_STEP),
        },
      })),
    zoomOut: () =>
      set((st) => ({
        doc: {
          ...st.doc,
          fontSize: clampFont((st.doc.fontSize ?? FONT_DEFAULT) - FONT_STEP),
        },
      })),
    zoomReset: () =>
      set((st) => ({ doc: { ...st.doc, fontSize: FONT_DEFAULT } })),
  };
}
