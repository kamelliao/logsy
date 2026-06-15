import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import type { EventMark, EventShape } from "../types";

// Layout constants (CSS px).
const GUTTER = 76;   // left lane-label column
const RIGHT = 12;
const AXIS = 18;     // top axis strip (timestamps) — pinned, never scrolls
const PAD = 6;       // gap below the last lane
// Each lane is a fixed height: adding tracks grows the plot (and scrolls it
// vertically past the viewport) rather than squeezing every lane thinner, so
// many tracks stay readable at a glance regardless of the panel's height.
const LANE_H = 28;

// Minimap (overview strip above the main canvas): fixed height; a draggable
// brush shows the visible window over the whole [0, maxT] domain. Only shown
// once there are events to overview.
const MM_H = 30;     // minimap strip height (CSS px)
const MM_EDGE = 5;   // px around a brush edge that grabs it to resize (zoom)

/** Format a ns instant/duration with an adaptive unit. */
function fmtNs(ns: number): string {
  const a = Math.abs(ns);
  const trim = (n: number) => n.toFixed(a >= 1e6 ? 3 : 2).replace(/\.?0+$/, "");
  if (a >= 1e9) return trim(ns / 1e9) + " s";
  if (a >= 1e6) return trim(ns / 1e6) + " ms";
  if (a >= 1e3) return trim(ns / 1e3) + " µs";
  return Math.round(ns) + " ns";
}

/** A "nice" step ≥ a raw step (1/2/5 × 10ⁿ). */
function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/** Trace a point marker of the given shape, centered at (x, y). */
function tracePoint(ctx: CanvasRenderingContext2D, shape: EventShape | undefined, x: number, y: number, r: number) {
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

interface View { offset: number; nsPerPx: number }

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
}

// Marker geometry per icon-size setting: `r` = point radius (px), `hot` = its
// hovered radius, `span` = span-bar half-height (px).
const ICON_SIZES = {
  S: { r: 2.5, hot: 3.5, span: 3.5 },
  M: { r: 3.5, hot: 4.5, span: 5 },
  L: { r: 5, hot: 6, span: 7 },
} as const;

export function TimelineCanvas({ marks, lanes, onJump, placeholder, bottomInset = 0, iconSize = "M" }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // `size` is the scroll VIEWPORT (the wrap's client box); the canvas always fills
  // it and lanes beyond it are reached by vertical scroll, not by shrinking.
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [scrollY, setScrollY] = useState(0);
  const [view, setView] = useState<View | null>(null);
  // `x`/`y` are canvas-relative px (for picking); `cx`/`cy` are viewport client
  // coords used to place the portaled tooltip so the wrap's overflow can't clip it.
  const [hover, setHover] = useState<{ i: number; x: number; y: number; cx: number; cy: number } | null>(null);
  // Cursor position (CSS px in canvas) for the full-height hover guide line.
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  // Drag-to-measure band stored in TIME (ns), not screen px, so zooming keeps the
  // swept duration fixed — only the band's on-screen width changes. Persists after
  // release until the next gesture.
  const [measure, setMeasure] = useState<{ t0: number; t1: number } | null>(null);
  const pan = useRef<{ x: number; offset: number } | null>(null);
  const measuring = useRef(false);
  // Minimap drag state: `mode` is which part of the brush the gesture grabbed
  // (body → pan, left/right edge → zoom that edge), `offset`/`nsPerPx` snapshot
  // the view at grab time so the move is computed from the delta.
  const mmRef = useRef<HTMLCanvasElement>(null);
  const mmDrag = useRef<{ mode: "pan" | "left" | "right"; startX: number; offset: number; nsPerPx: number } | null>(null);

  const laneIndex = useMemo(() => new Map(lanes.map((l, i) => [l, i])), [lanes]);
  // The time domain is fixed to [0, maxT]: the axis never scrolls left of 0 nor
  // right of the largest timestamp among the added lines.
  const maxT = useMemo(() => {
    let hi = -Infinity;
    for (const m of marks) hi = Math.max(hi, m.end ?? m.t);
    return marks.length ? hi : 1;
  }, [marks]);
  const domMax = Math.max(1, maxT);

  const plotW = Math.max(1, size.w - GUTTER - RIGHT);
  // Fixed lane height: the plot grows with the track count and scrolls vertically
  // past the viewport instead of scaling each lane to the panel height.
  const laneH = LANE_H;
  const contentH = lanes.length ? AXIS + lanes.length * laneH + PAD : size.h;
  // Extend the scroll range by the sheet-covered height so the bottom lanes can be
  // scrolled up from behind the sheet (only meaningful when there are lanes).
  const spacerH = Math.max(0, contentH - size.h + (lanes.length ? bottomInset : 0));

  // Clamp a view to the [0, domMax] domain: cap zoom-out at "whole domain fills
  // the plot", and keep the visible window inside the domain.
  const clampView = useCallback((v: View): View => {
    const maxNsPerPx = domMax / plotW;
    const nsPerPx = Math.min(Math.max(v.nsPerPx, 1e-6), maxNsPerPx);
    const maxOffset = Math.max(0, domMax - plotW * nsPerPx);
    const offset = Math.min(Math.max(v.offset, 0), maxOffset);
    return { offset, nsPerPx };
  }, [plotW, domMax]);

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
    const key = `${domMax}`;
    if (view && lastRange.current === key) return;
    lastRange.current = key;
    setView({ offset: 0, nsPerPx: domMax / plotW });
  }, [plotW, domMax, view]);

  // On a width change, re-clamp the kept view (idempotent → no refit, no loop).
  useEffect(() => {
    if (!view || plotW <= 1) return;
    const c = clampView(view);
    if (c.offset !== view.offset || c.nsPerPx !== view.nsPerPx) setView(c);
  }, [plotW, domMax, view, clampView]);

  const xOf = useCallback((t: number, v: View) => GUTTER + (t - v.offset) / v.nsPerPx, []);
  const tOf = useCallback((x: number, v: View) => v.offset + (x - GUTTER) * v.nsPerPx, []);
  // Minimap maps the whole [0, domMax] domain across the same plot region, so its
  // ticks line up horizontally with the main axis below.
  const mmX = useCallback((t: number) => GUTTER + (t / domMax) * plotW, [domMax, plotW]);
  const mmT = useCallback((x: number) => ((x - GUTTER) / plotW) * domMax, [domMax, plotW]);

  const viewRef = useRef(view);
  viewRef.current = view;
  // Latest cursor + whether the pointer is over the canvas, read by the
  // window-level key handler so WASD works on hover (no click-to-focus needed).
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const hoverRef = useRef(false);

  const pick = useCallback((px: number, py: number): number => {
    if (!view || py < AXIS) return -1;
    const lane = Math.floor((py - AXIS + scrollY) / laneH);
    let best = -1, bestD = 7;
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      if (laneIndex.get(m.lane) !== lane) continue;
      const x1 = xOf(m.t, view);
      const x2 = m.end !== undefined ? xOf(m.end, view) : x1;
      const d = px < x1 ? x1 - px : px > x2 ? px - x2 : 0;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }, [marks, view, laneIndex, xOf, laneH, scrollY]);

  // Snap a cursor x to the nearest event edge (a point's t, or a span's t/end)
  // within SNAP_PX, so a measurement locks onto exact event timestamps and the Δ
  // is event-to-event. Beyond the threshold the raw cursor time is kept.
  const SNAP_PX = 7;
  const snapTime = useCallback((px: number, v: View): number => {
    let bestT = tOf(px, v), bestD = SNAP_PX;
    for (const m of marks) {
      const edges = m.end !== undefined ? [m.t, m.end] : [m.t];
      for (const t of edges) {
        const d = Math.abs(xOf(t, v) - px);
        if (d < bestD) { bestD = d; bestT = t; }
      }
    }
    return bestT;
  }, [marks, tOf, xOf]);

  // --- draw ---
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !view || size.w <= 0 || size.h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = size.w, H = size.h;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const cs = getComputedStyle(cv);
    const cText = cs.getPropertyValue("--text").trim() || "#1c1f23";
    const cMuted = cs.getPropertyValue("--text-3").trim() || "#8c929b";
    const cBorder = cs.getPropertyValue("--border").trim() || "#e3e6ea";
    ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "middle";

    // Visible plot floor: the viewport bottom, but no lower than the last lane's
    // bottom (in viewport coords, offset by scrollY) so gridlines and bands don't
    // bleed into empty space when the lanes don't fill the viewport.
    const lanesFloor = lanes.length ? AXIS + lanes.length * laneH - scrollY : H - PAD;
    const bottom = Math.min(H - PAD, lanesFloor);

    // Tick positions are shared by the gridlines (in the lane area) and the
    // pinned axis labels below.
    const step = niceStep(view.nsPerPx * 70);
    const t0 = Math.ceil(tOf(GUTTER, view) / step) * step;

    // lane bands + labels — clipped to below the (pinned) axis so scrolled rows
    // never paint over the timestamp strip; offset by scrollY.
    ctx.save();
    ctx.beginPath(); ctx.rect(0, AXIS, W, bottom - AXIS); ctx.clip();
    for (let i = 0; i < lanes.length; i++) {
      const yTop = AXIS + i * laneH - scrollY;
      if (yTop >= bottom || yTop + laneH <= AXIS) continue;
      if (i % 2 === 1) { ctx.fillStyle = "rgba(130,140,150,0.07)"; ctx.fillRect(0, yTop, W, laneH); }
      ctx.fillStyle = cMuted; ctx.textAlign = "left";
      const name = lanes[i].length > 11 ? lanes[i].slice(0, 10) + "…" : lanes[i];
      ctx.fillText(name, 6, yTop + laneH / 2);
    }
    ctx.restore();

    // gutter divider + vertical gridlines (full plot height; below the axis)
    ctx.strokeStyle = cBorder; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(GUTTER + 0.5, AXIS); ctx.lineTo(GUTTER + 0.5, bottom); ctx.stroke();
    ctx.strokeStyle = "rgba(130,140,150,0.18)";
    for (let t = t0; ; t += step) {
      const x = xOf(t, view);
      if (x > W - RIGHT) break;
      if (x < GUTTER) continue;
      ctx.beginPath(); ctx.moveTo(x + 0.5, AXIS); ctx.lineTo(x + 0.5, bottom); ctx.stroke();
    }

    // marks (clipped to plot, offset by scrollY)
    ctx.save();
    ctx.beginPath(); ctx.rect(GUTTER, AXIS, W - GUTTER - RIGHT, bottom - AXIS); ctx.clip();
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      const li = laneIndex.get(m.lane);
      if (li === undefined) continue;
      const cy = AXIS + li * laneH + laneH / 2 - scrollY;
      if (cy < AXIS || cy > bottom) continue;
      const x1 = xOf(m.t, view);
      const hot = hover?.i === i;
      ctx.fillStyle = m.color || "#cdd3da";
      ctx.strokeStyle = hot ? cText : "rgba(0,0,0,0.28)";
      ctx.lineWidth = hot ? 1.5 : 1;
      if (m.end !== undefined) {
        const sh = ICON_SIZES[iconSize].span;
        const x2 = Math.max(xOf(m.end, view), x1 + 2);
        ctx.beginPath(); ctx.roundRect(x1, cy - sh, x2 - x1, sh * 2, 3); ctx.fill(); ctx.stroke();
      } else {
        const sz = ICON_SIZES[iconSize];
        tracePoint(ctx, m.shape, x1, cy, hot ? sz.hot : sz.r);
        ctx.fill(); ctx.stroke();
      }
    }
    ctx.restore();

    // measure band (drawn over the marks). Edges come from TIME, so the band
    // tracks the data through zoom/pan and Δ stays constant; only its on-screen
    // position/width changes. Clamped to the plot for drawing.
    if (measure) {
      const xa = xOf(measure.t0, view), xb = xOf(measure.t1, view);
      const lo = Math.min(xa, xb), hi = Math.max(xa, xb);
      const cl = Math.max(lo, GUTTER), cr = Math.min(hi, W - RIGHT);
      if (cr > cl) {
        ctx.fillStyle = "rgba(59,130,246,0.12)";
        ctx.fillRect(cl, AXIS, cr - cl, bottom - AXIS);
        ctx.strokeStyle = "rgba(59,130,246,0.55)"; ctx.lineWidth = 1;
        ctx.beginPath();
        if (lo >= GUTTER && lo <= W - RIGHT) { ctx.moveTo(lo + 0.5, AXIS); ctx.lineTo(lo + 0.5, bottom); }
        if (hi >= GUTTER && hi <= W - RIGHT) { ctx.moveTo(hi + 0.5, AXIS); ctx.lineTo(hi + 0.5, bottom); }
        ctx.stroke();
        // Δ readout centered above the visible band
        const dt = Math.abs(measure.t1 - measure.t0);
        const label = fmtNs(dt);
        ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
        const tw = ctx.measureText(label).width;
        const cx = Math.min(Math.max((cl + cr) / 2, GUTTER + tw / 2 + 4), W - RIGHT - tw / 2 - 4);
        ctx.fillStyle = "rgba(59,130,246,0.92)";
        ctx.fillRect(cx - tw / 2 - 4, AXIS + 2, tw + 8, 14);
        ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(label, cx, AXIS + 9);
        ctx.textBaseline = "middle";
      }
    }

    // full-height hover guide line (over the lanes) + the cursor timestamp.
    if (cursor && cursor.x > GUTTER && cursor.x <= W - RIGHT && cursor.y >= AXIS) {
      ctx.strokeStyle = "rgba(59,130,246,0.5)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cursor.x + 0.5, AXIS); ctx.lineTo(cursor.x + 0.5, bottom); ctx.stroke();
    }

    // --- pinned top axis strip (drawn last so nothing scrolls over it) ---
    ctx.clearRect(0, 0, W, AXIS);
    ctx.strokeStyle = cBorder; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(GUTTER, AXIS + 0.5); ctx.lineTo(W - RIGHT, AXIS + 0.5); ctx.stroke();
    ctx.fillStyle = cMuted; ctx.textAlign = "center";
    for (let t = t0; ; t += step) {
      const x = xOf(t, view);
      if (x > W - RIGHT) break;
      if (x < GUTTER) continue;
      ctx.fillText(fmtNs(t), x, AXIS / 2);
    }
    // cursor timestamp, shown in the axis strip above the guide line
    if (cursor && cursor.x > GUTTER && cursor.x <= W - RIGHT && cursor.y >= AXIS) {
      const label = fmtNs(tOf(cursor.x, view));
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      const tw = ctx.measureText(label).width;
      const cx = Math.min(Math.max(cursor.x, GUTTER + tw / 2 + 4), W - RIGHT - tw / 2 - 4);
      ctx.fillStyle = "rgba(59,130,246,0.92)";
      ctx.fillRect(cx - tw / 2 - 4, 1, tw + 8, AXIS - 3);
      ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(label, cx, (AXIS - 1) / 2);
      ctx.textAlign = "left";
    }
  }, [view, size.w, size.h, scrollY, marks, lanes, laneIndex, laneH, hover, cursor, measure, iconSize, xOf, tOf]);

  // --- minimap draw ---
  useEffect(() => {
    const cv = mmRef.current;
    if (!cv || !view || size.w <= 0 || marks.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = size.w, H = MM_H;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const cs = getComputedStyle(cv);
    const cBorder = cs.getPropertyValue("--border").trim() || "#e3e6ea";

    // "overview" gutter divider, mirroring the main canvas gutter.
    ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.strokeStyle = cBorder; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(GUTTER + 0.5, 0); ctx.lineTo(GUTTER + 0.5, H); ctx.stroke();

    // every mark, compressed onto the full domain (points → ticks, spans → bars).
    const top = 4, bot = H - 4;
    for (const m of marks) {
      const x1 = mmX(m.t);
      ctx.strokeStyle = ctx.fillStyle = m.color || "#cdd3da";
      if (m.end !== undefined) {
        const x2 = Math.max(mmX(m.end), x1 + 1);
        ctx.globalAlpha = 0.6; ctx.fillRect(x1, top, x2 - x1, bot - top); ctx.globalAlpha = 1;
      } else {
        ctx.globalAlpha = 0.85; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x1 + 0.5, top); ctx.lineTo(x1 + 0.5, bot); ctx.stroke();
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
    ctx.strokeStyle = "rgba(59,130,246,0.7)"; ctx.lineWidth = 1;
    ctx.strokeRect(bx0 + 0.5, 0.5, Math.max(1, bx1 - bx0) - 1, H - 1);
    // edge handles
    ctx.fillStyle = "rgba(59,130,246,0.7)";
    ctx.fillRect(bx0, H / 2 - 5, 2, 10);
    ctx.fillRect(bx1 - 2, H / 2 - 5, 2, 10);
  }, [view, size.w, marks, domMax, plotW, mmX]);

  // --- minimap interaction ---
  const onMmDown = (e: React.PointerEvent) => {
    if (!view) return;
    const rect = mmRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    mmRef.current!.setPointerCapture(e.pointerId);
    const span = plotW * view.nsPerPx;
    let x0 = mmX(view.offset), x1 = mmX(view.offset + span);
    let offset = view.offset;
    // Click outside the brush → recenter it on the cursor first, then pan.
    if (px < x0 - MM_EDGE || px > x1 + MM_EDGE) {
      const v = clampView({ offset: mmT(px) - span / 2, nsPerPx: view.nsPerPx });
      setView(v);
      offset = v.offset; x0 = mmX(v.offset); x1 = mmX(v.offset + span);
      mmDrag.current = { mode: "pan", startX: px, offset, nsPerPx: v.nsPerPx };
      return;
    }
    const mode = Math.abs(px - x0) <= MM_EDGE ? "left" : Math.abs(px - x1) <= MM_EDGE ? "right" : "pan";
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
        const x0 = mmX(v.offset), x1 = mmX(v.offset + plotW * v.nsPerPx);
        cv.style.cursor = Math.abs(px - x0) <= MM_EDGE || Math.abs(px - x1) <= MM_EDGE
          ? "ew-resize" : px >= x0 && px <= x1 ? "grab" : "pointer";
      }
      return;
    }
    const nsPerMmPx = domMax / plotW;
    if (d.mode === "pan") {
      setView(clampView({ offset: d.offset + (px - d.startX) * nsPerMmPx, nsPerPx: d.nsPerPx }));
    } else {
      const startT = d.offset, endT = d.offset + plotW * d.nsPerPx, tAt = mmT(px);
      const eps = plotW * 1e-3; // keep the window from collapsing to zero width
      if (d.mode === "left") {
        const newStart = Math.min(tAt, endT - eps);
        setView(clampView({ offset: newStart, nsPerPx: (endT - newStart) / plotW }));
      } else {
        const newEnd = Math.max(tAt, startT + eps);
        setView(clampView({ offset: startT, nsPerPx: (newEnd - startT) / plotW }));
      }
    }
  };
  const onMmUp = () => { mmDrag.current = null; };

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
  }, [tOf, clampView]);

  // Pan on shift-drag or dragging the top axis strip; plain body drag measures.
  const onDown = (e: React.PointerEvent) => {
    if (!view) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    (e.target as Element).setPointerCapture(e.pointerId);
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
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    if (pan.current && view) {
      setView(clampView({ ...view, offset: pan.current.offset - (e.clientX - pan.current.x) * view.nsPerPx }));
      setCursor({ x: px, y: py });
      return;
    }
    setCursor({ x: px, y: py });
    if (measuring.current) {
      const v = viewRef.current;
      if (v) { const t = snapTime(px, v); setMeasure((m) => (m ? { t0: m.t0, t1: t } : { t0: t, t1: t })); }
      return;
    }
    const i = pick(px, py);
    setHover(i >= 0 ? { i, x: px, y: py, cx: e.clientX, cy: e.clientY } : null);
  };
  const onUp = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    if (pan.current) { pan.current = null; return; }
    if (measuring.current) {
      measuring.current = false;
      const v = viewRef.current;
      const moved = (measure && v) ? Math.abs(xOf(measure.t1, v) - xOf(measure.t0, v)) : 0;
      if (moved < 3) {
        // a click, not a drag → clear the band and jump to the mark under it
        setMeasure(null);
        const i = pick(px, py);
        if (i >= 0) onJump(marks[i].lineN);
      }
      // a real drag keeps the band shown for reading the duration
    }
  };
  const onLeave = () => { hoverRef.current = false; setCursor(null); if (!measuring.current) setHover(null); };
  const fit = () => { lastRange.current = ""; setView(null); };

  // Keyboard nav works while the cursor is OVER the canvas — no click-to-focus
  // needed. A/D pan left/right, W/S zoom in/out (anchored at the cursor, else the
  // plot center). Skipped while an editable element is focused so it never hijacks
  // typing elsewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hoverRef.current) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
      const v = viewRef.current;
      if (!v) return;
      const k = e.key.toLowerCase();
      if (k === "a" || k === "d") {
        const step = plotW * 0.15 * v.nsPerPx;
        setView(clampView({ ...v, offset: v.offset + (k === "a" ? -step : step) }));
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
  }, [plotW, tOf, clampView]);

  const hm = hover ? marks[hover.i] : null;
  const fieldEntries = hm?.fields ? Object.entries(hm.fields).slice(0, 8) : [];
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
      onScroll={(e) => setScrollY((e.currentTarget as HTMLDivElement).scrollTop)}
    >
      <div className="tlc-vp">
        <canvas
          ref={canvasRef}
          style={{ outline: "none", cursor: pan.current ? "grabbing" : hover ? "pointer" : "crosshair" }}
          onPointerEnter={() => { hoverRef.current = true; }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={onLeave}
        />
        <button className="tlc-fit" title="Fit all events" onClick={fit}>fit</button>
        {measure && (
          <button className="tlc-clear" title="Clear measurement" onClick={() => setMeasure(null)}>clear Δ</button>
        )}
        {placeholder && marks.length === 0 && <div className="tlc-empty">{placeholder}</div>}
      </div>
      <div className="tlc-spacer" style={{ height: spacerH }} />
    </div>
    {/* Tooltip is portaled to <body> with fixed positioning so the wrap's
        `overflow` can't clip a tall card; it flips up/left near edges. */}
    {hm && hover && createPortal(
      (() => {
        const flipUp = hover.cy > window.innerHeight / 2;
        const flipLeft = hover.cx > window.innerWidth - 252;
        const pos: React.CSSProperties = {
          position: "fixed", zIndex: 1000, maxHeight: "60vh", overflow: "hidden",
          left: flipLeft ? undefined : hover.cx + 14,
          right: flipLeft ? window.innerWidth - hover.cx + 14 : undefined,
          top: flipUp ? undefined : hover.cy + 14,
          bottom: flipUp ? window.innerHeight - hover.cy + 14 : undefined,
        };
        return (
          <div className="tlc-tip" style={pos}>
            <div className="tlc-tip-h"><span className="tlc-tip-lane" style={{ background: hm.color }}>{hm.lane}</span> L{hm.lineN}</div>
            <div className="tlc-tip-t">{fmtNs(hm.t)}{hm.end !== undefined ? `  →  ${fmtNs(hm.end)}  (Δ ${fmtNs(hm.end - hm.t)})` : ""}</div>
            {fieldEntries.length > 0 && (
              <div className="tlc-tip-fields">
                {fieldEntries.map(([k, v]) => (
                  <div className="tlc-tip-field" key={k}><span className="tlc-tip-k">{k}</span><span className="tlc-tip-v">{v.raw}</span></div>
                ))}
              </div>
            )}
          </div>
        );
      })(),
      document.body,
    )}
    </div>
  );
}
