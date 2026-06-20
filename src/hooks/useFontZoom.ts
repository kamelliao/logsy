import { useCallback, useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AppState } from "@/types";

const FONT_DEFAULT = 12;
const FONT_STEP = 1;
const FONT_MIN = 8;
const FONT_MAX = 24;

const clampFont = (n: number) => Math.max(FONT_MIN, Math.min(FONT_MAX, n));

interface Deps {
  state: AppState;
  setState: Dispatch<SetStateAction<AppState>>;
}

/**
 * Log-view font size and its zoom controls. Zoom is driven from the menu, the
 * keyboard (Ctrl +/−/0) and Ctrl+wheel over the log. Persisted in `state.fontSize`.
 */
export function useFontZoom({ state, setState }: Deps): {
  fontSize: number;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
} {
  const zoomIn = useCallback(
    () =>
      setState((s) => ({
        ...s,
        fontSize: clampFont((s.fontSize ?? FONT_DEFAULT) + FONT_STEP),
      })),
    [setState],
  );
  const zoomOut = useCallback(
    () =>
      setState((s) => ({
        ...s,
        fontSize: clampFont((s.fontSize ?? FONT_DEFAULT) - FONT_STEP),
      })),
    [setState],
  );
  const zoomReset = useCallback(
    () => setState((s) => ({ ...s, fontSize: FONT_DEFAULT })),
    [setState],
  );

  useEffect(() => {
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      // The timeline owns ctrl+wheel over its own area (axis zoom); don't also
      // font-zoom the log view when the cursor is there.
      if ((e.target as Element | null)?.closest?.(".tlc-outer")) return;
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      setState((s) => ({
        ...s,
        fontSize: clampFont((s.fontSize ?? FONT_DEFAULT) + dir * FONT_STEP),
      }));
    }
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [setState]);

  return {
    fontSize: state.fontSize ?? FONT_DEFAULT,
    zoomIn,
    zoomOut,
    zoomReset,
  };
}
