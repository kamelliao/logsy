import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import type { EventMark, EventShape } from "../types";

// Layout constants (CSS px).
const GUTTER = 76;   // left lane-label column
const RIGHT = 12;
const AXIS = 18;     // top axis strip (timestamps)
const PAD = 6;       // gap below the last lane
const LANE_MIN = 16, LANE_MAX = 40;

// The canvas auto-fits its lane content (no manual resize): one row per visible
// lane, capped so a long track list can't push the rest of the panel around.
const EMPTY_H = 120;  // height when there are no lanes yet (room for the hint)
const MAX_H = 420;

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
}

export function TimelineCanvas({ marks, lanes, onJump, placeholder }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: EMPTY_H });
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
  // Height tracks the lane count: AXIS strip + one LANE_MAX row per visible lane
  // + bottom gap, capped at MAX_H. No trailing blank space below the last lane.
  const wrapH = lanes.length === 0
    ? EMPTY_H
    : Math.min(MAX_H, AXIS + lanes.length * LANE_MAX + PAD);

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
  const laneH = Math.max(LANE_MIN, Math.min(LANE_MAX, (size.h - AXIS - PAD) / Math.max(1, lanes.length)));

  // Clamp a view to the [0, domMax] domain: cap zoom-out at "whole domain fills
  // the plot", and keep the visible window inside the domain.
  const clampView = useCallback((v: View): View => {
    const maxNsPerPx = domMax / plotW;
    const nsPerPx = Math.min(Math.max(v.nsPerPx, 1e-6), maxNsPerPx);
    const maxOffset = Math.max(0, domMax - plotW * nsPerPx);
    const offset = Math.min(Math.max(v.offset, 0), maxOffset);
    return { offset, nsPerPx };
  }, [plotW, domMax]);

  // Track the wrapper's rendered size (width is fluid; height follows wrapH).
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

  const viewRef = useRef(view);
  viewRef.current = view;

  const pick = useCallback((px: number, py: number): number => {
    if (!view) return -1;
    const lane = Math.floor((py - AXIS) / laneH);
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
  }, [marks, view, laneIndex, xOf, laneH]);

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
    if (!cv || !view || size.w <= 0) return;
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

    const lanesH = Math.min(lanes.length, Math.floor((H - AXIS - PAD) / laneH)) * laneH;
    const bottom = AXIS + lanesH;

    // lane bands + labels
    for (let i = 0; i < lanes.length; i++) {
      const yTop = AXIS + i * laneH;
      if (yTop + laneH > H - PAD + 0.5) break;
      if (i % 2 === 1) { ctx.fillStyle = "rgba(130,140,150,0.07)"; ctx.fillRect(0, yTop, W, laneH); }
      ctx.fillStyle = cMuted; ctx.textAlign = "left";
      const name = lanes[i].length > 11 ? lanes[i].slice(0, 10) + "…" : lanes[i];
      ctx.fillText(name, 6, yTop + laneH / 2);
    }
    // gutter divider
    ctx.strokeStyle = cBorder; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(GUTTER + 0.5, 0); ctx.lineTo(GUTTER + 0.5, bottom); ctx.stroke();

    // top axis strip
    ctx.strokeStyle = cBorder;
    ctx.beginPath(); ctx.moveTo(GUTTER, AXIS + 0.5); ctx.lineTo(W - RIGHT, AXIS + 0.5); ctx.stroke();
    const step = niceStep(view.nsPerPx * 70);
    const t0 = Math.ceil(tOf(GUTTER, view) / step) * step;
    ctx.fillStyle = cMuted; ctx.textAlign = "center";
    for (let t = t0; ; t += step) {
      const x = xOf(t, view);
      if (x > W - RIGHT) break;
      ctx.strokeStyle = "rgba(130,140,150,0.18)";
      ctx.beginPath(); ctx.moveTo(x + 0.5, AXIS); ctx.lineTo(x + 0.5, bottom); ctx.stroke();
      ctx.fillText(fmtNs(t), x, AXIS / 2);
    }

    // marks (clipped to plot)
    ctx.save();
    ctx.beginPath(); ctx.rect(GUTTER, AXIS, W - GUTTER - RIGHT, bottom - AXIS); ctx.clip();
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      const li = laneIndex.get(m.lane);
      if (li === undefined) continue;
      const cy = AXIS + li * laneH + laneH / 2;
      if (cy > bottom) continue;
      const x1 = xOf(m.t, view);
      const hot = hover?.i === i;
      ctx.fillStyle = m.color || "#cdd3da";
      ctx.strokeStyle = hot ? cText : "rgba(0,0,0,0.28)";
      ctx.lineWidth = hot ? 1.5 : 1;
      if (m.end !== undefined) {
        const x2 = Math.max(xOf(m.end, view), x1 + 2);
        ctx.beginPath(); ctx.roundRect(x1, cy - 5, x2 - x1, 10, 3); ctx.fill(); ctx.stroke();
      } else {
        tracePoint(ctx, m.shape, x1, cy, hot ? 4.5 : 3.5);
        ctx.fill(); ctx.stroke();
      }
    }
    ctx.restore();

    // measure band (drawn under the guide line, over the marks). Edges come from
    // TIME, so the band tracks the data through zoom/pan and Δ stays constant;
    // only its on-screen position/width changes. Clamped to the plot for drawing.
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

    // full-height hover guide line (over everything) + the cursor timestamp,
    // shown in the axis strip above the line so the exact instant is readable.
    if (cursor && cursor.x > GUTTER && cursor.x <= W - RIGHT && cursor.y >= AXIS) {
      ctx.strokeStyle = "rgba(59,130,246,0.5)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cursor.x + 0.5, AXIS); ctx.lineTo(cursor.x + 0.5, bottom); ctx.stroke();

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
  }, [view, size.w, size.h, marks, lanes, laneIndex, laneH, hover, cursor, measure, xOf, tOf]);

  // --- interaction ---
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      const v = viewRef.current;
      if (!v) return;
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
  const onLeave = () => { setCursor(null); if (!measuring.current) setHover(null); };
  const fit = () => { lastRange.current = ""; setView(null); };

  // Keyboard nav (canvas must be focused — a click focuses it): A/D pan
  // left/right, W/S zoom in/out. Zoom keeps the point under the cursor (or the
  // plot center) fixed, mirroring the wheel.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const v = viewRef.current;
    if (!v) return;
    const k = e.key.toLowerCase();
    if (k === "a" || k === "d") {
      const step = plotW * 0.15 * v.nsPerPx;
      setView(clampView({ ...v, offset: v.offset + (k === "a" ? -step : step) }));
    } else if (k === "w" || k === "s") {
      const px = cursor ? cursor.x : GUTTER + plotW / 2;
      const tAt = tOf(px, v);
      const nsPerPx = v.nsPerPx * (k === "w" ? 1 / 1.2 : 1.2);
      setView(clampView({ offset: tAt - (px - GUTTER) * nsPerPx, nsPerPx }));
    } else {
      return;
    }
    e.preventDefault();
  };

  const hm = hover ? marks[hover.i] : null;
  const fieldEntries = hm?.fields ? Object.entries(hm.fields).slice(0, 8) : [];
  return (
    <div className="tlc-wrap" ref={wrapRef} style={{ height: wrapH }}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        style={{ width: "100%", height: "100%", outline: "none", cursor: pan.current ? "grabbing" : hover ? "pointer" : "crosshair" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onLeave}
        onKeyDown={onKeyDown}
      />
      <button className="tlc-fit" title="Fit all events" onClick={fit}>fit</button>
      {measure && (
        <button className="tlc-clear" title="Clear measurement" onClick={() => setMeasure(null)}>clear Δ</button>
      )}
      {placeholder && marks.length === 0 && <div className="tlc-empty">{placeholder}</div>}
      {/* Tooltip is portaled to <body> with fixed positioning so the wrap's
          `overflow:hidden` can't clip a tall card; it flips up/left near edges. */}
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
