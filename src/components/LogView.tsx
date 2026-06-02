import { useState, useMemo, useRef, useEffect, CSSProperties, ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Download, Filter, Search, X } from "lucide-react";
import { toast } from "sonner";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { LogFile, ViewResult, CompiledFilter, FieldValue } from "../types";
import { escapeRegex, segments } from "../logic";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const _charWCache = new Map<number, number>();
function charWidth(fontSize: number): number {
  if (_charWCache.has(fontSize)) return _charWCache.get(fontSize)!;
  try {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = `${fontSize}px "Cascadia Code","Cascadia Mono",ui-monospace,Consolas,monospace`;
    _charWCache.set(fontSize, ctx.measureText("M".repeat(100)).width / 100 || fontSize * 0.6);
  } catch { _charWCache.set(fontSize, fontSize * 0.6); }
  return _charWCache.get(fontSize)!;
}

function buildFindRe(q: string): RegExp | null {
  if (!q) return null;
  try { return new RegExp(escapeRegex(q), "gi"); } catch { return null; }
}

function renderLine(text: string, winner: CompiledFilter | null, findRe: RegExp | null, currentKey: string | null, ri: number) {
  if (findRe) {
    findRe.lastIndex = 0;
    const out: (string | ReactNode)[] = [];
    let last = 0, k = 0, guard = 0;
    let m: RegExpExecArray | null;
    while ((m = findRe.exec(text)) !== null) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const key = `${ri}:${m.index}`;
      out.push(<span key={"h" + k} className={"find-hit" + (key === currentKey ? " current" : "")}>{m[0]}</span>);
      last = m.index + m[0].length;
      if (m[0].length === 0) findRe.lastIndex++;
      k++;
      if (++guard > 4000) break;
    }
    if (last < text.length) out.push(text.slice(last));
    return out.length ? out : text;
  }
  if (winner?.re) {
    const segs = segments(text, winner.re);
    if (segs.length === 1 && !segs[0].hit) return text;
    return segs.map((s, i) => s.hit ? <span key={i} className="log-hit">{s.t}</span> : s.t);
  }
  return text;
}

/** Compact 2-row table for one line's parsed fields: names on top, values below. */
function FieldTable({ fields }: { fields: Record<string, FieldValue> }) {
  const keys = Object.keys(fields);
  return (
    <table className="fp-table">
      <tbody>
        <tr className="fp-keys">{keys.map((k) => <td key={k}>{k}</td>)}</tr>
        <tr className="fp-vals">
          {keys.map((k) => (
            <td key={k} className={typeof fields[k].value === "number" ? "num" : ""}>{fields[k].raw}</td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

interface LogViewProps {
  file: LogFile;
  view: ViewResult;
  viewMode: "all" | "matches";
  findOpen: boolean;
  mapColorMode: "bg" | "text";
  mapWidth: number;
  fontSize: number;
  showLineNumbers: boolean;
  style?: CSSProperties;
  onToggleViewMode: (m: "all" | "matches") => void;
  onToggleFind: () => void;
  onCloseFind: () => void;
  onBuildFilter: (pattern: string) => void;
}

export function LogView({
  file, view, viewMode, findOpen, mapColorMode, mapWidth, fontSize, showLineNumbers, style,
  onCloseFind, onBuildFilter,
}: LogViewProps) {
  const rowH = Math.round(fontSize * 1.5);
  const scrollRef = useRef<HTMLDivElement>(null);
  const mapCanvasRef = useRef<HTMLCanvasElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const [selMenu, setSelMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  const [selectedLines, setSelectedLines] = useState<Set<number>>(() => new Set());
  const [anchorRi, setAnchorRi] = useState<number | null>(null);
  const [expandedLines, setExpandedLines] = useState<Set<number>>(() => new Set());

  const toggleExpand = (n: number) =>
    setExpandedLines((s) => {
      const next = new Set(s);
      next.has(n) ? next.delete(n) : next.add(n);
      return next;
    });

  const isDragSelectingRef = useRef(false);
  const dragStartRiRef = useRef<number | null>(null);
  const dragBaseSetRef = useRef<Set<number>>(new Set());

  const visible = useMemo(() => {
    const rows = view.rows.filter((r) => !r.excluded);
    if (viewMode === "matches" && view.hasHighlights) return rows.filter((r) => r.winner);
    return rows;
  }, [view, viewMode]);

  const maxLen = useMemo(() => {
    let m = 0;
    for (const r of visible) if (r.text.length > m) m = r.text.length;
    return m;
  }, [visible]);
  const minW = (showLineNumbers ? 53 : 0) + 12 + Math.ceil(maxLen * charWidth(fontSize)) + 28;

  const rowVirtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 12,
  });

  const findRe = useMemo(() => buildFindRe(query), [query]);

  const hits = useMemo(() => {
    if (!findRe) return [];
    const list: { ri: number; index: number; key: string }[] = [];
    for (let i = 0; i < visible.length; i++) {
      findRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      let guard = 0;
      while ((m = findRe.exec(visible[i].text)) !== null) {
        list.push({ ri: i, index: m.index, key: `${i}:${m.index}` });
        if (m[0].length === 0) findRe.lastIndex++;
        if (++guard > 4000) break;
      }
    }
    return list;
  }, [findRe, visible]);

  useEffect(() => { rowVirtualizer.measure(); }, [rowH]);

  useEffect(() => { setCurrent(0); }, [query]);
  useEffect(() => { if (findOpen) findInputRef.current?.focus(); }, [findOpen]);

  useEffect(() => {
    if (!hits.length) return;
    const h = hits[Math.min(current, hits.length - 1)];
    if (!h) return;
    rowVirtualizer.scrollToIndex(h.ri, { align: "center", behavior: "smooth" });
  }, [current, hits]);

  useEffect(() => {
    rowVirtualizer.scrollToIndex(0);
    setSelectedLines(new Set());
    setAnchorRi(null);
    setExpandedLines(new Set());
  }, [file.id, viewMode]);

  useEffect(() => { setSelectedLines(new Set()); setAnchorRi(null); }, [view]);

  const scrollTop = rowVirtualizer.scrollOffset ?? 0;
  const viewH = scrollRef.current?.clientHeight ?? 600;

  useEffect(() => {
    const canvas = mapCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    if (!visible.length) return;
    const total = visible.length;
    const markH = Math.max(1, Math.round(h / total));
    for (let ri = 0; ri < visible.length; ri++) {
      const r = visible[ri];
      if (!r.winner) continue;
      const y = Math.round((ri / total) * h);
      ctx.fillStyle = mapColorMode === "text" ? r.winner.f.textColor : r.winner.f.bgColor;
      ctx.fillRect(0, y, w, markH);
    }
    const contentH = total * rowH;
    const vpTop = Math.round((scrollTop / Math.max(1, contentH)) * h);
    const vpH = Math.max(6, Math.round((viewH / Math.max(1, contentH)) * h));
    ctx.fillStyle = "rgba(0,0,0,0.07)";
    ctx.fillRect(0, vpTop, w, vpH);
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, vpTop + 0.5, w - 1, Math.max(5, vpH - 1));
  }, [view, visible, viewH, scrollTop, mapColorMode, mapWidth]);

  function nav(dir: number) { if (!hits.length) return; setCurrent((c) => (c + dir + hits.length) % hits.length); }
  const currentKey = hits.length ? hits[Math.min(current, hits.length - 1)].key : null;

  function onMapClick(e: React.MouseEvent<HTMLDivElement>) {
    const canvas = mapCanvasRef.current;
    if (!canvas || !visible.length) return;
    const rect = canvas.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const ri = Math.max(0, Math.min(visible.length - 1, Math.floor((y / rect.height) * visible.length)));
    rowVirtualizer.scrollToIndex(ri, { align: "center" });
  }

  function onRowClick(e: React.MouseEvent, ri: number, n: number) {
    const s = window.getSelection();
    if (s && !s.isCollapsed) return;
    if (e.altKey) { toggleExpand(n); return; } // Alt+click toggles the field table
    if (e.shiftKey && anchorRi != null) {
      const a = Math.min(anchorRi, ri), b = Math.max(anchorRi, ri);
      const set = new Set(e.ctrlKey || e.metaKey ? selectedLines : []);
      for (let i = a; i <= b && i < visible.length; i++) set.add(visible[i].n);
      setSelectedLines(set);
    } else if (e.ctrlKey || e.metaKey) {
      const set = new Set(selectedLines);
      if (set.has(n)) set.delete(n); else set.add(n);
      setSelectedLines(set);
      setAnchorRi(ri);
    } else {
      setSelectedLines(new Set([n]));
      setAnchorRi(ri);
    }
  }

  function handleRowMouseDown(e: React.MouseEvent, ri: number) {
    if (e.altKey) { e.preventDefault(); return; } // don't start a text selection on Alt+click
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault(); // prevent text selection during ctrl+drag
    dragStartRiRef.current = ri;
    isDragSelectingRef.current = false;
  }

  function handleRowMouseEnter(ri: number) {
    const start = dragStartRiRef.current;
    if (start === null) return;
    if (!isDragSelectingRef.current) {
      isDragSelectingRef.current = true;
      // capture the selection that existed before this drag began
      dragBaseSetRef.current = new Set(selectedLines);
      setAnchorRi(start);
    }
    // rebuild selection each move so dragging back over rows deselects them
    const a = Math.min(start, ri), b = Math.max(start, ri);
    const next = new Set(dragBaseSetRef.current);
    for (let i = a; i <= b && i < visible.length; i++) next.add(visible[i].n);
    setSelectedLines(next);
  }

  useEffect(() => {
    function onUp() {
      isDragSelectingRef.current = false;
      dragStartRiRef.current = null;
    }
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  function handleMouseUp() {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!text || !sel?.rangeCount) { setSelMenu(null); return; }
    if (!scrollRef.current?.contains(sel.anchorNode)) { setSelMenu(null); return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setSelMenu({ x: Math.max(4, rect.left), y: rect.top, text });
  }

  useEffect(() => {
    if (!selMenu) return;
    function h(e: MouseEvent) {
      const menu = document.querySelector(".sel-menu");
      if (menu && !menu.contains(e.target as Node)) setSelMenu(null);
    }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [selMenu]);

  function copySelectedLines(): boolean {
    if (!selectedLines.size) return false;
    const out = visible
      .filter((r) => selectedLines.has(r.n))
      .map((r) => (showLineNumbers ? `${String(r.n).padStart(8)}  ${r.text}` : r.text))
      .join("\n");
    navigator.clipboard.writeText(out).catch(() => {});
    toast.success(`Copied ${selectedLines.size.toLocaleString()} line${selectedLines.size > 1 ? "s" : ""}`);
    return true;
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
        const s = window.getSelection();
        if (s && !s.isCollapsed) return;
        if (selectedLines.size) { e.preventDefault(); copySelectedLines(); }
      } else if (e.key === "Escape" && selectedLines.size) {
        setSelectedLines(new Set());
      } else if ((e.key === "ArrowRight" || e.key === "Enter") && selectedLines.size === 1) {
        // Expand the single selected line's parsed fields (if it has any).
        const n = [...selectedLines][0];
        if (visible.find((r) => r.n === n)?.fields) { e.preventDefault(); setExpandedLines((s) => new Set(s).add(n)); }
      } else if (e.key === "ArrowLeft" && selectedLines.size === 1) {
        const n = [...selectedLines][0];
        setExpandedLines((s) => { const x = new Set(s); x.delete(n); return x; });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedLines, visible, showLineNumbers]);

  function exportView() {
    const text = visible.map((r) => String(r.n).padStart(8) + "  " + r.text).join("\n");
    const base = file.name.replace(/\.log$/i, "");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = base + ".filtered.log"; a.click();
    URL.revokeObjectURL(url);
  }

  const matchedCount = view.hasHighlights ? view.rows.filter((r) => !r.excluded && r.winner).length : 0;
  const hiddenByExclude = view.rows.filter((r) => r.excluded).length;

  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  // Selected lines that have parsed fields, for the comparison table.
  const compareRows = useMemo(
    () => visible.filter((r) => selectedLines.has(r.n) && r.fields),
    [visible, selectedLines],
  );
  // Union of field names across the compared rows, in first-seen order.
  const compareCols = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const r of compareRows) {
      for (const k of Object.keys(r.fields!)) if (!seen.has(k)) { seen.add(k); out.push(k); }
    }
    return out;
  }, [compareRows]);

  return (
    <div className="logview" style={style}>
      {/* header */}
      <div className="logview-bar">
        <div className="lv-title">
          <Search size={15} style={{ color: "#4f8cff" }} />
          {file.name}
        </div>
        <div className="lv-spacer" />
        <div className="lv-stat">
          <b>{visible.length.toLocaleString()}</b>
          {" / " + view.rows.length.toLocaleString() + " lines"}
          {view.hasHighlights && <span>{"  ·  "}<b>{matchedCount.toLocaleString()}</b>{" matched"}</span>}
          {hiddenByExclude > 0 && <span style={{ color: "var(--error)" }}>{"  ·  " + hiddenByExclude.toLocaleString() + " excluded"}</span>}
        </div>
        {/* <div className="seg" style={{ marginLeft: 6 }}>
          <button className={viewMode === "all" ? "on" : ""} onClick={() => onToggleViewMode("all")} title="Show every line; unmatched dimmed  (Ctrl+H)">Show all</button>
          <button className={viewMode === "matches" ? "on" : ""} onClick={() => onToggleViewMode("matches")} title="Only lines matching a filter  (Ctrl+H)">Matches only</button>
        </div> */}
        <Tooltip>
          <TooltipTrigger render={
            <Button variant="ghost" size="icon-sm" onClick={exportView} style={{ marginLeft: 2 }} />
          }>
            <Download />
          </TooltipTrigger>
          <TooltipContent>Export filtered view</TooltipContent>
        </Tooltip>
        {/* <Tooltip>
          <TooltipTrigger render={
            <Button size="icon" onClick={onToggleFind} style={{ marginLeft: 2 }} />
          }>
            <Search size={16} />
          </TooltipTrigger>
          <TooltipContent>Find  (Ctrl+F)</TooltipContent>
        </Tooltip> */}
      </div>

      {/* find bar */}
      {findOpen && (
        <div className="findbar">
          <Search size={14} style={{ color: "var(--text-3)" }} />
          <input
            ref={findInputRef}
            placeholder="Find in view…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); nav(e.shiftKey ? -1 : 1); }
              if (e.key === "Escape") onCloseFind();
            }}
          />
          <span className="find-count">
            {hits.length ? `${Math.min(current + 1, hits.length)} / ${hits.length}` : query ? "0 / 0" : ""}
          </span>
          <div className="find-divider" />
          <div className="find-nav">
            <Tooltip>
              <TooltipTrigger render={<Button size="icon-sm" onClick={() => nav(-1)} />}>
                <ArrowUp size={15} />
              </TooltipTrigger>
              <TooltipContent>Previous (Shift+Enter)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger render={<Button size="icon-sm" onClick={() => nav(1)} />}>
                <ArrowDown size={15} />
              </TooltipTrigger>
              <TooltipContent>Next (Enter)</TooltipContent>
            </Tooltip>
          </div>
          <Tooltip>
            <TooltipTrigger render={<Button size="icon-sm" onClick={onCloseFind} />}>
              <X size={15} />
            </TooltipTrigger>
            <TooltipContent>Close (Esc)</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* content */}
      {visible.length === 0 ? (
        <div className="log-empty">
          <Filter size={24} style={{ color: "var(--text-3)", marginBottom: 4 }} />
          <div>No lines match the active filters.</div>
          <div style={{ fontSize: 12 }}>Switch to "Show all" or disable a filter.</div>
        </div>
      ) : (
        <div className="log-content-area">
          <div
            className={"log-scroll scroll" + (showLineNumbers ? "" : " no-gutter")}
            ref={scrollRef}
            onMouseDown={() => setSelMenu(null)}
            onMouseUp={handleMouseUp}
            style={{ overflowY: "auto", overflowX: "auto" }}
          >
            <div className="log-inner" style={{ minWidth: minW, height: totalSize, position: "relative" }}>
              {virtualItems.map((vItem) => {
                const r = visible[vItem.index];
                const w = r.winner;
                const dim = viewMode === "all" && view.hasHighlights && !w;
                const sel = selectedLines.has(r.n);
                const canExpand = !!r.fields;
                const expanded = expandedLines.has(r.n);
                const rowStyle: CSSProperties = {
                  height: rowH,
                  ...(w ? { background: w.f.bgColor, color: w.f.textColor, borderLeftColor: w.f.textColor } : {}),
                };
                return (
                  <div
                    key={r.n}
                    data-index={vItem.index}
                    ref={rowVirtualizer.measureElement}
                    className="log-rowwrap"
                    style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vItem.start}px)` }}
                  >
                    <div
                      className={"log-row" + (w ? " matched" : "") + (dim ? " dim" : "") + (sel ? " selected" : "") + (canExpand ? " expandable" : "")}
                      style={rowStyle}
                      onMouseDown={(e) => handleRowMouseDown(e, vItem.index)}
                      onMouseEnter={() => handleRowMouseEnter(vItem.index)}
                      onClick={(e) => onRowClick(e, vItem.index, r.n)}
                    >
                      {canExpand && (
                        <span
                          className={"log-exp" + (expanded ? " on" : "")}
                          title={expanded ? "Collapse fields (Alt+click)" : "Expand parsed fields (Alt+click)"}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); toggleExpand(r.n); }}
                        >
                          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </span>
                      )}
                      {showLineNumbers && <span className="log-gut">{r.n}</span>}
                      <span className="log-txt">{renderLine(r.text, w, findRe, currentKey, vItem.index)}</span>
                    </div>
                    {expanded && r.fields && (
                      <div className="log-fieldpanel">
                        <FieldTable fields={r.fields} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          {view.hasHighlights && (
            <div
              className="match-map"
              style={{ width: mapWidth, flex: `0 0 ${mapWidth}px` }}
              title="Match map — click to jump"
              onClick={onMapClick}
            >
              <canvas ref={mapCanvasRef} width={mapWidth} height={viewH} />
            </div>
          )}
        </div>
      )}

      {/* field comparison table for multi-selected lines */}
      {compareRows.length >= 2 && (
        <div className="cmp-panel">
          <div className="cmp-head">
            <span className="cmp-title">Compare · {compareRows.length} lines</span>
            <div className="lv-spacer" />
            <Tooltip>
              <TooltipTrigger render={<Button size="icon-sm" onClick={() => setSelectedLines(new Set())} />}>
                <X size={15} />
              </TooltipTrigger>
              <TooltipContent>Clear selection</TooltipContent>
            </Tooltip>
          </div>
          <div className="cmp-scroll scroll">
            <table className="cmp-table">
              <thead>
                <tr>
                  <th className="cmp-ln">line</th>
                  {compareCols.map((c) => <th key={c}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {compareRows.map((r) => (
                  <tr key={r.n}>
                    <td className="cmp-ln">{r.n}</td>
                    {compareCols.map((c) => {
                      const fv = r.fields![c];
                      return (
                        <td key={c} className={fv && typeof fv.value === "number" ? "num" : ""}>
                          {fv ? fv.raw : "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* selection popup */}
      {selMenu && (
        <div className="sel-menu" style={{ left: selMenu.x, top: selMenu.y }}>
          <button onClick={() => { onBuildFilter(selMenu.text); setSelMenu(null); }} title="Add the selected text as a new filter">
            <Filter size={13} /> Add filter…
          </button>
        </div>
      )}
    </div>
  );
}
