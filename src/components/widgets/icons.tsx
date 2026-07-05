import type { SVGProps } from "react";

// Custom SVG glyphs that lucide doesn't ship, drawn to match its style
// (currentColor stroke, width 2, round caps/joins, 24×24 viewBox) so they sit
// cleanly next to lucide icons. Signature mirrors a lucide icon: pass `size`,
// plus any standard SVG prop (className, style, strokeWidth, …).

type IconProps = { size?: number } & Omit<SVGProps<SVGSVGElement>, "size">;

/** "Find in selection" glyph — three frameless lines (medium / long / short). */
export function SelectionLinesIcon({ size = 15, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <line x1="4" y1="7" x2="15" y2="7" />
      <line x1="4" y1="13" x2="19" y2="13" />
      <line x1="4" y1="19" x2="15" y2="19" />
    </svg>
  );
}
