import { invoke } from "@tauri-apps/api/core";
import type { AppState, FilterSet, LogFile } from "@/types";
import { exportPayload } from "@/lib/filterFile";
import { baseName } from "@/lib/path";
import type { MenuItem } from "@/components/MenuPopup";

interface Deps {
  state: AppState;
  file: LogFile | null;
  set: FilterSet | null;
  fileViewMode: "all" | "matches";
  showLineNumbers: boolean;
  fontSize: number;
  canUndo: boolean;
  canRedo: boolean;

  // File menu.
  openFiles: () => void | Promise<void>;
  importFilters: () => void | Promise<void>;
  appendFilters: () => void | Promise<void>;
  saveFilters: () => void | Promise<void>;
  saveFiltersAs: () => void | Promise<void>;
  loadPaths: (paths: string[]) => void | Promise<void>;
  loadFilterFromPath: (path: string) => void | Promise<void>;
  clearRecent: (key: "recentFiles" | "recentFilterFiles") => void;

  // Edit menu.
  undo: () => void;
  redo: () => void;
  selectAllLines: () => void;
  setFindOpen: (v: boolean) => void;
  openGoto: () => void;

  // View menu.
  toggleFilterCollapsed: () => void;
  setViewMode: (m: "all" | "matches") => void;
  toggleLineNumbers: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;

  // Filters menu.
  openNewFilter: () => void;
  bulk: (action: string) => void;

  // Help menu.
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
  const {
    state,
    file,
    set,
    fileViewMode,
    showLineNumbers,
    fontSize,
    canUndo,
    canRedo,
  } = deps;

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
          action: () => deps.clearRecent("recentFiles"),
        },
      ]
    : [{ label: "No recent files", disabled: true }];

  const recentFilterFilesMenu: MenuItem[] = state.recentFilterFiles.length
    ? [
        ...state.recentFilterFiles.map((p, i) => ({
          label: `${i + 1}   ${baseName(p)}`,
          disabled: !set,
          action: () => void deps.loadFilterFromPath(p),
        })),
        { sep: true as const },
        {
          label: "Clear Recent Filter Files",
          action: () => deps.clearRecent("recentFilterFiles"),
        },
      ]
    : [{ label: "No recent filter files", disabled: true }];

  return {
    File: [
      { label: "Open…", key: "Ctrl O", action: () => void deps.openFiles() },
      {
        label: "Load Filters…",
        disabled: !set,
        action: () => void deps.importFilters(),
      },
      {
        label: "Append Filters…",
        disabled: !set,
        action: () => void deps.appendFilters(),
      },
      {
        label: "Save Filter",
        disabled: saveFilterDisabled,
        action: () => void deps.saveFilters(),
      },
      {
        label: "Save Filter As…",
        disabled: !set,
        action: () => void deps.saveFiltersAs(),
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
      { label: "Undo", key: "Ctrl Z", disabled: !canUndo, action: deps.undo },
      { label: "Redo", key: "Ctrl Y", disabled: !canRedo, action: deps.redo },
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
        action: () => deps.setFindOpen(true),
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
      { label: "Zoom In", key: "Ctrl +", action: deps.zoomIn },
      { label: "Zoom Out", key: "Ctrl −", action: deps.zoomOut },
      {
        label: `Reset Zoom  (${fontSize}px)`,
        key: "Ctrl 0",
        action: deps.zoomReset,
      },
    ],
    Filters: [
      {
        label: "Add new filter…",
        disabled: !set,
        action: () => deps.openNewFilter(),
      },
      { sep: true },
      {
        label: "Enable all filters",
        disabled: !set,
        action: () => deps.bulk("enableAll"),
      },
      {
        label: "Disable all filters",
        disabled: !set,
        action: () => deps.bulk("disableAll"),
      },
      {
        label: "Remove all filters",
        disabled: !set,
        action: () => deps.bulk("clear"),
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
