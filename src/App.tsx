import {
  useState,
  useMemo,
  useEffect,
  useCallback,
  CSSProperties,
  ReactNode,
} from "react";
import { FolderOpen, Upload } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import type { FilterGroup } from "@/types";
import { DEFAULT_PALETTE } from "@/lib/palette";
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
import { MenuPopup } from "@/components/MenuPopup";
import { AboutModal } from "@/components/AboutModal";
import { ShortcutsModal } from "@/components/ShortcutsModal";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Workspace } from "@/components/Workspace";
import { Titlebar } from "@/components/Titlebar";
import { GotoDialog } from "@/components/GotoDialog";
import { Overlays } from "@/components/Overlays";
import { useUndoableState } from "@/hooks/useUndoableState";
import { useFontZoom } from "@/hooks/useFontZoom";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useMenuDefs } from "@/hooks/useMenuDefs";
import { useLogFiles } from "@/hooks/useLogFiles";
import { useDockLayout } from "@/hooks/useDockLayout";
import { useFilterActions, type EditingState } from "@/hooks/useFilterActions";
import { useCompare } from "@/hooks/useCompare";
import { useTimeline } from "@/hooks/useTimeline";
import { useBookmarks } from "@/hooks/useBookmarks";
import { activeFile } from "@/state/selectors";

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
  const dock = useDockLayout();
  // The three the App body itself drives; the rest of the bundle is consumed by
  // <Workspace> (the dock chrome) via the `dock` prop.
  const { startPanelTransition, selectPanelTab, toggleFilterCollapsed } = dock;

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

  const { fontSize, zoomIn, zoomOut, zoomReset } = useFontZoom();

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
    zoomIn,
    zoomOut,
    zoomReset,
    findOpen,
    editing,
    openScreen,
    filesCount: state.files.length,
    setOpenScreen,
    shortcutsOpen,
    setShortcutsOpen,
    aboutOpen,
    setAboutOpen,
    undo,
    redo,
    toggleFilterCollapsed,
    openGoto,
    openNewFilter,
    focusFilterSearch,
  });

  const menuDefs = useMenuDefs({
    state,
    file,
    set,
    fileViewMode,
    showLineNumbers,
    fontSize,
    canUndo,
    canRedo,
    openFiles,
    importFilters,
    appendFilters,
    saveFilters,
    saveFiltersAs,
    loadPaths,
    loadFilterFromPath,
    clearRecent,
    undo,
    redo,
    selectAllLines,
    setFindOpen,
    openGoto,
    toggleFilterCollapsed,
    setViewMode,
    toggleLineNumbers,
    zoomIn,
    zoomOut,
    zoomReset,
    openNewFilter,
    bulk,
    openDocs,
    setShortcutsOpen,
    setAboutOpen,
  });

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

    return (
      <Workspace
        logview={logview}
        filterBody={filterBody}
        compareBody={compareBody}
        bookmarksBody={bookmarksBody}
        timelineBody={timelineBody}
        dock={dock}
        compareCollapse={compareCollapse}
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
        <Titlebar menus={MENUS} openMenu={openMenu} setOpenMenu={setOpenMenu} />

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

        <Overlays
          busy={busy}
          isSwitchingFile={isSwitchingFile}
          dragOver={dragOver}
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
  );
}
