import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import { createPortal } from "react-dom";
import type { EventMark, EventShape } from "@/types";

// Layout constants (CSS px).
// The left lane-label column is user-resizable (drag the gutter divider); the
// live width is component state, persisted to localStorage. These are the default
// and clamp bounds, plus the grab zone around the divider.
const DEFAULT_GUTTER = 76;
const GUTTER_MIN = 60;
const GUTTER_MAX = 280;
const GUTTER_EDGE = 4; // px around the divider that grabs it to resize
const GUTTER_KEY = "logsy.tl.gutter";
const RIGHT = 12;
const AXIS = 18; // top axis strip (timestamps) — pinned, never scrolls
const PAD = 6; // gap below the last lane
// Each lane is a fixed height: adding tracks grows the plot (and scrolls it
// vertically past the viewport) rather than squeezing every lane thinner, so
// many tracks stay readable at a glance regardless of the panel's height.
const LANE_H = 28;
// An expanded lane keeps its LANE_H point row, then adds a card strip below for
// the per-point detail cards. The strip height is sized per lane to fit its cards
// (estCardH), clamped to [CARD_MIN_H, CARD_MAX_H]. Cards are decimated left→right
// but may overlap by CARD_OVERLAP of their width, so the strip packs dense while
// the rendered-card count stays bounded (perf). Hover focuses one; clicking raises.
const CARD_MIN_H = 60;
const CARD_MAX_H = 300;
const CARD_GAP = 6;
// The decimation "sweet spot": how much of a card's width the next card may cover.
// 0 = strict no-overlap (sparse, big gaps); →1 = a card per point (dense but slow).
// At 0.5 each kept card still shows its left half (header + timestamp). Tune here.
const CARD_OVERLAP = 0.5;

// Minimap (overview strip above the main canvas): fixed height; a draggable
// brush shows the visible window over the whole [0, maxT] domain. Only shown
// once there are events to overview.
const MM_H = 30; // minimap strip height (CSS px)
const MM_EDGE = 5; // px around a brush edge that grabs it to resize (zoom)

/** Add thousands separators to the integer part of a numeric string. */
function group(s: string): string {
  const neg = s.startsWith("-");
  const [int, frac] = (neg ? s.slice(1) : s).split(".");
  const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + g + (frac !== undefined ? "." + frac : "");
}

/** Format a ns instant/duration with an adaptive unit + grouped digits. */
function fmtNs(ns: number): string {
  const a = Math.abs(ns);
  const trim = (n: number) =>
    group(n.toFixed(a >= 1e6 ? 3 : 2).replace(/\.?0+$/, ""));
  if (a >= 1e9) return trim(ns / 1e9) + " s";
  if (a >= 1e6) return trim(ns / 1e6) + " ms";
  if (a >= 1e3) return trim(ns / 1e3) + " µs";
  return group(String(Math.round(ns))) + " ns";
}

/** Multiply a hex color toward black by `f` (0 = black, 1 = unchanged). */
function darken(hex: string, f = 0.62): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "rgba(0,0,0,0.28)";
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = Math.round(parseInt(h.slice(0, 2), 16) * f);
  const g = Math.round(parseInt(h.slice(2, 4), 16) * f);
  const b = Math.round(parseInt(h.slice(4, 6), 16) * f);
  return `rgb(${r}, ${g}, ${b})`;
}

/** A "nice" step ≥ a raw step (1/2/5 × 10ⁿ). */
function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/** Trim `s` (appending "…") until it fits within `maxW` px under the ctx font. */
function fitText(
  ctx: CanvasRenderingContext2D,
  s: string,
  maxW: number,
): string {
  if (maxW <= 0) return "";
  if (ctx.measureText(s).width <= maxW) return s;
  let hi = s.length;
  while (hi > 0 && ctx.measureText(s.slice(0, hi) + "…").width > maxW) hi--;
  return hi > 0 ? s.slice(0, hi) + "…" : "…";
}

/** Trace a point marker of the given shape, centered at (x, y). */
function tracePoint(
  ctx: CanvasRenderingContext2D,
  shape: EventShape | undefined,
  x: number,
  y: number,
  r: number,
) {
  ctx.beginPath();
  switch (shape) {
    case "square":
      ctx.rect(x - r, y - r, r * 2, r * 2);
      break;
    case "triangle": {
      const h = r * 1.2;
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + h, y + h * 0.82);
      ctx.lineTo(x - h, y + h * 0.82);
      ctx.closePath();
      break;
    }
    case "diamond":
      ctx.moveTo(x, y - r * 1.3);
      ctx.lineTo(x + r * 1.15, y);
      ctx.lineTo(x, y + r * 1.3);
      ctx.lineTo(x - r * 1.15, y);
      ctx.closePath();
      break;
    default:
      ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}

/** Stable identity for a mark (survives array re-creation): lane + source line. */
const markKey = (m: EventMark) => m.lane + " " + m.lineN;

/** Column count for a card's field grid (column-major flow keeps it from getting
 *  tall+thin) — same rule the hover card uses. */
function cardCols(m: EventMark): number {
  const n = m.fields ? Object.keys(m.fields).length : 0;
  return n > 24 ? 3 : n > 12 ? 2 : 1;
}

/** Approximate px width of a string at the card's 11px UI font. There's no canvas
 *  ctx in this layout pass, so use per-glyph averages (narrow punctuation/`i`/`l`
 *  thinner, wide caps fatter, digits are tabular). Good enough to size a card to
 *  its content instead of a flat max. */
function approxTextW(s: string): number {
  let w = 0;
  for (const ch of s) {
    if (ch === " ") w += 3.1;
    else if (/[.,:;'`|!iIlj()[\]]/.test(ch)) w += 3;
    else if (/[mMW@]/.test(ch)) w += 9;
    else if (/[0-9]/.test(ch)) w += 6.2;
    else w += 6.4;
  }
  return w;
}

/** A card's natural width: multi-column (field-heavy) cards grow with the column
 *  count; a single-column card is sized to its widest row's CONTENT (header / time
 *  / a field's key+value) rather than a flat 240 — so a sparse card hugs its text
 *  instead of being a wide empty box. Capped both ways: the value column ellipsises
 *  at its own max, so a long value can't blow the card up. */
function estCardW(m: EventMark): number {
  const c = cardCols(m);
  if (c > 1) return c * 190;
  const VAL_CAP = 150; // matches .tlc-tip-v max-width
  // header: lane chip (name + 10px chip padding) + " L<lineN>"
  let content = approxTextW(m.lane) + 12 + approxTextW(" L" + m.lineN);
  if (m.end !== undefined) {
    const valW = Math.max(
      approxTextW(fmtNs(m.t)),
      approxTextW(fmtNs(m.end)),
      approxTextW(fmtNs(m.end - m.t)),
    );
    content = Math.max(content, approxTextW("begin") + 14 + valW); // label + srow gap
  } else {
    content = Math.max(content, approxTextW(fmtNs(m.t)));
  }
  if (m.fields) {
    for (const [k, v] of Object.entries(m.fields)) {
      // key + 8px field gap + value (the value ellipsises at VAL_CAP)
      content = Math.max(
        content,
        approxTextW(k) + 8 + Math.min(VAL_CAP, approxTextW(v.raw)),
      );
    }
  }
  // + 16px horizontal padding + a little slack so non-ellipsising rows don't clip.
  return Math.max(108, Math.min(240, Math.ceil(content) + 18));
}

/** Rough rendered height of a card (px), used to size an expanded lane so its
 *  cards aren't clipped. Approximates the `.tlc-tip` box: padding + header + the
 *  time row(s) (a span stacks begin/end/dur) + the fields grid (column-major, so
 *  `ceil(n / cols)` rows). Deliberately a slight OVER-estimate so the card's
 *  bottom padding is never clipped by the lane's maxHeight; the lane is capped. */
function estCardH(m: EventMark): number {
  const n = m.fields ? Object.keys(m.fields).length : 0;
  const rows = Math.ceil(n / cardCols(m));
  const timeBlock = m.end !== undefined ? 48 : 16;
  return 16 + 18 + timeBlock + (n > 0 ? 10 + rows * 16 : 0);
}

type CardItem = {
  m: EventMark;
  left: number;
  top: number;
  w: number;
  maxH: number;
  rank: number;
  clipTop: number;
};

function rrect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function drawCardOnCanvas(
  ctx: CanvasRenderingContext2D,
  c: CardItem,
  colors: {
    bg: string;
    border: string;
    text: string;
    dim: string;
    accent: string;
  },
) {
  const { m, left, top, w, maxH, clipTop } = c;
  const PX = 8,
    PY = 6;

  ctx.save();
  if (clipTop > 0) {
    ctx.beginPath();
    ctx.rect(left, top + clipTop, w, maxH - clipTop);
    ctx.clip();
  }

  // Background + border
  rrect(ctx, left, top, w, maxH, 7);
  ctx.fillStyle = colors.bg;
  ctx.fill();
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 1;
  ctx.stroke();

  let y = top + PY;
  const x0 = left + PX;
  const xR = left + w - PX;

  // --- Header: lane chip + line number ---
  ctx.font = "bold 10px ui-sans-serif,system-ui,sans-serif";
  ctx.textBaseline = "middle";
  const chipPad = 5;
  const chipH = 14;
  const rawChipW = ctx.measureText(m.lane).width + chipPad * 2;
  const chipW = Math.min(rawChipW, w - PX * 2 - 32);

  rrect(ctx, x0, y, chipW, chipH, 3);
  ctx.fillStyle = m.color || "#94a3b8";
  ctx.fill();
  ctx.fillStyle = colors.text;
  ctx.textAlign = "left";
  ctx.fillText(m.lane, x0 + chipPad, y + chipH / 2, chipW - chipPad * 2);

  ctx.font = "11px ui-sans-serif,system-ui,sans-serif";
  ctx.fillStyle = colors.dim;
  ctx.fillText(` L${m.lineN}`, x0 + chipW + 3, y + chipH / 2);

  y += chipH + 5;

  // --- Time ---
  if (m.end !== undefined) {
    const rows = [
      { k: "begin", v: fmtNs(m.t), accent: false },
      { k: "end", v: fmtNs(m.end), accent: false },
      { k: "dur", v: fmtNs(m.end - m.t), accent: true },
    ];
    for (const row of rows) {
      ctx.font = "11px ui-sans-serif,system-ui,sans-serif";
      ctx.fillStyle = colors.dim;
      ctx.textAlign = "left";
      ctx.fillText(row.k, x0, y + 7);
      ctx.font = "600 11px ui-sans-serif,system-ui,sans-serif";
      ctx.fillStyle = row.accent ? colors.accent : colors.text;
      ctx.textAlign = "right";
      ctx.fillText(row.v, xR, y + 8);
      y += 16;
    }
  } else {
    ctx.font = "600 11px ui-sans-serif,system-ui,sans-serif";
    ctx.fillStyle = colors.text;
    ctx.textAlign = "left";
    ctx.fillText(fmtNs(m.t), x0, y + 8);
    y += 16;
  }

  // --- Fields ---
  const entries = m.fields ? Object.entries(m.fields) : [];
  if (entries.length > 0) {
    y += 4;
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(xR, y);
    ctx.stroke();
    y += 4;

    const valW = Math.max(60, (xR - x0) * 0.55);
    ctx.font = "11px ui-sans-serif,system-ui,sans-serif";
    for (const [k, fv] of entries) {
      if (y + 16 > top + maxH) break;
      ctx.fillStyle = colors.dim;
      ctx.textAlign = "left";
      ctx.fillText(k, x0, y + 8, xR - x0 - valW - 4);
      ctx.fillStyle = colors.text;
      ctx.textAlign = "right";
      ctx.fillText(fv.raw, xR, y + 8, valW);
      y += 16;
    }
  }

  ctx.restore();
}

/** Inner content of an event card — shared by the hover tooltip and the expanded
 *  lanes' per-point overlay cards (same information either way). */
function EventCardBody({ m, cols }: { m: EventMark; cols?: number }) {
  const fieldEntries = m.fields ? Object.entries(m.fields) : [];
  const c = cols ?? cardCols(m);
  return (
    <>
      <div className="tlc-tip-h">
        <span className="tlc-tip-lane" style={{ background: m.color }}>
          {m.lane}
        </span>{" "}
        L{m.lineN}
      </div>
      {m.end !== undefined ? (
        // Span: stack begin/end/dur as labelled, right-aligned rows so the range
        // and (accent-coloured) duration read at a glance.
        <div className="tlc-tip-span">
          <div className="tlc-tip-srow">
            <span className="tlc-tip-sk">begin</span>
            <span className="tlc-tip-sv">{fmtNs(m.t)}</span>
          </div>
          <div className="tlc-tip-srow">
            <span className="tlc-tip-sk">end</span>
            <span className="tlc-tip-sv">{fmtNs(m.end)}</span>
          </div>
          <div className="tlc-tip-srow dur">
            <span className="tlc-tip-sk">dur</span>
            <span className="tlc-tip-sv">{fmtNs(m.end - m.t)}</span>
          </div>
        </div>
      ) : (
        <div className="tlc-tip-t">{fmtNs(m.t)}</div>
      )}
      {fieldEntries.length > 0 && (
        <div
          className={"tlc-tip-fields" + (c > 1 ? " multi" : "")}
          style={
            c > 1
              ? {
                  gridAutoFlow: "column",
                  gridTemplateRows: `repeat(${Math.ceil(fieldEntries.length / c)}, auto)`,
                  columnGap: 14,
                }
              : undefined
          }
        >
          {fieldEntries.map(([k, v]) => (
            <div className="tlc-tip-field" key={k}>
              <span className="tlc-tip-k">{k}</span>
              <span className="tlc-tip-v">{v.raw}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

interface View {
  offset: number;
  nsPerPx: number;
}

interface Props {
  marks: EventMark[];
  /** Lane draw order (top→bottom). */
  lanes: string[];
  onJump: (lineN: number) => void;
  /** Centered message shown over the (otherwise empty) canvas when there are no events. */
  placeholder?: string;
  /** Height (px) at the canvas bottom currently covered by the overlaying sheet.
   *  Added to the scroll range so lanes behind the sheet can be scrolled into view
   *  — the canvas itself stays full height (no resize/jump when the sheet moves). */
  bottomInset?: number;
  /** Event-marker size (global setting): point radius + span bar half-height. */
  iconSize?: "S" | "M" | "L";
  /** Lane names whose track draws the time delta between consecutive points
   *  (`<-- 1.2 ms -->` annotations along the lane). */
  deltaLanes?: Set<string>;
  /** Lane names whose track is expanded: the lane grows taller and shows a
   *  per-point detail card (same content as the hover card) below each point. */
  expandedLanes?: Set<string>;
  /** Called once on mount with a function that captures the visible plot area
   *  (canvas + DOM overlay cards) as a WebP dataURL — used by the notebook
   *  "snapshot" button. */
  onRegisterCapture?: (capture: () => Promise<string | null>) => void;
}

// Marker geometry per icon-size setting: `r` = point radius (px), `hot` = its
// hovered radius, `span` = span-bar half-height (px).
const ICON_SIZES = {
  S: { r: 2.5, hot: 3.5, span: 3.5 },
  M: { r: 3.5, hot: 4.5, span: 5 },
  L: { r: 5, hot: 6, span: 7 },
} as const;

export function TimelineCanvas({
  marks,
  lanes,
  onJump,
  placeholder,
  bottomInset = 0,
  iconSize = "M",
  deltaLanes,
  expandedLanes,
  onRegisterCapture,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Kept current on every render so the capture closure always sees the latest cards.
  const cardsRef = useRef<CardItem[]>([]);

  // Register a capture fn once so the notebook snapshot button can grab the
  // visible plot area. Composites the canvas onto an offscreen canvas with a
  // solid background (the raw canvas is transparent), then draws the DOM overlay
  // cards (expanded per-point detail cards) directly via canvas 2D API so they
  // appear in the exported image.
  useEffect(() => {
    onRegisterCapture?.(async () => {
      const cv = canvasRef.current;
      if (!cv) return null;
      try {
        const dpr = window.devicePixelRatio || 1;
        const w = cv.clientWidth;
        const h = cv.clientHeight;
        const off = document.createElement("canvas");
        off.width = Math.round(w * dpr);
        off.height = Math.round(h * dpr);
        const ctx = off.getContext("2d")!;

        const cs = getComputedStyle(cv);
        const bg = cs.getPropertyValue("--panel-bg").trim() || "#fbfbfc";
        const border = cs.getPropertyValue("--border").trim() || "#e3e6ea";
        const text = cs.getPropertyValue("--text").trim() || "#1c1f23";
        const dim = cs.getPropertyValue("--text-3").trim() || "#8c929b";
        const accent = "#2c6ce6";

        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, off.width, off.height);
        ctx.drawImage(cv, 0, 0);

        ctx.save();
        ctx.scale(dpr, dpr);
        for (const c of cardsRef.current) {
          drawCardOnCanvas(ctx, c, { bg, border, text, dim, accent });
        }
        ctx.restore();

        return off.toDataURL("image/png");
      } catch {
        return null;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `size` is the scroll VIEWPORT (the wrap's client box); the canvas always fills
  // it and lanes beyond it are reached by vertical scroll, not by shrinking.
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [scrollY, setScrollY] = useState(0);
  const [view, setView] = useState<View | null>(null);
  // Resizable lane-label column width (drag the gutter divider). Persisted so the
  // chosen width survives reloads; clamped to [GUTTER_MIN, GUTTER_MAX].
  const [gutter, setGutter] = useState(() => {
    const v = Number(localStorage.getItem(GUTTER_KEY));
    return Number.isFinite(v) && v >= GUTTER_MIN && v <= GUTTER_MAX
      ? v
      : DEFAULT_GUTTER;
  });
  // Alias so the existing layout/draw code keeps reading `GUTTER`; its value now
  // tracks the resizable state (it's listed in the relevant effect deps).
  const GUTTER = gutter;
  // `x`/`y` are canvas-relative px (for picking); `cx`/`cy` are viewport client
  // coords used to place the portaled tooltip so the wrap's overflow can't clip it.
  const [hover, setHover] = useState<{
    i: number;
    x: number;
    y: number;
    cx: number;
    cy: number;
  } | null>(null);
  // Cursor position (CSS px in canvas) for the full-height hover guide line.
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  // Drag-to-measure band stored in TIME (ns), not screen px, so zooming keeps the
  // swept duration fixed — only the band's on-screen width changes. Persists after
  // release until the next gesture.
  const [measure, setMeasure] = useState<{ t0: number; t1: number } | null>(
    null,
  );
  // The marker last clicked stays highlighted (independent of hover) so it's
  // clear which event the log view jumped to. Keyed by markKey so it survives
  // marks-array re-creation.
  const [active, setActive] = useState<string | null>(null);
  // Points whose detail card the user raised to the front (clicked) in an expanded
  // lane, in CLICK ORDER — last entry is the topmost. Cards overlap; clicking a
  // point brings its card above the others (clicking the current front one drops
  // it). Keyed by markKey so it survives marks-array re-creation.
  const [raised, setRaised] = useState<string[]>([]);
  const pan = useRef<{ x: number; offset: number } | null>(null);
  const measuring = useRef(false);
  // Active gutter-resize drag (grabbed the divider): snapshots the start so the
  // width follows the cursor; committed to localStorage on release.
  const gutterDrag = useRef<{ startX: number; startG: number } | null>(null);
  // Minimap drag state: `mode` is which part of the brush the gesture grabbed
  // (body → pan, left/right edge → zoom that edge), `offset`/`nsPerPx` snapshot
  // the view at grab time so the move is computed from the delta.
  const mmRef = useRef<HTMLCanvasElement>(null);
  const mmDrag = useRef<{
    mode: "pan" | "left" | "right";
    startX: number;
    offset: number;
    nsPerPx: number;
  } | null>(null);

  const laneIndex = useMemo(
    () => new Map(lanes.map((l, i) => [l, i])),
    [lanes],
  );
  // markKey → index into `marks`, so a card (which only carries its mark) can map
  // a hover/click back to the index the hover state and draw loop key off.
  const markIndexByKey = useMemo(() => {
    const m = new Map<string, number>();
    marks.forEach((mk, i) => m.set(markKey(mk), i));
    return m;
  }, [marks]);
  // Per-lane marks sorted by time — built only for lanes that need an ordered
  // view: delta lanes (gap to predecessor) and expanded lanes (left→right card
  // decimation). Skipped entirely when no track enables either.
  const sortedLaneMarks = useMemo(() => {
    const want = new Set<string>();
    deltaLanes?.forEach((l) => want.add(l));
    expandedLanes?.forEach((l) => want.add(l));
    if (!want.size) return null;
    const byLane = new Map<string, EventMark[]>();
    for (const m of marks) {
      if (!want.has(m.lane)) continue;
      const arr = byLane.get(m.lane);
      if (arr) arr.push(m);
      else byLane.set(m.lane, [m]);
    }
    for (const arr of byLane.values()) arr.sort((a, b) => a.t - b.t);
    return byLane;
  }, [marks, deltaLanes, expandedLanes]);
  // The time domain spans the events' [min, max] padded with a margin on each
  // side, so the earliest/latest marks aren't glued to the plot edges and a lone
  // event sits centered. The axis never scrolls past these padded bounds.
  const { domMin, domMax } = useMemo(() => {
    if (!marks.length) return { domMin: 0, domMax: 1 };
    let lo = Infinity,
      hi = -Infinity;
    for (const m of marks) {
      // Include BOTH endpoints regardless of order: a span with end < start
      // would otherwise drive hi below lo, collapsing the domain (domSpan → ~0)
      // and freezing the tick loops on a near-zero step.
      const e = m.end ?? m.t;
      lo = Math.min(lo, m.t, e);
      hi = Math.max(hi, m.t, e);
    }
    const range = hi - lo;
    // 4% of the span on each side; for a zero-width range (single event / all
    // equal) fall back to a magnitude-relative pad so the lone point centers.
    const pad = range > 0 ? range * 0.04 : Math.max(1, Math.abs(hi) * 0.04);
    // Don't pad the left edge below zero for non-negative data: a monotonic
    // clock has no "negative time", and `-1.2 s` ticks left of the first event
    // read as a bug. Data that's genuinely negative (lo < 0) still pads normally.
    const min = lo - pad;
    return { domMin: lo >= 0 ? Math.max(0, min) : min, domMax: hi + pad };
  }, [marks]);
  const domSpan = Math.max(1e-6, domMax - domMin);

  const plotW = Math.max(1, size.w - GUTTER - RIGHT);
  // Card-strip height per expanded lane: tall enough for its biggest card (most
  // fields), so nothing is clipped, clamped to [CARD_MIN_H, CARD_MAX_H]. Stable
  // across zoom/scroll (depends only on the lane's marks), so no layout thrash.
  const laneCardH = useMemo(() => {
    const m = new Map<string, number>();
    if (!expandedLanes?.size) return m;
    for (const lane of expandedLanes) {
      const arr = sortedLaneMarks?.get(lane);
      // A lane with no plotted marks contributes no card strip: expanding an
      // empty track must not open a blank gap below its (also empty) point row.
      if (!arr || arr.length === 0) {
        m.set(lane, 0);
        continue;
      }
      let h = CARD_MIN_H;
      for (const mk of arr) h = Math.max(h, estCardH(mk) + CARD_GAP);
      m.set(lane, Math.min(CARD_MAX_H, h));
    }
    return m;
  }, [expandedLanes, sortedLaneMarks]);
  // Per-lane heights: every lane has a LANE_H point row; an expanded lane adds its
  // card-strip height below. `laneTops[i]` is the lane's top in content coords
  // (before scrollY); the plot grows with the total and scrolls vertically rather
  // than squeezing lanes.
  const { laneTops, totalLaneH } = useMemo(() => {
    const tops: number[] = [];
    let y = AXIS;
    for (const l of lanes) {
      tops.push(y);
      y +=
        LANE_H + (expandedLanes?.has(l) ? (laneCardH.get(l) ?? CARD_MIN_H) : 0);
    }
    return { laneTops: tops, totalLaneH: y - AXIS };
  }, [lanes, expandedLanes, laneCardH]);
  // The point sits in the top LANE_H strip of its lane (so an expanded lane's dot
  // stays put, with the card hanging below). Content coords, before scrollY.
  const pointCy = useCallback(
    (li: number) => laneTops[li] + LANE_H / 2,
    [laneTops],
  );
  const contentH = lanes.length ? AXIS + totalLaneH + PAD : size.h;
  // Extend the scroll range by the sheet-covered height so the bottom lanes can be
  // scrolled up from behind the sheet (only meaningful when there are lanes).
  const spacerH = Math.max(
    0,
    contentH - size.h + (lanes.length ? bottomInset : 0),
  );

  // Clamp a view to the [domMin, domMax] domain: cap zoom-out at "whole domain
  // fills the plot", and keep the visible window inside the domain.
  const clampView = useCallback(
    (v: View): View => {
      const maxNsPerPx = domSpan / plotW;
      const nsPerPx = Math.min(Math.max(v.nsPerPx, 1e-6), maxNsPerPx);
      const maxOffset = Math.max(domMin, domMax - plotW * nsPerPx);
      const offset = Math.min(Math.max(v.offset, domMin), maxOffset);
      return { offset, nsPerPx };
    },
    [plotW, domMin, domMax, domSpan],
  );

  // Track the wrapper's rendered (viewport) size.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Auto-fit the whole [0, domMax] domain — but only when the data range changes
  // (or there's no view yet), NOT when the plot merely resizes. This keeps the
  // zoom/pan state across a height/width resize.
  const lastRange = useRef("");
  useEffect(() => {
    if (plotW <= 1) return;
    const key = `${domMin}:${domMax}`;
    if (view && lastRange.current === key) return;
    lastRange.current = key;
    setView({ offset: domMin, nsPerPx: domSpan / plotW });
  }, [plotW, domMin, domMax, domSpan, view]);

  // On a width change, re-clamp the kept view (idempotent → no refit, no loop).
  // Guard on the ACTUAL plotW so this only fires for width changes: a domMin/
  // domMax change (e.g. timeline data loading in after a reload) is owned by the
  // auto-fit effect above. If this ran on those too it would clamp a now-stale
  // `view` and, being queued after the refit, clobber it — leaving the minimap
  // brush stuck at minimum width on the far left.
  const prevPlotW = useRef(plotW);
  useEffect(() => {
    if (prevPlotW.current === plotW) return;
    prevPlotW.current = plotW;
    if (!view || plotW <= 1) return;
    const c = clampView(view);
    if (c.offset !== view.offset || c.nsPerPx !== view.nsPerPx) setView(c);
  }, [plotW, view, clampView]);

  const xOf = useCallback(
    (t: number, v: View) => GUTTER + (t - v.offset) / v.nsPerPx,
    [GUTTER],
  );
  const tOf = useCallback(
    (x: number, v: View) => v.offset + (x - GUTTER) * v.nsPerPx,
    [GUTTER],
  );
  // Minimap maps the whole [domMin, domMax] domain across the same plot region,
  // so its ticks line up horizontally with the main axis below.
  const mmX = useCallback(
    (t: number) => GUTTER + ((t - domMin) / domSpan) * plotW,
    [GUTTER, domMin, domSpan, plotW],
  );
  const mmT = useCallback(
    (x: number) => domMin + ((x - GUTTER) / plotW) * domSpan,
    [GUTTER, domMin, domSpan, plotW],
  );

  const viewRef = useRef(view);
  viewRef.current = view;
  // Latest cursor + whether the pointer is over the canvas, read by the
  // window-level key handler so WASD works on hover (no click-to-focus needed).
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const hoverRef = useRef(false);

  const pick = useCallback(
    (px: number, py: number): number => {
      if (!view || py < AXIS) return -1;
      // Map y → lane by walking the (variable-height) lane bands, then restrict
      // the hit to the lane's LANE_H point row so a click in an expanded lane's
      // card strip doesn't pick a marker.
      const yc = py + scrollY;
      let lane = -1;
      for (let i = 0; i < laneTops.length; i++) {
        const bot =
          i + 1 < laneTops.length ? laneTops[i + 1] : AXIS + totalLaneH;
        if (yc >= laneTops[i] && yc < bot) {
          lane = i;
          break;
        }
      }
      if (lane < 0 || yc > laneTops[lane] + LANE_H) return -1;
      let best = -1,
        bestD = 7;
      for (let i = 0; i < marks.length; i++) {
        const m = marks[i];
        if (laneIndex.get(m.lane) !== lane) continue;
        const x1 = xOf(m.t, view);
        const x2 = m.end !== undefined ? xOf(m.end, view) : x1;
        const d = px < x1 ? x1 - px : px > x2 ? px - x2 : 0;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    },
    [marks, view, laneIndex, xOf, laneTops, totalLaneH, scrollY],
  );

  // Snap a cursor x to the nearest event edge (a point's t, or a span's t/end)
  // within SNAP_PX, so a measurement locks onto exact event timestamps and the Δ
  // is event-to-event. Beyond the threshold the raw cursor time is kept.
  const SNAP_PX = 7;
  const snapTime = useCallback(
    (px: number, v: View): number => {
      let bestT = tOf(px, v),
        bestD = SNAP_PX;
      for (const m of marks) {
        const edges = m.end !== undefined ? [m.t, m.end] : [m.t];
        for (const t of edges) {
          const d = Math.abs(xOf(t, v) - px);
          if (d < bestD) {
            bestD = d;
            bestT = t;
          }
        }
      }
      return bestT;
    },
    [marks, tOf, xOf],
  );

  // Overlay detail cards for expanded lanes: decimated left→right, but cards are
  // allowed to OVERLAP by up to CARD_OVERLAP of their width (each one reserves only
  // `w*(1-CARD_OVERLAP)+gap`), so the strip packs dense without rendering one node
  // per point (which tanks perf). Each kept card still shows its left edge (header +
  // timestamp); hover focuses one, clicking the dot raises it. A `raised` point is
  // force-shown even when it would be decimated — and it does NOT shift the auto
  // rhythm, so clicking never reshuffles the others. Positioned in viewport coords
  // (the sticky `.tlc-vp`); pointer-events:none — the dot above stays click-to-jump.
  const cards = useMemo(() => {
    if (!view || !expandedLanes?.size || !sortedLaneMarks || size.w <= 0)
      return [];
    const out: {
      m: EventMark;
      left: number;
      top: number;
      w: number;
      maxH: number;
      /** Click-order rank among raised cards (−1 = not raised). Higher = clicked
       *  more recently = stacked on top. */
      rank: number;
      /** px to clip off the card's top — the strip the pinned axis covers when the
       *  card has scrolled partly above it (0 when fully below the axis). */
      clipTop: number;
    }[] = [];
    // markKey → click-order index, so a kept card knows its stacking rank.
    const rankOf = new Map(raised.map((k, i) => [k, i]));
    for (const lane of expandedLanes) {
      const li = laneIndex.get(lane);
      if (li === undefined) continue;
      const top = laneTops[li] + LANE_H - scrollY + 2;
      const maxH = (laneCardH.get(lane) ?? CARD_MIN_H) - CARD_GAP;
      // Cull only when the card's whole band is off-screen — entirely above the
      // pinned axis, or entirely below the viewport. A card scrolled partly under
      // the axis still shows its lower part; we just clip the covered strip (below)
      // so it doesn't paint over the timestamp axis.
      if (top + maxH <= AXIS || top >= size.h) continue;
      const clipTop = Math.max(0, AXIS - top);
      const arr = sortedLaneMarks.get(lane);
      if (!arr) continue;
      let nextFree = -Infinity;
      for (const m of arr) {
        const x = xOf(m.t, view);
        if (x < GUTTER || x > size.w - RIGHT) continue;
        const rank = rankOf.get(markKey(m)) ?? -1;
        const survives = x >= nextFree; // would survive decimation on its own
        if (!survives && rank < 0) continue; // decimated away (and not raised)
        const w = estCardW(m);
        const left = Math.min(
          Math.max(x, GUTTER),
          Math.max(GUTTER, size.w - RIGHT - w),
        );
        out.push({ m, left, top, w, maxH, rank, clipTop });
        // Advance the rhythm only for cards that occupy an auto slot — a raised
        // card shown out-of-rhythm doesn't push the others, so the auto layout is
        // identical with or without it (clicking adds a card, never moves one).
        if (survives) nextFree = x + w * (1 - CARD_OVERLAP) + CARD_GAP;
      }
    }
    return out;
  }, [
    view,
    expandedLanes,
    sortedLaneMarks,
    laneCardH,
    size.w,
    size.h,
    scrollY,
    laneTops,
    laneIndex,
    raised,
    xOf,
    GUTTER,
  ]);
  cardsRef.current = cards;

  // Hit-test the overlay cards (viewport coords): a card counts as part of its
  // point, so hovering/clicking a card behaves like hovering/clicking the dot. The
  // cards keep pointer-events:none (so drag-to-measure over the strip still works);
  // this picks the TOPMOST card under the cursor by the same z the render uses
  // (raised rank > plain), returning the mark's index into `marks` (−1 = none).
  const pickCard = useCallback(
    (px: number, py: number): number => {
      let best = -1,
        bestZ = -Infinity;
      for (const c of cards) {
        if (px < c.left || px > c.left + c.w) continue;
        if (py < c.top + c.clipTop || py > c.top + c.maxH) continue;
        const z = c.rank >= 0 ? 5 + c.rank : 4;
        if (z >= bestZ) {
          bestZ = z;
          best = markIndexByKey.get(markKey(c.m)) ?? best;
        }
      }
      return best;
    },
    [cards, markIndexByKey],
  );

  // --- draw ---
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !view || size.w <= 0 || size.h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = size.w,
      H = size.h;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const cs = getComputedStyle(cv);
    const cText = cs.getPropertyValue("--text").trim() || "#1c1f23";
    const cMuted = cs.getPropertyValue("--text-3").trim() || "#8c929b";
    const cBorder = cs.getPropertyValue("--border").trim() || "#e3e6ea";
    const ACCENT = "#3b82f6";
    ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "middle";

    // The active (clicked) mark drives a persistent "playhead": a full-height
    // accent guide line at its start time + an enlarged, accent-edged marker +
    // a timestamp chip pinned in the ruler. Found once here by stable key.
    const activeMark = active
      ? (marks.find((m) => markKey(m) === active) ?? null)
      : null;

    // Visible plot floor: the viewport bottom, but no lower than the last lane's
    // bottom (in viewport coords, offset by scrollY) so gridlines and bands don't
    // bleed into empty space when the lanes don't fill the viewport.
    const lanesFloor = lanes.length ? AXIS + totalLaneH - scrollY : H - PAD;
    const bottom = Math.min(H - PAD, lanesFloor);

    // Tick positions are shared by the gridlines (in the lane area) and the
    // pinned axis labels below.
    const step = niceStep(view.nsPerPx * 70);
    const t0 = Math.ceil(tOf(GUTTER, view) / step) * step;

    // lane bands + labels — clipped to below the (pinned) axis so scrolled rows
    // never paint over the timestamp strip; offset by scrollY.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, AXIS, W, bottom - AXIS);
    ctx.clip();
    for (let i = 0; i < lanes.length; i++) {
      const yTop = laneTops[i] - scrollY;
      const lh =
        (i + 1 < laneTops.length ? laneTops[i + 1] : AXIS + totalLaneH) -
        laneTops[i];
      if (yTop >= bottom || yTop + lh <= AXIS) continue;
      if (i % 2 === 1) {
        ctx.fillStyle = "rgba(130,140,150,0.07)";
        ctx.fillRect(0, yTop, W, lh);
      }
      ctx.fillStyle = cMuted;
      ctx.textAlign = "left";
      // Fit the full name into the (resizable) gutter: 6px left pad + 6px gap to
      // the divider. A wider gutter therefore shows more of a long track name. The
      // label sits in the point row (top LANE_H), aligned with the lane's dot.
      ctx.fillText(fitText(ctx, lanes[i], GUTTER - 12), 6, yTop + LANE_H / 2);
    }
    ctx.restore();

    // gutter divider + vertical gridlines (full plot height; below the axis)
    ctx.strokeStyle = cBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(GUTTER + 0.5, AXIS);
    ctx.lineTo(GUTTER + 0.5, bottom);
    ctx.stroke();
    ctx.strokeStyle = "rgba(130,140,150,0.18)";
    // `lastX` guards against a step too small to advance x in float (huge
    // timestamps + tiny step): once x stops moving, stop rather than spin forever.
    for (let t = t0, lastX = -Infinity; ; t += step) {
      const x = xOf(t, view);
      if (x > W - RIGHT || x <= lastX) break;
      lastX = x;
      if (x < GUTTER) continue;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, AXIS);
      ctx.lineTo(x + 0.5, bottom);
      ctx.stroke();
    }

    // active marker → persistent playhead guide line (drawn behind the marks so
    // the enlarged marker sits on top of it).
    const activeX = activeMark ? xOf(activeMark.t, view) : null;
    if (activeX !== null && activeX >= GUTTER && activeX <= W - RIGHT) {
      ctx.strokeStyle = "rgba(59,130,246,0.7)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(activeX + 0.5, AXIS);
      ctx.lineTo(activeX + 0.5, bottom);
      ctx.stroke();
    }

    // marks (clipped to plot, offset by scrollY)
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, AXIS, W - GUTTER - RIGHT, bottom - AXIS);
    ctx.clip();
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      const li = laneIndex.get(m.lane);
      if (li === undefined) continue;
      const cy = pointCy(li) - scrollY;
      if (cy < AXIS || cy > bottom) continue;
      const x1 = xOf(m.t, view);
      const hot = hover?.i === i;
      const isActive = active === markKey(m);
      const fill = m.color || "#cdd3da";
      ctx.fillStyle = fill;
      // Active marker: accent edge + a slight enlarge (paired with the playhead
      // line). Hovered: the strong text color. Otherwise a darker shade of the
      // fill so each marker reads as one color.
      ctx.strokeStyle = isActive ? ACCENT : hot ? cText : darken(fill);
      ctx.lineWidth = isActive ? 2 : hot ? 1.5 : 1;
      const sz = ICON_SIZES[iconSize];
      if (m.end !== undefined) {
        const sh = sz.span + (isActive ? 1 : 0);
        const x2 = Math.max(xOf(m.end, view), x1 + 2);
        ctx.beginPath();
        ctx.roundRect(x1, cy - sh, x2 - x1, sh * 2, 3);
        ctx.fill();
        ctx.stroke();
      } else {
        const r = (hot ? sz.hot : sz.r) + (isActive ? 1.5 : 0);
        tracePoint(ctx, m.shape, x1, cy, r);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();

    // delta connectors: a `<-- 1.2 ms -->` annotation spanning the gap between
    // consecutive events on each delta-enabled lane. For points it's begin→begin;
    // for spans it's the previous end → the next begin (the inter-span gap). The
    // label is dropped (line+arrows kept) when the gap is too narrow for the text,
    // and the whole pair is skipped when the endpoints are too close for the
    // arrowheads — zooming in reveals more (the same hide-on-overlap rule).
    if (sortedLaneMarks && deltaLanes?.size) {
      const cPanel = cs.getPropertyValue("--panel-bg").trim() || "#ffffff";
      ctx.save();
      ctx.beginPath();
      ctx.rect(GUTTER, AXIS, W - GUTTER - RIGHT, bottom - AXIS);
      ctx.clip();
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      const inset = ICON_SIZES[iconSize].r + 3;
      const AH = 3; // arrowhead size
      for (const [lane, arr] of sortedLaneMarks) {
        if (!deltaLanes.has(lane)) continue;
        const li = laneIndex.get(lane);
        if (li === undefined) continue;
        const cy = pointCy(li) - scrollY;
        if (cy < AXIS || cy > bottom) continue;
        for (let i = 1; i < arr.length; i++) {
          // Left endpoint = the previous event's END (its begin for a point);
          // right endpoint = this event's BEGIN. So a span lane measures the gap
          // between spans (prev end ↔ next begin), not begin↔begin.
          const prevEnd = arr[i - 1].end ?? arr[i - 1].t;
          const curBegin = arr[i].t;
          const xa = xOf(prevEnd, view);
          const xb = xOf(curBegin, view);
          if (xb < GUTTER || xa > W - RIGHT) continue; // wholly offscreen
          const Lx = xa + inset,
            Rx = xb - inset;
          const gap = Rx - Lx;
          if (gap < 1.5) continue; // dots effectively touching — nothing to draw
          // One shared centerline (the +0.5 the 1px line wants) for the line AND
          // the arrowheads, so the triangles sit dead-centre on the connector
          // instead of riding half a pixel high.
          const y = Math.round(cy) + 0.5;
          ctx.strokeStyle = ctx.fillStyle = cMuted;
          ctx.lineWidth = 1;
          // Arrowheads only once there's room for both; below that the gap still
          // gets a plain connecting line (shrinking smoothly as points close in)
          // rather than vanishing — so a tight cluster never looks like a bug.
          const heads = gap >= 2 * AH + 2;
          // line spans between the arrowhead bases when they're drawn (no tail
          // through the apex), else the full gap → a clean `<——>` dimension line.
          ctx.beginPath();
          ctx.moveTo(heads ? Lx + AH : Lx, y);
          ctx.lineTo(heads ? Rx - AH : Rx, y);
          ctx.stroke();
          if (heads) {
            // arrowheads pointing outward (toward the two points)
            ctx.beginPath();
            ctx.moveTo(Lx, y);
            ctx.lineTo(Lx + AH, y - AH);
            ctx.lineTo(Lx + AH, y + AH);
            ctx.closePath();
            ctx.moveTo(Rx, y);
            ctx.lineTo(Rx - AH, y - AH);
            ctx.lineTo(Rx - AH, y + AH);
            ctx.closePath();
            ctx.fill();
          }
          // label centered, on a panel-bg chip that masks the line behind it
          const label = fmtNs(curBegin - prevEnd);
          const tw = ctx.measureText(label).width;
          if (gap >= tw + 10) {
            const mx = (Lx + Rx) / 2;
            ctx.fillStyle = cPanel;
            ctx.fillRect(mx - tw / 2 - 3, y - 6, tw + 6, 12);
            ctx.fillStyle = cMuted;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(label, mx, y);
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
          }
        }
      }
      ctx.restore();
    }

    // measure band (drawn over the marks). Edges come from TIME, so the band
    // tracks the data through zoom/pan and Δ stays constant; only its on-screen
    // position/width changes. Clamped to the plot for drawing.
    if (measure) {
      const xa = xOf(measure.t0, view),
        xb = xOf(measure.t1, view);
      const lo = Math.min(xa, xb),
        hi = Math.max(xa, xb);
      const cl = Math.max(lo, GUTTER),
        cr = Math.min(hi, W - RIGHT);
      if (cr > cl) {
        ctx.fillStyle = "rgba(59,130,246,0.12)";
        ctx.fillRect(cl, AXIS, cr - cl, bottom - AXIS);
        ctx.strokeStyle = "rgba(59,130,246,0.55)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (lo >= GUTTER && lo <= W - RIGHT) {
          ctx.moveTo(lo + 0.5, AXIS);
          ctx.lineTo(lo + 0.5, bottom);
        }
        if (hi >= GUTTER && hi <= W - RIGHT) {
          ctx.moveTo(hi + 0.5, AXIS);
          ctx.lineTo(hi + 0.5, bottom);
        }
        ctx.stroke();
        // Δ readout centered above the visible band
        const dt = Math.abs(measure.t1 - measure.t0);
        const label = fmtNs(dt);
        ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
        const tw = ctx.measureText(label).width;
        const cx = Math.min(
          Math.max((cl + cr) / 2, GUTTER + tw / 2 + 4),
          W - RIGHT - tw / 2 - 4,
        );
        ctx.fillStyle = "rgba(59,130,246,0.92)";
        ctx.fillRect(cx - tw / 2 - 4, AXIS + 2, tw + 8, 14);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, cx, AXIS + 9);
        ctx.textBaseline = "middle";
      }
    }

    // full-height hover guide line (over the lanes) + the cursor timestamp.
    if (
      cursor &&
      cursor.x > GUTTER &&
      cursor.x <= W - RIGHT &&
      cursor.y >= AXIS
    ) {
      ctx.strokeStyle = "rgba(59,130,246,0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cursor.x + 0.5, AXIS);
      ctx.lineTo(cursor.x + 0.5, bottom);
      ctx.stroke();
    }

    // --- pinned top axis strip (drawn last so nothing scrolls over it) ---
    ctx.clearRect(0, 0, W, AXIS);
    ctx.strokeStyle = cBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(GUTTER, AXIS + 0.5);
    ctx.lineTo(W - RIGHT, AXIS + 0.5);
    ctx.stroke();
    ctx.fillStyle = cMuted;
    ctx.textAlign = "center";
    for (let t = t0, lastX = -Infinity; ; t += step) {
      const x = xOf(t, view);
      if (x > W - RIGHT || x <= lastX) break;
      lastX = x;
      if (x < GUTTER) continue;
      ctx.fillText(fmtNs(t), x, AXIS / 2);
    }
    // cursor timestamp, shown in the axis strip above the guide line
    if (
      cursor &&
      cursor.x > GUTTER &&
      cursor.x <= W - RIGHT &&
      cursor.y >= AXIS
    ) {
      const label = fmtNs(tOf(cursor.x, view));
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      const tw = ctx.measureText(label).width;
      const cx = Math.min(
        Math.max(cursor.x, GUTTER + tw / 2 + 4),
        W - RIGHT - tw / 2 - 4,
      );
      ctx.fillStyle = "rgba(59,130,246,0.92)";
      ctx.fillRect(cx - tw / 2 - 4, 1, tw + 8, AXIS - 3);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx, (AXIS - 1) / 2);
      ctx.textAlign = "left";
    }
    // active marker → persistent timestamp chip + a caret dropping onto the
    // playhead line, so the selected event stays labelled while scrolling/panning.
    if (
      activeX !== null &&
      activeMark &&
      activeX >= GUTTER &&
      activeX <= W - RIGHT
    ) {
      const label = fmtNs(activeMark.t);
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      const tw = ctx.measureText(label).width;
      const cx = Math.min(
        Math.max(activeX, GUTTER + tw / 2 + 4),
        W - RIGHT - tw / 2 - 4,
      );
      ctx.fillStyle = ACCENT;
      ctx.fillRect(cx - tw / 2 - 4, 1, tw + 8, AXIS - 3);
      ctx.beginPath();
      ctx.moveTo(activeX - 4, AXIS - 0.5);
      ctx.lineTo(activeX + 4, AXIS - 0.5);
      ctx.lineTo(activeX, AXIS + 3.5);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx, (AXIS - 1) / 2);
      ctx.textAlign = "left";
    }
  }, [
    view,
    size.w,
    size.h,
    scrollY,
    marks,
    lanes,
    laneIndex,
    laneTops,
    totalLaneH,
    pointCy,
    hover,
    active,
    cursor,
    measure,
    iconSize,
    xOf,
    tOf,
    GUTTER,
    deltaLanes,
    sortedLaneMarks,
  ]);

  // --- minimap draw ---
  useEffect(() => {
    const cv = mmRef.current;
    if (!cv || !view || size.w <= 0 || marks.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = size.w,
      H = MM_H;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const cs = getComputedStyle(cv);
    const cBorder = cs.getPropertyValue("--border").trim() || "#e3e6ea";

    // "overview" gutter divider, mirroring the main canvas gutter.
    ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.strokeStyle = cBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(GUTTER + 0.5, 0);
    ctx.lineTo(GUTTER + 0.5, H);
    ctx.stroke();

    // every mark, compressed onto the full domain (points → ticks, spans → bars).
    const top = 4,
      bot = H - 4;
    for (const m of marks) {
      const x1 = mmX(m.t);
      ctx.strokeStyle = ctx.fillStyle = m.color || "#cdd3da";
      if (m.end !== undefined) {
        const x2 = Math.max(mmX(m.end), x1 + 1);
        ctx.globalAlpha = 0.6;
        ctx.fillRect(x1, top, x2 - x1, bot - top);
        ctx.globalAlpha = 1;
      } else {
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x1 + 0.5, top);
        ctx.lineTo(x1 + 0.5, bot);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // brush = the visible window; dim the domain outside it.
    const bx0 = Math.max(GUTTER, mmX(view.offset));
    const bx1 = Math.min(W - RIGHT, mmX(view.offset + plotW * view.nsPerPx));
    ctx.fillStyle = "rgba(120, 130, 140, 0.05)";
    if (bx0 > GUTTER) ctx.fillRect(GUTTER, 0, bx0 - GUTTER, H);
    if (bx1 < W - RIGHT) ctx.fillRect(bx1, 0, W - RIGHT - bx1, H);
    ctx.fillStyle = "rgba(59,130,246,0)";
    ctx.fillRect(bx0, 0, Math.max(1, bx1 - bx0), H);
    ctx.strokeStyle = "rgba(59,130,246,0.7)";
    ctx.lineWidth = 1;
    ctx.strokeRect(bx0 + 0.5, 0.5, Math.max(1, bx1 - bx0) - 1, H - 1);
    // edge handles
    ctx.fillStyle = "rgba(59,130,246,0.7)";
    ctx.fillRect(bx0, H / 2 - 5, 2, 10);
    ctx.fillRect(bx1 - 2, H / 2 - 5, 2, 10);
  }, [view, size.w, marks, domSpan, plotW, mmX, GUTTER]);

  // --- minimap interaction ---
  const onMmDown = (e: React.PointerEvent) => {
    if (!view) return;
    const rect = mmRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    mmRef.current!.setPointerCapture(e.pointerId);
    const span = plotW * view.nsPerPx;
    const x0 = mmX(view.offset),
      x1 = mmX(view.offset + span);
    let offset = view.offset;
    // Click outside the brush → recenter it on the cursor first, then pan.
    if (px < x0 - MM_EDGE || px > x1 + MM_EDGE) {
      const v = clampView({
        offset: mmT(px) - span / 2,
        nsPerPx: view.nsPerPx,
      });
      setView(v);
      offset = v.offset;
      mmDrag.current = { mode: "pan", startX: px, offset, nsPerPx: v.nsPerPx };
      return;
    }
    const mode =
      Math.abs(px - x0) <= MM_EDGE
        ? "left"
        : Math.abs(px - x1) <= MM_EDGE
          ? "right"
          : "pan";
    mmDrag.current = { mode, startX: px, offset, nsPerPx: view.nsPerPx };
  };
  const onMmMove = (e: React.PointerEvent) => {
    const cv = mmRef.current!;
    const rect = cv.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const d = mmDrag.current;
    if (!d) {
      // hover cursor hint when not dragging (no re-render)
      const v = viewRef.current;
      if (v) {
        const x0 = mmX(v.offset),
          x1 = mmX(v.offset + plotW * v.nsPerPx);
        cv.style.cursor =
          Math.abs(px - x0) <= MM_EDGE || Math.abs(px - x1) <= MM_EDGE
            ? "ew-resize"
            : px >= x0 && px <= x1
              ? "grab"
              : "pointer";
      }
      return;
    }
    const nsPerMmPx = domSpan / plotW;
    if (d.mode === "pan") {
      setView(
        clampView({
          offset: d.offset + (px - d.startX) * nsPerMmPx,
          nsPerPx: d.nsPerPx,
        }),
      );
    } else {
      const startT = d.offset,
        endT = d.offset + plotW * d.nsPerPx,
        tAt = mmT(px);
      const eps = plotW * 1e-3; // keep the window from collapsing to zero width
      if (d.mode === "left") {
        const newStart = Math.min(tAt, endT - eps);
        setView(
          clampView({ offset: newStart, nsPerPx: (endT - newStart) / plotW }),
        );
      } else {
        const newEnd = Math.max(tAt, startT + eps);
        setView(
          clampView({ offset: startT, nsPerPx: (newEnd - startT) / plotW }),
        );
      }
    }
  };
  const onMmUp = () => {
    mmDrag.current = null;
  };

  // --- interaction ---
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    // Plain wheel scrolls the lanes vertically (native, via the scroll wrap);
    // Ctrl/⌘+wheel zooms the time axis, cursor-anchored.
    const onWheel = (e: WheelEvent) => {
      const v = viewRef.current;
      if (!v) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = cv.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const tAt = tOf(px, v);
      const nsPerPx = Math.max(1e-3, v.nsPerPx * Math.exp(e.deltaY * 0.0015));
      setView(clampView({ offset: tAt - (px - GUTTER) * nsPerPx, nsPerPx }));
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [tOf, clampView, GUTTER]);

  // Pan on shift-drag or dragging the top axis strip; plain body drag measures.
  const onDown = (e: React.PointerEvent) => {
    if (!view) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left,
      py = e.clientY - rect.top;
    (e.target as Element).setPointerCapture(e.pointerId);
    // Grab the gutter divider (anywhere down its height) → resize the lane-label
    // column instead of measuring/panning.
    if (Math.abs(px - GUTTER) <= GUTTER_EDGE) {
      gutterDrag.current = { startX: e.clientX, startG: GUTTER };
      return;
    }
    if (e.shiftKey || py < AXIS) {
      pan.current = { x: e.clientX, offset: view.offset };
    } else {
      measuring.current = true;
      const t = snapTime(px, view);
      setMeasure({ t0: t, t1: t });
      setHover(null);
    }
  };
  const onMove = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left,
      py = e.clientY - rect.top;
    if (gutterDrag.current) {
      setGutter(Math.min(GUTTER_MAX, Math.max(GUTTER_MIN, Math.round(px))));
      setCursor({ x: px, y: py });
      return;
    }
    if (pan.current && view) {
      setView(
        clampView({
          ...view,
          offset:
            pan.current.offset - (e.clientX - pan.current.x) * view.nsPerPx,
        }),
      );
      setCursor({ x: px, y: py });
      return;
    }
    setCursor({ x: px, y: py });
    if (measuring.current) {
      const v = viewRef.current;
      if (v) {
        const t = snapTime(px, v);
        setMeasure((m) => (m ? { t0: m.t0, t1: t } : { t0: t, t1: t }));
      }
      return;
    }
    // Dot row first; if the cursor isn't on a dot, fall back to its expanded card
    // (so hovering a card highlights its point + focuses the card).
    let i = pick(px, py);
    if (i < 0) i = pickCard(px, py);
    setHover(i >= 0 ? { i, x: px, y: py, cx: e.clientX, cy: e.clientY } : null);
  };
  const onUp = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left,
      py = e.clientY - rect.top;
    if (gutterDrag.current) {
      gutterDrag.current = null;
      localStorage.setItem(GUTTER_KEY, String(GUTTER));
      return;
    }
    if (pan.current) {
      pan.current = null;
      return;
    }
    if (measuring.current) {
      measuring.current = false;
      const v = viewRef.current;
      const moved =
        measure && v ? Math.abs(xOf(measure.t1, v) - xOf(measure.t0, v)) : 0;
      if (moved < 3) {
        // a click, not a drag → clear the band and jump to the mark under it;
        // a click on empty space clears the active highlight.
        setMeasure(null);
        // A click on a dot OR on its expanded card jumps/raises that mark.
        let i = pick(px, py);
        if (i < 0) i = pickCard(px, py);
        if (i >= 0) {
          const m = marks[i];
          setActive(markKey(m));
          onJump(m.lineN);
          // On an expanded lane, bring this point's card to the FRONT (append =
          // topmost). Clicking the card that's already frontmost drops it back; any
          // other click just re-orders it above the rest.
          if (expandedLanes?.has(m.lane)) {
            const k = markKey(m);
            setRaised((p) => {
              const without = p.filter((x) => x !== k);
              return p.length && p[p.length - 1] === k
                ? without
                : [...without, k];
            });
          }
        } else setActive(null);
      }
      // a real drag keeps the band shown for reading the duration
    }
  };
  const onLeave = () => {
    hoverRef.current = false;
    setCursor(null);
    if (!measuring.current) setHover(null);
  };
  const fit = () => {
    lastRange.current = "";
    setView(null);
    setRaised([]); // dropping back to the overview clears any raised cards
  };

  // Clear the active marker when a pointer-down lands anywhere outside this
  // canvas (e.g. in the log view) — clicks on the canvas itself are handled by
  // onUp (which sets/keeps/clears active based on what's under the cursor).
  useEffect(() => {
    if (!active) return;
    const onDocDown = (e: PointerEvent) => {
      if (e.target !== canvasRef.current) setActive(null);
    };
    window.addEventListener("pointerdown", onDocDown);
    return () => window.removeEventListener("pointerdown", onDocDown);
  }, [active]);

  // Keyboard nav works while the cursor is OVER the canvas — no click-to-focus
  // needed. A/D pan left/right, W/S zoom in/out (anchored at the cursor, else the
  // plot center). Skipped while an editable element is focused so it never hijacks
  // typing elsewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hoverRef.current) return;
      const ae = document.activeElement as HTMLElement | null;
      if (
        ae &&
        (ae.tagName === "INPUT" ||
          ae.tagName === "TEXTAREA" ||
          ae.isContentEditable)
      )
        return;
      const v = viewRef.current;
      if (!v) return;
      const k = e.key.toLowerCase();
      if (k === "a" || k === "d") {
        const step = plotW * 0.15 * v.nsPerPx;
        setView(
          clampView({ ...v, offset: v.offset + (k === "a" ? -step : step) }),
        );
      } else if (k === "w" || k === "s") {
        const c = cursorRef.current;
        const px = c ? c.x : GUTTER + plotW / 2;
        const tAt = tOf(px, v);
        const nsPerPx = v.nsPerPx * (k === "w" ? 1 / 1.2 : 1.2);
        setView(clampView({ offset: tAt - (px - GUTTER) * nsPerPx, nsPerPx }));
      } else {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [plotW, tOf, clampView, GUTTER]);

  const hm = hover ? marks[hover.i] : null;
  const hoverKey = hm ? markKey(hm) : null;
  // Keys of the points that currently show a card in an expanded lane (auto or
  // pinned). Hovering one of these focuses its card (thicker border) instead of
  // popping a duplicate floating tooltip; a hovered point WITHOUT a card (it was
  // decimated away, or its lane isn't expanded) still gets the floating card.
  const shownKeys = new Set(cards.map((c) => markKey(c.m)));
  const hoverHasCard = hoverKey !== null && shownKeys.has(hoverKey);
  // Column count drives the hover card's width + flip math; the body itself flows
  // the fields column-major (see EventCardBody).
  const fieldCols = hm ? cardCols(hm) : 1;
  return (
    <div className="tlc-outer">
      <div className="tlc-mm">
        {marks.length > 0 && (
          <canvas
            ref={mmRef}
            style={{ width: size.w || "100%", height: MM_H }}
            onPointerDown={onMmDown}
            onPointerMove={onMmMove}
            onPointerUp={onMmUp}
          />
        )}
      </div>
      {/* Scroll wrap: lanes scroll vertically here; the canvas (+ its overlay
        controls) is sticky so the axis/buttons stay pinned, and a spacer below
        creates the scroll range. */}
      <div
        className="tlc-wrap scroll"
        ref={wrapRef}
        onScroll={(e) =>
          setScrollY((e.currentTarget as HTMLDivElement).scrollTop)
        }
      >
        <div className="tlc-vp" ref={vpRef}>
          <canvas
            ref={canvasRef}
            style={{
              outline: "none",
              cursor: gutterDrag.current
                ? "col-resize"
                : pan.current
                  ? "grabbing"
                  : !measuring.current &&
                      cursor &&
                      Math.abs(cursor.x - GUTTER) <= GUTTER_EDGE
                    ? "col-resize"
                    : hover
                      ? "pointer"
                      : "crosshair",
            }}
            onPointerEnter={() => {
              hoverRef.current = true;
            }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={onLeave}
          />
          <button className="tlc-fit" title="Fit all events" onClick={fit}>
            fit
          </button>
          {measure && (
            <button
              className="tlc-clear"
              title="Clear measurement"
              onClick={() => setMeasure(null)}
            >
              clear Δ
            </button>
          )}
          {placeholder && marks.length === 0 && (
            <div className="tlc-empty">{placeholder}</div>
          )}
          {/* Expanded lanes' per-point detail cards — one per in-view point, freely
              overlapping (pointer-events:none so the dot above stays click-to-jump
              and drag-to-measure still works over the card strip). Hovering a point
              focuses its card; clicking the dot raises it above the rest. */}
          {cards.map((c) => {
            const key = markKey(c.m);
            const isHot = key === hoverKey;
            // The clicked mark — its dot wears the accent (blue) playhead on the
            // canvas, so its card wears the matching accent frame (see active class).
            const isActive = key === active;
            return (
              <div
                key={key}
                className={
                  "tlc-tip tlc-card" +
                  (c.rank >= 0 ? " tlc-card-raised" : "") +
                  (isActive ? " tlc-card-active" : "") +
                  (isHot ? " tlc-card-hot" : "")
                }
                style={{
                  left: c.left,
                  top: c.top,
                  maxWidth: c.w,
                  maxHeight: c.maxH,
                  overflow: "hidden",
                  // Hovered tops the pile, then the active (selected) card, then
                  // raised cards by click order (later = higher), then plain cards.
                  zIndex: isHot
                    ? 1000
                    : isActive
                      ? 900
                      : c.rank >= 0
                        ? 5 + c.rank
                        : undefined,
                  clipPath: c.clipTop
                    ? `inset(${c.clipTop}px 0 0 0)`
                    : undefined,
                }}
              >
                <EventCardBody m={c.m} />
              </div>
            );
          })}
        </div>
        <div className="tlc-spacer" style={{ height: spacerH }} />
      </div>
      {/* Tooltip is portaled to <body> with fixed positioning so the wrap's
        `overflow` can't clip a tall card; it flips up/left near edges. */}
      {hm &&
        hover &&
        !hoverHasCard &&
        createPortal(
          (() => {
            const flipUp = hover.cy > window.innerHeight / 2;
            // Card width grows with the column count so multi-column cards still
            // flip clear of the right edge.
            const cardW = fieldCols > 1 ? fieldCols * 190 : 240;
            const flipLeft = hover.cx > window.innerWidth - (cardW + 12);
            const pos: React.CSSProperties = {
              position: "fixed",
              zIndex: 1000,
              maxWidth: cardW,
              maxHeight: "60vh",
              overflow: "hidden",
              left: flipLeft ? undefined : hover.cx + 14,
              right: flipLeft ? window.innerWidth - hover.cx + 14 : undefined,
              top: flipUp ? undefined : hover.cy + 14,
              bottom: flipUp ? window.innerHeight - hover.cy + 14 : undefined,
            };
            return (
              <div className="tlc-tip" style={pos}>
                <EventCardBody m={hm} />
              </div>
            );
          })(),
          document.body,
        )}
    </div>
  );
}
