import type { AppState, Filter } from "@/types";
import { DEFAULT_TEXT_COLOR, DEFAULT_BG_COLOR, FONT_DEFAULT } from "@/config";

let _uid = 1;
export function uid(prefix: string): string {
  return `${prefix}_${(_uid++).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function makeFilter(
  pattern: string,
  opts: Partial<Filter> = {},
): Filter {
  return {
    id: uid("f"),
    pattern,
    description: opts.description ?? "",
    enabled: opts.enabled !== false,
    caseSensitive: !!opts.caseSensitive,
    regex: !!opts.regex,
    exclude: !!opts.exclude,
    textColor: opts.textColor ?? DEFAULT_TEXT_COLOR,
    bgColor: opts.bgColor ?? DEFAULT_BG_COLOR,
    groupId: opts.groupId ?? null,
    fields: opts.fields,
  };
}

// ---------------------------------------------------------------------------
// TextAnalysisTool.NET (.tat) import — lets users migrate their filter sets.
// These helpers are the pure mapping layer; the DOM parsing lives in filterFile.
// ---------------------------------------------------------------------------

/** Map a TextAnalysisTool.NET hex colour ("808000", or 8-digit ARGB) to #rrggbb. */
export function tatColor(
  raw: string | null | undefined,
  fallback: string,
): string {
  let h = (raw ?? "").trim().replace(/^#/, "");
  if (h.length === 8) h = h.slice(2); // drop the leading ARGB alpha byte
  return /^[0-9a-fA-F]{6}$/.test(h) ? `#${h.toLowerCase()}` : fallback;
}

/** Build one of our filters from a TextAnalysisTool.NET <filter> element's attrs. */
export function filterFromTatAttrs(
  a: Record<string, string | null | undefined>,
): Filter {
  const yes = (v: string | null | undefined) =>
    (v ?? "").trim().toLowerCase() === "y";
  return makeFilter(a.text ?? "", {
    description: a.description ?? "",
    enabled: yes(a.enabled),
    exclude: yes(a.excluding),
    caseSensitive: yes(a.case_sensitive),
    regex: yes(a.regex),
    textColor: tatColor(a.foreColor, DEFAULT_TEXT_COLOR),
    bgColor: tatColor(a.backColor, DEFAULT_BG_COLOR),
  });
}

/** A fresh, empty workspace. Files are added by the user loading logs from disk. */
export function initialState(): AppState {
  return {
    files: [],
    activeFileId: null,
    recentFiles: [],
    recentFilterFiles: [],
    sidebarCollapsed: true,
    splitRatio: 0.5,
    panelPos: "right",
    mapColorMode: "bg",
    mapWidth: 16,
    fontSize: FONT_DEFAULT,
    fontWeight: 400,
    showLineNumbers: true,
    comparePos: "right",
    filterCollapsed: false,
    activePanelTab: "filters",
    comparePopped: false,
    timelinePopped: false,
    poppedActiveTab: "compare",
    poppedCollapsed: false,
    panelSizes: {},
  };
}

export function normalizeState(state: AppState): AppState {
  // Migrate the old app-level viewMode onto each file once (per-document now).
  const legacyViewMode = (
    state as Partial<Record<"viewMode", "all" | "matches">>
  ).viewMode;
  for (const f of state.files) {
    if (f.viewMode === undefined && legacyViewMode) f.viewMode = legacyViewMode;
  }
  for (const f of state.files) {
    if (!Array.isArray(f.sets)) f.sets = [];
    for (const g of f.sets) {
      if (!Array.isArray(g.groups)) g.groups = [];
      const validIds = new Set(g.groups.map((s) => s.id));
      for (const flt of g.filters) {
        // Drop references to deleted groups; backfill a missing groupId.
        if (
          flt.groupId === undefined ||
          (flt.groupId !== null && !validIds.has(flt.groupId))
        ) {
          flt.groupId = null;
        }
      }
      // Build / validate the top-level layout order (groups + ungrouped filters).
      if (!Array.isArray(g.order)) g.order = [];
      const groupIds = g.groups.map((s) => s.id);
      const ungroupedIds = g.filters
        .filter((f) => f.groupId === null)
        .map((f) => f.id);
      const valid = new Set<string>([...groupIds, ...ungroupedIds]);
      g.order = g.order.filter((id) => valid.has(id));
      const present = new Set(g.order);
      // Append anything missing. On first migration this preserves the old
      // layout: loose filter rows first (on top), then groups.
      for (const id of [...ungroupedIds, ...groupIds]) {
        if (!present.has(id)) g.order.push(id);
      }
      // Timeline track config: a track = (filter, field), so de-dupe by the
      // `filterId:timeField` pair — NOT by field name alone (which collapsed
      // every track sharing a field like `ts`/`time` down to one on reload).
      // Keep undefined when there are none.
      if (Array.isArray(g.sources)) {
        const seen = new Set<string>();
        g.sources = g.sources
          .filter((s) => {
            if (
              !s ||
              typeof s.filterId !== "string" ||
              typeof s.timeField !== "string"
            )
              return false;
            if (s.kind !== "point" && s.kind !== "span") return false;
            const key = s.filterId + ":" + s.timeField;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .map((s) => ({
            ...s,
            lane: typeof s.lane === "string" ? s.lane : s.timeField,
            unit: ["hms", "s", "ms", "us", "ns", "date", "custom"].includes(
              s.unit,
            )
              ? s.unit
              : "hms",
            format: typeof s.format === "string" ? s.format : undefined,
          }));
        if (g.sources.length === 0) delete g.sources;
      } else if (g.sources !== undefined) {
        delete g.sources;
      }
    }
    if (!f.activeSetId || !f.sets.find((g) => g.id === f.activeSetId)) {
      f.activeSetId = f.sets[0]?.id ?? null;
    }
    // Bookmarks: keep only well-formed entries (a numeric line + a string note).
    f.markers = Array.isArray(f.markers)
      ? f.markers
          .filter(
            (m) => m && typeof m.n === "number" && typeof m.icon === "string",
          )
          .map((m) => ({
            n: m.n,
            icon: m.icon,
            note: typeof m.note === "string" ? m.note : "",
          }))
      : [];
    // Per-document log-view header state (migrated from the old app-level viewMode).
    if (f.viewMode !== "matches") f.viewMode = "all";
    if (typeof f.findOpen !== "boolean") f.findOpen = false;
  }
  if (
    !state.activeFileId ||
    !state.files.find((f) => f.id === state.activeFileId)
  ) {
    state.activeFileId = state.files[0]?.id ?? null;
  }
  if (!Array.isArray(state.recentFiles)) state.recentFiles = [];
  if (!Array.isArray(state.recentFilterFiles)) state.recentFilterFiles = [];
  if (!state.mapColorMode) state.mapColorMode = "bg";
  if (!state.mapWidth) state.mapWidth = 16;
  if (!state.fontSize) state.fontSize = FONT_DEFAULT;
  if (!state.fontWeight) state.fontWeight = 400;
  if (state.showLineNumbers === undefined) state.showLineNumbers = true;
  if (state.comparePos !== "bottom" && state.comparePos !== "right")
    state.comparePos = "right";
  if (state.filterCollapsed === undefined) state.filterCollapsed = false;
  if (
    !["filters", "compare", "bookmarks", "timeline", "notebook"].includes(
      state.activePanelTab,
    )
  )
    state.activePanelTab = "filters";
  if (typeof state.comparePopped !== "boolean") state.comparePopped = false;
  if (typeof state.timelinePopped !== "boolean") state.timelinePopped = false;
  if (
    state.poppedActiveTab !== "compare" &&
    state.poppedActiveTab !== "timeline"
  )
    state.poppedActiveTab = "compare";
  if (typeof state.poppedCollapsed !== "boolean") state.poppedCollapsed = false;
  // Migrate the pre-shared-dock collapse flag onto the shared popped dock.
  const legacyCmpCollapsed = (
    state as Partial<Record<"compareCollapsed", boolean>>
  ).compareCollapsed;
  if (legacyCmpCollapsed && !state.poppedCollapsed)
    state.poppedCollapsed = true;
  delete (state as Partial<Record<"compareCollapsed", unknown>>)
    .compareCollapsed;
  // panelSizes is bucketed (group → id → percent); drop any old flat/invalid shape.
  if (
    !state.panelSizes ||
    typeof state.panelSizes !== "object" ||
    Object.values(state.panelSizes).some(
      (v) => typeof v !== "object" || v === null,
    )
  ) {
    state.panelSizes = {};
  }
  // Drop the short-lived app-level parse-profile fields; parsing now lives on
  // individual regex filters (Filter.fields).
  delete (
    state as Partial<
      Record<"profiles" | "activeProfileId" | "structuredView", unknown>
    >
  ).profiles;
  delete (
    state as Partial<
      Record<"profiles" | "activeProfileId" | "structuredView", unknown>
    >
  ).activeProfileId;
  delete (
    state as Partial<
      Record<"profiles" | "activeProfileId" | "structuredView", unknown>
    >
  ).structuredView;
  // viewMode moved onto each LogFile; drop the stale app-level field.
  delete (state as Partial<Record<"viewMode", unknown>>).viewMode;
  // Global filter-pack library: keep only well-formed packs. Don't deep-rewrite
  // a pack's internals — its `order` references filter/group ids, so coercing
  // them through makeFilter (fresh ids) would break the layout. Packs are
  // produced well-formed internally; imported packs are sanitized on import.
  if (Array.isArray(state.filterPacks)) {
    state.filterPacks = state.filterPacks.filter(
      (p) =>
        p &&
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        Array.isArray(p.filters) &&
        Array.isArray(p.groups) &&
        Array.isArray(p.order),
    );
    if (state.filterPacks.length === 0) delete state.filterPacks;
    // Tags are loose user labels — keep only trimmed, non-empty strings; drop the
    // field entirely when nothing survives so packs without tags stay clean.
    for (const p of state.filterPacks ?? []) {
      if (Array.isArray(p.tags)) {
        const t = p.tags
          .filter((x): x is string => typeof x === "string" && x.trim() !== "")
          .map((x) => x.trim());
        if (t.length) p.tags = t;
        else delete p.tags;
      } else if (p.tags !== undefined) {
        delete p.tags;
      }
    }
  } else if (state.filterPacks !== undefined) {
    delete state.filterPacks;
  }
  // Packs side-panel width: clamp to the same range the resize drag enforces.
  if (typeof state.packsDrawerW === "number") {
    state.packsDrawerW = Math.max(
      280,
      Math.min(680, Math.round(state.packsDrawerW)),
    );
  } else if (state.packsDrawerW !== undefined) {
    delete state.packsDrawerW;
  }
  // Packs list sort: one of the known modes, else drop back to manual (default).
  if (
    state.packsSort !== undefined &&
    !["manual", "name", "created", "count"].includes(state.packsSort)
  ) {
    delete state.packsSort;
  }
  return state;
}
