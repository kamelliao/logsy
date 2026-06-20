import { useEffect, useMemo } from "react";
import { toast } from "sonner";
import type { AppState } from "@/types";
import { SAFE_MODE } from "@/state/persistence";
import { useStore } from "@/store";

export interface UndoableState {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  /** Latest state, readable from async callbacks without stale closures. */
  stateRef: React.RefObject<AppState>;
  /**
   * Mutate state immutably. By default the edit is recorded for undo; pass
   * { undoable: false } for navigation / file / view-only changes, or
   * { coalesce } to fold a run of similar edits (typing, dragging) into one step.
   */
  patchState: (
    fn: (s: AppState) => void,
    opts?: { undoable?: boolean; coalesce?: string },
  ) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Push a path to the front of a recent-list (deduped, capped at 10). */
  pushRecent: (key: "recentFiles" | "recentFilterFiles", path: string) => void;
  clearRecent: (key: "recentFiles" | "recentFilterFiles") => void;
}

/**
 * Thin adapter exposing the Zustand store under the legacy useUndoableState shape,
 * so App.tsx and the action hooks keep working unchanged while the migration to
 * slice-by-slice store subscriptions proceeds. The actual state, persistence, and
 * undo/redo engine now live in `@/store`.
 */
export function useUndoableState(): UndoableState {
  const state = useStore((s) => s.doc);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const patchState = useStore((s) => s.patchState);
  const setState = useStore((s) => s.setDoc);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const pushRecent = useStore((s) => s.pushRecent);
  const clearRecent = useStore((s) => s.clearRecent);

  // A stable ref whose `.current` always reads the freshest document from the
  // store — replaces the old `stateRef.current = state` so async callbacks (file
  // loading, undo) never close over a stale snapshot.
  const stateRef = useMemo(
    () =>
      ({
        get current() {
          return useStore.getState().doc;
        },
      }) as React.RefObject<AppState>,
    [],
  );

  // Tell the user when this session is running in safe mode (started with --safe):
  // their saved workspace is untouched on disk and will return on a normal launch.
  useEffect(() => {
    if (SAFE_MODE) {
      toast.warning(
        "Safe mode: your saved state was not loaded and won't be saved this session. Restart normally to restore it.",
        { duration: 8000 },
      );
    }
  }, []);

  return {
    state,
    setState,
    stateRef,
    patchState,
    undo,
    redo,
    canUndo,
    canRedo,
    pushRecent,
    clearRecent,
  };
}
