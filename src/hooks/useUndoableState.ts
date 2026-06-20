import { useState, useEffect, useRef, useReducer, useCallback } from "react";
import { toast } from "sonner";
import type { AppState } from "@/types";
import { STATE_KEY, SAFE_MODE, loadState } from "@/state/persistence";

const HISTORY_CAP = 50;

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
 * Owns the whole AppState: the React state, localStorage persistence, and the
 * undo/redo history engine. Everything that mutates the workspace funnels
 * through `patchState` / `setState` returned here.
 */
export function useUndoableState(): UndoableState {
  const [state, setState] = useState<AppState>(loadState);

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

  // Persist on a short debounce — serializing the whole state synchronously on
  // every edit added a fixed cost to each action on large filter sets. The
  // unload flush (below) covers the trailing edits.
  useEffect(() => {
    if (SAFE_MODE) return; // never write over the preserved state in safe mode
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify(state));
      } catch {
        /* ignore */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [state]);

  // Latest state, readable from async callbacks (file loading) and from
  // patchState / undo without stale closures.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Flush the debounced persist when the window goes away (reload / close), so
  // edits made within the debounce window aren't lost.
  useEffect(() => {
    const flush = () => {
      if (SAFE_MODE) return; // see SAFE_MODE: don't persist this session
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify(stateRef.current));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  // ---------- undo / redo ----------
  // Whole-AppState snapshots. Snapshots are immutable (patchState clones before
  // mutating), so stacking the prior reference is cheap. Memory-only (not
  // persisted); `bumpHistory` re-renders so menu enablement stays in sync.
  const past = useRef<AppState[]>([]);
  const future = useRef<AppState[]>([]);
  const coalesceKey = useRef<string | null>(null);
  const [, bumpHistory] = useReducer((x: number) => x + 1, 0);

  const patchState = useCallback(
    (
      fn: (s: AppState) => void,
      opts?: { undoable?: boolean; coalesce?: string },
    ) => {
      if (opts?.undoable !== false) {
        const base = stateRef.current;
        const top = past.current[past.current.length - 1];
        const fold = !!opts?.coalesce && coalesceKey.current === opts.coalesce;
        // Skip when folding, or when an earlier edit this tick already pushed the
        // same base (so a single user action is one undo step).
        if (!fold && top !== base) {
          past.current.push(base);
          if (past.current.length > HISTORY_CAP) past.current.shift();
        }
        future.current = [];
        coalesceKey.current = opts?.coalesce ?? null;
        bumpHistory();
      }
      setState((s) => {
        const n = structuredClone(s);
        fn(n);
        return n;
      });
    },
    [],
  );

  const undo = useCallback(() => {
    if (past.current.length === 0) return;
    const prev = past.current.pop()!;
    future.current.push(stateRef.current);
    coalesceKey.current = null;
    bumpHistory();
    setState(prev);
  }, []);
  const redo = useCallback(() => {
    if (future.current.length === 0) return;
    const next = future.current.pop()!;
    past.current.push(stateRef.current);
    coalesceKey.current = null;
    bumpHistory();
    setState(next);
  }, []);
  const canUndo = past.current.length > 0;
  const canRedo = future.current.length > 0;

  const pushRecent = useCallback(
    (key: "recentFiles" | "recentFilterFiles", path: string) => {
      setState((s) => {
        const cur = (s[key] ?? []).filter((p) => p !== path);
        cur.unshift(path);
        return { ...s, [key]: cur.slice(0, 10) };
      });
    },
    [],
  );
  const clearRecent = useCallback(
    (key: "recentFiles" | "recentFilterFiles") =>
      setState((s) => ({ ...s, [key]: [] })),
    [],
  );

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
