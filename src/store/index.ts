import { create, type StoreApi } from "zustand";
import {
  persist,
  type PersistStorage,
  type StorageValue,
} from "zustand/middleware";
import { produce, setAutoFreeze } from "immer";
import type { AppState } from "@/types";
import { initialState, normalizeState } from "@/lib/defaults";
import { STATE_KEY, STATE_VERSION, SAFE_MODE, HISTORY_CAP } from "@/config";
import type { ConfirmOptions } from "@/components/dialogs/ConfirmDialog";
import {
  createFilterActions,
  type FilterActions,
} from "@/store/slices/filterSlice";
import { createUiSlice, type UiSlice } from "@/store/slices/uiSlice";
import {
  createPrefsActions,
  type PrefsActions,
} from "@/store/slices/prefsSlice";
import {
  createRecentsActions,
  type RecentsActions,
} from "@/store/slices/recentsSlice";
import {
  createBookmarkActions,
  type BookmarkActions,
} from "@/store/slices/bookmarkSlice";
import {
  createLinesActions,
  type LinesActions,
} from "@/store/slices/linesSlice";

export type { EditingState } from "@/store/slices/filterSlice";
export { selectActiveMarkers } from "@/store/slices/bookmarkSlice";

// The prior engine cloned whole state via structuredClone, so snapshots were never
// frozen. immer's `produce` gives us structural sharing (cheap snapshots) with the
// same `(s) => { s.x = y }` ergonomics — but we keep auto-freeze OFF to preserve the
// old mutation profile: raw `setDoc` updaters and selectors read state directly, and
// some still build new state with spreads rather than producers.
setAutoFreeze(false);

type PatchOpts = { undoable?: boolean; coalesce?: string };

/** Typed `set`/`get` handed to the slice factories in `@/store/slices/*`. */
export type StoreSet = StoreApi<Store>["setState"];
export type StoreGet = StoreApi<Store>["getState"];

export interface Store
  extends
    FilterActions,
    UiSlice,
    PrefsActions,
    RecentsActions,
    BookmarkActions,
    LinesActions {
  /** The persisted, undoable workspace document (everything that used to be AppState). */
  doc: AppState;
  /** Menu-enablement flags, mirrored into store state so selectors re-render on change. */
  canUndo: boolean;
  canRedo: boolean;

  // ---- runtime collaborators (bound by App; not state we can compute) ----
  /** App-styled confirm() replacement; bound from useConfirm. */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  setRuntime: (rt: {
    confirm?: (opts: ConfirmOptions) => Promise<boolean>;
  }) => void;

  // ---- undo engine ----
  /**
   * Mutate the document immutably. Recorded for undo by default; pass
   * { undoable: false } for navigation / view-only / persisted-but-not-undoable
   * edits, or { coalesce } to fold a run of similar edits into one undo step.
   * Ported from the old useUndoableState engine.
   */
  patchState: (fn: (s: AppState) => void, opts?: PatchOpts) => void;
  /** Replace the document without touching the undo stack (the old raw `setState`). */
  setDoc: React.Dispatch<React.SetStateAction<AppState>>;
  undo: () => void;
  redo: () => void;
}

// Undo history is memory-only — never persisted, never rendered — so it lives in
// module scope (mirrors the old `useRef` stacks), out of the store's state object.
const past: AppState[] = [];
const future: AppState[] = [];
let coalesceKey: string | null = null;

/**
 * A localStorage adapter that keeps the on-disk format byte-compatible with the
 * pre-store payload: a bare `AppState` JSON under STATE_KEY (no persist wrapper).
 * Writes are debounced 300ms and flushed on unload — same optimization the old
 * useUndoableState had. SAFE_MODE neither reads nor writes (preserves a bad state
 * on disk for the next normal launch).
 */
function createRawStorage(): PersistStorage<Pick<Store, "doc">> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: string | null = null;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending == null) return;
    try {
      localStorage.setItem(STATE_KEY, pending);
    } catch {
      /* ignore */
    }
    pending = null;
  };
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
  }
  return {
    getItem: () => {
      if (SAFE_MODE) return null;
      try {
        const raw = localStorage.getItem(STATE_KEY);
        if (!raw) return null;
        return {
          state: { doc: normalizeState(JSON.parse(raw) as AppState) },
          version: STATE_VERSION,
        };
      } catch {
        return null;
      }
    },
    setItem: (_name, value: StorageValue<Pick<Store, "doc">>) => {
      if (SAFE_MODE) return; // never overwrite the preserved state in safe mode
      pending = JSON.stringify(value.state.doc);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 300);
    },
    removeItem: () => {
      try {
        localStorage.removeItem(STATE_KEY);
      } catch {
        /* ignore */
      }
    },
  };
}

export const useStore = create<Store>()(
  persist(
    (set, get) => ({
      doc: normalizeState(initialState()),
      canUndo: false,
      canRedo: false,

      // ---- runtime collaborators (safe fallbacks until App binds the real ones) ----
      confirm: (o) =>
        Promise.resolve(
          window.confirm(
            typeof o.message === "string" ? o.message : "Are you sure?",
          ),
        ),
      setRuntime: (rt) => set(rt),

      // ---- slices (see @/store/slices/*) ----
      ...createUiSlice(set),
      ...createFilterActions(set, get),
      ...createPrefsActions(set),
      ...createRecentsActions(set),
      ...createBookmarkActions(get),
      ...createLinesActions(set),

      // ---- undo engine ----
      patchState: (fn, opts) => {
        const base = get().doc;
        if (opts?.undoable !== false) {
          const top = past[past.length - 1];
          const fold = !!opts?.coalesce && coalesceKey === opts.coalesce;
          // Skip the push when folding, or when an earlier edit this tick already
          // stacked the same base — one user action stays one undo step.
          if (!fold && top !== base) {
            past.push(base);
            if (past.length > HISTORY_CAP) past.shift();
          }
          future.length = 0;
          coalesceKey = opts?.coalesce ?? null;
        }
        const doc = produce(base, (d: AppState) => {
          fn(d);
        });
        set(
          opts?.undoable !== false
            ? { doc, canUndo: past.length > 0, canRedo: false }
            : { doc },
        );
      },

      setDoc: (updater) =>
        set((st) => ({
          doc:
            typeof updater === "function"
              ? (updater as (s: AppState) => AppState)(st.doc)
              : updater,
        })),

      undo: () => {
        if (past.length === 0) return;
        const prev = past.pop()!;
        future.push(get().doc);
        coalesceKey = null;
        set({ doc: prev, canUndo: past.length > 0, canRedo: true });
      },
      redo: () => {
        if (future.length === 0) return;
        const next = future.pop()!;
        past.push(get().doc);
        coalesceKey = null;
        set({ doc: next, canUndo: true, canRedo: future.length > 0 });
      },
    }),
    {
      name: STATE_KEY,
      version: STATE_VERSION,
      storage: createRawStorage(),
      // Only the document is persisted; canUndo/canRedo and actions are not.
      partialize: (st) => ({ doc: st.doc }),
      // Safe mode: stay on the fresh initialState, don't read the saved blob.
      skipHydration: SAFE_MODE,
    },
  ),
);
