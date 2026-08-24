import type { StoreSet } from "@/store";
import type { EditingState } from "@/store/slices/filterSlice";

/** One in-flight task shown by the loading overlay. */
export interface BusyTask {
  /** Identity for `endBusy` — never reused, so a stale clear can't hit a new task. */
  token: number;
  /** What the card says, e.g. "Opening app.log". The "…" is added by the overlay. */
  label: string;
  /** Abandon the task. Absent when it genuinely can't be stopped. */
  cancel?: () => void;
}

// Monotonic, module-level: tokens must stay unique across store resets too.
let busyToken = 0;

/** Non-persisted, transient UI state that several panels/modals read off the store. */
export interface UiSlice {
  /** The draft open in the filter editor modal (null when closed). */
  editing: EditingState | null;
  setEditing: (e: EditingState | null) => void;
  /** "View this filter only" — ephemeral focus on a single filter's matches. */
  soloFilterId: string | null;
  setSoloFilterId: (id: string | null) => void;
  /**
   * Filter ids to flash briefly in the panel — e.g. the rows just inserted from
   * a pack. Transient: set then auto-cleared, never persisted.
   */
  flashFilterIds: string[];
  /** Flash these filter rows, then clear after a beat (no-op for an empty set). */
  flashFilters: (ids: string[]) => void;
  /** Filter-packs drawer open state. Lives here (not in `doc`) so the top menubar
   *  and the panel's toolbar button can both toggle it without prop-drilling, and
   *  it resets to closed on reload. */
  packsOpen: boolean;
  setPacksOpen: (v: boolean) => void;
  togglePacks: () => void;
  /**
   * Every in-flight blocking task, oldest first. The ONE loading overlay (rendered
   * over the log panel, see LoadingOverlay) shows the last entry, so a task that
   * starts while another is running takes the card and hands it back when it ends.
   * Owning them all here is what makes the overlay single: the file read, the
   * filter/pack read and anything added later push onto the same stack.
   */
  busyStack: BusyTask[];
  /** Push a task and return its token. `cancel` gets a Cancel button on the card. */
  beginBusy: (label: string, cancel?: () => void) => number;
  /** Pop the task with this token. A token that's already gone is a no-op, so a
   *  late clean-up can never wipe a newer task's overlay. */
  endBusy: (token: number) => void;
  /** File ids, most-recently-viewed first — Quick Open's default ordering. Session
   *  state, not persisted: after a reload the file order stands in for it. */
  fileMru: string[];
  touchFileMru: (id: string) => void;
  /** Drop closed files from the MRU, so "the file before this one" can never
   *  name a log that is no longer open. */
  forgetFileMru: (ids: string[]) => void;
}

export function createUiSlice(set: StoreSet): UiSlice {
  return {
    editing: null,
    setEditing: (e) => set({ editing: e }),
    soloFilterId: null,
    setSoloFilterId: (id) => set({ soloFilterId: id }),
    flashFilterIds: [],
    flashFilters: (ids) => {
      if (ids.length === 0) return;
      set({ flashFilterIds: ids });
      // Clear only if a newer flash hasn't replaced this one in the meantime.
      setTimeout(() => {
        set((s) => (s.flashFilterIds === ids ? { flashFilterIds: [] } : {}));
      }, 1100);
    },
    packsOpen: false,
    setPacksOpen: (v) => set({ packsOpen: v }),
    togglePacks: () => set((s) => ({ packsOpen: !s.packsOpen })),
    busyStack: [],
    beginBusy: (label, cancel) => {
      const token = ++busyToken;
      set((s) => ({ busyStack: [...s.busyStack, { token, label, cancel }] }));
      return token;
    },
    endBusy: (token) =>
      set((s) =>
        s.busyStack.some((b) => b.token === token)
          ? { busyStack: s.busyStack.filter((b) => b.token !== token) }
          : {},
      ),
    fileMru: [],
    touchFileMru: (id) =>
      set((s) =>
        s.fileMru[0] === id
          ? {}
          : { fileMru: [id, ...s.fileMru.filter((x) => x !== id)] },
      ),
    forgetFileMru: (ids) =>
      set((s) => {
        const gone = new Set(ids);
        return s.fileMru.some((id) => gone.has(id))
          ? { fileMru: s.fileMru.filter((id) => !gone.has(id)) }
          : {};
      }),
  };
}
