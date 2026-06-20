import {
  useState,
  useMemo,
  useEffect,
  useCallback,
  useRef,
  Fragment,
  CSSProperties,
  ReactNode,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronUp,
  Eraser,
  FolderOpen,
  Minus,
  PanelBottom,
  PanelBottomClose,
  PanelRightClose,
  PanelLeftOpen,
  PanelRight,
  PanelTopOpen,
  Square,
  Upload,
  X,
} from "lucide-react";
import { tinykeys } from "tinykeys";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import type { FilterGroup } from "@/types";
import { DEFAULT_PALETTE } from "@/lib/palette";
import { exportPayload } from "@/lib/filterFile";
import type { PaletteEntry } from "@/types";

import { compileAll, computeView } from "@/lib/engine";
import { Sidebar } from "@/components/Sidebar";
import { LogView } from "@/components/LogView";
import { FilterPanel } from "@/components/FilterPanel";
import { EditModal } from "@/components/EditModal";
import { PaletteModal } from "@/components/PaletteModal";
import { CompareTable } from "@/components/CompareTable";
import { useCompareCollapse } from "@/components/useCompareCollapse";
import { BookmarksPanel } from "@/components/BookmarksPanel";
import { TimelinePanel } from "@/components/TimelinePanel";
import { MenuPopup, type MenuItem } from "@/components/MenuPopup";
import { AboutModal } from "@/components/AboutModal";
import { ShortcutsModal } from "@/components/ShortcutsModal";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useUndoableState } from "@/hooks/useUndoableState";
import { useFontZoom } from "@/hooks/useFontZoom";
import { useLogFiles } from "@/hooks/useLogFiles";
import { useDockLayout } from "@/hooks/useDockLayout";
import { useFilterActions, type EditingState } from "@/hooks/useFilterActions";
import { useCompare } from "@/hooks/useCompare";
import { useTimeline } from "@/hooks/useTimeline";
import { useBookmarks } from "@/hooks/useBookmarks";
import { activeFile } from "@/state/selectors";
import { baseName } from "@/lib/path";

const MENUS = ["File", "Edit", "View", "Filters", "Help"] as const;
const DOCS_URL = "https://github.com/kamelliao/logsy#readme";

export function App() {
  const {
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
  } = useUndoableState();
  const [editing, setEditing] = useState<EditingState | null>(null);
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
  const [appVersion, setAppVersion] = useState("0.2.1");
  // Go-to-line dialog + signals pushed to LogView for menu-driven actions.
  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoVal, setGotoVal] = useState("");
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
  const gotoInputRef = useRef<HTMLInputElement>(null);
  // "View this filter only" — ephemeral focus on a single filter's matches.
  const [soloFilterId, setSoloFilterId] = useState<string | null>(null);
  // App-styled confirm() replacement (see useConfirm) + a bump to focus the
  // filter panel's search box from a keyboard shortcut.
  const [appConfirm, confirmNode] = useConfirm();
  const [focusSearchNonce, setFocusSearchNonce] = useState(0);

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {
        /* not under Tauri */
      });
  }, []);

  const file =
    state.files.find((f) => f.id === state.activeFileId) ??
    state.files[0] ??
    null;
  const set = file
    ? (file.sets.find((g) => g.id === file.activeSetId) ?? file.sets[0])
    : null;
  // Log-view header state is per-document (stored on the active LogFile).
  const findOpen = file?.findOpen ?? false;
  const fileViewMode: "all" | "matches" = file?.viewMode ?? "all";

  // Switching filter sets (or files) exits "view this filter only".
  useEffect(() => {
    setSoloFilterId(null);
  }, [file?.activeSetId, file?.id]);

  const {
    lines,
    busy,
    isSwitchingFile,
    dragOver,
    openScreen,
    setOpenScreen,
    selectFile,
    deleteFile,
    openFiles,
    loadPaths,
  } = useLogFiles({
    patchState,
    setState,
    stateRef,
    pushRecent,
    appConfirm,
    file,
  });

  const compiled = useMemo(
    () => compileAll(set?.filters ?? []),
    [set?.filters],
  );
  const view = useMemo(() => computeView(lines, compiled), [lines, compiled]);

  // ---------- dock layout ----------
  const {
    isPanelPending,
    startPanelTransition,
    fpRef,
    popRef,
    setFilterPos,
    toggleFilterCollapsed,
    togglePoppedCollapsed,
    selectPanelTab,
    popCompareOut,
    dockCompareBack,
    popTimelineOut,
    dockTimelineBack,
    compareTabAvailable,
    timelineTabAvailable,
    poppedTabs,
    popOpen,
    poppedActiveTab,
    activePanelTab,
    poppedPos,
    layoutFor,
    onLayoutFor,
    MAIN_COLLAPSED,
    POP_COLLAPSED,
  } = useDockLayout({ state, setState, stateRef });

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
  } = useCompare({ view, file, state, setState });
  const {
    tracks,
    timelineLines,
    marks,
    badEndTracks,
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
    addLinesToTimeline,
    toggleTimelineTrack,
  } = useTimeline({
    view,
    file,
    set,
    state,
    setState,
    patchState,
    selectPanelTab,
  });
  const { markers, setMarker, removeMarker, clearMarkers } = useBookmarks({
    file,
    patchState,
  });

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

  // ---------- filter actions ----------
  const {
    switchSet,
    addSet,
    renameSet,
    deleteSet,
    reorderSets,
    duplicateSet,
    addGroup,
    renameGroup,
    toggleGroup,
    deleteGroup,
    applyLayout,
    setGroupEnabled,
    updateFilter,
    deleteFilter,
    deleteFilters,
    setFiltersEnabled,
    duplicateFilter,
    openNewFilter,
    openFilterFromPattern,
    openEditFilter,
    saveFilter,
    saveFiltersAs,
    saveFilters,
    loadFilterFromPath,
    importFilters,
    appendFilters,
    bulk,
  } = useFilterActions({
    file,
    set,
    patchState,
    pushRecent,
    appConfirm,
    startPanelTransition,
    setEditing,
    soloFilterId,
    setSoloFilterId,
  });

  // ---------- palette ----------
  const effectivePalette: PaletteEntry[] =
    state.customPalette ?? DEFAULT_PALETTE;
  const [paletteModalOpen, setPaletteModalOpen] = useState(false);
  const applyPalette = (palette: PaletteEntry[]) =>
    setState((s) => ({ ...s, customPalette: palette }));

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
  // Any explicit view-mode toggle also exits "view this filter only". Both the
  // view mode and the find bar are stored per-document on the active LogFile.
  const setViewMode = (m: "all" | "matches") => {
    setSoloFilterId(null);
    patchState(
      (s) => {
        const f = activeFile(s);
        if (f) f.viewMode = m;
      },
      { undoable: false },
    );
  };
  const setFindOpen = (v: boolean | ((prev: boolean) => boolean)) =>
    patchState(
      (s) => {
        const f = activeFile(s);
        if (!f) return;
        f.findOpen = typeof v === "function" ? v(f.findOpen ?? false) : v;
      },
      { undoable: false },
    );
  const toggleSidebar = () =>
    setState((s) => ({ ...s, sidebarCollapsed: !s.sidebarCollapsed }));
  const toggleLineNumbers = () =>
    setState((s) => ({ ...s, showLineNumbers: !(s.showLineNumbers ?? true) }));

  const { fontSize, zoomIn, zoomOut, zoomReset } = useFontZoom({
    state,
    setState,
  });

  const fontWeight = state.fontWeight ?? 400;
  const showLineNumbers = state.showLineNumbers ?? true;
  const rowH = Math.round(fontSize * 1.5);
  const filterRowH = Math.round(fontSize * 1.58);

  // ---------- keyboard shortcuts ----------
  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    // While a menu is open, Left/Right move to the adjacent top-level menu and
    // Esc closes it (matches native menubar keyboard navigation).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenMenu(null);
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const i = MENUS.indexOf(openMenu.name as (typeof MENUS)[number]);
      if (i < 0) return;
      const ni =
        (i + (e.key === "ArrowRight" ? 1 : -1) + MENUS.length) % MENUS.length;
      const el = document.querySelector(`[data-menu="${MENUS[ni]}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        setOpenMenu({ name: MENUS[ni], x: r.left, y: r.bottom });
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  useEffect(() => {
    return tinykeys(window, {
      "$mod+o": (e) => {
        e.preventDefault();
        void openFiles();
      },
      "$mod+f": (e) => {
        e.preventDefault();
        setFindOpen(true);
      },
      "$mod+F": (e) => {
        e.preventDefault();
        setFindOpen(true);
      },
      "$mod+h": (e) => {
        e.preventDefault();
        setViewMode(fileViewMode === "all" ? "matches" : "all");
      },
      "$mod+H": (e) => {
        e.preventDefault();
        setViewMode(fileViewMode === "all" ? "matches" : "all");
      },
      "$mod+=": (e) => {
        e.preventDefault();
        zoomIn();
      },
      "$mod+shift+=": (e) => {
        e.preventDefault();
        zoomIn();
      },
      "$mod+-": (e) => {
        e.preventDefault();
        zoomOut();
      },
      "$mod+0": (e) => {
        e.preventDefault();
        zoomReset();
      },
      Escape: () => {
        if (shortcutsOpen) setShortcutsOpen(false);
        else if (aboutOpen) setAboutOpen(false);
        else if (findOpen && !editing) setFindOpen(false);
        // Leave the open screen (back to the active file) if there's one to show.
        else if (openScreen && state.files.length > 0) setOpenScreen(false);
      },
    });
  }, [
    findOpen,
    editing,
    openScreen,
    state.files.length,
    fileViewMode,
    zoomIn,
    zoomOut,
    zoomReset,
    shortcutsOpen,
    aboutOpen,
  ]);

  // ---------- menu actions ----------
  const openDocs = () => {
    invoke("open_url", { url: DOCS_URL }).catch((e) =>
      toast.error("Could not open documentation: " + String(e)),
    );
  };
  const selectAllLines = () => setSelectAllNonce((n) => n + 1);
  const openGoto = () => {
    setGotoVal("");
    setGotoOpen(true);
  };
  const submitGoto = () => {
    const n = parseInt(gotoVal, 10);
    if (Number.isFinite(n) && n > 0) setGotoSignal({ n, nonce: Date.now() });
    setGotoOpen(false);
  };
  // Focus the go-to input once the dialog opens.
  useEffect(() => {
    if (gotoOpen) requestAnimationFrame(() => gotoInputRef.current?.focus());
  }, [gotoOpen]);

  // Latest handlers for the once-mounted keydown listener below, so it never
  // calls a stale closure (openNewFilter reads `set`, etc.).
  const shortcutRef = useRef({ openNewFilter, focusFilterSearch });
  shortcutRef.current = { openNewFilter, focusFilterSearch };

  // Ctrl+B (toggle filter panel), Ctrl+G (go to line) and Ctrl+R (reload) on a
  // plain keydown listener — robust regardless of focus or keymap quirks. Kept
  // off tinykeys so there's exactly one handler (no double-toggle).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      // Undo / redo — but let the browser's native undo handle editable fields
      // (filter editor, inline rename) so typing isn't clobbered.
      if (k === "z" || k === "y") {
        const t = e.target as HTMLElement | null;
        if (t && t.closest('input, textarea, [contenteditable="true"]')) return;
        e.preventDefault();
        if (k === "y" || e.shiftKey) redo();
        else undo();
        return;
      }
      if (e.shiftKey) {
        // Ctrl+Shift+N: new filter · Ctrl+Shift+L: focus the filter search box.
        if (k === "n") {
          e.preventDefault();
          shortcutRef.current.openNewFilter();
        } else if (k === "l") {
          e.preventDefault();
          shortcutRef.current.focusFilterSearch();
        }
        return;
      }
      if (k === "b") {
        e.preventDefault();
        toggleFilterCollapsed();
      } else if (k === "g") {
        e.preventDefault();
        openGoto();
      } else if (k === "r") {
        e.preventDefault();
        location.reload();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Suppress the native browser context menu app-wide, except inside editable
  // fields (so right-click copy/paste still works there). The app's own
  // right-click menus are React handlers and are unaffected.
  useEffect(() => {
    function onCtx(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (t && t.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
    }
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  // Save Filter is disabled when the current set was already saved/loaded and
  // hasn't changed since (nothing to write).
  const saveFilterDisabled =
    !set || (!!set.filePath && set.savedSnapshot === exportPayload(set));

  const recentFilesMenu: MenuItem[] = state.recentFiles.length
    ? [
        ...state.recentFiles.map((p, i) => ({
          label: `${i + 1}   ${baseName(p)}`,
          action: () => void loadPaths([p]),
        })),
        { sep: true as const },
        {
          label: "Clear Recent Files",
          action: () => clearRecent("recentFiles"),
        },
      ]
    : [{ label: "No recent files", disabled: true }];

  const recentFilterFilesMenu: MenuItem[] = state.recentFilterFiles.length
    ? [
        ...state.recentFilterFiles.map((p, i) => ({
          label: `${i + 1}   ${baseName(p)}`,
          disabled: !set,
          action: () => void loadFilterFromPath(p),
        })),
        { sep: true as const },
        {
          label: "Clear Recent Filter Files",
          action: () => clearRecent("recentFilterFiles"),
        },
      ]
    : [{ label: "No recent filter files", disabled: true }];

  const menuDefs: Record<string, MenuItem[]> = {
    File: [
      { label: "Open…", key: "Ctrl O", action: () => void openFiles() },
      {
        label: "Load Filters…",
        disabled: !set,
        action: () => void importFilters(),
      },
      {
        label: "Append Filters…",
        disabled: !set,
        action: () => void appendFilters(),
      },
      {
        label: "Save Filter",
        disabled: saveFilterDisabled,
        action: () => void saveFilters(),
      },
      {
        label: "Save Filter As…",
        disabled: !set,
        action: () => void saveFiltersAs(),
      },
      { sep: true },
      { label: "Recent Files", submenu: recentFilesMenu },
      { label: "Recent Filter Files", submenu: recentFilterFilesMenu },
      { sep: true },
      { label: "Reload", key: "Ctrl R", action: () => location.reload() },
      {
        label: "Exit",
        action: () => invoke("window_controls", { action: "close" }),
      },
    ],
    Edit: [
      { label: "Undo", key: "Ctrl Z", disabled: !canUndo, action: undo },
      { label: "Redo", key: "Ctrl Y", disabled: !canRedo, action: redo },
      { sep: true },
      {
        label: "Select All",
        key: "Ctrl A",
        disabled: !file,
        action: selectAllLines,
      },
      {
        label: "Find…",
        key: "Ctrl F",
        disabled: !file,
        action: () => setFindOpen(true),
      },
      { label: "Go to…", key: "Ctrl G", disabled: !file, action: openGoto },
    ],
    View: [
      {
        label: "Show filter panel",
        checked: !state.filterCollapsed,
        key: "Ctrl B",
        disabled: !file,
        action: toggleFilterCollapsed,
      },
      { sep: true },
      {
        label: "Show only matched lines",
        checked: fileViewMode === "matches",
        key: "Ctrl H",
        action: () =>
          setViewMode(fileViewMode === "matches" ? "all" : "matches"),
      },
      {
        label: "Show line numbers",
        checked: showLineNumbers,
        action: toggleLineNumbers,
      },
      { sep: true },
      { label: "Zoom In", key: "Ctrl +", action: zoomIn },
      { label: "Zoom Out", key: "Ctrl −", action: zoomOut },
      {
        label: `Reset Zoom  (${fontSize}px)`,
        key: "Ctrl 0",
        action: zoomReset,
      },
    ],
    Filters: [
      {
        label: "Add new filter…",
        disabled: !set,
        action: () => openNewFilter(),
      },
      { sep: true },
      {
        label: "Enable all filters",
        disabled: !set,
        action: () => bulk("enableAll"),
      },
      {
        label: "Disable all filters",
        disabled: !set,
        action: () => bulk("disableAll"),
      },
      {
        label: "Remove all filters",
        disabled: !set,
        action: () => bulk("clear"),
      },
    ],
    Help: [
      { label: "Keyboard shortcuts", action: () => setShortcutsOpen(true) },
      { label: "Documentation", action: openDocs },
      { label: "About", action: () => setAboutOpen(true) },
    ],
  };

  // Build the resizable workspace: log view + filter/compare docks. Docks dock
  // bottom or right; on the same side compare sits before (above/left-of) filter.
  function renderWorkspace(): ReactNode {
    const logview = (
      <LogView
        key={file!.id}
        file={file!}
        view={logView}
        lines={lines}
        filters={set!.filters}
        viewMode={effectiveViewMode}
        soloPattern={
          soloView && soloFilter
            ? soloFilter.pattern || "untitled filter"
            : null
        }
        onExitSolo={() => setSoloFilterId(null)}
        onToggleViewMode={setViewMode}
        onToggleFind={() => setFindOpen((v) => !v)}
        findOpen={findOpen}
        onCloseFind={() => setFindOpen(false)}
        onBuildFilter={openFilterFromPattern}
        mapColorMode={state.mapColorMode ?? "bg"}
        mapWidth={state.mapWidth ?? 14}
        fontSize={fontSize}
        showLineNumbers={showLineNumbers}
        compareLines={compareLines}
        onAddToCompare={addToCompare}
        onRemoveFromCompare={removeFromCompare}
        timelineLines={timelineLines}
        onAddToTimeline={addLinesToTimeline}
        onRemoveFromTimeline={removeFromTimeline}
        selectAllNonce={selectAllNonce}
        gotoSignal={gotoSignal}
        onExportView={exportFilteredView}
        markers={markers}
        markerJump={markerJump}
        onSetMarker={setMarker}
        onRemoveMarker={removeMarker}
      />
    );

    const filterBody = (
      <FilterPanel
        file={file!}
        set={set!}
        counts={view.counts}
        onSwitchSet={switchSet}
        onAddSet={addSet}
        onRenameSet={renameSet}
        onDeleteSet={deleteSet}
        onDuplicateSet={duplicateSet}
        onReorderSet={reorderSets}
        onAddGroup={addGroup}
        onRenameGroup={renameGroup}
        onToggleGroup={toggleGroup}
        onDeleteGroup={deleteGroup}
        onSetGroupEnabled={setGroupEnabled}
        onUpdateFilter={updateFilter}
        onAddFilter={openNewFilter}
        onDeleteFilter={deleteFilter}
        onDeleteFilters={deleteFilters}
        onSetFiltersEnabled={setFiltersEnabled}
        onDuplicateFilter={duplicateFilter}
        onViewFilterOnly={setSoloFilterId}
        onEditFilter={openEditFilter}
        onToggleTimelineTrack={toggleTimelineTrack}
        onApplyLayout={applyLayout}
        onBulk={bulk}
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
      />
    );
    const bookmarksBody = (
      <BookmarksPanel
        markers={markers}
        lineText={(n) => view.rows[n - 1]?.text ?? ""}
        onJump={jumpToMarker}
        onSetNote={(n, note) => {
          const m = markers.find((x) => x.n === n);
          setMarker(n, m?.icon ?? "bookmark", note);
        }}
        onRemove={removeMarker}
        onClearAll={clearMarkers}
      />
    );

    const timelineBody = (
      <TimelinePanel
        tracks={tracks}
        filters={set?.filters ?? []}
        timeFields={timeFieldsByFilter}
        marks={marks}
        badEndTracks={badEndTracks}
        lineCount={timelineLines.size}
        onSetTrack={setTrack}
        onRemoveTrack={removeTrack}
        onReorderTracks={reorderTracks}
        onAddMatchingLines={addAllMatchingLines}
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
      />
    );

    const foldChevron = (pos: "bottom" | "right", collapsed: boolean) =>
      pos === "bottom" ? (
        collapsed ? (
          <ChevronUp size={15} />
        ) : (
          <ChevronDown size={15} />
        )
      ) : collapsed ? (
        <ChevronLeft size={15} />
      ) : (
        <ChevronRight size={15} />
      );

    // The main panel: a tab bar switching between Filters and (when present and
    // not popped out) Compare. Collapses to its tab strip.
    const mainDockNode = (): ReactNode => {
      const collapsed = state.filterCollapsed;
      const pos = state.panelPos;
      const chevron = foldChevron(pos, collapsed);

      // Right-docked + collapsed: a thin vertical strip labelled with the active tab.
      if (collapsed && pos === "right") {
        return (
          <div className="dock dock-right collapsed panel-dock">
            <div
              className="dock-head"
              onClick={toggleFilterCollapsed}
              title="Expand  (Ctrl+B)"
            >
              <span className="dock-chevron">{chevron}</span>
              <span className="dock-title">
                {activePanelTab === "compare"
                  ? `Compare · ${compareRows.length}`
                  : activePanelTab === "bookmarks"
                    ? `Bookmarks · ${markers.length}`
                    : activePanelTab === "timeline"
                      ? `Timeline · ${marks.length}`
                      : "Filters"}
              </span>
            </div>
          </div>
        );
      }

      return (
        <div
          className={
            "dock dock-" + pos + (collapsed ? " collapsed" : "") + " panel-dock"
          }
        >
          <div className="dock-head tabbed">
            <div className="panel-tabs">
              <button
                className={
                  "ptab" + (activePanelTab === "filters" ? " active" : "")
                }
                onClick={() => selectPanelTab("filters")}
              >
                Filters
              </button>
              <button
                className={
                  "ptab" + (activePanelTab === "bookmarks" ? " active" : "")
                }
                onClick={() => selectPanelTab("bookmarks")}
              >
                Bookmarks
                {markers.length > 0 && (
                  <span className="ptab-badge">{markers.length}</span>
                )}
              </button>
              {timelineTabAvailable && (
                <button
                  className={
                    "ptab" + (activePanelTab === "timeline" ? " active" : "")
                  }
                  onClick={() => selectPanelTab("timeline")}
                >
                  Timeline
                  {marks.length > 0 && (
                    <span className="ptab-badge">{marks.length}</span>
                  )}
                </button>
              )}
              {compareTabAvailable && (
                <button
                  className={
                    "ptab" + (activePanelTab === "compare" ? " active" : "")
                  }
                  onClick={() => selectPanelTab("compare")}
                >
                  Compare
                  {showCompare && (
                    <span className="ptab-badge">{compareRows.length}</span>
                  )}
                </button>
              )}
            </div>
            <div className="dock-spacer" />
            {activePanelTab === "compare" && (
              <>
                <button
                  className="dock-btn"
                  title={
                    compareCollapse.allCollapsed
                      ? "Expand all tables"
                      : "Collapse all tables"
                  }
                  disabled={!compareCollapse.hasGroups}
                  onClick={compareCollapse.toggleAll}
                >
                  {compareCollapse.allCollapsed ? (
                    <ChevronsUpDown size={14} />
                  ) : (
                    <ChevronsDownUp size={14} />
                  )}
                </button>
                <button
                  className="dock-btn"
                  title="Clear comparison"
                  onClick={clearCompare}
                >
                  <Eraser size={14} />
                </button>
                <button
                  className="dock-btn"
                  title="Pop out beside Filters"
                  onClick={popCompareOut}
                >
                  {pos === "bottom" ? (
                    <PanelLeftOpen size={14} />
                  ) : (
                    <PanelTopOpen size={14} />
                  )}
                </button>
              </>
            )}
            {activePanelTab === "timeline" && (
              <>
                <button
                  className="dock-btn"
                  title="Clear timeline"
                  onClick={clearTimeline}
                >
                  <Eraser size={14} />
                </button>
                <button
                  className="dock-btn"
                  title="Pop out beside Filters"
                  onClick={popTimelineOut}
                >
                  {pos === "bottom" ? (
                    <PanelLeftOpen size={14} />
                  ) : (
                    <PanelTopOpen size={14} />
                  )}
                </button>
              </>
            )}
            <button
              className="dock-btn"
              title={pos === "bottom" ? "Dock right" : "Dock bottom"}
              onClick={() =>
                setFilterPos(pos === "bottom" ? "right" : "bottom")
              }
            >
              {pos === "bottom" ? (
                <PanelRight size={14} />
              ) : (
                <PanelBottom size={14} />
              )}
            </button>
            <button
              className="dock-btn"
              title={(collapsed ? "Expand" : "Collapse") + "  (Ctrl+B)"}
              onClick={toggleFilterCollapsed}
            >
              {chevron}
            </button>
          </div>
          {!collapsed && (
            <div className={"dock-body" + (isPanelPending ? " pending" : "")}>
              {activePanelTab === "filters"
                ? filterBody
                : activePanelTab === "compare"
                  ? compareBody
                  : activePanelTab === "timeline"
                    ? timelineBody
                    : bookmarksBody}
            </div>
          )}
        </div>
      );
    };

    // The shared popped dock: Compare and Timeline, when popped out, live here as
    // tabs (one or both). It docks on the side opposite the main panel so the two
    // never sit on the same edge. Collapsing mirrors the main dock exactly (same
    // shared tab-strip look): right → a thin vertical title strip, otherwise the
    // tab bar stays visible (just the body is dropped).
    const popDockNode = (): ReactNode => {
      const collapsed = !!state.poppedCollapsed;
      const pos = poppedPos;
      const chevron = foldChevron(pos, collapsed);
      const activeTitle =
        poppedActiveTab === "compare"
          ? `Compare · ${compareRows.length}`
          : `Timeline · ${marks.length}`;

      // Right-docked + collapsed: a thin vertical strip labelled with the active tab.
      if (collapsed && pos === "right") {
        return (
          <div className="dock dock-right collapsed panel-dock">
            <div
              className="dock-head"
              onClick={togglePoppedCollapsed}
              title="Expand"
            >
              <span className="dock-chevron">{chevron}</span>
              <span className="dock-title">{activeTitle}</span>
            </div>
          </div>
        );
      }

      return (
        <div
          className={
            "dock dock-" + pos + (collapsed ? " collapsed" : "") + " panel-dock"
          }
        >
          <div className="dock-head tabbed">
            <div className="panel-tabs">
              {poppedTabs.map((t) => (
                <button
                  key={t}
                  className={"ptab" + (poppedActiveTab === t ? " active" : "")}
                  onClick={() =>
                    setState((s) => ({
                      ...s,
                      poppedActiveTab: t,
                      poppedCollapsed: false,
                    }))
                  }
                >
                  {t === "compare" ? (
                    <>
                      Compare
                      {showCompare && (
                        <span className="ptab-badge">{compareRows.length}</span>
                      )}
                    </>
                  ) : (
                    <>
                      Timeline
                      {marks.length > 0 && (
                        <span className="ptab-badge">{marks.length}</span>
                      )}
                    </>
                  )}
                </button>
              ))}
            </div>
            <div className="dock-spacer" />
            {poppedActiveTab === "compare" ? (
              <>
                <button
                  className="dock-btn"
                  title={
                    compareCollapse.allCollapsed
                      ? "Expand all tables"
                      : "Collapse all tables"
                  }
                  disabled={!compareCollapse.hasGroups}
                  onClick={(e) => {
                    e.stopPropagation();
                    compareCollapse.toggleAll();
                  }}
                >
                  {compareCollapse.allCollapsed ? (
                    <ChevronsUpDown size={14} />
                  ) : (
                    <ChevronsDownUp size={14} />
                  )}
                </button>
                <button
                  className="dock-btn"
                  title="Clear comparison"
                  onClick={(e) => {
                    e.stopPropagation();
                    clearCompare();
                  }}
                >
                  <Eraser size={14} />
                </button>
              </>
            ) : (
              <button
                className="dock-btn"
                title="Clear timeline"
                onClick={(e) => {
                  e.stopPropagation();
                  clearTimeline();
                }}
              >
                <Eraser size={14} />
              </button>
            )}
            <button
              className="dock-btn"
              title="Dock back into panel"
              onClick={(e) => {
                e.stopPropagation();
                if (poppedActiveTab === "compare") dockCompareBack();
                else dockTimelineBack();
              }}
            >
              {pos === "bottom" ? (
                <PanelRightClose size={14} />
              ) : (
                <PanelBottomClose size={14} />
              )}
            </button>
            <button
              className="dock-btn"
              title={collapsed ? "Expand" : "Collapse"}
              onClick={togglePoppedCollapsed}
            >
              {chevron}
            </button>
          </div>
          {!collapsed && (
            <div className="dock-body">
              {poppedActiveTab === "compare" ? compareBody : timelineBody}
            </div>
          )}
        </div>
      );
    };

    type PanelDesc = {
      id: string;
      node: ReactNode;
      collapsible?: boolean;
      collapsed?: boolean;
      collapsedSize?: string;
      minSize?: string;
      ref?: React.RefObject<PanelImperativeHandle | null>;
    };
    const buildGroup = (
      orientation: "vertical" | "horizontal",
      gid: string,
      panels: PanelDesc[],
    ): ReactNode => {
      const ids = panels.map((p) => p.id);
      // Remount the set when its panel set changes — the library can't have a
      // Panel inserted into / removed from a live set ("constraints not found").
      const groupKey = gid + ":" + ids.join(",");
      const dl = layoutFor(groupKey, ids);
      return (
        <ResizablePanelGroup
          key={groupKey}
          orientation={orientation}
          className="main"
          id={groupKey}
          defaultLayout={dl}
          onLayoutChanged={onLayoutFor(groupKey)}
        >
          {panels.map((p, i) => {
            const cs = p.collapsedSize ?? "26px";
            return (
              <Fragment key={p.id}>
                <ResizablePanel
                  id={p.id}
                  defaultSize={p.collapsed ? cs : `${dl[p.id]}%`}
                  // A collapsed dock is pinned to the strip height (min == max) so
                  // neither dragging nor a sibling's collapse can grow it back.
                  // A side dock carries a px floor (p.minSize) so it can't be
                  // dragged into an unusably narrow sliver.
                  minSize={
                    p.collapsed
                      ? cs
                      : (p.minSize ?? (p.collapsible ? "8%" : "15%"))
                  }
                  maxSize={p.collapsed ? cs : "100%"}
                  panelRef={p.ref}
                >
                  {p.node}
                </ResizablePanel>
                {i < panels.length - 1 && <ResizableHandle withHandle />}
              </Fragment>
            );
          })}
        </ResizablePanelGroup>
      );
    };

    // The main panel is always present; Compare and Timeline share the one popped
    // dock, present only when at least one of them is popped out.
    const docks = [
      { id: "fp", pos: state.panelPos, ref: fpRef },
      ...(popOpen ? [{ id: "pop", pos: poppedPos, ref: popRef }] : []),
    ];
    // Keep array order (main panel before the popped dock).
    const side = (s: "bottom" | "right") => docks.filter((d) => d.pos === s);
    const bottomDocks = side("bottom");
    const rightDocks = side("right");
    const dockPanel = (d: {
      id: string;
      ref: React.RefObject<PanelImperativeHandle | null>;
    }): PanelDesc => ({
      id: d.id,
      node: d.id === "fp" ? mainDockNode() : popDockNode(),
      collapsible: true,
      ref: d.ref,
      collapsed:
        d.id === "fp" ? state.filterCollapsed : !!state.poppedCollapsed,
      collapsedSize: d.id === "fp" ? MAIN_COLLAPSED : POP_COLLAPSED,
    });

    let center: ReactNode = logview;
    if (bottomDocks.length) {
      center = buildGroup("vertical", "grp-v", [
        { id: "lv", node: logview },
        ...bottomDocks.map(dockPanel),
      ]);
    }
    if (rightDocks.length) {
      // Side docks get a px floor so a drag can't shrink them into an unusable
      // sliver (the content needs room for a pattern + hit count). When collapsed
      // they stay pinned to their strip width instead.
      const RIGHT_DOCK_MIN = "240px";
      return buildGroup("horizontal", "grp-h", [
        { id: bottomDocks.length ? "center" : "lv", node: center },
        ...rightDocks
          .map(dockPanel)
          .map((p) => (p.collapsed ? p : { ...p, minSize: RIGHT_DOCK_MIN })),
      ]);
    }
    return center;
  }

  return (
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
        <div className="titlebar" data-tauri-drag-region>
          <div className="brand">Logsy</div>
          <div className="menubar">
            {MENUS.map((m) => (
              <div
                key={m}
                data-menu={m}
                className={"menu" + (openMenu?.name === m ? " active" : "")}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setOpenMenu(
                    openMenu?.name === m
                      ? null
                      : { name: m, x: rect.left, y: rect.bottom },
                  );
                }}
                // Once any menu is open, hovering a sibling switches to it
                // (standard menubar behaviour — no extra click needed).
                onMouseEnter={(e) => {
                  if (!openMenu || openMenu.name === m) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  setOpenMenu({ name: m, x: rect.left, y: rect.bottom });
                }}
              >
                {m}
              </div>
            ))}
          </div>
          <div
            className="win-controls"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div
              className="wc"
              onClick={() => invoke("window_controls", { action: "minimize" })}
            >
              <Minus size={15} />
            </div>
            <div
              className="wc"
              onClick={() => invoke("window_controls", { action: "maximize" })}
            >
              <Square size={13} />
            </div>
            <div
              className="wc close"
              onClick={() => invoke("window_controls", { action: "close" })}
            >
              <X size={15} />
            </div>
          </div>
        </div>

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
            onSetPanelPos={(pos) => setState((s) => ({ ...s, panelPos: pos }))}
            onSetMapColorMode={(mode) =>
              setState((s) => ({ ...s, mapColorMode: mode }))
            }
            onSetMapWidth={(w) => setState((s) => ({ ...s, mapWidth: w }))}
            onSetFontWeight={(w) => setState((s) => ({ ...s, fontWeight: w }))}
            onSetTimelineIconSize={(sz) =>
              setState((s) => ({ ...s, timelineIconSize: sz }))
            }
            onManagePalette={() => setPaletteModalOpen(true)}
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

        {/* palette management modal */}
        {paletteModalOpen && (
          <PaletteModal
            palette={effectivePalette}
            onChange={applyPalette}
            onClose={() => setPaletteModalOpen(false)}
          />
        )}

        {/* loading overlay — shown while a log file is read from disk */}
        {busy && (
          <div className="busy-overlay">
            <div className="busy-card">
              <div className="busy-spinner" />
              <div className="busy-text">Opening {busy.name}…</div>
            </div>
          </div>
        )}

        {/* file-switch overlay — shown while React computes the view for a large file */}
        {isSwitchingFile && !busy && (
          <div className="busy-overlay">
            <div className="busy-card">
              <div className="busy-spinner" />
              <div className="busy-text">Loading…</div>
            </div>
          </div>
        )}

        {/* drag-and-drop overlay */}
        {dragOver && (
          <div className="drop-overlay">
            <div className="drop-overlay-inner">
              <Upload size={34} />
              <div className="do-title">Drop log files to open</div>
            </div>
          </div>
        )}

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
          <div className="goto-overlay" onMouseDown={() => setGotoOpen(false)}>
            <div className="goto-box" onMouseDown={(e) => e.stopPropagation()}>
              <div className="goto-title">Go to line</div>
              <input
                ref={gotoInputRef}
                className="goto-input"
                type="number"
                min={1}
                placeholder="Line number…"
                value={gotoVal}
                onChange={(e) => setGotoVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitGoto();
                  }
                  if (e.key === "Escape") setGotoOpen(false);
                }}
              />
              <div className="goto-actions">
                <Button variant="ghost" onClick={() => setGotoOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={submitGoto}>Go</Button>
              </div>
            </div>
          </div>
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
  );
}
