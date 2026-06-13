import {
  FileText, Star, Flag, Bug, Zap, CircleAlert, type LucideIcon,
} from "lucide-react";
import type { FileIcon } from "../types";

/** The glyphs offered in the per-file icon picker, in display order. */
export const FILE_ICONS: { id: FileIcon; label: string; Icon: LucideIcon }[] = [
  { id: "file",  label: "Document",  Icon: FileText },
  { id: "star",  label: "Important", Icon: Star },
  { id: "flag",  label: "Flagged",   Icon: Flag },
  { id: "bug",   label: "Debug",     Icon: Bug },
  { id: "zap",   label: "Events",    Icon: Zap },
  { id: "alert", label: "Alert",     Icon: CircleAlert },
];

const BY_ID = new Map(FILE_ICONS.map((m) => [m.id, m]));

/** Render a file's chosen glyph (defaults to the document icon). */
export function FileGlyph({ icon, size = 16 }: { icon?: FileIcon; size?: number }) {
  const Icon = (icon && BY_ID.get(icon)?.Icon) ?? FileText;
  return <Icon size={size} />;
}
