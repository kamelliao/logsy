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
  /** Group this filter belongs to; null = ungrouped (renders above groups). */
  groupId: string | null;
  /**
   * Structured fields this filter extracts, one per named capture group in its
   * regex. Present only for regex filters whose pattern has `(?<name>…)` groups;
   * a matching line then exposes these as parsed fields.
   */
  fields?: FieldDef[];
}

export interface FilterGroup {
  id: string;
  name: string;
  collapsed: boolean;
}

/**
 * A named, collapsible sidebar section that partitions the open log files. Purely
 * organizational — grouping a file never touches its filters/markers. Mirrors
 * FilterGroup: files reference one via `LogFile.groupId`, order lives on
 * `AppState.fileGroups`.
 */
export interface FileGroup {
  id: string;
  name: string;
  collapsed: boolean;
}

/**
 * A whole-set layout snapshot used by the filter drag-and-drop while a drag is
 * in flight (kept local to FilterPanel) and to commit the final arrangement in a
 * single undoable step. `top` is the interleaved top-level order (group ids and
 * loose filter ids); `inGroup` maps a group id to its ordered filter ids.
 */
export interface FilterLayout {
  top: { kind: "group" | "filter"; id: string }[];
  inGroup: Record<string, string[]>;
}

export interface FilterSet {
  id: string;
  name: string;
  /** Flat, ordered list of all filters in the set (across groups). */
  filters: Filter[];
  /** Ordered group metadata; filters reference these via Filter.groupId. */
  groups: FilterGroup[];
  /**
   * Top-level layout order: a mixed sequence of group ids and ungrouped
   * filter ids. Lets loose filter rows and groups be freely interleaved.
   * Filters that belong to a group are not listed here (they live inside
   * the group, ordered by their position in `filters`).
   */
  order: string[];
  /**
   * Timeline event sources for this set: each draws events from one filter's
   * matched lines onto one named lane. Travels with the saved filter file.
   */
  sources?: TimelineSource[];
  /** Last path this set's filters were saved to (for "Save filters"). */
  filePath?: string;
  /**
   * Serialized payload (exportPayload) at the moment the set was last saved or
   * loaded. "Save Filter" is disabled while the current payload still equals this
   * — i.e. nothing has changed since the last save.
   */
  savedSnapshot?: string;
}

/**
 * A reusable, named bundle of filters — a "pack" saved to the user's global
 * library and inserted into any set later. Same shape as an exported filter file
 * minus timeline sources (which bind to one file's time semantics): the filters,
 * the groups they belong to, and the interleaved top-level `order`. Inserting a
 * pack remaps ids and appends, so the same pack can be dropped in repeatedly.
 */
export interface FilterPack {
  id: string;
  name: string;
  /** Epoch ms the pack was saved; rendered as a relative date on its card. */
  createdAt: number;
  /** Flat, ordered filters (across groups), as in a FilterSet. */
  filters: Filter[];
  groups: FilterGroup[];
  /** Top-level interleaved order of group ids and ungrouped filter ids. */
  order: string[];
  /** User labels for organizing the library; drives the drawer's tag filter. */
  tags?: string[];
}

/** The set of bookmark glyphs a marker can use. */
export type MarkerIcon = "bookmark" | "star" | "flag" | "bug" | "pin" | "alert";

/** The set of glyphs a log file's sidebar entry can use. */
export type FileIcon = "file" | "star" | "flag" | "bug" | "zap" | "alert";

/** A user-placed bookmark pinned to one log line, with an optional note. */
export interface Marker {
  /** Line number the marker is pinned to. */
  n: number;
  icon: MarkerIcon;
  /** Free-text note; "" when none. */
  note: string;
}

export interface LogFile {
  id: string;
  name: string;
  /** Absolute path on disk the log was loaded from (used to reload on restart). */
  path: string | null;
  lineCount: number;
  /** Character encoding the file was decoded with (e.g. "UTF-8", "Big5"). */
  encoding?: string;
  /**
   * User-forced encoding label that overrides auto-detection (undefined = auto).
   * Persisted, so a reopened file re-decodes with the same forced encoding.
   */
  encodingOverride?: string;
  /**
   * What auto-detection last chose for this file. Kept while an override is
   * active (unlike `encoding`, which tracks the decode actually used), so the
   * encoding pill's Auto-detect row keeps naming the detected encoding.
   */
  detectedEncoding?: string;
  /** User-chosen sidebar glyph; undefined = default document icon. */
  icon?: FileIcon;
  /** File group this log belongs to; null/undefined = ungrouped (renders above
   *  groups, like an ungrouped filter). References `AppState.fileGroups`. */
  groupId?: string | null;
  /**
   * Ordered ids of the filter sets this file shows (its tab strip order). Each id
   * resolves to a set in the app-level `AppState.filterSets` pool; two files
   * listing the same id SHARE that set (edits sync — see the shared-set feature).
   * Replaces the old per-file `sets: FilterSet[]`; `normalizeState` migrates it.
   */
  setRefs: string[];
  activeSetId: string | null;
  /** User bookmarks pinned to line numbers (persisted with the file). */
  markers?: Marker[];
  /** Per-document log-view header state: "show only matched lines" toggle. */
  viewMode?: "all" | "matches";
  /** Per-document log-view header state: whether the find bar is open. */
  findOpen?: boolean;
  /**
   * @deprecated Notebooks are app-level now (see `AppState.notebooks`); a report
   * can reference lines from several files. This per-file doc only survives so a
   * one-time migration (in `normalizeState`) can lift it into a `Notebook`.
   */
  notebookDoc?: Record<string, unknown> | null;
}

/**
 * A user-authored report. App-level (not per-file): one notebook can embed pinned
 * lines / compare tables / timeline images drawn from *several* log files, so it
 * lives on `AppState`, decoupled from the active document. Persisted, not undoable.
 */
export interface Notebook {
  id: string;
  name: string;
  /** Serialized TipTap doc JSON. Source of truth for the editor content. */
  doc?: Record<string, unknown> | null;
  /** Epoch ms created / last edited; `updatedAt` could drive a sort later. */
  createdAt: number;
  updatedAt: number;
}

export interface AppState {
  files: LogFile[];
  activeFileId: string | null;
  /**
   * App-level pool of filter sets (id → set). Files reference sets by id via
   * `LogFile.setRefs`; several files pointing at the same id share that one set
   * object, so editing it in one file is instantly visible in the others. A set
   * with no referencing file is garbage-collected in `normalizeState`.
   */
  filterSets: Record<string, FilterSet>;
  /** Named, collapsible sidebar sections partitioning the open files. Ordered;
   *  a file joins one via `LogFile.groupId`. Undefined when no groups exist. */
  fileGroups?: FileGroup[];
  /** Most-recently-opened log file paths (newest first), for File ▸ Recent Files. */
  recentFiles: string[];
  /** Most-recently-used filter file paths (newest first), for Recent Filter Files. */
  recentFilterFiles: string[];
  sidebarCollapsed: boolean;
  splitRatio: number;
  panelPos: "bottom" | "right";
  mapColorMode: "bg" | "text";
  mapWidth: number;
  fontSize: number;
  /** Font weight of the log text (400 / 500 / 600). */
  fontWeight: number;
  /** Show the line-number gutter in the log view (and include numbers when copying). */
  showLineNumbers: boolean;
  /** Where the comparison panel docks *when popped out* of the tabbed panel. */
  comparePos: "bottom" | "right";
  /** Collapsed (rolled-up) state of the main tabbed panel. */
  filterCollapsed: boolean;
  /** Active tab in the main panel. */
  activePanelTab: "filters" | "compare" | "bookmarks" | "timeline" | "notebook";
  /** When true, Compare is shown in the popped dock (beside Filters) instead of as
   *  a tab in the main panel. */
  comparePopped: boolean;
  /** When true, Timeline is shown in the popped dock (beside Filters) instead of
   *  as a tab in the main panel. */
  timelinePopped?: boolean;
  /** Compare and Timeline, when popped out, SHARE one dock on the side opposite
   *  the main panel. This is the active tab within that shared popped dock. */
  poppedActiveTab?: "compare" | "timeline";
  /** Collapsed (rolled-up) state of the shared popped dock. */
  poppedCollapsed?: boolean;
  /**
   * Persisted panel sizes (percent), bucketed by group-structure key so that
   * sizes from one dock arrangement never bleed into another. Outer key is the
   * group signature, inner key is the panel id.
   */
  panelSizes: Record<string, Record<string, number>>;
  /** User-customised quick-access colour palette (swatches row in Edit filter).
   *  undefined = use the built-in defaults. */
  customPalette?: PaletteEntry[];
  /** Log lines added to the timeline, per file id. Persisted (survives reload),
   *  but not on the undo stack; line numbers are file-specific so it's keyed by file. */
  timelineLinesByFile?: Record<string, number[]>;
  /** Log lines added to the comparison panel, per file id. Persisted (survives
   *  reload / document switch / filter switch) like timeline lines; line numbers
   *  are file-specific so it's keyed by file. */
  compareLinesByFile?: Record<string, number[]>;
  /** Height (px) of the timeline panel's draggable bottom sheet (track list). */
  timelineSheetH?: number;
  /** Size of the event markers (points/spans) drawn on the timeline canvas. */
  timelineIconSize?: "S" | "M" | "L";
  /** What the filter rows show as their label: the regex `pattern`, the
   *  `description`, or description-with-pattern-fallback (default). */
  filterLabel?: FilterLabelMode;
  /**
   * Global, reusable filter packs — the user's library. App-wide (not per-file
   * or per-set); persisted, but not on the undo stack. Inserting a pack into a
   * set IS undoable (it edits the set); managing the library is not.
   */
  filterPacks?: FilterPack[];
  /** Width (px) of the filter-packs side panel. */
  packsDrawerW?: number;
  /** Sort order for the packs library list ("manual" = user drag order). */
  packsSort?: PacksSort;
  /**
   * @deprecated Notebooks now live OUTSIDE the document, as top-level store
   * state with their own persistence key (see `store/index.ts`). Keeping them
   * on the doc put megabytes of embed payloads (timeline PNG data URLs) on
   * every undo snapshot + doc serialize, and let an app-level undo resurrect
   * deleted notebooks. These fields only survive so `extractNotebooks` can
   * lift them out of an old saved blob once; a live `doc` never carries them.
   */
  notebooks?: Notebook[];
  /** @deprecated See `notebooks` above — lifted into the store at hydration. */
  activeNotebookId?: string | null;
}

/** How the packs drawer orders its cards; "manual" keeps the drag order. */
export type PacksSort = "manual" | "name" | "created" | "count";

/** Filter-row label source (global setting). `desc-first` shows the description
 *  when set, else the pattern; `pattern`/`description` always show that field. */
export type FilterLabelMode = "pattern" | "description" | "desc-first";

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

/**
 * Unit a timeline source's time field is in. Clock formats ("H:M:S.mmm", "M:S")
 * are self-describing → `"hms"`; a plain number carries no unit, so the user
 * declares whether it is seconds / milli / micro / nanoseconds. `"date"` is for
 * absolute date+time stamps (Android logcat "MM-DD HH:MM:SS.mmm", ISO 8601,
 * syslog "Mon DD HH:MM:SS") — auto-parsed, year assumed when omitted (the
 * timeline is relative, so a missing year doesn't shift the layout). `"custom"`
 * parses the field with a user-supplied `TimelineSource.format` pattern (e.g.
 * "MM-dd HH:mm:ss.SSS") — the escape hatch for any shape the auto-parsers miss.
 * The timeline normalizes everything to nanoseconds using this. Lives on
 * `TimelineSource`, independent of the filter's field definitions.
 */
export type TimeUnit = "hms" | "s" | "ms" | "us" | "ns" | "date" | "custom";

/** Marker shape for a point event on the timeline (spans always render as bars). */
export type EventShape = "circle" | "square" | "triangle" | "diamond";

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
  /** Lines that are not excluded and have a colour winner. */
  matchedCount: number;
  /** Lines hidden by enabled exclude filters. */
  excludedCount: number;
  /**
   * Lazily extract a row's parsed fields by line number. Fields are no longer
   * computed for every line up front — only the rows that actually need them
   * (compare table, an expanded row) call this. Returns undefined when the line
   * has no field provider.
   */
  fieldsFor(n: number): Record<string, FieldValue> | undefined;
  /**
   * All enabled highlight (non-exclude) filters matching line `n`, in filter
   * order (colour winner first). Lazy; backed by the per-filter match bit sets.
   */
  matchedFiltersFor(n: number): Filter[];
}

export interface Segment {
  t: string;
  hit: boolean;
}

/**
 * One timeline track = one lane, identified by a **(filter, time field)** pair.
 * Tracks are a user-owned, ordered list on `FilterSet.sources` (no auto-derivation):
 * the user adds one with `+ Add track`, picking a filter then one of its numeric
 * fields. Events are produced only for log lines the user has added to the
 * timeline (like the compare panel); a line feeds this track when its first
 * matching filter is `filterId` and it exposes `timeField` — emitting a `point`,
 * or a `span` when `endField` is also present on that line. Persisted with the
 * saved filter file; identity key is `filterId + ":" + timeField`.
 */
export interface TimelineSource {
  id: string;
  /** The filter this track binds to (matches `ViewRow.fieldsFromId`). */
  filterId: string;
  /** Parsed field name this track reads its time from (point time / span start). */
  timeField: string;
  /** Lane label (defaults to the field name). */
  lane: string;
  kind: "point" | "span";
  /** Span only: the field name holding the end time (same filter, same line). */
  endField?: string;
  /** Unit the time field(s) are in; normalized to ns. */
  unit: TimeUnit;
  /**
   * Only when `unit === "custom"`: the user's time-format pattern, applied to the
   * raw field text. Tokens `YYYY YY MMM MM M DD D HH H mm m ss s` plus a run of
   * `S` (fractional seconds, any length); every other character matches literally.
   */
  format?: string;
  /** Mark color; defaults to a per-lane palette color. */
  color?: string;
  /** Point marker shape; defaults to "circle". Spans always render as bars. */
  shape?: EventShape;
  /** Row collapsed in the config list (UI only). */
  collapsed?: boolean;
  /** Hide this track from the timeline without deleting its config. */
  hidden?: boolean;
  /** Draw the time delta between consecutive points on this lane (UI only). */
  showDeltas?: boolean;
  /** Expand this lane to show a per-point detail card (UI only). */
  expanded?: boolean;
}

/** One extracted timeline event, time normalized to nanoseconds. */
export interface EventMark {
  lane: string;
  /** Event time in canonical nanoseconds (the span start, for a span). */
  t: number;
  /** Span end in nanoseconds; absent for point events. */
  end?: number;
  /** 1-based log line the event came from. */
  lineN: number;
  label: string;
  color?: string;
  /** Point marker shape; absent renders as a circle. Ignored for spans. */
  shape?: EventShape;
  /** All parsed fields of the source line, for the hover card. */
  fields?: Record<string, FieldValue>;
}
