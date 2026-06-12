import type { AppState, Filter, PaletteEntry } from "./types";

export const DEFAULT_PALETTE: PaletteEntry[] = [
  { name: "default", text: "#1c1f23", bg: "#ffffff" },
  { name: "red",    text: "#b42318", bg: "#fce4e4" },
  { name: "orange", text: "#b54708", bg: "#fcebd9" },
  { name: "amber",  text: "#854d0e", bg: "#fef7c3" },
  { name: "green",  text: "#166534", bg: "#dcfce7" },
  { name: "teal",   text: "#115e59", bg: "#ccfbf1" },
  { name: "blue",   text: "#1e40af", bg: "#dbeafe" },
  { name: "indigo", text: "#3730a3", bg: "#e0e7ff" },
  { name: "violet", text: "#6b21a8", bg: "#f3e8ff" },
  { name: "pink",   text: "#9d174d", bg: "#fce7f3" },
  { name: "slate",  text: "#334155", bg: "#e7ebf0" },
];

/** @deprecated Use DEFAULT_PALETTE */
export const PALETTE: PaletteEntry[] = [
  { name: "default", text: "#1c1f23", bg: "#ffffff" },
  { name: "red",    text: "#b42318", bg: "#fce4e4" },
  { name: "orange", text: "#b54708", bg: "#fcebd9" },
  { name: "amber",  text: "#854d0e", bg: "#fef7c3" },
  { name: "green",  text: "#166534", bg: "#dcfce7" },
  { name: "teal",   text: "#115e59", bg: "#ccfbf1" },
  { name: "blue",   text: "#1e40af", bg: "#dbeafe" },
  { name: "indigo", text: "#3730a3", bg: "#e0e7ff" },
  { name: "violet", text: "#6b21a8", bg: "#f3e8ff" },
  { name: "pink",   text: "#9d174d", bg: "#fce7f3" },
  { name: "slate",  text: "#334155", bg: "#e7ebf0" },
];

/** Fixed palettes the editor offers for each channel (searchable via combobox). */
export interface ColorOption {
  name: string;
  color: string;
}

// One vivid, well-separated colour per hue family (plus two neutrals). Earlier
// the list led with six near-identical darks (ink/black/slate/gray/zinc/stone),
// which gave the user no meaningful choice — colour is what tells log patterns
// apart, so the options need to actually look different.
export const TEXT_SWATCHES: ColorOption[] = [
  { name: "ink",     color: "#1c1f23" },
  { name: "white",   color: "#ffffff" },
  { name: "red",     color: "#dc2626" },
  { name: "orange",  color: "#ea580c" },
  { name: "amber",   color: "#d97706" },
  { name: "yellow",  color: "#ca8a04" },
  { name: "lime",    color: "#65a30d" },
  { name: "green",   color: "#16a34a" },
  { name: "emerald", color: "#059669" },
  { name: "teal",    color: "#0d9488" },
  { name: "cyan",    color: "#0891b2" },
  { name: "sky",     color: "#0284c7" },
  { name: "blue",    color: "#2563eb" },
  { name: "indigo",  color: "#4f46e5" },
  { name: "violet",  color: "#7c3aed" },
  { name: "purple",  color: "#9333ea" },
  { name: "fuchsia", color: "#c026d3" },
  { name: "pink",    color: "#db2777" },
  { name: "rose",    color: "#e11d48" },
  { name: "brown",   color: "#92400e" },
  { name: "slate",   color: "#475569" },
];

// Distinct pastel tints — one per hue, at a slightly stronger level than before
// so adjacent choices read as genuinely different behind the log text.
export const BG_SWATCHES: ColorOption[] = [
  { name: "white",     color: "#ffffff" },
  { name: "black",     color: "#141414" },
  { name: "highlight", color: "#fff7c2" },
  { name: "red",       color: "#fecaca" },
  { name: "orange",    color: "#fed7aa" },
  { name: "amber",     color: "#fde68a" },
  { name: "yellow",    color: "#fef08a" },
  { name: "lime",      color: "#d9f99d" },
  { name: "green",     color: "#bbf7d0" },
  { name: "emerald",   color: "#a7f3d0" },
  { name: "teal",      color: "#99f6e4" },
  { name: "cyan",      color: "#a5f3fc" },
  { name: "sky",       color: "#bae6fd" },
  { name: "blue",      color: "#bfdbfe" },
  { name: "indigo",    color: "#c7d2fe" },
  { name: "violet",    color: "#ddd6fe" },
  { name: "purple",    color: "#e9d5ff" },
  { name: "fuchsia",   color: "#f5d0fe" },
  { name: "pink",      color: "#fbcfe8" },
  { name: "rose",      color: "#fecdd3" },
  { name: "slate",     color: "#e2e8f0" },
  // Saturated / vivid backgrounds — stronger than the pastels above for filters
  // that need to stand out. Picking a dark one auto-lightens dark text.
  { name: "red bold",     color: "#f87171" },
  { name: "orange bold",  color: "#fb923c" },
  { name: "yellow bold",  color: "#facc15" },
  { name: "lime bold",    color: "#a3e635" },
  { name: "sky bold",     color: "#38bdf8" },
  { name: "blue bold",    color: "#60a5fa" },
  { name: "indigo bold",  color: "#818cf8" },
  { name: "fuchsia bold", color: "#e879f9" },
  { name: "pink bold",    color: "#f472b6" },
  { name: "rose bold",    color: "#fb7185" },
];

let _uid = 1;
export function uid(prefix: string): string {
  return `${prefix}_${(_uid++).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function makeFilter(pattern: string, opts: Partial<Filter> = {}): Filter {
  return {
    id: uid("f"),
    pattern,
    description: opts.description ?? "",
    enabled: opts.enabled !== false,
    caseSensitive: !!opts.caseSensitive,
    regex: !!opts.regex,
    exclude: !!opts.exclude,
    textColor: opts.textColor ?? "#1c1f23",
    bgColor: opts.bgColor ?? "#ffffff",
    groupId: opts.groupId ?? null,
    fields: opts.fields,
  };
}

// ---------------------------------------------------------------------------
// TextAnalysisTool.NET (.tat) import — lets users migrate their filter sets.
// These helpers are the pure mapping layer; the DOM parsing lives in App.tsx.
// ---------------------------------------------------------------------------

/** Map a TextAnalysisTool.NET hex colour ("808000", or 8-digit ARGB) to #rrggbb. */
export function tatColor(raw: string | null | undefined, fallback: string): string {
  let h = (raw ?? "").trim().replace(/^#/, "");
  if (h.length === 8) h = h.slice(2); // drop the leading ARGB alpha byte
  return /^[0-9a-fA-F]{6}$/.test(h) ? `#${h.toLowerCase()}` : fallback;
}

/** Build one of our filters from a TextAnalysisTool.NET <filter> element's attrs. */
export function filterFromTatAttrs(a: Record<string, string | null | undefined>): Filter {
  const yes = (v: string | null | undefined) => (v ?? "").trim().toLowerCase() === "y";
  return makeFilter(a.text ?? "", {
    description: a.description ?? "",
    enabled: yes(a.enabled),
    exclude: yes(a.excluding),
    caseSensitive: yes(a.case_sensitive),
    regex: yes(a.regex),
    textColor: tatColor(a.foreColor, "#1c1f23"),
    bgColor: tatColor(a.backColor, "#ffffff"),
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
    viewMode: "all",
    mapColorMode: "bg",
    mapWidth: 16,
    fontSize: 12.5,
    fontWeight: 400,
    showLineNumbers: true,
    comparePos: "right",
    filterCollapsed: false,
    compareCollapsed: false,
    activePanelTab: "filters",
    comparePopped: false,
    panelSizes: {},
  };
}

export function normalizeState(state: AppState): AppState {
  for (const f of state.files) {
    if (!Array.isArray(f.sets)) f.sets = [];
    for (const g of f.sets) {
      if (!Array.isArray(g.groups)) g.groups = [];
      const validIds = new Set(g.groups.map((s) => s.id));
      for (const flt of g.filters) {
        // Drop references to deleted groups; backfill a missing groupId.
        if (flt.groupId === undefined || (flt.groupId !== null && !validIds.has(flt.groupId))) {
          flt.groupId = null;
        }
      }
      // Build / validate the top-level layout order (groups + ungrouped filters).
      if (!Array.isArray(g.order)) g.order = [];
      const groupIds = g.groups.map((s) => s.id);
      const ungroupedIds = g.filters.filter((f) => f.groupId === null).map((f) => f.id);
      const valid = new Set<string>([...groupIds, ...ungroupedIds]);
      g.order = g.order.filter((id) => valid.has(id));
      const present = new Set(g.order);
      // Append anything missing. On first migration this preserves the old
      // layout: loose filter rows first (on top), then groups.
      for (const id of [...ungroupedIds, ...groupIds]) {
        if (!present.has(id)) g.order.push(id);
      }
    }
    if (!f.activeSetId || !f.sets.find((g) => g.id === f.activeSetId)) {
      f.activeSetId = f.sets[0]?.id ?? null;
    }
    // Bookmarks: keep only well-formed entries (a numeric line + a string note).
    f.markers = Array.isArray(f.markers)
      ? f.markers.filter((m) => m && typeof m.n === "number" && typeof m.icon === "string")
          .map((m) => ({ n: m.n, icon: m.icon, note: typeof m.note === "string" ? m.note : "" }))
      : [];
  }
  if (!state.activeFileId || !state.files.find((f) => f.id === state.activeFileId)) {
    state.activeFileId = state.files[0]?.id ?? null;
  }
  if (!Array.isArray(state.recentFiles)) state.recentFiles = [];
  if (!Array.isArray(state.recentFilterFiles)) state.recentFilterFiles = [];
  if (!state.mapColorMode) state.mapColorMode = "bg";
  if (!state.mapWidth) state.mapWidth = 16;
  if (!state.fontSize) state.fontSize = 12.5;
  if (!state.fontWeight) state.fontWeight = 400;
  if (state.showLineNumbers === undefined) state.showLineNumbers = true;
  if (state.comparePos !== "bottom" && state.comparePos !== "right") state.comparePos = "right";
  if (state.filterCollapsed === undefined) state.filterCollapsed = false;
  if (state.compareCollapsed === undefined) state.compareCollapsed = false;
  if (state.activePanelTab !== "filters" && state.activePanelTab !== "compare" && state.activePanelTab !== "bookmarks") state.activePanelTab = "filters";
  if (typeof state.comparePopped !== "boolean") state.comparePopped = false;
  // panelSizes is bucketed (group → id → percent); drop any old flat/invalid shape.
  if (!state.panelSizes || typeof state.panelSizes !== "object" ||
      Object.values(state.panelSizes).some((v) => typeof v !== "object" || v === null)) {
    state.panelSizes = {};
  }
  // Drop the short-lived app-level parse-profile fields; parsing now lives on
  // individual regex filters (Filter.fields).
  delete (state as Partial<Record<"profiles" | "activeProfileId" | "structuredView", unknown>>).profiles;
  delete (state as Partial<Record<"profiles" | "activeProfileId" | "structuredView", unknown>>).activeProfileId;
  delete (state as Partial<Record<"profiles" | "activeProfileId" | "structuredView", unknown>>).structuredView;
  return state;
}
