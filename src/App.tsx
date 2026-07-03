import {
  useState,
  useMemo,
  useEffect,
  useCallback,
  useDeferredValue,
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
import { Sidebar } from "@/components/layout/Sidebar";
import { LogView } from "@/components/LogView";
import { FilterPanel } from "@/components/FilterPanel";
import { EditModal } from "@/components/dialogs/EditModal";
import { PaletteModal } from "@/components/dialogs/PaletteModal";
import { CompareTable } from "@/components/CompareTable";
import { useCompareCollapse } from "@/hooks/useCompareCollapse";
import { BookmarksPanel } from "@/components/BookmarksPanel";
import { TimelinePanel } from "@/components/TimelinePanel";
import { MenuPopup } from "@/components/layout/MenuPopup";
import { AboutModal } from "@/components/dialogs/AboutModal";
import { ShortcutsModal } from "@/components/dialogs/ShortcutsModal";
import { useConfirm } from "@/components/dialogs/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Workspace } from "@/components/layout/Workspace";
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
  // even when the bar is already open (see focusFind).
  const [findFocusNonce, setFindFocusNonce] = useState(0);

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
  const file =
    deferredFile ??
    state.files.find((f) => f.id === state.activeFileId) ??
    state.files[0] ??
    null;
  const isSwitchingFile =
    !!deferredFile && deferredFile.id !== state.activeFileId;

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
  const deferredSet = file?.sets.find((g) => g.id === dock.deferredActiveSetId);
  const set = file
    ? (deferredSet ??
      file.sets.find((g) => g.id === file.activeSetId) ??
      file.sets[0])
    : null;
  // Log-view header state is per-document (stored on the active LogFile).
  const findOpen = file?.findOpen ?? false;
  const fileViewMode: "all" | "matches" = file?.viewMode ?? "all";

  // Switching filter sets (or files) exits "view this filter only".
  useEffect(() => {
    setSoloFilterId(null);
  }, [file?.activeSetId, file?.id, setSoloFilterId]);

  const {
    lines,
    busy,
    dragOver,
    openScreen,
    setOpenScreen,
    selectFile,
    deleteFile,
    openFiles,
    loadPaths,
    setFileEncoding,
  } = useLogFiles({ file });

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
  // Ctrl+F: open the find bar and focus its input. The nonce bump tells LogView
  // to focus even when the bar was already open (so a second Ctrl+F re-focuses
  // and selects the existing query instead of doing nothing).
  const focusFind = () => {
    setFindOpen(true);
    setFindFocusNonce((n) => n + 1);
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
        findFocusNonce={findFocusNonce}
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
        onSetEncoding={(label) => setFileEncoding(file!.id, label)}
        onAddToNotebook={(ns) => {
          const picked = ns
            .map((n) => ({ n, text: view.rows[n - 1]?.text ?? "" }))
            .filter((l) => l.text !== "");
          if (picked.length) {
            useStore.getState().ensureNotebook();
            callAddPinnedLines(picked, file!.name, file!.id);
            selectPanelTab("notebook");
          }
        }}
      />
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
              onReorderFiles={(from, to) =>
                patchState(
                  (s) => {
                    if (
                      from < 0 ||
                      to < 0 ||
                      from >= s.files.length ||
                      to >= s.files.length ||
                      from === to
                    )
                      return;
                    const [m] = s.files.splice(from, 1);
                    s.files.splice(to, 0, m);
                  },
                  { undoable: false },
                )
              }
              onSetPanelPos={(pos) =>
                setState((s) => ({ ...s, panelPos: pos }))
              }
              onSetMapColorMode={(mode) =>
                setState((s) => ({ ...s, mapColorMode: mode }))
              }
              onSetMapWidth={(w) => setState((s) => ({ ...s, mapWidth: w }))}
              onSetFontWeight={(w) =>
                setState((s) => ({ ...s, fontWeight: w }))
              }
              onSetTimelineIconSize={(sz) =>
                setState((s) => ({ ...s, timelineIconSize: sz }))
              }
              onSetFilterLabel={(mode) =>
                setState((s) => ({ ...s, filterLabel: mode }))
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
            loadingLabel={loadingLabel}
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
    </NotebookHost>
  );
}
