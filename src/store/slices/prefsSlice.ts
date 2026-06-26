import type { StoreSet } from "@/store";
import type { PacksSort } from "@/types";
import { FONT_DEFAULT, FONT_STEP, clampFont } from "@/config";

/** Log-view font zoom (Ctrl +/−/0 and Ctrl+wheel). Persisted, off the undo stack. */
export interface PrefsActions {
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  /** Width (px) of the packs side panel; persisted, off the undo stack. */
  setPacksDrawerW: (w: number) => void;
  /** Sort order of the packs library list; persisted, off the undo stack. */
  setPacksSort: (sort: PacksSort) => void;
}

/** Clamp the packs panel to a sane on-screen range. */
export const PACKS_W_MIN = 280;
export const PACKS_W_MAX = 680;
const clampPacksW = (w: number) =>
  Math.max(PACKS_W_MIN, Math.min(PACKS_W_MAX, Math.round(w)));

export function createPrefsActions(set: StoreSet): PrefsActions {
  return {
    setPacksDrawerW: (w) =>
      set((st) => ({ doc: { ...st.doc, packsDrawerW: clampPacksW(w) } })),
    setPacksSort: (sort) =>
      set((st) => ({ doc: { ...st.doc, packsSort: sort } })),
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
