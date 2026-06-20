import {
  Bookmark,
  Star,
  Flag,
  Bug,
  Pin,
  CircleAlert,
  type LucideIcon,
} from "lucide-react";
import type { MarkerIcon } from "@/types";

/** The bookmark glyphs offered in the picker, in display order. */
export const MARKER_ICONS: {
  id: MarkerIcon;
  label: string;
  color: string;
  Icon: LucideIcon;
}[] = [
  { id: "bookmark", label: "Bookmark", color: "#2563eb", Icon: Bookmark },
  { id: "star", label: "Star", color: "#d97706", Icon: Star },
  { id: "flag", label: "Flag", color: "#dc2626", Icon: Flag },
  { id: "bug", label: "Bug", color: "#16a34a", Icon: Bug },
  { id: "pin", label: "Pin", color: "#7c3aed", Icon: Pin },
  { id: "alert", label: "Alert", color: "#ea580c", Icon: CircleAlert },
];

const BY_ID = new Map(MARKER_ICONS.map((m) => [m.id, m]));

export function markerColor(icon: MarkerIcon): string {
  return BY_ID.get(icon)?.color ?? "#2563eb";
}

/** Render a marker's glyph in its own colour. */
export function MarkerGlyph({
  icon,
  size = 13,
}: {
  icon: MarkerIcon;
  size?: number;
}) {
  const m = BY_ID.get(icon) ?? MARKER_ICONS[0];
  const Icon = m.Icon;
  return <Icon size={size} color={m.color} fill={m.color} fillOpacity={0.18} />;
}
