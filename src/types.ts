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
  /**
   * When true the filter only extracts fields and does not colour matching
   * lines — needed for a catch-all structural filter that would otherwise paint
   * the whole log.
   */
  extractOnly?: boolean;
}

export interface FilterSection {
  id: string;
  name: string;
  collapsed: boolean;
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
  sidebarCollapsed: boolean;
  splitRatio: number;
  panelPos: "bottom" | "right";
  viewMode: "all" | "matches";
  mapColorMode: "bg" | "text";
  mapWidth: number;
  fontSize: number;
  /** Show the line-number gutter in the log view (and include numbers when copying). */
  showLineNumbers: boolean;
  /** Where the comparison panel docks. */
  comparePos: "bottom" | "right";
  /** Collapsed (rolled-up) state of the filter / comparison docks. */
  filterCollapsed: boolean;
  compareCollapsed: boolean;
  /** Persisted size (percent) of each resizable panel, keyed by panel id. */
  panelSizes: Record<string, number>;
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
}

export interface Segment {
  t: string;
  hit: boolean;
}
