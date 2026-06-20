import { useEffect } from "react";
import { useStore } from "@/store";
import { FONT_DEFAULT } from "@/config";

/**
 * Log-view font size and its zoom controls, backed by the store's prefs slice.
 * Zoom is driven from the menu, the keyboard (Ctrl +/−/0) and Ctrl+wheel over the
 * log. Persisted in `state.fontSize`; this hook only adds the Ctrl+wheel listener.
 */
export function useFontZoom(): {
  fontSize: number;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
} {
  const fontSize = useStore((s) => s.doc.fontSize ?? FONT_DEFAULT);
  const zoomIn = useStore((s) => s.zoomIn);
  const zoomOut = useStore((s) => s.zoomOut);
  const zoomReset = useStore((s) => s.zoomReset);

  useEffect(() => {
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      // The timeline owns ctrl+wheel over its own area (axis zoom); don't also
      // font-zoom the log view when the cursor is there.
      if ((e.target as Element | null)?.closest?.(".tlc-outer")) return;
      e.preventDefault();
      if (e.deltaY < 0) zoomIn();
      else zoomOut();
    }
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [zoomIn, zoomOut]);

  return { fontSize, zoomIn, zoomOut, zoomReset };
}
