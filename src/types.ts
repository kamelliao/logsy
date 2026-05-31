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

export interface ViewRow {
  n: number;
  text: string;
  winner: CompiledFilter | null;
  excluded: boolean;
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
