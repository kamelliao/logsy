import type { AppState, Filter, PaletteEntry } from "./types";

export const PALETTE: PaletteEntry[] = [
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
  { name: "highlight", color: "#fff7c2" },
  { name: "white",     color: "#ffffff" },
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
    bgColor: opts.bgColor ?? "#fff7c2",
    sectionId: opts.sectionId ?? null,
    fields: opts.fields,
    extractOnly: opts.extractOnly,
  };
}

/** A fresh, empty workspace. Files are added by the user loading logs from disk. */
export function initialState(): AppState {
  return {
    files: [],
    activeFileId: null,
    sidebarCollapsed: false,
    splitRatio: 0.5,
    panelPos: "bottom",
    viewMode: "all",
    mapColorMode: "bg",
    mapWidth: 14,
    fontSize: 12.5,
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
    for (const g of f.groups) {
      if (!Array.isArray(g.sections)) g.sections = [];
      const validIds = new Set(g.sections.map((s) => s.id));
      for (const flt of g.filters) {
        // Backfill older filters and drop references to deleted sections.
        if (flt.sectionId === undefined || (flt.sectionId !== null && !validIds.has(flt.sectionId))) {
          flt.sectionId = null;
        }
      }
      // Build / validate the top-level layout order (sections + ungrouped filters).
      if (!Array.isArray(g.order)) g.order = [];
      const sectionIds = g.sections.map((s) => s.id);
      const ungroupedIds = g.filters.filter((f) => f.sectionId === null).map((f) => f.id);
      const valid = new Set<string>([...sectionIds, ...ungroupedIds]);
      g.order = g.order.filter((id) => valid.has(id));
      const present = new Set(g.order);
      // Append anything missing. On first migration this preserves the old
      // layout: loose filter rows first (on top), then sections.
      for (const id of [...ungroupedIds, ...sectionIds]) {
        if (!present.has(id)) g.order.push(id);
      }
    }
    if (!f.activeGroupId || !f.groups.find((g) => g.id === f.activeGroupId)) {
      f.activeGroupId = f.groups[0]?.id ?? null;
    }
  }
  if (!state.activeFileId || !state.files.find((f) => f.id === state.activeFileId)) {
    state.activeFileId = state.files[0]?.id ?? null;
  }
  if (!state.mapColorMode) state.mapColorMode = "bg";
  if (!state.mapWidth) state.mapWidth = 14;
  if (!state.fontSize) state.fontSize = 12.5;
  if (state.showLineNumbers === undefined) state.showLineNumbers = true;
  if (state.comparePos !== "bottom" && state.comparePos !== "right") state.comparePos = "right";
  if (state.filterCollapsed === undefined) state.filterCollapsed = false;
  if (state.compareCollapsed === undefined) state.compareCollapsed = false;
  if (state.activePanelTab !== "filters" && state.activePanelTab !== "compare") state.activePanelTab = "filters";
  if (typeof state.comparePopped !== "boolean") state.comparePopped = false;
  // panelSizes is bucketed (group → id → percent); drop any old flat/invalid shape.
  if (!state.panelSizes || typeof state.panelSizes !== "object" ||
      Object.values(state.panelSizes).some((v) => typeof v !== "object" || v === null)) {
    state.panelSizes = {};
  }
  // Drop the short-lived app-level parse-profile fields; parsing now lives on
  // individual regex filters (Filter.fields / Filter.extractOnly).
  delete (state as Partial<Record<"profiles" | "activeProfileId" | "structuredView", unknown>>).profiles;
  delete (state as Partial<Record<"profiles" | "activeProfileId" | "structuredView", unknown>>).activeProfileId;
  delete (state as Partial<Record<"profiles" | "activeProfileId" | "structuredView", unknown>>).structuredView;
  return state;
}
