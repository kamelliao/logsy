export interface Filter {
  id: string;
  pattern: string;
  description: string;
  enabled: boolean;
  caseSensitive: boolean;
  regex: boolean;
  exclude: boolean;
  textColor: string;
  bgColor: string;
  /** Section this filter belongs to; null = ungrouped (renders above sections). */
  sectionId: string | null;
  /**
   * Structured fields this filter extracts, one per named capture group in its
   * regex. Present only for regex filters whose pattern has `(?<name>…)` groups;
   * a matching line then exposes these as parsed fields.
   */
  fields?: FieldDef[];
}

export interface FilterSection {
  id: string;
  name: string;
  collapsed: boolean;
}

/**
 * A whole-group layout snapshot used by the filter drag-and-drop while a drag is
 * in flight (kept local to FilterPanel) and to commit the final arrangement in a
 * single undoable step. `top` is the interleaved top-level order (section ids and
 * loose filter ids); `inSection` maps a section id to its ordered filter ids.
 */
export interface FilterLayout {
  top: { kind: "section" | "filter"; id: string }[];
  inSection: Record<string, string[]>;
}

export interface FilterGroup {
  id: string;
  name: string;
  /** Flat, ordered list of all filters in the group (across sections). */
  filters: Filter[];
  /** Ordered section metadata; filters reference these via Filter.sectionId. */
  sections: FilterSection[];
  /**
   * Top-level layout order: a mixed sequence of section ids and ungrouped
   * filter ids. Lets loose filter rows and sections be freely interleaved.
   * Filters that belong to a section are not listed here (they live inside
   * the section, ordered by their position in `filters`).
   */
  order: string[];
  /** Last path this group's filters were saved to (for "Save filters"). */
  filePath?: string;
  /**
   * Serialized payload (exportPayload) at the moment the group was last saved or
   * loaded. "Save Filter" is disabled while the current payload still equals this
   * — i.e. nothing has changed since the last save.
   */
  savedSnapshot?: string;
}

export interface LogFile {
  id: string;
  name: string;
  /** Absolute path on disk the log was loaded from (used to reload on restart). */
  path: string | null;
  lineCount: number;
  groups: FilterGroup[];
  activeGroupId: string | null;
}

export interface AppState {
  files: LogFile[];
  activeFileId: string | null;
  /** Most-recently-opened log file paths (newest first), for File ▸ Recent Files. */
  recentFiles: string[];
  /** Most-recently-used filter file paths (newest first), for Recent Filter Files. */
  recentFilterFiles: string[];
  sidebarCollapsed: boolean;
  splitRatio: number;
  panelPos: "bottom" | "right";
  viewMode: "all" | "matches";
  mapColorMode: "bg" | "text";
  mapWidth: number;
  fontSize: number;
  /** Show the line-number gutter in the log view (and include numbers when copying). */
  showLineNumbers: boolean;
  /** Where the comparison panel docks *when popped out* of the tabbed panel. */
  comparePos: "bottom" | "right";
  /** Collapsed (rolled-up) state of the main tabbed panel / popped compare dock. */
  filterCollapsed: boolean;
  compareCollapsed: boolean;
  /** Active tab in the main panel (Filters or Compare share one tabbed dock). */
  activePanelTab: "filters" | "compare";
  /** When true, Compare is shown as its own dock (so it can sit beside Filters)
   *  instead of as a tab in the main panel. */
  comparePopped: boolean;
  /**
   * Persisted panel sizes (percent), bucketed by group-structure key so that
   * sizes from one dock arrangement never bleed into another. Outer key is the
   * group signature, inner key is the panel id.
   */
  panelSizes: Record<string, Record<string, number>>;
}

export interface PaletteEntry {
  name: string;
  text: string;
  bg: string;
}

export interface CompiledFilter {
  f: Filter;
  re: RegExp | null;
  ok: boolean;
  err?: string;
  empty?: boolean;
}

/** How a parsed field's raw text is coerced for display, sorting, and math. */
export type FieldType = "string" | "int" | "hex" | "float" | "time";

export interface FieldDef {
  /** Named capture group this field reads from. */
  name: string;
  type: FieldType;
}

/** A single extracted field: the matched text plus its coerced value. */
export interface FieldValue {
  raw: string;
  /** Coerced per FieldType; falls back to `raw` when coercion yields NaN. */
  value: number | string;
}

export interface ViewRow {
  n: number;
  text: string;
  winner: CompiledFilter | null;
  excluded: boolean;
  /** Fields extracted by the first matching structural filter; absent if none. */
  fields?: Record<string, FieldValue>;
  /** Id of the filter that supplied this row's fields, if any. */
  fieldsFromId?: string;
}

export interface ViewResult {
  rows: ViewRow[];
  counts: Record<string, number>;
  hasHighlights: boolean;
  hasExcludes: boolean;
  /**
   * Lazily extract a row's parsed fields by line number. Fields are no longer
   * computed for every line up front — only the rows that actually need them
   * (compare table, an expanded row) call this. Returns undefined when the line
   * has no field provider.
   */
  fieldsFor(n: number): Record<string, FieldValue> | undefined;
}

export interface Segment {
  t: string;
  hit: boolean;
}
