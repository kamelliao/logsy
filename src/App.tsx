import {
  useState,
  useMemo,
  useEffect,
  useCallback,
  useDeferredValue,
  useRef,
  CSSProperties,
  ReactNode,
} from "react";
import { FolderOpen, Upload } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import type { FilterGroup } from "@/types";
import { DEFAULT_PALETTE } from "@/lib/palette";
import type { PaletteEntry } from "@/types";

import { compileAll, computeView } from "@/lib/engine";
import { Sidebar } from "@/components/layout/Sidebar";
import { LogView } from "@/components/LogView";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { FilterPanel } from "@/components/FilterPanel";
import { EditModal } from "@/components/dialogs/EditModal";
import { CompareTable } from "@/components/CompareTable";
import { useCompareCollapse } from "@/hooks/useCompareCollapse";
import { BookmarksPanel } from "@/components/BookmarksPanel";
import { TimelinePanel } from "@/components/TimelinePanel";
import { MenuPopup } from "@/components/layout/MenuPopup";
import { AboutModal } from "@/components/dialogs/AboutModal";
import { ShortcutsModal } from "@/components/dialogs/ShortcutsModal";
import { SettingsDialog } from "@/components/dialogs/SettingsDialog";
import { useConfirm } from "@/components/dialogs/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Workspace } from "@/components/layout/Workspace";
import { PaneTabs } from "@/components/layout/PaneTabs";
import { Titlebar } from "@/components/layout/Titlebar";
import { GotoDialog } from "@/components/dialogs/GotoDialog";
import { Overlays } from "@/components/layout/Overlays";
import { useFontZoom } from "@/hooks/useFontZoom";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useMenuDefs } from "@/hooks/useMenuDefs";
import { useLogFiles } from "@/hooks/useLogFiles";
import { useDockLayout } from "@/hooks/useDockLayout";
import { useCompare } from "@/hooks/useCompare";
import { useTimeline } from "@/hooks/useTimeline";
import { useBookmarks } from "@/hooks/useBookmarks";
import { useStore } from "@/store";
import {
  NotebookHost,
  callAddPinnedLines,
  callAddCompareCard,
  callAddTimelineCard,
} from "@/context/NotebookContext";
import { NotebookPanel } from "@/components/notebook/NotebookPanel";
import { setPinnedLinesJumpHandler } from "@/components/notebook/PinnedLinesNode";
import { activeFile } from "@/state/selectors";
import { SAFE_MODE, DOCS_URL, APP_VERSION_FALLBACK } from "@/config";
import { useShallow } from "zustand/react/shallow";

const MENUS = ["File", "Edit", "View", "Filters", "Help"] as const;

export function App() {
  // Workspace state comes straight from the store now. Undo/redo + their enabled
  // flags are read where they're used (menus, keyboard) directly from the store.
  const state = useStore((s) => s.doc);
  const { setState, patchState } = useStore(
    useShallow((s) => ({ setState: s.setDoc, patchState: s.patchState })),
  );

  // Safe mode (launched with --safe): the saved workspace is untouched on disk and
  // won't be saved this session. Tell the user once; a normal launch restores it.
  useEffect(() => {
    if (SAFE_MODE)
      toast.warning(
        "Safe mode: your saved state was not loaded and won't be saved this session. Restart normally to restore it.",
        { duration: 8000 },
      );
  }, []);
  const editing = useStore((s) => s.editing);
  const setEditing = useStore((s) => s.setEditing);
  // Store-driven loading overlay for reading a filter/pack file from disk.
  const loadingLabel = useStore((s) => s.loadingLabel);
  // A request to scroll+flash a filter row (e.g. clicking a Compare group header).
  // The bumping nonce re-triggers the flash even when the same id is re-requested.
  const [filterFlash, setFilterFlash] = useState<{
    id: string;
    nonce: number;
  } | null>(null);
  const [openMenu, setOpenMenu] = useState<{
    name: string;
    x: number;
    y: number;
  } | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [appVersion, setAppVersion] = useState(APP_VERSION_FALLBACK);
  // Go-to-line dialog + signals pushed to LogView for menu-driven actions.
  const [gotoOpen, setGotoOpen] = useState(false);
  const [selectAllNonce, setSelectAllNonce] = useState(0);
  const [gotoSignal, setGotoSignal] = useState<{
    n: number;
    nonce: number;
  } | null>(null);
  // Pushed to LogView to scroll/select a bookmarked line from the Bookmarks tab.
  const [markerJump, setMarkerJump] = useState<{
    n: number;
    nonce: number;
  } | null>(null);
  // "View this filter only" — ephemeral focus on a single filter's matches (ui slice).
  const soloFilterId = useStore((s) => s.soloFilterId);
  const setSoloFilterId = useStore((s) => s.setSoloFilterId);
  // App-styled confirm() replacement (see useConfirm) + a bump to focus the
  // filter panel's search box from a keyboard shortcut.
  const [appConfirm, confirmNode] = useConfirm();
  const [focusSearchNonce, setFocusSearchNonce] = useState(0);
  // Bumped to (re)focus the log find bar's input — lets Ctrl+F refocus the box
  // even when the bar is already open (see focusFind). `findSeed` carries the
  // text highlighted at the moment Ctrl+F was pressed, for seeding the query.
  const [findFocusNonce, setFindFocusNonce] = useState(0);
  const [findSeed, setFindSeed] = useState("");
  // ---- split view (#6→#5): VS Code-style editor groups. Ephemeral, not persisted. ----
  // Each pane is a "group" with its own ordered file tabs + active tab. The FOCUSED
  // pane's active tab is the app's active file, so the filter/compare/timeline/
  // bookmark panels + write actions follow whichever pane you last touched; only the
  // non-focused pane needs its own computed view. `dir`: "h" = left/right (default).
  // Each pane's find bar is ephemeral while split is on.
  // A pane is a VS Code editor group: its own ordered file tabs + active tab. The
  // active filter set is NOT stored here — it's a per-document property
  // (`LogFile.activeSetId`), so each pane's set follows whichever file it shows.
  type Pane = { tabs: string[]; active: string | null };
  const [split, setSplit] = useState<{ on: boolean; dir: "h" | "v" }>({
    on: false,
    dir: "h",
  });
  const [activePaneId, setActivePaneId] = useState<"a" | "b">("a");
  const [panes, setPanes] = useState<{ a: Pane; b: Pane }>({
    a: { tabs: [], active: null },
    b: { tabs: [], active: null },
  });
  const [findOpenA, setFindOpenA] = useState(false);
  const [findOpenB, setFindOpenB] = useState(false);
  const [findFocusNonceB, setFindFocusNonceB] = useState(0);
  // While a file is dragged (OS or sidebar), where it would drop. In split mode:
  // onto a pane (add tab). In single-pane mode: the CENTER (open in place) or one of
  // four EDGE zones (open a new split on that side). Drives the drop indicators.
  type Zone = "left" | "right" | "top" | "bottom";
  type DropHint =
    | { kind: "pane"; pane: "a" | "b" }
    | { kind: "center" }
    | { kind: "edge"; zone: Zone }
    | null;
  const [dropHint, setDropHint] = useState<DropHint>(null);
  // Committing to an EDGE zone is debounced by a short dwell so a quick pass across
  // the pane doesn't flicker the split preview (center / pane / clearing are
  // immediate). The drop action itself still uses the real drop position, not this.
  const dropHintRef = useRef<DropHint>(null);
  const dropHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitHint = (h: DropHint) => {
    dropHintRef.current = h;
    setDropHint(h);
  };
  const applyDropHint = (hint: DropHint) => {
    const cur = dropHintRef.current;
    if (dropHintTimer.current) {
      clearTimeout(dropHintTimer.current);
      dropHintTimer.current = null;
    }
    // Immediate for null / pane / center.
    if (!hint || hint.kind !== "edge") {
      commitHint(hint);
      return;
    }
    if (cur?.kind === "edge" && cur.zone === hint.zone) return; // already shown
    // A (new) edge: keep the current feedback (center when not yet an edge), and
    // commit the edge only after a brief dwell.
    if (!cur || cur.kind !== "edge") commitHint({ kind: "center" });
    dropHintTimer.current = setTimeout(() => {
      commitHint(hint);
      dropHintTimer.current = null;
    }, 50);
  };

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {
        /* not under Tauri */
      });
  }, []);

  // The active file, derived from a *deferred* active-file id for the same reason
  // `set` is (below): switching to another open tab re-runs computeView over a
  // large file — heavy work React can't defer through a transition now the doc
  // lives in a Zustand store (useSyncExternalStore). useDeferredValue lets the old
  // file (and its lines/view) stay on screen, dimmed, until the background render
  // catches up. The live id drives the instant sidebar tab highlight; a deferred id
  // left over from a closed file isn't found, so we fall back to the live file.
  const deferredFileId = useDeferredValue(state.activeFileId);
  const deferredFile = state.files.find((f) => f.id === deferredFileId);
  const liveActiveFile =
    state.files.find((f) => f.id === state.activeFileId) ??
    state.files[0] ??
    null;
  // In split view, both panes' files are already loaded and rendered, so moving
  // focus between them must NOT go through the deferred file-switch path (its
  // one-frame lag + "Loading…" overlay would flash a reload). Use the LIVE active
  // file so a focus swap is instant; single-pane keeps the deferred behaviour.
  const file = split.on ? liveActiveFile : (deferredFile ?? liveActiveFile);
  const isSwitchingFile =
    !split.on && !!deferredFile && deferredFile.id !== state.activeFileId;

  // ---------- dock layout ----------
  // Resolved before `set` because the dock owns the deferred panel-view selection
  // (the deferred set id, below) that `set` keys off.
  const dock = useDockLayout();
  const { selectPanelTab, toggleFilterCollapsed } = dock;

  // The active filter set, derived from the dock's *deferred* set id so switching
  // sets keeps the heavy re-render (recompile + recompute view + the filter list +
  // LogView highlights) off the click's critical path. The doc lives in a Zustand
  // store (useSyncExternalStore) now, and React can't defer external-store updates
  // inside a transition — so the dock defers the derived value with useDeferredValue
  // instead. During a switch the deferred id still points at the old set (the live
  // file.activeSetId drives the instant tab highlight); a deferred id left over from
  // a previous file isn't in this file's sets, so we fall back to the live set (no
  // file-switch flicker).
  // Resolve the active set from the global list via the active file's per-document
  // selection. During a SET switch (same file) the deferred id lags, so `set` shows
  // the old set until the heavy re-render catches up (smooth INP). During a FILE
  // switch we skip the deferral (`isSwitchingFile`) so a previous file's set never
  // flashes — the deferred `file` already smooths that transition. Split view uses
  // the LIVE set so a focus swap between panes doesn't lag/flash.
  const deferredSet =
    !split.on && !isSwitchingFile && dock.deferredActiveSetId
      ? state.filterSets.find((g) => g.id === dock.deferredActiveSetId)
      : undefined;
  const set =
    deferredSet ??
    (file?.activeSetId
      ? state.filterSets.find((g) => g.id === file.activeSetId)
      : undefined) ??
    state.filterSets[0] ??
    null;
  // Log-view header state is per-document (stored on the active LogFile).
  const findOpen = file?.findOpen ?? false;
  const fileViewMode: "all" | "matches" = file?.viewMode ?? "all";

  // Switching filter sets (or files) exits "view this filter only".
  useEffect(() => {
    setSoloFilterId(null);
  }, [file?.activeSetId, file?.id, setSoloFilterId]);

  // Set below to the split view's OS-drop router/highlighter (useLogFiles calls
  // them on a file drag/drop so it can land in the pane under the cursor).
  const osDropRef = useRef<
    ((paths: string[], x: number, y: number) => boolean) | null
  >(null);
  const osDragRef = useRef<((x: number, y: number) => void) | null>(null);
  const {
    lines,
    linesFor,
    busy,
    dragOver,
    openScreen,
    setOpenScreen,
    selectFile,
    deleteFile,
    openFiles,
    loadPaths,
    setFileEncoding,
  } = useLogFiles({ file, osDropRef, osDragRef });

  const compiled = useMemo(
    () => compileAll(set?.filters ?? []),
    [set?.filters],
  );
  const view = useMemo(() => computeView(lines, compiled), [lines, compiled]);

  // The filter slice's confirm-dialog collaborator can't be store state (it's a
  // React/UI primitive), so bind it into the store once.
  useEffect(() => {
    useStore.getState().setRuntime({ confirm: appConfirm });
  }, [appConfirm]);

  // ---------- compare / timeline / bookmarks ----------
  const {
    compareLines,
    compareRows,
    addToCompare,
    removeFromCompare,
    clearCompare,
    clearCompareGroup,
    importCompareGroup,
    exportGroupCsv,
  } = useCompare({ view, file });
  const {
    tracks,
    timelineLines,
    marks,
    badEndTracks,
    badFormatTracks,
    timeFieldsByFilter,
    orphanLines,
    trackLineStats,
    removeFromTimeline,
    clearTimeline,
    setTrack,
    removeTrack,
    reorderTracks,
    importTrackLines,
    clearTrackLines,
    addAllMatchingLines,
    setAllTracks,
    deleteAllTracks,
    clearAllLines,
    addLinesToTimeline,
    toggleTimelineTrack,
  } = useTimeline({ view, file, set, selectPanelTab });
  const { markers, setMarker, removeMarker } = useBookmarks();

  // Soloing a filter ("View this filter only"): the log shows just that filter's
  // matches (forced enabled, never excluding), while the filter panel keeps its
  // badge counts from the full `view`. Ephemeral — not persisted, not undoable.
  const soloFilter = soloFilterId
    ? (set?.filters.find((f) => f.id === soloFilterId) ?? null)
    : null;
  const soloView = useMemo(() => {
    if (!soloFilterId) return null;
    const c = compiled.find((x) => x.f.id === soloFilterId);
    if (!c || !c.re || !c.ok) return null;
    return computeView(lines, [
      { ...c, f: { ...c.f, enabled: true, exclude: false } },
    ]);
  }, [soloFilterId, compiled, lines]);
  const logView = soloView ?? view;
  const effectiveViewMode: "all" | "matches" = soloView
    ? "matches"
    : fileViewMode;

  // The NON-focused split pane shows its own file with its own computed view (the
  // focused pane reuses the active-file derivations above). Solo doesn't apply here
  // (it's an active-file concept). Only computed while split is on.
  const otherPaneId: "a" | "b" = activePaneId === "a" ? "b" : "a";
  const otherFileId = split.on ? panes[otherPaneId].active : null;
  const otherFile = otherFileId
    ? (state.files.find((f) => f.id === otherFileId) ?? null)
    : null;
  const otherLines = linesFor(otherFile?.id);
  // The non-focused pane's set is that document's own active selection (per-file),
  // so two panes showing different files apply different filter sets.
  const otherSet =
    (otherFile?.activeSetId
      ? state.filterSets.find((g) => g.id === otherFile.activeSetId)
      : undefined) ??
    state.filterSets[0] ??
    null;
  const otherCompiled = useMemo(
    () => compileAll(otherSet?.filters ?? []),
    [otherSet?.filters],
  );
  const otherView = useMemo(
    () => computeView(otherLines, otherCompiled),
    [otherLines, otherCompiled],
  );
  const otherCompareLines = useMemo(
    () =>
      new Set(
        otherFile ? (state.compareLinesByFile?.[otherFile.id] ?? []) : [],
      ),
    [otherFile, state.compareLinesByFile],
  );
  const otherTimelineLines = useMemo(
    () =>
      new Set(
        otherFile ? (state.timelineLinesByFile?.[otherFile.id] ?? []) : [],
      ),
    [otherFile, state.timelineLinesByFile],
  );

  // Keep the FOCUSED pane's active tab in sync with the app's active file (which the
  // sidebar / open dialog drive). Opening/selecting a file makes it the focused
  // pane's active tab, adding a tab if it's new — VS Code's "open into the active
  // group" behaviour.
  useEffect(() => {
    const active = state.activeFileId;
    if (!active) return;
    const pane = split.on ? activePaneId : "a";
    setPanes((p) => {
      const g = p[pane];
      if (g.active === active && g.tabs.includes(active)) return p;
      if (split.on) {
        // Split: opening/selecting a file adds it to the focused group (VS Code).
        const tabs = g.tabs.includes(active) ? g.tabs : [...g.tabs, active];
        return { ...p, [pane]: { tabs, active } };
      }
      // Single pane: keep the persisted main-group strip only while the active file
      // is one of its tabs (e.g. after closing a split); switching to a file outside
      // it resets the group to just that file — so merely opening files doesn't
      // accumulate a runaway strip.
      const tabs = g.tabs.includes(active) ? g.tabs : [active];
      return { ...p, a: { tabs, active } };
    });
  }, [split.on, activePaneId, state.activeFileId]);

  // Drop tabs whose file was closed; re-point a group's active tab if it vanished.
  useEffect(() => {
    const ids = new Set(state.files.map((f) => f.id));
    setPanes((p) => {
      const fix = (g: Pane): Pane => {
        const tabs = g.tabs.filter((id) => ids.has(id));
        const active =
          g.active && ids.has(g.active)
            ? g.active
            : (tabs[tabs.length - 1] ?? null);
        return { tabs, active };
      };
      const a = fix(p.a);
      const b = fix(p.b);
      if (
        a.active === p.a.active &&
        b.active === p.b.active &&
        a.tabs.length === p.a.tabs.length &&
        b.tabs.length === p.b.tabs.length
      )
        return p;
      return { a, b };
    });
  }, [state.files]);

  // Clear the drop hint (+ any pending edge-dwell timer) once the OS drag leaves.
  useEffect(() => {
    if (!dragOver) {
      if (dropHintTimer.current) {
        clearTimeout(dropHintTimer.current);
        dropHintTimer.current = null;
      }
      dropHintRef.current = null;
      setDropHint(null);
    }
  }, [dragOver]);

  // Per-table collapse for the Compare panel — see useCompareCollapse for why it
  // lives here (shared between the dock-head toggle and each table's chevron).
  const compareCollapse = useCompareCollapse(compareRows);

  // Reveal the Filters tab and focus its search box (Ctrl+Shift+L). The nonce
  // bump tells FilterPanel to focus even when the tab was already open.
  const focusFilterSearch = () => {
    selectPanelTab("filters");
    setFocusSearchNonce((n) => n + 1);
  };
  const showCompare = compareRows.length > 0;
  // Filter-row "Compare matching lines": pull the filter's parsed lines into the
  // comparison and reveal the Compare tab so the result is immediately visible —
  // the Compare analogue of "Add to timeline track".
  const compareFilter = (id: string) => {
    importCompareGroup(id);
    selectPanelTab("compare");
  };

  // ---------- filter actions ----------
  // Filter actions are read from the store where used (FilterPanel, menus, keyboard
  // self-subscribe). App keeps only the few it still wires into its own render:
  // focusFilter (toggleGroup), EditModal (deleteFilter/saveFilter), LogView
  // (openFilterFromPattern).
  const { toggleGroup, deleteFilter, openFilterFromPattern, saveFilter } =
    useStore(
      useShallow((s) => ({
        toggleGroup: s.toggleGroup,
        deleteFilter: s.deleteFilter,
        openFilterFromPattern: s.openFilterFromPattern,
        saveFilter: s.saveFilter,
      })),
    );

  // ---------- palette ----------
  // Palette editing now lives in the Settings dialog (store-connected); App only
  // resolves the effective palette for the filter editor's swatch row.
  const effectivePalette: PaletteEntry[] =
    state.customPalette ?? DEFAULT_PALETTE;
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ---------- navigation glue (panel ↔ panel) ----------
  // Jump from a Compare group header to the filter that produced it: reveal the
  // Filters tab, expand the filter's group if collapsed, then flash its row.
  // selectPanelTab no-ops (no dim transition) when Filters is already the visible
  // main tab — e.g. Compare popped out into its own dock — so clicking a header
  // row no longer flickers the filter panel's disable animation.
  const focusFilter = (id: string) => {
    selectPanelTab("filters");
    const f = set?.filters.find((x) => x.id === id);
    if (f?.groupId) {
      const grp = set?.groups.find((g) => g.id === f.groupId);
      if (grp?.collapsed) toggleGroup(grp.id);
    }
    setFilterFlash({ id, nonce: Date.now() });
  };

  // Jump to a bookmark from the Bookmarks tab. Bookmarks only render in "Show
  // all"; if the target line is hidden *because* of matches-only mode (not
  // excluded, just unmatched), switch to all first so the jump lands on it.
  const jumpToMarker = (n: number) => {
    const row = view.rows.find((r) => r.n === n);
    if (
      fileViewMode === "matches" &&
      view.hasHighlights &&
      row &&
      !row.excluded &&
      !row.winner
    ) {
      setViewMode("all");
    }
    setMarkerJump({ n, nonce: Date.now() });
  };

  // Wire the pinned-lines "jump to line" button into the app's jump mechanism.
  // A notebook can cite lines from several logs, so a card carries its source
  // file id: switch to that file first (if it's still open), then jump. When the
  // card's file is the active one — or its id is blank (pre-fileId cards) — fall
  // straight through to the in-file jump.
  const jumpToNotebookLine = (fileId: string, n: number) => {
    if (fileId && fileId !== file?.id) {
      if (!state.files.some((f) => f.id === fileId)) {
        toast.info("That log isn't open anymore.");
        return;
      }
      // Show the target file (deferred file-switch remounts LogView) and push the
      // jump; the new LogView reads markerJump on mount. Force "show all" on the
      // target so a matches-only view can't hide the cited line.
      setState((s) => ({ ...s, activeFileId: fileId }));
      patchState(
        (s) => {
          const f = s.files.find((x) => x.id === fileId);
          if (f) f.viewMode = "all";
        },
        { undoable: false },
      );
      setMarkerJump({ n, nonce: Date.now() });
      return;
    }
    jumpToMarker(n);
  };
  setPinnedLinesJumpHandler(jumpToNotebookLine);

  // Export the filtered log view via a native save dialog. LogView builds the
  // text (it knows which rows are visible) and hands it here to write.
  const exportFilteredView = useCallback(
    async (defaultName: string, text: string) => {
      const path = await save({
        defaultPath: defaultName,
        filters: [{ name: "Log", extensions: ["log", "txt"] }],
      });
      if (typeof path !== "string") return;
      try {
        await invoke("write_text_file", { path, contents: text });
        toast.success("Filtered view exported");
      } catch (e) {
        toast.error("Could not export view: " + String(e));
      }
    },
    [],
  );

  // ---------- layout ----------
  // Any explicit view-mode toggle also exits "view this filter only". View mode is
  // per-document; the split view targets a specific file so a pane toggles its own.
  const setViewModeFor = (fileId: string | null, m: "all" | "matches") => {
    setSoloFilterId(null);
    patchState(
      (s) => {
        const f = fileId ? s.files.find((x) => x.id === fileId) : activeFile(s);
        if (f) f.viewMode = m;
      },
      { undoable: false },
    );
  };
  const setViewMode = (m: "all" | "matches") =>
    setViewModeFor(state.activeFileId, m);
  const setFindOpen = (v: boolean | ((prev: boolean) => boolean)) =>
    patchState(
      (s) => {
        const f = activeFile(s);
        if (!f) return;
        f.findOpen = typeof v === "function" ? v(f.findOpen ?? false) : v;
      },
      { undoable: false },
    );
  // Ctrl+F: open the find bar and focus its input. The nonce bump tells LogView
  // to focus even when the bar was already open (so a second Ctrl+F re-focuses
  // and selects the existing query instead of doing nothing).
  const focusFind = () => {
    // Capture any highlighted text NOW: opening the bar focuses its input,
    // which clears the document selection before LogView's effects run.
    setFindSeed(window.getSelection()?.toString() ?? "");
    // Route to the last-touched pane (each pane has its own find bar while split).
    if (split.on) {
      if (activePaneId === "b") {
        setFindOpenB(true);
        setFindFocusNonceB((n) => n + 1);
      } else {
        setFindOpenA(true);
        setFindFocusNonce((n) => n + 1);
      }
    } else {
      setFindOpen(true);
      setFindFocusNonce((n) => n + 1);
    }
  };
  // Split toggle (button / Ctrl+\). Turning ON keeps the main group (pane A) and
  // seeds pane B with another open file (or the same when only one is open); the
  // main group's accumulated tabs are preserved. Turning OFF merges both groups'
  // tabs back into pane A (the surviving single view), keeping the active file.
  const toggleSplit = () => {
    const turningOn = !split.on;
    setSplit((s) => ({ ...s, on: turningOn }));
    setActivePaneId("a");
    setPanes((p) => {
      const active = state.activeFileId;
      if (turningOn) {
        const other = state.files.find((f) => f.id !== active)?.id ?? active;
        const a = p.a.tabs.length
          ? p.a
          : { tabs: active ? [active] : [], active };
        return { a, b: { tabs: other ? [other] : [], active: other } };
      }
      const merged = [
        ...p.a.tabs,
        ...p.b.tabs.filter((id) => !p.a.tabs.includes(id)),
      ];
      return { a: { tabs: merged, active }, b: { tabs: [], active: null } };
    });
  };
  const setSplitDir = (dir: "h" | "v") => setSplit((s) => ({ ...s, dir }));
  // Focus a pane: it becomes active and its active tab becomes the app's file. The
  // filter panel + highlights then follow that document's own active set (per-file),
  // so no set syncing is needed here.
  const focusPane = (pane: "a" | "b") => {
    if (pane === activePaneId) return;
    setActivePaneId(pane);
    const target = panes[pane].active;
    if (target && target !== state.activeFileId) selectFile(target);
  };
  // Click a file tab in a pane: focus that pane, activate the tab, make it the file.
  const activateTab = (pane: "a" | "b", fileId: string) => {
    setActivePaneId(pane);
    setPanes((p) => ({
      ...p,
      [pane]: {
        tabs: p[pane].tabs.includes(fileId)
          ? p[pane].tabs
          : [...p[pane].tabs, fileId],
        active: fileId,
      },
    }));
    if (fileId !== state.activeFileId) selectFile(fileId);
  };
  // Collapse the split back to a single view: the surviving pane's group becomes the
  // main group A (its tabs persist as the single-pane strip). Used when a pane loses
  // its last tab (closed or dragged away).
  const closeSplit = (survivorPane: "a" | "b") => {
    const g = panes[survivorPane];
    setSplit((s) => ({ ...s, on: false }));
    setActivePaneId("a");
    setPanes((p) => ({ a: p[survivorPane], b: { tabs: [], active: null } }));
    if (g.active && g.active !== state.activeFileId) selectFile(g.active);
  };
  // Close a file tab in a pane (the file stays open globally). In split mode,
  // closing a pane's LAST tab collapses that pane (the other becomes the single
  // view). In single mode the main-group strip only shows at ≥2 tabs, so this never
  // empties it.
  const closeTab = (pane: "a" | "b", fileId: string) => {
    const g = panes[pane];
    const remaining = g.tabs.filter((id) => id !== fileId);
    if (remaining.length === 0) {
      if (split.on) closeSplit(pane === "a" ? "b" : "a");
      return;
    }
    const nextActive =
      g.active === fileId ? remaining[remaining.length - 1] : g.active;
    setPanes((p) => ({
      ...p,
      [pane]: { tabs: remaining, active: nextActive },
    }));
    if (
      pane === activePaneId &&
      g.active === fileId &&
      nextActive &&
      nextActive !== state.activeFileId
    )
      selectFile(nextActive);
  };
  // Drop a dragged tab into `toPane` at `index` (drag-between-panes or reorder). The
  // source keeps ≥1 tab on a cross-pane move; the target activates the file + focuses.
  const moveTabTo = (
    fromPane: "a" | "b",
    toPane: "a" | "b",
    fileId: string,
    index: number,
  ) => {
    // Dragging a pane's LAST tab to the other pane empties the source → collapse to
    // a single view: the target group (with the moved file) becomes the main group.
    if (
      fromPane !== toPane &&
      panes[fromPane].tabs.filter((id) => id !== fileId).length === 0
    ) {
      const to = panes[toPane];
      const toTabs = to.tabs.includes(fileId) ? to.tabs : [...to.tabs, fileId];
      setSplit((s) => ({ ...s, on: false }));
      setActivePaneId("a");
      setPanes({
        a: { tabs: toTabs, active: fileId },
        b: { tabs: [], active: null },
      });
      if (fileId !== state.activeFileId) selectFile(fileId);
      return;
    }
    setPanes((p) => {
      const from = p[fromPane];
      const to = p[toPane];
      const fromTabs = from.tabs.filter((id) => id !== fileId);
      // Insert into the target list at the caret index (adjusted if the file was
      // already there before the slot).
      const origIdx = to.tabs.indexOf(fileId);
      const toBase = to.tabs.filter((id) => id !== fileId);
      let idx = index;
      if (origIdx >= 0 && origIdx < index) idx -= 1;
      idx = Math.max(0, Math.min(idx, toBase.length));
      toBase.splice(idx, 0, fileId);
      if (fromPane === toPane) {
        return { ...p, [toPane]: { tabs: toBase, active: fileId } };
      }
      const fromActive =
        from.active === fileId
          ? (fromTabs[fromTabs.length - 1] ?? null)
          : from.active;
      return {
        ...p,
        [fromPane]: { tabs: fromTabs, active: fromActive },
        [toPane]: { tabs: toBase, active: fileId },
      };
    });
    setActivePaneId(toPane);
    if (fileId !== state.activeFileId) selectFile(fileId);
  };
  // The drop target while a tab is dragged: which pane + the insertion index the
  // `|` caret marks. Computed from the live pointer (below), so tabs never live-
  // reorder during the drag.
  const computeTabDrop = (
    px: number,
    py: number,
  ): { pane: "a" | "b"; index: number } | null => {
    // Split panes carry data-pane; the single-pane group is `.lv-pane` (= pane "a").
    const groups = document.querySelectorAll("[data-pane], .lv-pane");
    for (const g of groups) {
      const r = g.getBoundingClientRect();
      if (px < r.left || px > r.right || py < r.top || py > r.bottom) continue;
      const p = g.getAttribute("data-pane") ?? "a";
      if (p !== "a" && p !== "b") continue;
      const tabEls = g.querySelectorAll(".pane-tabs .pane-tab");
      let index = tabEls.length;
      for (let i = 0; i < tabEls.length; i++) {
        const tr = (tabEls[i] as HTMLElement).getBoundingClientRect();
        if (px < tr.left + tr.width / 2) {
          index = i;
          break;
        }
      }
      return { pane: p, index };
    }
    return null;
  };
  // Rect hit-testing in CSS px (robust against overlays, which `elementFromPoint`
  // would hit). Which split pane a CSS coord is over:
  const paneAtCss = (cx: number, cy: number): "a" | "b" | null => {
    let found: "a" | "b" | null = null;
    document.querySelectorAll("[data-pane]").forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
        const p = el.getAttribute("data-pane");
        if (p === "a" || p === "b") found = p;
      }
    });
    return found;
  };
  // In single-pane mode, which zone of the log view a CSS coord is in: within ~22%
  // of an edge → that edge (opens a split there); otherwise the center (open here).
  const zoneOfLogview = (cx: number, cy: number): Zone | "center" | null => {
    let hit: DOMRect | null = null;
    document.querySelectorAll(".logview").forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom)
        hit = r;
    });
    if (!hit) return null;
    const rect: DOMRect = hit;
    const relX = (cx - rect.left) / rect.width;
    const relY = (cy - rect.top) / rect.height;
    const dist: Record<Zone, number> = {
      left: relX,
      right: 1 - relX,
      top: relY,
      bottom: 1 - relY,
    };
    const nearest = (Object.keys(dist) as Zone[]).reduce((a, b) =>
      dist[a] <= dist[b] ? a : b,
    );
    return dist[nearest] <= 0.22 ? nearest : "center";
  };
  // The drop action for a CSS-px cursor: onto a split pane (when split), else the
  // single pane's center (open here) or an edge (open a new split on that side).
  const computeDropHint = (cx: number, cy: number): DropHint => {
    if (split.on) {
      const p = paneAtCss(cx, cy);
      return p ? { kind: "pane", pane: p } : null;
    }
    const z = zoneOfLogview(cx, cy);
    if (!z) return null;
    return z === "center" ? { kind: "center" } : { kind: "edge", zone: z };
  };
  // Open a split with `fileIds` in a new pane on the dragged-to side; the current
  // active file takes the other pane. Focus the new pane.
  const openSplitWith = (zone: Zone, fileIds: string[]) => {
    const layout: Record<Zone, { dir: "h" | "v"; newPane: "a" | "b" }> = {
      left: { dir: "h", newPane: "a" },
      right: { dir: "h", newPane: "b" },
      top: { dir: "v", newPane: "a" },
      bottom: { dir: "v", newPane: "b" },
    };
    const { dir, newPane } = layout[zone];
    const activeFid = state.activeFileId;
    const newFid = fileIds[fileIds.length - 1] ?? null;
    const paneNew: Pane = { tabs: [...fileIds], active: newFid };
    const paneOld: Pane = {
      tabs: activeFid ? [activeFid] : [],
      active: activeFid,
    };
    setSplit({ on: true, dir });
    setPanes(
      newPane === "a" ? { a: paneNew, b: paneOld } : { a: paneOld, b: paneNew },
    );
    setActivePaneId(newPane);
    if (newFid && newFid !== state.activeFileId) selectFile(newFid);
  };
  // Add already-resolved file ids to a split pane as tabs (shared by OS-drop + the
  // sidebar drop routing).
  const addFilesToPane = (pane: "a" | "b", ids: string[]) => {
    if (!ids.length) return;
    setPanes((p) => ({
      ...p,
      [pane]: {
        tabs: [
          ...p[pane].tabs,
          ...ids.filter((id) => !p[pane].tabs.includes(id)),
        ],
        active: ids[ids.length - 1],
      },
    }));
    setActivePaneId(pane);
    selectFile(ids[ids.length - 1]);
  };
  // Highlight where an OS-dragged file would land (pane or edge-split preview).
  osDragRef.current = (x, y) => {
    const dpr = window.devicePixelRatio || 1;
    applyDropHint(computeDropHint(x / dpr, y / dpr));
  };
  // OS file drop over the log area: pane → add tab(s); single-pane center → open
  // in place; edge → open a new split on that side. Returns true when it claims the
  // drop (an empty workspace has no `.logview`, so it falls through to the default).
  osDropRef.current = (paths, x, y) => {
    applyDropHint(null);
    const dpr = window.devicePixelRatio || 1;
    const hint = computeDropHint(x / dpr, y / dpr);
    if (!hint) return false; // not over the log area → default (open screen path)
    void (async () => {
      // loadPaths dedupes by path + activates the last; resolve each to its id.
      await loadPaths(paths);
      const files = useStore.getState().doc.files;
      const ids = paths
        .map((p) => files.find((f) => f.path === p)?.id)
        .filter((id): id is string => !!id);
      if (!ids.length) return;
      if (hint.kind === "pane") addFilesToPane(hint.pane, ids);
      else if (hint.kind === "edge") openSplitWith(hint.zone, ids);
      // center: loadPaths already opened + activated the file(s) in place.
    })();
    return true;
  };
  // Tab drag needs a small threshold so a plain click still activates the tab.
  const tabSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  // The file name shown in the DragOverlay clone while a tab is dragged (the source
  // tab stays put), and the live caret target ({pane,index}) it will drop into.
  const [draggingTabName, setDraggingTabName] = useState<string | null>(null);
  const [draggingFromPane, setDraggingFromPane] = useState<"a" | "b" | null>(
    null,
  );
  const [tabDropTarget, setTabDropTarget] = useState<{
    pane: "a" | "b";
    index: number;
  } | null>(null);
  const tabPointerCleanup = useRef<(() => void) | null>(null);
  const onTabDragStart = (e: DragStartEvent) => {
    const fileId = String(e.active.id).slice(2);
    setDraggingFromPane(String(e.active.id).slice(0, 1) as "a" | "b");
    setDraggingTabName(state.files.find((f) => f.id === fileId)?.name ?? null);
    // Track the live pointer to drive the drop caret (dnd-kit's `over` can't give
    // us an insertion index without live-reordering droppables).
    const move = (ev: PointerEvent) =>
      setTabDropTarget(computeTabDrop(ev.clientX, ev.clientY));
    window.addEventListener("pointermove", move);
    tabPointerCleanup.current = () =>
      window.removeEventListener("pointermove", move);
  };
  const endTabDrag = () => {
    tabPointerCleanup.current?.();
    tabPointerCleanup.current = null;
    setDraggingTabName(null);
    setDraggingFromPane(null);
    setTabDropTarget(null);
  };
  const onTabDragEnd = (e: DragEndEvent) => {
    const dt = tabDropTarget;
    endTabDrag();
    if (!dt) return;
    const fromPane = String(e.active.id).slice(0, 1) as "a" | "b";
    const fileId = String(e.active.id).slice(2);
    moveTabTo(fromPane, dt.pane, fileId, dt.index);
  };
  const toggleSidebar = () =>
    setState((s) => ({ ...s, sidebarCollapsed: !s.sidebarCollapsed }));
  const toggleLineNumbers = () =>
    setState((s) => ({ ...s, showLineNumbers: !(s.showLineNumbers ?? true) }));

  // useFontZoom still runs for its Ctrl+wheel listener; the zoom actions themselves
  // are read from the store by the menus/keyboard that use them.
  const { fontSize } = useFontZoom();

  const fontWeight = state.fontWeight ?? 400;
  const showLineNumbers = state.showLineNumbers ?? true;
  const rowH = Math.round(fontSize * 1.5);
  const filterRowH = Math.round(fontSize * 1.58);

  // ---------- menu actions ----------
  const openDocs = () => {
    invoke("open_url", { url: DOCS_URL }).catch((e) =>
      toast.error("Could not open documentation: " + String(e)),
    );
  };
  const selectAllLines = () => setSelectAllNonce((n) => n + 1);
  const openGoto = () => setGotoOpen(true);

  useKeyboardShortcuts({
    menus: MENUS,
    openMenu,
    setOpenMenu,
    openFiles,
    fileViewMode,
    setViewMode,
    setFindOpen,
    findOpen,
    openScreen,
    filesCount: state.files.length,
    setOpenScreen,
    shortcutsOpen,
    setShortcutsOpen,
    aboutOpen,
    setAboutOpen,
    toggleFilterCollapsed,
    openGoto,
    focusFilterSearch,
    focusFind,
    toggleSplit,
  });

  const menuDefs = useMenuDefs({
    openFiles,
    loadPaths,
    selectAllLines,
    setFindOpen,
    openGoto,
    toggleFilterCollapsed,
    setViewMode,
    toggleLineNumbers,
    openDocs,
    setShortcutsOpen,
    setAboutOpen,
  });

  // Build the resizable workspace: log view + filter/compare docks. Docks dock
  // bottom or right; on the same side compare sits before (above/left-of) filter.
  function renderWorkspace(): ReactNode {
    // Files as {id,name} for the pane tab strips.
    const openFilesList = state.files.map((f) => ({ id: f.id, name: f.name }));

    // Per-pane data bundle. The FOCUSED pane reuses the active-file derivations
    // (view/set/markers/compare/…); the other pane uses its own file's computed
    // view. All WRITE actions target the bundle's file explicitly (viewMode,
    // encoding) or the active file (compare/timeline/bookmark) — safe because
    // interacting with a pane focuses it first, making its file active.
    const bundleFor = (pane: "a" | "b") => {
      if (pane === activePaneId) {
        if (!file) return null;
        return {
          file,
          view: logView,
          lines,
          filters: set?.filters ?? [],
          viewMode: effectiveViewMode,
          markers,
          compareLines,
          timelineLines,
          soloPattern:
            soloView && soloFilter
              ? soloFilter.pattern || "untitled filter"
              : null,
        };
      }
      if (!otherFile) return null;
      return {
        file: otherFile,
        view: otherView,
        lines: otherLines,
        filters: otherSet?.filters ?? [],
        viewMode: (otherFile.viewMode ?? "all") as "all" | "matches",
        markers: otherFile.markers ?? [],
        compareLines: otherCompareLines,
        timelineLines: otherTimelineLines,
        soloPattern: null,
      };
    };

    const logViewFor = (pane: "a" | "b"): ReactNode => {
      const b = bundleFor(pane);
      if (!b) return null;
      const isFocused = pane === activePaneId;
      // Show the tab strip when split, or (single pane) when the main group kept ≥2
      // tabs — e.g. after closing a split. A lone file stays strip-free.
      const showTabs = split.on || panes[pane].tabs.length >= 2;
      // Find bar: per-pane ephemeral while split is on; falls back to the file-backed
      // findOpen for the single pane.
      const findOpenP = split.on
        ? pane === "a"
          ? findOpenA
          : findOpenB
        : findOpen;
      const setFindOpenP = split.on
        ? pane === "a"
          ? setFindOpenA
          : setFindOpenB
        : setFindOpen;
      const findNonceP =
        split.on && pane === "b" ? findFocusNonceB : findFocusNonce;
      const lv = (
        <LogView
          key={b.file.id + ":" + pane}
          paneId={pane}
          file={b.file}
          view={b.view}
          lines={b.lines}
          filters={b.filters}
          viewMode={b.viewMode}
          soloPattern={b.soloPattern}
          onExitSolo={() => setSoloFilterId(null)}
          onToggleViewMode={(m) => setViewModeFor(b.file.id, m)}
          onToggleFind={() => setFindOpenP((v) => !v)}
          findOpen={findOpenP}
          onCloseFind={() => setFindOpenP(false)}
          findFocusNonce={findNonceP}
          findSeed={findSeed}
          onBuildFilter={openFilterFromPattern}
          mapColorMode={state.mapColorMode ?? "bg"}
          mapWidth={state.mapWidth ?? 14}
          fontSize={fontSize}
          showLineNumbers={showLineNumbers}
          compareLines={b.compareLines}
          onAddToCompare={addToCompare}
          onRemoveFromCompare={removeFromCompare}
          timelineLines={b.timelineLines}
          onAddToTimeline={addLinesToTimeline}
          onRemoveFromTimeline={removeFromTimeline}
          selectAllNonce={isFocused ? selectAllNonce : undefined}
          gotoSignal={isFocused ? gotoSignal : undefined}
          onExportView={exportFilteredView}
          markers={b.markers}
          markerJump={isFocused ? markerJump : undefined}
          onSetMarker={setMarker}
          onRemoveMarker={removeMarker}
          onSetEncoding={(label) => setFileEncoding(b.file.id, label)}
          splitOn={split.on}
          splitDir={split.dir}
          onToggleSplit={toggleSplit}
          onSetSplitDir={setSplitDir}
          onPaneFocus={() => focusPane(pane)}
          hideTitle={showTabs}
          onAddToNotebook={(ns) => {
            const picked = ns
              .map((n) => ({ n, text: b.view.rows[n - 1]?.text ?? "" }))
              .filter((l) => l.text !== "");
            if (picked.length) {
              useStore.getState().ensureNotebook();
              callAddPinnedLines(picked, b.file.name, b.file.id);
              selectPanelTab("notebook");
            }
          }}
        />
      );
      // Single pane: an optional main-group tab strip on top, then the log wrapped
      // so the drop preview (center "open here" or an edge split) can overlay it.
      if (!split.on) {
        return (
          <div className="lv-pane">
            {showTabs && (
              <PaneTabs
                pane="a"
                tabs={panes.a.tabs}
                activeId={panes.a.active}
                files={openFilesList}
                caretIndex={
                  tabDropTarget?.pane === "a" ? tabDropTarget.index : null
                }
                onActivate={(id) => activateTab("a", id)}
                onClose={(id) => closeTab("a", id)}
              />
            )}
            <div className="lv-wrap">
              {lv}
              {dropHint?.kind === "center" && (
                <div className="lv-split-preview center">
                  <div className="pane-drop-card">
                    <Upload size={16} />
                    <span>Open here</span>
                  </div>
                </div>
              )}
              {dropHint?.kind === "edge" && (
                <div className={"lv-split-preview " + dropHint.zone}>
                  <div className="pane-drop-card">
                    <Upload size={16} />
                    <span>Open split</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      }
      return (
        <div
          className={"pane-group" + (isFocused ? " focused" : "")}
          data-pane={pane}
          onPointerDownCapture={() => focusPane(pane)}
        >
          <PaneTabs
            pane={pane}
            tabs={panes[pane].tabs}
            activeId={panes[pane].active}
            files={openFilesList}
            caretIndex={
              tabDropTarget?.pane === pane ? tabDropTarget.index : null
            }
            onActivate={(id) => activateTab(pane, id)}
            onClose={(id) => closeTab(pane, id)}
          />
          {lv}
          {dropHint?.kind === "pane" && dropHint.pane === pane && (
            <div className="pane-drop-hint">
              <div className="pane-drop-card">
                <Upload size={16} />
                <span>Drop to open here</span>
              </div>
            </div>
          )}
          {/* Dragging a tab onto a DIFFERENT pane highlights that pane too (the `|`
              caret in its strip shows exactly where it will land). */}
          {draggingTabName &&
            tabDropTarget?.pane === pane &&
            draggingFromPane !== pane && <div className="pane-tab-drop" />}
        </div>
      );
    };

    const logview = split.on ? (
      <DndContext
        sensors={tabSensors}
        onDragStart={onTabDragStart}
        onDragEnd={onTabDragEnd}
        onDragCancel={endTabDrag}
      >
        <ResizablePanelGroup
          // Remount when the orientation flips — the library can't switch a live
          // group between horizontal/vertical.
          key={"lv-split-" + split.dir}
          id="lv-split"
          orientation={split.dir === "h" ? "horizontal" : "vertical"}
          defaultLayout={{ "pane-a": 50, "pane-b": 50 }}
        >
          <ResizablePanel id="pane-a" defaultSize="50%" minSize="12%">
            {logViewFor("a")}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="pane-b" defaultSize="50%" minSize="12%">
            {logViewFor("b")}
          </ResizablePanel>
        </ResizablePanelGroup>
        <DragOverlay dropAnimation={null}>
          {draggingTabName ? (
            <div className="pane-tab active pane-tab-overlay">
              <span className="pane-tab-name">{draggingTabName}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    ) : (
      // Single pane still needs a DndContext so the main-group tab strip's tabs are
      // draggable (reorder within the one group).
      <DndContext
        sensors={tabSensors}
        onDragStart={onTabDragStart}
        onDragEnd={onTabDragEnd}
        onDragCancel={endTabDrag}
      >
        {logViewFor("a")}
        <DragOverlay dropAnimation={null}>
          {draggingTabName ? (
            <div className="pane-tab active pane-tab-overlay">
              <span className="pane-tab-name">{draggingTabName}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    );

    const filterBody = (
      <FilterPanel
        file={file!}
        set={set!}
        counts={view.counts}
        onToggleTimelineTrack={toggleTimelineTrack}
        onCompareFilter={compareFilter}
        flashFilterId={filterFlash?.id ?? null}
        flashNonce={filterFlash?.nonce ?? 0}
        onFlashConsumed={() => setFilterFlash(null)}
        focusSearchNonce={focusSearchNonce}
      />
    );
    const compareBody = (
      <CompareTable
        rows={compareRows}
        rowH={rowH}
        onRemove={(n) => removeFromCompare([n])}
        onExport={exportGroupCsv}
        onClearGroup={clearCompareGroup}
        onImportMatching={importCompareGroup}
        onJump={jumpToMarker}
        onFocusFilter={focusFilter}
        collapsed={compareCollapse.collapsed}
        onToggleCollapse={compareCollapse.toggle}
        labelFor={(id) => {
          const f = set!.filters.find((x) => x.id === id);
          return (f?.description?.trim() || f?.pattern) ?? "Fields";
        }}
        colorFor={(id) =>
          set!.filters.find((x) => x.id === id)?.textColor ?? "#c2c7cd"
        }
        indexFor={(id) => set!.filters.findIndex((x) => x.id === id)}
        onAddToNotebook={(label, cols, rows) => {
          useStore.getState().ensureNotebook();
          callAddCompareCard(label, cols, rows);
          selectPanelTab("notebook");
        }}
      />
    );
    const bookmarksBody = (
      <BookmarksPanel
        lineText={(n) => view.rows[n - 1]?.text ?? ""}
        onJump={jumpToMarker}
      />
    );

    const timelineBody = (
      <TimelinePanel
        tracks={tracks}
        filters={set?.filters ?? []}
        timeFields={timeFieldsByFilter}
        marks={marks}
        badEndTracks={badEndTracks}
        badFormatTracks={badFormatTracks}
        lineCount={timelineLines.size}
        onSetTrack={setTrack}
        onRemoveTrack={removeTrack}
        onReorderTracks={reorderTracks}
        onAddMatchingLines={addAllMatchingLines}
        onImportAll={addAllMatchingLines}
        onClearAll={clearAllLines}
        onSetAll={setAllTracks}
        onDeleteAll={deleteAllTracks}
        onImportTrackLines={importTrackLines}
        onClearTrackLines={clearTrackLines}
        trackLineStats={trackLineStats}
        orphanLines={orphanLines}
        onRemoveLines={removeFromTimeline}
        onJump={jumpToMarker}
        onFocusFilter={focusFilter}
        sheetH={state.timelineSheetH ?? 200}
        onSetSheetH={(h) => setState((s) => ({ ...s, timelineSheetH: h }))}
        iconSize={state.timelineIconSize ?? "M"}
        onAddToNotebook={(dataUrl) => {
          useStore.getState().ensureNotebook();
          callAddTimelineCard(dataUrl);
          selectPanelTab("notebook");
        }}
      />
    );

    const notebookBody = <NotebookPanel />;

    return (
      <Workspace
        logview={logview}
        filterBody={filterBody}
        compareBody={compareBody}
        bookmarksBody={bookmarksBody}
        timelineBody={timelineBody}
        notebookBody={notebookBody}
        dock={dock}
        compareCollapse={compareCollapse}
        // Split view only: name the document the dock panels act on (the focused
        // pane's file), so it's unambiguous which log Filters/Bookmarks/… target.
        docChip={split.on ? (file?.name ?? null) : null}
        panelPos={state.panelPos}
        filterCollapsed={state.filterCollapsed}
        poppedCollapsed={!!state.poppedCollapsed}
        compareCount={compareRows.length}
        markerCount={markers.length}
        markCount={marks.length}
        showCompare={showCompare}
        clearCompare={clearCompare}
        clearTimeline={clearTimeline}
        onSelectPoppedTab={(t) =>
          setState((s) => ({
            ...s,
            poppedActiveTab: t,
            poppedCollapsed: false,
          }))
        }
      />
    );
  }

  return (
    <NotebookHost>
      <TooltipProvider delay={350}>
        <div
          className="app"
          style={
            {
              "--log-font-size": `${fontSize}px`,
              "--log-font-weight": fontWeight,
              "--log-row-h": `${rowH}px`,
              "--filter-row-h": `${filterRowH}px`,
            } as CSSProperties
          }
        >
          {/* titlebar */}
          <Titlebar
            menus={MENUS}
            openMenu={openMenu}
            setOpenMenu={setOpenMenu}
          />

          {/* body */}
          <div className="body">
            <Sidebar
              state={state}
              collapsed={state.sidebarCollapsed}
              openScreen={openScreen}
              onToggleCollapse={toggleSidebar}
              onSelectFile={selectFile}
              onOpenFile={() => setOpenScreen(true)}
              onDeleteFile={deleteFile}
              onSetFileIcon={(id, icon) =>
                patchState(
                  (s) => {
                    const f = s.files.find((x) => x.id === id);
                    if (f) f.icon = icon;
                  },
                  { undoable: false },
                )
              }
              onOpenSettings={() => setSettingsOpen(true)}
              onFileDragOver={(pt) =>
                applyDropHint(pt ? computeDropHint(pt.x, pt.y) : null)
              }
              onFileDropAt={(fileId, x, y) => {
                const hint = computeDropHint(x, y);
                if (!hint) return false;
                if (hint.kind === "pane") activateTab(hint.pane, fileId);
                else if (hint.kind === "center") selectFile(fileId);
                else openSplitWith(hint.zone, [fileId]);
                return true;
              }}
            />
            {file && set && !openScreen ? (
              renderWorkspace()
            ) : (
              <div
                className={"empty-workspace" + (dragOver ? " dragover" : "")}
                onClick={() => void openFiles()}
                title="Click to open a log file, or drop one here"
              >
                <div className="ew-card">
                  <div className="ew-icon">
                    <FolderOpen size={40} />
                  </div>
                  <div className="ew-title">
                    {state.files.length ? "Open another log" : "No log open"}
                  </div>
                  <div className="ew-sub">
                    Click here to choose a log file, or drag &amp; drop one into
                    this window.
                  </div>
                  <Button
                    onClick={(e) => {
                      e.stopPropagation();
                      void openFiles();
                    }}
                  >
                    <Upload data-icon="inline-start" />
                    Open log file
                  </Button>
                  <div className="ew-hint">Ctrl O</div>
                </div>
              </div>
            )}
          </div>

          {/* modal */}
          {editing && set && (
            <EditModal
              filter={editing.filter}
              isNew={editing.isNew}
              genSeed={editing.genSeed}
              lines={lines}
              groups={set.order
                .map((id) => set.groups.find((g) => g.id === id))
                .filter((g): g is FilterGroup => !!g)
                .concat(set.groups.filter((g) => !set.order.includes(g.id)))}
              palette={effectivePalette}
              onSave={saveFilter}
              onClose={() => setEditing(null)}
              onDelete={() => deleteFilter(editing.filter.id)}
            />
          )}

          {/* settings dialog (store-connected; palette editor lives inside it) */}
          {settingsOpen && (
            <SettingsDialog onClose={() => setSettingsOpen(false)} />
          )}

          <Overlays
            busy={busy}
            loadingLabel={loadingLabel}
            isSwitchingFile={isSwitchingFile}
          />

          {openMenu && (
            <MenuPopup
              key={openMenu.name}
              items={menuDefs[openMenu.name]}
              x={openMenu.x}
              y={openMenu.y + 2}
              onClose={() => setOpenMenu(null)}
            />
          )}

          {/* go-to-line dialog */}
          {gotoOpen && (
            <GotoDialog
              onSubmit={(n) => setGotoSignal({ n, nonce: Date.now() })}
              onClose={() => setGotoOpen(false)}
            />
          )}

          {/* about dialog */}
          {aboutOpen && (
            <AboutModal
              version={appVersion}
              onClose={() => setAboutOpen(false)}
            />
          )}

          {/* keyboard shortcuts dialog */}
          {shortcutsOpen && (
            <ShortcutsModal onClose={() => setShortcutsOpen(false)} />
          )}

          {/* app-styled confirmations (replaces native confirm()) */}
          {confirmNode}

          <Toaster />
        </div>
      </TooltipProvider>
    </NotebookHost>
  );
}
