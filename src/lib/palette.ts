import type { PaletteEntry } from "@/types";

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
