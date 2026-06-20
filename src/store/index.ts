import { create } from "zustand";
import {
  persist,
  type PersistStorage,
  type StorageValue,
} from "zustand/middleware";
import { produce, setAutoFreeze } from "immer";
import type { AppState, Marker, MarkerIcon } from "@/types";
import { initialState, normalizeState } from "@/lib/defaults";
import { STATE_KEY, SAFE_MODE } from "@/state/persistence";
import { activeFile } from "@/state/selectors";
import type { ConfirmOptions } from "@/components/dialogs/ConfirmDialog";
import {
  createFilterActions,
  type FilterActions,
  type EditingState,
} from "@/store/filterSlice";

export type { EditingState } from "@/store/filterSlice";

// The prior engine cloned whole state via structuredClone, so snapshots were never
// frozen. immer's `produce` gives us structural sharing (cheap snapshots) with the
// same `(s) => { s.x = y }` ergonomics — but we keep auto-freeze OFF to preserve the
// old mutation profile: raw `setDoc` updaters and selectors read state directly, and
// some still build new state with spreads rather than producers.
setAutoFreeze(false);

const HISTORY_CAP = 50;
const STATE_VERSION = 6;
const EMPTY_MARKERS: Marker[] = [];

// Log-view font zoom bounds (Ctrl +/−/0 and Ctrl+wheel). Persisted, not undoable.
const FONT_DEFAULT = 12;
const FONT_STEP = 1;
const clampFont = (n: number) => Math.max(8, Math.min(24, n));

// Compare/timeline pinned lines: persisted per file, NOT on the undo stack. Both
// edit a `{ [fileId]: number[] }` map on the active file via this shared mutator.
type LinesKey = "compareLinesByFile" | "timelineLinesByFile";
function mutateLines(
  set: (updater: (st: Store) => Partial<Store>) => void,
  key: LinesKey,
  fn: (cur: Set<number>) => void,
) {
  set((st) => {
    const fid = activeFile(st.doc)?.id;
    if (!fid) return {};
    const cur = new Set(st.doc[key]?.[fid] ?? []);
    fn(cur);
    return {
      doc: { ...st.doc, [key]: { ...(st.doc[key] ?? {}), [fid]: [...cur] } },
    };
  });
}

type RecentKey = "recentFiles" | "recentFilterFiles";
type PatchOpts = { undoable?: boolean; coalesce?: string };

export interface Store extends FilterActions {
  /** The persisted, undoable workspace document (everything that used to be AppState). */
  doc: AppState;
  /** Menu-enablement flags, mirrored into store state so selectors re-render on change. */
  canUndo: boolean;
  canRedo: boolean;

  // ---- ui slice (non-persisted, transient) ----
  /** The draft open in the filter editor modal (null when closed). */
  editing: EditingState | null;
  setEditing: (e: EditingState | null) => void;
  /** "View this filter only" — ephemeral focus on a single filter's matches. */
  soloFilterId: string | null;
  setSoloFilterId: (id: string | null) => void;

  // ---- runtime collaborators (bound by App; not state we can compute) ----
  /** App-styled confirm() replacement; bound from useConfirm. */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  /** Defer a heavy re-render (the dock's useTransition); bound from useDockLayout. */
  runTransition: (fn: () => void) => void;
  setRuntime: (rt: {
    confirm?: (opts: ConfirmOptions) => Promise<boolean>;
    runTransition?: (fn: () => void) => void;
  }) => void;

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
  pushRecent: (key: RecentKey, path: string) => void;
  clearRecent: (key: RecentKey) => void;

  // ---- prefs slice ----
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;

  // ---- bookmark slice ----
  setMarker: (n: number, icon: MarkerIcon, note: string) => void;
  removeMarker: (n: number) => void;
  clearMarkers: () => void;

  // ---- compare slice (persisted lines, non-undoable) ----
  addToCompare: (ns: number[]) => void;
  removeFromCompare: (ns: number[]) => void;
  clearCompare: () => void;

  // ---- timeline slice (persisted lines, non-undoable) ----
  addToTimeline: (ns: number[]) => void;
  removeFromTimeline: (ns: number[]) => void;
  clearTimeline: () => void;
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

      // ---- ui slice ----
      editing: null,
      setEditing: (e) => set({ editing: e }),
      soloFilterId: null,
      setSoloFilterId: (id) => set({ soloFilterId: id }),

      // ---- runtime collaborators (safe fallbacks until App binds the real ones) ----
      confirm: (o) =>
        Promise.resolve(
          window.confirm(
            typeof o.message === "string" ? o.message : "Are you sure?",
          ),
        ),
      runTransition: (fn) => fn(),
      setRuntime: (rt) => set(rt),

      // ---- filter slice ----
      ...createFilterActions(set, get),

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

      // ---- prefs slice: font zoom (persisted, off the undo stack) ----
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

      pushRecent: (key, path) =>
        set((st) => {
          const cur = (st.doc[key] ?? []).filter((p) => p !== path);
          cur.unshift(path);
          return { doc: { ...st.doc, [key]: cur.slice(0, 10) } };
        }),
      clearRecent: (key) => set((st) => ({ doc: { ...st.doc, [key]: [] } })),

      // ---- bookmark slice: pinned to the active file, persisted, off the undo stack ----
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

      // ---- compare slice: pinned lines per file (persisted, off the undo stack) ----
      addToCompare: (ns) => {
        mutateLines(set, "compareLinesByFile", (c) =>
          ns.forEach((n) => c.add(n)),
        );
        // Surface the comparison: focus its tab, or expand it if it's popped out.
        set((st) =>
          st.doc.comparePopped
            ? {
                doc: {
                  ...st.doc,
                  poppedCollapsed: false,
                  poppedActiveTab: "compare" as const,
                },
              }
            : {
                doc: {
                  ...st.doc,
                  activePanelTab: "compare" as const,
                  filterCollapsed: false,
                },
              },
        );
      },
      removeFromCompare: (ns) =>
        mutateLines(set, "compareLinesByFile", (c) =>
          ns.forEach((n) => c.delete(n)),
        ),
      clearCompare: () =>
        mutateLines(set, "compareLinesByFile", (c) => c.clear()),

      // ---- timeline slice: plotted lines per file (persisted, off the undo stack) ----
      addToTimeline: (ns) =>
        mutateLines(set, "timelineLinesByFile", (c) =>
          ns.forEach((n) => c.add(n)),
        ),
      removeFromTimeline: (ns) =>
        mutateLines(set, "timelineLinesByFile", (c) =>
          ns.forEach((n) => c.delete(n)),
        ),
      clearTimeline: () =>
        mutateLines(set, "timelineLinesByFile", (c) => c.clear()),
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

/** Markers of the active file (stable empty array when none, to avoid render loops). */
export const selectActiveMarkers = (s: Store): Marker[] =>
  activeFile(s.doc)?.markers ?? EMPTY_MARKERS;
