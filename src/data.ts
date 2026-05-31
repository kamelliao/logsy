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

export const TEXT_SWATCHES: ColorOption[] = [
  { name: "ink",     color: "#1c1f23" },
  { name: "black",   color: "#000000" },
  { name: "slate",   color: "#334155" },
  { name: "gray",    color: "#374151" },
  { name: "zinc",    color: "#3f3f46" },
  { name: "stone",   color: "#44403c" },
  { name: "red",     color: "#b91c1c" },
  { name: "crimson", color: "#991b1b" },
  { name: "rose",    color: "#be123c" },
  { name: "pink",    color: "#be185d" },
  { name: "magenta", color: "#9d174d" },
  { name: "fuchsia", color: "#a21caf" },
  { name: "purple",  color: "#7e22ce" },
  { name: "grape",   color: "#6b21a8" },
  { name: "violet",  color: "#6d28d9" },
  { name: "indigo",  color: "#4338ca" },
  { name: "navy",    color: "#3730a3" },
  { name: "blue",    color: "#1d4ed8" },
  { name: "royal",   color: "#1e40af" },
  { name: "sky",     color: "#0369a1" },
  { name: "cyan",    color: "#0e7490" },
  { name: "teal",    color: "#0f766e" },
  { name: "pine",    color: "#115e59" },
  { name: "emerald", color: "#047857" },
  { name: "green",   color: "#15803d" },
  { name: "forest",  color: "#166534" },
  { name: "lime",    color: "#4d7c0f" },
  { name: "moss",    color: "#3f6212" },
  { name: "yellow",  color: "#a16207" },
  { name: "amber",   color: "#b45309" },
  { name: "orange",  color: "#c2410c" },
  { name: "rust",    color: "#9a3412" },
  { name: "brown",   color: "#78350f" },
];

export const BG_SWATCHES: ColorOption[] = [
  { name: "highlight", color: "#fff7c2" },
  { name: "white",     color: "#ffffff" },
  { name: "slate",     color: "#f1f5f9" },
  { name: "gray",      color: "#f3f4f6" },
  { name: "zinc",      color: "#f4f4f5" },
  { name: "stone",     color: "#f5f5f4" },
  { name: "silver",    color: "#e5e7eb" },
  { name: "red",       color: "#fee2e2" },
  { name: "salmon",    color: "#fecaca" },
  { name: "rose",      color: "#ffe4e6" },
  { name: "pink",      color: "#fce7f3" },
  { name: "blush",     color: "#fbcfe8" },
  { name: "fuchsia",   color: "#fae8ff" },
  { name: "purple",    color: "#f3e8ff" },
  { name: "grape",     color: "#e9d5ff" },
  { name: "violet",    color: "#ede9fe" },
  { name: "indigo",    color: "#e0e7ff" },
  { name: "blue",      color: "#dbeafe" },
  { name: "powder",    color: "#bfdbfe" },
  { name: "sky",       color: "#e0f2fe" },
  { name: "cyan",      color: "#cffafe" },
  { name: "teal",      color: "#ccfbf1" },
  { name: "aqua",      color: "#99f6e4" },
  { name: "emerald",   color: "#d1fae5" },
  { name: "green",     color: "#dcfce7" },
  { name: "mint",      color: "#bbf7d0" },
  { name: "lime",      color: "#ecfccb" },
  { name: "yellow",    color: "#fef9c3" },
  { name: "amber",     color: "#fef3c7" },
  { name: "gold",      color: "#fde68a" },
  { name: "orange",    color: "#ffedd5" },
  { name: "peach",     color: "#fed7aa" },
  { name: "cream",     color: "#fef6e4" },
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
  return state;
}
