import {
  useState,
  useMemo,
  useEffect,
  useCallback,
  useDeferredValue,
  useRef,
  Fragment,
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
import type { FilterGroup, Pane } from "@/types";
import { DEFAULT_PALETTE } from "@/lib/palette";
import type { PaletteEntry } from "@/types";

/** Stable empty array — a pane with no compare/timeline lines must not hand
 *  PaneData a fresh `[]` each render (it would re-memo its Sets every time). */
const EMPTY_NUMS: number[] = [];

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
import { PaneTabs, type TabFile } from "@/components/layout/PaneTabs";
import { PaneData, type PaneBundle } from "@/components/layout/PaneData";
import { Titlebar } from "@/components/layout/Titlebar";
import { GotoDialog } from "@/components/dialogs/GotoDialog";
import { QuickOpenDialog } from "@/components/dialogs/QuickOpenDialog";
import { Overlays } from "@/components/layout/Overlays";
import { useFontZoom } from "@/hooks/useFontZoom";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useMenuDefs } from "@/hooks/useMenuDefs";
import { useLogFiles } from "@/hooks/useLogFiles";
import { useSplitView, paneLayout, type Zone } from "@/hooks/useSplitView";
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
import { disambiguationSuffixes } from "@/lib/path";
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
  // Quick Open palette (Ctrl+P) — fuzzy-jump between the open logs.
  const [quickOpen, setQuickOpen] = useState(false);
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
  // ---- split view: VS Code-style editor groups, persisted on `doc.splitView`. ----
  // The layout is N panes in ONE row or column (no nesting), each an "editor group"
  // with its own ordered file tabs + active tab. The FOCUSED pane's active tab is the
  // app's active file, so the filter/compare/timeline/bookmark panels + write actions
  // follow whichever pane you last touched.
  //
  // The layout and every mutation on it live in useSplitView (constructed below, once
  // `selectFile` exists). App keeps only the ephemeral chrome around it: the drop
  // hints, the tab-drag state, and the per-pane find bars.
  const sv = state.splitView!; // normalizeState guarantees a layout with ≥1 pane
  const splitOn = sv.panes.length > 1;
  // The document each pane is showing. Handed to useLogFiles so a pane restored onto
  // a log that was never the active file still gets its lines read from disk.
  const paneFileIds = useMemo(
    () => sv.panes.map((p) => p.active).filter((id): id is string => !!id),
    [sv.panes],
  );
  // Files as the pane tab strips show them: the name, plus the parent-dir suffix
  // that tells same-named logs apart (`deviceA/0703`) — the same VS Code-style
  // disambiguation the sidebar does, which matters far more here, since two panes
  // showing `console.log` from different devices are otherwise identical tabs.
  const tabFiles: TabFile[] = useMemo(() => {
    const suffixes = disambiguationSuffixes(state.files);
    return state.files.map((f) => ({
      id: f.id,
      name: f.name,
      dir: suffixes[f.id],
      // Shown in full on the tab's hover tooltip — a tab is often truncated.
      path: f.path,
    }));
  }, [state.files]);
  // Find bars: while split, each pane owns an ephemeral one (two panes on one file
  // keep independent queries). A lone pane keeps the file-backed, persisted `findOpen`.
  const [findOpenByPane, setFindOpenByPane] = useState<Record<string, boolean>>(
    {},
  );
  const [findNonceByPane, setFindNonceByPane] = useState<
    Record<string, number>
  >({});
  // While a file is dragged (OS or sidebar), where it would drop. With several panes:
  // onto a pane (add tab). With one: the CENTER (open in place) or one of four EDGE
  // zones (open a new pane on that side). Drives the drop indicators.
  type DropHint =
    | { kind: "pane"; pane: string }
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
  // In split view every pane's file is already loaded and rendered, so moving focus
  // between panes must NOT go through the deferred file-switch path (its one-frame
  // lag + "Loading…" overlay would flash a reload). Use the LIVE active file so a
  // focus swap is instant; single-pane keeps the deferred behaviour.
  const file = splitOn ? liveActiveFile : (deferredFile ?? liveActiveFile);
  const isSwitchingFile =
    !splitOn && !!deferredFile && deferredFile.id !== state.activeFileId;

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
    !splitOn && !isSwitchingFile && dock.deferredActiveSetId
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
    deleteFiles,
    openFiles,
    cancelOpen,
    loadPaths,
    setFileEncoding,
  } = useLogFiles({ file, paneFileIds, osDropRef, osDragRef });

  // Every pane mutation (focus, tabs, split/close, drag-between-panes, sizes). Built
  // here because its actions route through `selectFile` — the layout itself was read
  // from the store above, so nothing below depends on this ordering.
  const split = useSplitView({ selectFile });
  const { panes, activePaneId } = split;

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
    if (splitOn) {
      setFindOpenByPane((m) => ({ ...m, [activePaneId]: true }));
      setFindNonceByPane((m) => ({
        ...m,
        [activePaneId]: (m[activePaneId] ?? 0) + 1,
      }));
    } else {
      setFindOpen(true);
      setFindFocusNonce((n) => n + 1);
    }
  };
  // Per-pane find-bar accessors: ephemeral + per-pane while split, file-backed (and
  // persisted) when a single pane is showing.
  const findOpenFor = (paneId: string) =>
    splitOn ? !!findOpenByPane[paneId] : findOpen;
  const findNonceFor = (paneId: string) =>
    splitOn ? (findNonceByPane[paneId] ?? 0) : findFocusNonce;
  const setFindOpenFor =
    (paneId: string) => (v: boolean | ((prev: boolean) => boolean)) => {
      if (!splitOn) return setFindOpen(v);
      setFindOpenByPane((m) => ({
        ...m,
        [paneId]: typeof v === "function" ? v(!!m[paneId]) : v,
      }));
    };
  // The drop target while a tab is dragged: which pane + the insertion index the
  // `|` caret marks. Computed from the live pointer (below), so tabs never live-
  // reorder during the drag.
  const computeTabDrop = (
    px: number,
    py: number,
  ): { pane: string; index: number } | null => {
    for (const g of document.querySelectorAll("[data-pane]")) {
      const r = g.getBoundingClientRect();
      if (px < r.left || px > r.right || py < r.top || py > r.bottom) continue;
      const p = g.getAttribute("data-pane");
      if (!p) continue;
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
  // would hit). Which pane a CSS coord is over:
  const paneAtCss = (cx: number, cy: number): string | null => {
    let found: string | null = null;
    document.querySelectorAll("[data-pane]").forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom)
        found = el.getAttribute("data-pane");
    });
    return found;
  };
  // In single-pane mode, which zone of the log view a CSS coord is in: only right up
  // against an edge (the outer 10%) does it split there; the whole middle opens the
  // file in place. Splitting is the rarer intent, so it takes a deliberate aim.
  const EDGE_ZONE = 0.1;
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
    return dist[nearest] <= EDGE_ZONE ? nearest : "center";
  };
  // The drop action for a CSS-px cursor: onto a pane (when several are open), else
  // the lone pane's center (open here) or an edge (open a new pane on that side).
  // Edge zones stay a single-pane affordance — with panes already side by side, the
  // adjacent edges of neighbouring panes would be an ambiguous target.
  const computeDropHint = (cx: number, cy: number): DropHint => {
    if (splitOn) {
      const p = paneAtCss(cx, cy);
      return p ? { kind: "pane", pane: p } : null;
    }
    const z = zoneOfLogview(cx, cy);
    if (!z) return null;
    return z === "center" ? { kind: "center" } : { kind: "edge", zone: z };
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
    // Dropped into a pane → the new file opens on THAT pane's filter set, not the
    // focused pane's (they can differ; the set follows the document a pane shows).
    const paneSetId =
      hint.kind === "pane"
        ? (() => {
            const shown = panes.find((p) => p.id === hint.pane)?.active;
            const f = shown ? state.files.find((x) => x.id === shown) : null;
            return f?.activeSetId ?? state.filterSets[0]?.id ?? undefined;
          })()
        : undefined;
    void (async () => {
      // A pane/edge drop places the file itself, so loadPaths must NOT activate it
      // on the way in — an activated file is pulled into the focused pane, and the
      // drop would land it in two panes. Only a center drop wants the default.
      await loadPaths(paths, {
        activate: hint.kind === "center",
        setId: paneSetId,
      });
      // loadPaths dedupes by path; resolve each back to its id.
      const files = useStore.getState().doc.files;
      const ids = paths
        .map((p) => files.find((f) => f.path === p)?.id)
        .filter((id): id is string => !!id);
      if (!ids.length) return;
      if (hint.kind === "pane") split.addFilesToPane(hint.pane, ids);
      else if (hint.kind === "edge")
        split.openPaneAtEdge(panes[0].id, hint.zone, ids);
      // center: loadPaths already opened + activated the file(s) in place.
    })();
    return true;
  };
  // Tab drag needs a small threshold so a plain click still activates the tab.
  const tabSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  // A tab's drag id is "<paneId>:<fileId>" — both are uid()s, which never contain a
  // colon, so the FIRST one splits them.
  const splitDragId = (id: string): { pane: string; fileId: string } => {
    const at = id.indexOf(":");
    return { pane: id.slice(0, at), fileId: id.slice(at + 1) };
  };
  // The file shown in the DragOverlay clone while a tab is dragged (the source tab
  // stays put), and the live caret target ({pane,index}) it will drop into.
  const [draggingTab, setDraggingTab] = useState<TabFile | null>(null);
  const [draggingFromPane, setDraggingFromPane] = useState<string | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<{
    pane: string;
    index: number;
  } | null>(null);
  const tabPointerCleanup = useRef<(() => void) | null>(null);
  const onTabDragStart = (e: DragStartEvent) => {
    const { pane, fileId } = splitDragId(String(e.active.id));
    setDraggingFromPane(pane);
    setDraggingTab(tabFiles.find((f) => f.id === fileId) ?? null);
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
    setDraggingTab(null);
    setDraggingFromPane(null);
    setTabDropTarget(null);
  };
  const onTabDragEnd = (e: DragEndEvent) => {
    const dt = tabDropTarget;
    endTabDrag();
    if (!dt) return;
    const { pane, fileId } = splitDragId(String(e.active.id));
    split.moveTabTo(pane, dt.pane, fileId, dt.index);
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
    openQuickOpen: () => setQuickOpen(true),
    fileViewMode,
    setViewMode,
    // Escape closes whichever bar is actually showing: the focused pane's while
    // split, the file-backed one otherwise.
    setFindOpen: (v) => setFindOpenFor(activePaneId)(v),
    findOpen: findOpenFor(activePaneId),
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
    splitPane: split.splitPane,
    closePane: () => split.closePane(activePaneId),
  });

  const menuDefs = useMenuDefs({
    openFiles,
    loadPaths,
    selectAllLines,
    focusFind,
    openGoto,
    openQuickOpen: () => setQuickOpen(true),
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
    // The FOCUSED pane's bundle: it reuses the active-file derivations (view / set /
    // markers / compare / solo) that the dock panels are built from, so the active
    // file's view is never computed twice. Every OTHER pane derives its own inside
    // PaneData — App can't useMemo per pane when the pane count is variable.
    //
    // All WRITE actions target the bundle's file explicitly (viewMode, encoding) or
    // the active file (compare/timeline/bookmark) — safe because interacting with a
    // pane focuses it first, making its file the active one.
    const focusedBundle: PaneBundle | null = file
      ? {
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
        }
      : null;

    // One pane: its tab strip + its LogView, wrapped in PaneData (which supplies the
    // pane's view of its document). PaneData wraps EVERY pane, focused or not, so the
    // element tree keeps the same shape when focus moves — otherwise LogView would
    // remount on a focus swap and lose its scroll position.
    const logViewFor = (pane: Pane): ReactNode => {
      const isFocused = pane.id === activePaneId;
      const paneFile = pane.active
        ? (state.files.find((f) => f.id === pane.active) ?? null)
        : null;
      // The pane's filter set is its DOCUMENT's own selection, so panes on different
      // files apply different sets with no syncing.
      const paneSet =
        (paneFile?.activeSetId
          ? state.filterSets.find((g) => g.id === paneFile.activeSetId)
          : undefined) ??
        state.filterSets[0] ??
        null;
      return (
        <PaneData
          key={pane.id}
          file={paneFile}
          filters={paneSet?.filters ?? null}
          lines={linesFor(pane.active)}
          compareLineNums={
            (paneFile && state.compareLinesByFile?.[paneFile.id]) || EMPTY_NUMS
          }
          timelineLineNums={
            (paneFile && state.timelineLinesByFile?.[paneFile.id]) || EMPTY_NUMS
          }
          override={isFocused ? focusedBundle : null}
        >
          {(b) => {
            if (!b) return null;
            // Show the tab strip when split, or (lone pane) when it kept ≥2 tabs —
            // e.g. after closing a split. A single open log stays strip-free.
            const showTabs = splitOn || pane.tabs.length >= 2;
            const setFindOpenP = setFindOpenFor(pane.id);
            const lv = (
              <LogView
                key={b.file.id + ":" + pane.id}
                paneId={pane.id}
                file={b.file}
                view={b.view}
                lines={b.lines}
                filters={b.filters}
                viewMode={b.viewMode}
                soloPattern={b.soloPattern}
                onExitSolo={() => setSoloFilterId(null)}
                onToggleViewMode={(m) => setViewModeFor(b.file.id, m)}
                onToggleFind={() => setFindOpenP((v) => !v)}
                findOpen={findOpenFor(pane.id)}
                onCloseFind={() => setFindOpenP(false)}
                findFocusNonce={findNonceFor(pane.id)}
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
                onJumpMarker={jumpToMarker}
                lineText={(n) => b.view.rows[n - 1]?.text ?? ""}
                onSetMarker={setMarker}
                onRemoveMarker={removeMarker}
                onSetEncoding={(label) => setFileEncoding(b.file.id, label)}
                splitOn={splitOn}
                splitDir={sv.dir}
                onSplitPane={split.splitPane}
                onClosePane={() => split.closePane(pane.id)}
                onSetSplitDir={split.setDir}
                onPaneFocus={() => split.focusPane(pane.id)}
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
            const tabs = showTabs && (
              <PaneTabs
                pane={pane.id}
                tabs={pane.tabs}
                activeId={pane.active}
                focused={isFocused}
                files={tabFiles}
                caretIndex={
                  tabDropTarget?.pane === pane.id ? tabDropTarget.index : null
                }
                onActivate={(id) => split.activateTab(pane.id, id)}
                onClose={(id) => split.closeTab(pane.id, id)}
              />
            );
            // A lone pane: no focus frame (there's nothing to disambiguate), and the
            // log is wrapped so the center/edge drop preview can overlay it.
            if (!splitOn) {
              return (
                <div className="lv-pane" data-pane={pane.id}>
                  {tabs}
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
                data-pane={pane.id}
                onPointerDownCapture={() => split.focusPane(pane.id)}
              >
                {tabs}
                {lv}
                {dropHint?.kind === "pane" && dropHint.pane === pane.id && (
                  <div className="pane-drop-hint">
                    <div className="pane-drop-card">
                      <Upload size={16} />
                      <span>Drop to open here</span>
                    </div>
                  </div>
                )}
                {/* Dragging a tab onto a DIFFERENT pane highlights that pane too (the
                    `|` caret in its strip shows exactly where it will land). */}
                {draggingTab &&
                  tabDropTarget?.pane === pane.id &&
                  draggingFromPane !== pane.id && (
                    <div className="pane-tab-drop" />
                  )}
              </div>
            );
          }}
        </PaneData>
      );
    };

    // The clone that follows the pointer while a tab is dragged (the source tab stays
    // put, clipped by its strip's overflow).
    const dragClone = draggingTab ? (
      <div className="pane-tab active pane-tab-overlay">
        <span className="pane-tab-name">{draggingTab.name}</span>
        {draggingTab.dir && (
          <span className="pane-tab-dir">{draggingTab.dir}</span>
        )}
      </div>
    ) : null;

    // The panes, laid out in one resizable row ("h") or column ("v"). Sizes persist
    // per pane id; a pane with none (freshly split) takes an even share of what's
    // left. The per-pane floor scales with the count, so it can never sum past 100%
    // however many panes are open.
    const layout = paneLayout(panes, sv.sizes);
    const paneMin = `${Math.max(2, Math.min(12, 90 / panes.length))}%`;
    const logview = (
      <DndContext
        sensors={tabSensors}
        onDragStart={onTabDragStart}
        onDragEnd={onTabDragEnd}
        onDragCancel={endTabDrag}
      >
        {splitOn ? (
          <ResizablePanelGroup
            // Remount when the orientation flips OR the pane set changes — the
            // library can't switch a live group's axis, nor have a Panel inserted
            // into / removed from a live set ("constraints not found").
            key={"lv-split:" + sv.dir + ":" + panes.map((p) => p.id).join(",")}
            id="lv-split"
            orientation={sv.dir === "h" ? "horizontal" : "vertical"}
            defaultLayout={layout}
            onLayoutChanged={split.setSizes}
          >
            {panes.map((p, i) => (
              <Fragment key={p.id}>
                <ResizablePanel
                  id={p.id}
                  defaultSize={`${layout[p.id]}%`}
                  minSize={paneMin}
                >
                  {logViewFor(p)}
                </ResizablePanel>
                {i < panes.length - 1 && <ResizableHandle withHandle />}
              </Fragment>
            ))}
          </ResizablePanelGroup>
        ) : (
          // A lone pane still needs the DndContext so its tab strip can be reordered.
          logViewFor(panes[0])
        )}
        <DragOverlay dropAnimation={null}>{dragClone}</DragOverlay>
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
        timelineBody={timelineBody}
        notebookBody={notebookBody}
        dock={dock}
        compareCollapse={compareCollapse}
        // Split view only: name the document the dock panels act on (the focused
        // pane's file), so it's unambiguous which log Filters/Bookmarks/… target.
        docChip={splitOn ? (file?.name ?? null) : null}
        panelPos={state.panelPos}
        filterCollapsed={state.filterCollapsed}
        poppedCollapsed={!!state.poppedCollapsed}
        compareCount={compareRows.length}
        markCount={marks.length}
        showCompare={showCompare}
        clearCompare={clearCompare}
        clearTimeline={clearTimeline}
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
              onDeleteFiles={deleteFiles}
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
              onFileDropAt={(fileIds, x, y) => {
                const hint = computeDropHint(x, y);
                if (!hint) return false;
                // A whole multi-selection can be dragged out at once; the last file of
                // the batch ends up the active one, as when tabs are dropped on a pane.
                const last = fileIds[fileIds.length - 1];
                if (hint.kind === "pane")
                  split.addFilesToPane(hint.pane, fileIds);
                else if (hint.kind === "center") selectFile(last);
                else split.openPaneAtEdge(panes[0].id, hint.zone, fileIds);
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
            onCancelBusy={cancelOpen}
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

          {/* quick open (Ctrl+P) */}
          {quickOpen && (
            <QuickOpenDialog
              files={state.files}
              onPick={selectFile}
              onClose={() => setQuickOpen(false)}
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
