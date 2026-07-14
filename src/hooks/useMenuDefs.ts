import { invoke } from "@tauri-apps/api/core";
import { exportPayload } from "@/lib/filterFile";
import { baseName } from "@/lib/path";
import { useStore } from "@/store";
import { activeFile, activeSet } from "@/state/selectors";
import { useShallow } from "zustand/react/shallow";
import type { MenuItem } from "@/components/layout/MenuPopup";

interface Deps {
  // Handlers that aren't (yet) store actions: log-file IO, App-local UI signals,
  // and the dock/view toggles. State and the filter/undo/zoom actions are read
  // from the store directly.
  openFiles: () => void | Promise<void>;
  loadPaths: (paths: string[]) => void | Promise<void>;
  selectAllLines: () => void;
  // Same handler as Ctrl+F — it routes to the FOCUSED pane's find bar, which a
  // plain `setFindOpen(true)` would miss (that flag only drives the single-pane,
  // file-backed bar).
  focusFind: () => void;
  openGoto: () => void;
  toggleFilterCollapsed: () => void;
  setViewMode: (m: "all" | "matches") => void;
  toggleLineNumbers: () => void;
  openDocs: () => void;
  setShortcutsOpen: (v: boolean) => void;
  setAboutOpen: (v: boolean) => void;
}

/**
 * Builds the top-level menubar definitions (File / Edit / View / Filters / Help)
 * plus the Recent Files / Recent Filter Files submenus. Pure assembly of
 * `MenuItem[]` from the current state and the action callbacks — no rendering;
 * App maps the returned record over the menubar and feeds it to MenuPopup.
 */
export function useMenuDefs(deps: Deps): Record<string, MenuItem[]> {
  const state = useStore((s) => s.doc);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const packsOpen = useStore((s) => s.packsOpen);
  const {
    undo,
    redo,
    clearRecent,
    zoomIn,
    zoomOut,
    zoomReset,
    openNewFilter,
    bulk,
    importFilters,
    appendFilters,
    saveFilters,
    saveFiltersAs,
    loadFilterFromPath,
    togglePacks,
  } = useStore(
    useShallow((s) => ({
      undo: s.undo,
      redo: s.redo,
      clearRecent: s.clearRecent,
      zoomIn: s.zoomIn,
      zoomOut: s.zoomOut,
      zoomReset: s.zoomReset,
      openNewFilter: s.openNewFilter,
      bulk: s.bulk,
      importFilters: s.importFilters,
      appendFilters: s.appendFilters,
      saveFilters: s.saveFilters,
      saveFiltersAs: s.saveFiltersAs,
      loadFilterFromPath: s.loadFilterFromPath,
      togglePacks: s.togglePacks,
    })),
  );

  const file = activeFile(state);
  const set = activeSet(state);
  const fileViewMode: "all" | "matches" = file?.viewMode ?? "all";
  const showLineNumbers = state.showLineNumbers ?? true;
  const fontSize = state.fontSize ?? 12;

  // Save Filter is disabled when the current set was already saved/loaded and
  // hasn't changed since (nothing to write).
  const saveFilterDisabled =
    !set || (!!set.filePath && set.savedSnapshot === exportPayload(set));

  const recentFilesMenu: MenuItem[] = state.recentFiles.length
    ? [
        ...state.recentFiles.map((p, i) => ({
          label: `${i + 1}   ${baseName(p)}`,
          action: () => void deps.loadPaths([p]),
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

  return {
    File: [
      { label: "Open…", key: "Ctrl O", action: () => void deps.openFiles() },
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
        action: deps.selectAllLines,
      },
      {
        label: "Find…",
        key: "Ctrl F",
        disabled: !file,
        action: deps.focusFind,
      },
      {
        label: "Go to…",
        key: "Ctrl G",
        disabled: !file,
        action: deps.openGoto,
      },
    ],
    View: [
      {
        label: "Show filter panel",
        checked: !state.filterCollapsed,
        key: "Ctrl B",
        disabled: !file,
        action: deps.toggleFilterCollapsed,
      },
      {
        label: "Show filter packs",
        checked: packsOpen,
        action: togglePacks,
      },
      { sep: true },
      {
        label: "Show only matched lines",
        checked: fileViewMode === "matches",
        key: "Ctrl H",
        action: () =>
          deps.setViewMode(fileViewMode === "matches" ? "all" : "matches"),
      },
      {
        label: "Show line numbers",
        checked: showLineNumbers,
        action: deps.toggleLineNumbers,
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
        label: "New filter…",
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
      {
        label: "Keyboard shortcuts",
        action: () => deps.setShortcutsOpen(true),
      },
      { label: "Documentation", action: deps.openDocs },
      { label: "About", action: () => deps.setAboutOpen(true) },
    ],
  };
}
