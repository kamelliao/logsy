import {
  useState,
  useMemo,
  useRef,
  useEffect,
  CSSProperties,
  ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  ChartGantt,
  ChevronDown,
  ChevronRight,
  Columns3,
  Copy,
  Download,
  Eye,
  FileText,
  Filter,
  Minus,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  LogFile,
  ViewResult,
  FieldValue,
  Marker,
  MarkerIcon,
  Filter as FilterCfg,
} from "@/types";
import { escapeRegex } from "@/lib/engine";
import {
  MARKER_ICONS,
  MarkerGlyph,
  markerColor,
} from "@/components/widgets/markers";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const _charWCache = new Map<number, number>();
function charWidth(fontSize: number): number {
  if (_charWCache.has(fontSize)) return _charWCache.get(fontSize)!;
  try {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = `${fontSize}px "Cascadia Code","Cascadia Mono",ui-monospace,Consolas,monospace`;
    _charWCache.set(
      fontSize,
      ctx.measureText("M".repeat(100)).width / 100 || fontSize * 0.6,
    );
  } catch {
    _charWCache.set(fontSize, fontSize * 0.6);
  }
  return _charWCache.get(fontSize)!;
}

// Build the find regex. `regex` treats the query as a regex source (otherwise it
// matches literally); `caseSensitive` drops the `i` flag. Returns null for an
// empty query *or* an invalid regex source — callers tell the two apart via the
// query length (see `findInvalid`).
function buildFindRe(
  q: string,
  regex: boolean,
  caseSensitive: boolean,
): RegExp | null {
  if (!q) return null;
  const flags = caseSensitive ? "g" : "gi";
  try {
    return new RegExp(regex ? q : escapeRegex(q), flags);
  } catch {
    return null;
  }
}

// Highlights find hits only. Filter matches used to get their matched text
// wrapped in .log-hit spans here, but that re-ran every winner's regex on every
// visible row each scroll frame — dropped for scroll smoothness, the row's
// background color already marks the match.
function renderLine(
  text: string,
  findRe: RegExp | null,
  currentKey: string | null,
  ri: number,
) {
  if (!findRe) return text;
  findRe.lastIndex = 0;
  const out: (string | ReactNode)[] = [];
  let last = 0,
    k = 0,
    guard = 0;
  let m: RegExpExecArray | null;
  while ((m = findRe.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${ri}:${m.index}`;
    out.push(
      <span
        key={"h" + k}
        className={"find-hit" + (key === currentKey ? " current" : "")}
      >
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
    if (m[0].length === 0) findRe.lastIndex++;
    k++;
    if (++guard > 4000) break;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length ? out : text;
}

// Switching files remounts LogView (keyed by file.id in App), which resets the
// virtualizer to the top. Remember each file's last scroll offset here so a
// switch back lands where it left off. Module-level (like useLogFiles' linesStore)
// so it survives remounts; ephemeral — not persisted, which matches the lazy
// line cache (non-active files aren't even loaded after a restart).
const scrollByFile: Record<string, number> = {};

/** Compact 2-row table for one line's parsed fields: names on top, values below. */
function FieldTable({ fields }: { fields: Record<string, FieldValue> }) {
  const keys = Object.keys(fields);
  return (
    <table className="fp-table">
      <tbody>
        <tr className="fp-keys">
          {keys.map((k) => (
            <td key={k}>{k}</td>
          ))}
        </tr>
        <tr className="fp-vals">
          {keys.map((k) => (
            <td
              key={k}
              className={typeof fields[k].value === "number" ? "num" : ""}
            >
              {fields[k].raw}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

interface LogViewProps {
  file: LogFile;
  view: ViewResult;
  /** The active file's raw lines. Used only as a stable identity signal for
   *  resetting selection — it changes on file switch / reload, but NOT when
   *  filters or the view mode toggle (which re-create `view` but not `lines`). */
  lines: string[];
  /** Active set's filters, in order — used to label a matched row with its #N. */
  filters: FilterCfg[];
  viewMode: "all" | "matches";
  /** When set, the view is soloed to one filter; shows the exit banner. */
  soloPattern?: string | null;
  onExitSolo?: () => void;
  findOpen: boolean;
  mapColorMode: "bg" | "text";
  mapWidth: number;
  fontSize: number;
  showLineNumbers: boolean;
  compareLines: Set<number>;
  style?: CSSProperties;
  /** Bumped by the Edit ▸ Select All menu to select every visible line. */
  selectAllNonce?: number;
  /** Set by Edit ▸ Go to… to scroll/select a line number (nonce re-triggers). */
  gotoSignal?: { n: number; nonce: number } | null;
  /** Save the filtered view text via a native dialog (provided by App). */
  onExportView?: (defaultName: string, text: string) => void;
  /** Bookmarks for the active file (one per line number). */
  markers: Marker[];
  /** Set by the Bookmarks tab to scroll/select a marked line (nonce re-triggers). */
  markerJump?: { n: number; nonce: number } | null;
  onSetMarker: (n: number, icon: MarkerIcon, note: string) => void;
  onRemoveMarker: (n: number) => void;
  onToggleViewMode: (m: "all" | "matches") => void;
  onToggleFind: () => void;
  onCloseFind: () => void;
  /** "exact" adds the text verbatim; "pattern" generalizes it into a regex. */
  onBuildFilter: (pattern: string, mode?: "exact" | "pattern") => void;
  onAddToCompare: (ns: number[]) => void;
  onRemoveFromCompare: (ns: number[]) => void;
  timelineLines: Set<number>;
  onAddToTimeline: (ns: number[]) => void;
  onRemoveFromTimeline: (ns: number[]) => void;
}

export function LogView({
  file,
  view,
  lines,
  filters,
  viewMode,
  soloPattern,
  onExitSolo,
  findOpen,
  mapColorMode,
  mapWidth,
  fontSize,
  showLineNumbers,
  compareLines,
  style,
  selectAllNonce,
  gotoSignal,
  onExportView,
  markers,
  markerJump,
  onSetMarker,
  onRemoveMarker,
  onToggleViewMode,
  onToggleFind,
  onCloseFind,
  onBuildFilter,
  onAddToCompare,
  onRemoveFromCompare,
  timelineLines,
  onAddToTimeline,
  onRemoveFromTimeline,
}: LogViewProps) {
  const rowH = Math.round(fontSize * 1.5);
  // Filter id → 1-based position in the set, so a matched row's tooltip can name
  // its winner as "#N" (matching the serials shown in the filter/timeline panels).
  const filterSerial = useMemo(() => {
    const m = new Map<string, number>();
    filters.forEach((f, i) => m.set(f.id, i + 1));
    return m;
  }, [filters]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const mapCanvasRef = useRef<HTMLCanvasElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  // Find options: `.*` treats the query as a regex, `Aa` makes it case-sensitive.
  const [findRegex, setFindRegex] = useState(false);
  const [findCase, setFindCase] = useState(false);
  const [current, setCurrent] = useState(0);
  const [selMenu, setSelMenu] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const [rowMenu, setRowMenu] = useState<{
    x: number;
    y: number;
    n: number;
  } | null>(null);
  const [selectedLines, setSelectedLines] = useState<Set<number>>(
    () => new Set(),
  );
  const [anchorRi, setAnchorRi] = useState<number | null>(null);
  const [expandedLines, setExpandedLines] = useState<Set<number>>(
    () => new Set(),
  );
  // Open bookmark editor popover, anchored at a screen position for one line.
  const [markerPop, setMarkerPop] = useState<{
    x: number;
    y: number;
    n: number;
  } | null>(null);
  // Draft for the bookmark editor — edits stay local until committed via Done/Enter,
  // so a new bookmark isn't created (and an existing one isn't changed) on dismiss.
  const [markerDraft, setMarkerDraft] = useState<{
    icon: MarkerIcon;
    note: string;
    isNew: boolean;
  } | null>(null);

  // One shared logline hover card (line n + screen anchor). A single element —
  // never a per-row HoverCard — so it can't regress virtualized scroll perf.
  const [hover, setHover] = useState<{
    n: number;
    x: number;
    y: number;
  } | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const clearHover = () => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setHover((h) => (h === null ? h : null));
  };
  const armHover = (e: React.MouseEvent, n: number) => {
    if (dragStartRiRef.current !== null) return; // don't pop a card mid drag-select
    const x = e.clientX,
      y = e.clientY;
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHover({ n, x, y }), 350);
  };

  // Markers indexed by line number for O(1) gutter lookups.
  const markerMap = useMemo(
    () => new Map(markers.map((m) => [m.n, m])),
    [markers],
  );

  const [altDown, setAltDown] = useState(false);

  const toggleExpand = (n: number) =>
    setExpandedLines((s) => {
      const next = new Set(s);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  // Track Alt so loglines can show a pointer cursor (and reveal the chevron) on hover.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Alt") setAltDown(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Alt") setAltDown(false);
    };
    const blur = () => setAltDown(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  const isDragSelectingRef = useRef(false);
  const dragStartRiRef = useRef<number | null>(null);
  const dragBaseSetRef = useRef<Set<number>>(new Set());
  // Paint direction for the active ctrl+drag, fixed at mousedown from the start
  // row's state: "add" selects rows the drag covers, "remove" deselects them.
  const dragModeRef = useRef<"add" | "remove">("add");
  // Auto-scroll state during ctrl+drag (mouse position + pending RAF id).
  const dragMouseYRef = useRef<number | null>(null);
  const dragScrollRAFRef = useRef<number | null>(null);

  const visible = useMemo(() => {
    const rows = view.rows.filter((r) => !r.excluded);
    if (viewMode === "matches" && view.hasHighlights)
      return rows.filter((r) => r.winner);
    return rows;
  }, [view, viewMode]);

  const maxLen = useMemo(() => {
    let m = 0;
    for (const r of visible) if (r.text.length > m) m = r.text.length;
    return m;
  }, [visible]);
  // Size the line-number gutter to the file's largest line number (≥4 digits),
  // so big files aren't clipped to the old fixed 5-digit column. The left
  // padding (35px, matching .log-gut) reserves two lanes — the bookmark marker
  // and the expand chevron — so the digits never sit underneath them.
  const gutterW = useMemo(() => {
    const digits = Math.max(4, String(Math.max(1, file.lineCount || 0)).length);
    return Math.ceil(digits * charWidth(fontSize)) + 35 + 12; // marker + chevron lanes + right padding
  }, [file.lineCount, fontSize]);
  const minW =
    (showLineNumbers ? gutterW : 0) +
    12 +
    Math.ceil(maxLen * charWidth(fontSize)) +
    28;

  // Stable mirrors of render-time values for use inside stable RAF/effect closures.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const rowHRef = useRef(rowH);
  rowHRef.current = rowH;
  const selectedLinesRef = useRef(selectedLines);
  selectedLinesRef.current = selectedLines;

  const rowVirtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 12,
  });

  const findRe = useMemo(
    () => (findOpen ? buildFindRe(query, findRegex, findCase) : null),
    [query, findOpen, findRegex, findCase],
  );
  // Regex mode with a non-empty query that failed to compile: flag it so the bar
  // can say "Invalid regex" instead of a misleading "0 / 0".
  const findInvalid =
    findOpen && findRegex && query.length > 0 && findRe === null;

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

  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowH]);

  useEffect(() => {
    setCurrent(0);
  }, [query]);
  useEffect(() => {
    if (findOpen) findInputRef.current?.focus();
  }, [findOpen]);

  useEffect(() => {
    if (!hits.length) return;
    const h = hits[Math.min(current, hits.length - 1)];
    if (!h) return;
    rowVirtualizer.scrollToIndex(h.ri, { align: "center" });
  }, [current, hits]);

  // Remembers, while the view mode is stable, the "keep" line — the selected line
  // on screen, else the viewport-center line — together with its pixel offset
  // inside the viewport, plus the shift-anchor line. A viewMode switch then keeps
  // the "keep" line pinned at the same spot, mapping through the line number since
  // a given line lands at different row indices in "all" vs "matches".
  const prevViewModeRef = useRef(viewMode);
  const keepLineRef = useRef<number | null>(null);
  const keepOffsetRef = useRef(0);
  const shiftAnchorLineRef = useRef<number | null>(null);

  // Switching files remounts this component (keyed by file.id in App), which
  // resets the virtualizer — including its internal scrollOffset cache, which
  // a same-instance reset can't reach: it only updates via scroll events, so
  // when the browser had already clamped scrollTop to 0 after the content
  // shrank, scrollToIndex(0) was a no-op and the stale offset rendered the
  // view's tail rows below a blank gap until a reload.

  // Reset selection only when the underlying log content changes (file switch /
  // reload) — keyed on the stable `lines` identity, NOT `view`, since `view` is
  // re-created on every state patch (e.g. a Ctrl+H view-mode toggle) and would
  // otherwise wipe the selection on each one.
  useEffect(() => {
    setSelectedLines(new Set());
    setAnchorRi(null);
  }, [lines]);

  // Edit ▸ Select All — select every currently-visible line.
  useEffect(() => {
    if (!selectAllNonce) return;
    setSelectedLines(new Set(visible.map((r) => r.n)));
    setAnchorRi(visible.length ? visible.length - 1 : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectAllNonce]);

  // Edit ▸ Go to… — scroll to (and select) the requested line number, or the
  // nearest visible line at/after it.
  useEffect(() => {
    if (!gotoSignal || !visible.length) return;
    const { n } = gotoSignal;
    let idx = visible.findIndex((r) => r.n === n);
    if (idx < 0) idx = visible.findIndex((r) => r.n >= n);
    if (idx < 0) idx = visible.length - 1;
    rowVirtualizer.scrollToIndex(idx, { align: "center" });
    setSelectedLines(new Set([visible[idx].n]));
    setAnchorRi(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gotoSignal?.nonce]);

  const scrollTop = rowVirtualizer.scrollOffset ?? 0;
  const viewH = scrollRef.current?.clientHeight ?? 600;

  // Per-file scroll restore. The saved offset is captured once at mount (file.id
  // is stable for this component instance — App keys LogView by it). We restore it
  // once `visible` has rows by writing scrollTop on the scroll element directly
  // inside rAF: calling the virtualizer's scrollToOffset on a just-mounted
  // instance doesn't stick, and rows are fixed-height (estimateSize === rowH, no
  // dynamic measurement) so a pixel offset maps back exactly. The native scroll
  // then syncs the virtualizer. Saving is gated on scrollRestoredRef so the
  // mount-time scrollTop (0) can't overwrite the value we're about to restore.
  const restoreTargetRef = useRef(scrollByFile[file.id] ?? 0);
  const scrollRestoredRef = useRef(false);
  useEffect(() => {
    if (scrollRestoredRef.current || visible.length === 0) return;
    const target = restoreTargetRef.current;
    const el = scrollRef.current;
    if (target > 0 && el) {
      const raf = requestAnimationFrame(() => {
        el.scrollTop = target;
        scrollRestoredRef.current = true;
      });
      return () => cancelAnimationFrame(raf);
    }
    scrollRestoredRef.current = true;
  }, [visible.length]);
  useEffect(() => {
    if (scrollRestoredRef.current) scrollByFile[file.id] = scrollTop;
  }, [scrollTop, file.id]);

  // Sample the "keep" line + shift-anchor line, but only while the mode is stable:
  // on the switch render `visible` has already flipped to the new mode while
  // `scrollTop` still reflects the old one, so pairing them would be wrong.
  useEffect(() => {
    if (prevViewModeRef.current !== viewMode) return;
    if (!visible.length) {
      keepLineRef.current = null;
      shiftAnchorLineRef.current = null;
      return;
    }
    const last = visible.length - 1;
    const firstVi = Math.max(0, Math.floor(scrollTop / rowH));
    const lastVi = Math.min(last, Math.floor((scrollTop + viewH) / rowH));
    const centerIdx = Math.min(
      last,
      Math.max(0, Math.floor((scrollTop + viewH / 2) / rowH)),
    );
    // Prefer the on-screen selected line nearest the centre; otherwise the centre line.
    let idx = centerIdx;
    if (selectedLines.size) {
      let best = -1,
        bestDist = Infinity;
      for (let i = firstVi; i <= lastVi; i++) {
        if (selectedLines.has(visible[i].n)) {
          const d = Math.abs(i - centerIdx);
          if (d < bestDist) {
            bestDist = d;
            best = i;
          }
        }
      }
      if (best >= 0) idx = best;
    }
    keepLineRef.current = visible[idx].n;
    keepOffsetRef.current = idx * rowH - scrollTop; // pixel offset of the line's top within the viewport
    shiftAnchorLineRef.current =
      anchorRi != null ? (visible[anchorRi]?.n ?? null) : null;
  }, [scrollTop, viewH, visible, viewMode, rowH, anchorRi, selectedLines]);

  // Switching between "all" and "matches" keeps the "keep" line pinned at the same
  // vertical spot (instead of jumping to the top) and preserves the selection.
  useEffect(() => {
    if (prevViewModeRef.current === viewMode) return;
    prevViewModeRef.current = viewMode;
    // remap the shift-anchor through its line number; null if it's no longer shown
    const remapAnchor = () => {
      const al = shiftAnchorLineRef.current;
      setAnchorRi(
        al == null
          ? null
          : (() => {
              const i = visible.findIndex((r) => r.n === al);
              return i >= 0 ? i : null;
            })(),
      );
    };
    // Switching to "Show all": if a line is selected, recentre it — even one
    // scrolled out of sight — so the selection is always brought back into view.
    // The selected line nearest the keep line is found here, at switch time,
    // rather than rescanning the whole view on every scroll step.
    if (viewMode === "all" && selectedLines.size && visible.length) {
      const keep = keepLineRef.current;
      let selLine: number | null = null,
        bestDist = Infinity;
      for (const sn of selectedLines) {
        const d = keep == null ? 0 : Math.abs(sn - keep);
        if (d < bestDist) {
          bestDist = d;
          selLine = sn;
        }
      }
      const idx =
        selLine == null ? -1 : visible.findIndex((r) => r.n === selLine);
      if (idx >= 0) {
        rowVirtualizer.scrollToIndex(idx, { align: "center" });
        remapAnchor();
        return;
      }
    }
    const keep = keepLineRef.current;
    if (keep == null || !visible.length) {
      rowVirtualizer.scrollToIndex(0);
      return;
    }
    let idx = visible.findIndex((r) => r.n === keep);
    if (idx < 0) idx = visible.findIndex((r) => r.n >= keep); // line hidden in new mode → next one
    if (idx < 0) idx = visible.length - 1;
    rowVirtualizer.scrollToOffset(
      Math.max(0, idx * rowH - keepOffsetRef.current),
    );
    remapAnchor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);

  // Jump to a bookmarked line from the Bookmarks tab: scroll it to centre and
  // select it. Declared after the view-mode switch effect so that when a hidden
  // marker forces a switch to "Show all", this final scroll wins.
  useEffect(() => {
    if (!markerJump || !visible.length) return;
    let idx = visible.findIndex((r) => r.n === markerJump.n);
    if (idx < 0) idx = visible.findIndex((r) => r.n >= markerJump.n);
    if (idx < 0) idx = visible.length - 1;
    rowVirtualizer.scrollToIndex(idx, { align: "center" });
    setSelectedLines(new Set([visible[idx].n]));
    setAnchorRi(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markerJump?.nonce]);

  // The match map repaints on every scroll step (the viewport indicator moves),
  // but the marks themselves only change with the view. So the marks render
  // into an offscreen canvas when *they* change, and the per-scroll repaint is
  // a single drawImage plus the indicator — instead of one fillRect per matched
  // line per frame, which froze scrolling once many filters matched many lines.
  const mapMarksRef = useRef<HTMLCanvasElement | null>(null);
  // Bookmark notch positions, precomputed with the marks and drawn in the
  // composite pass so they keep sitting above the viewport indicator.
  const mapNotchesRef = useRef<{ y: number; h: number; color: string }[]>([]);
  useEffect(() => {
    const canvas = mapCanvasRef.current;
    if (!canvas) return;
    const { width: w, height: h } = canvas;
    const marks =
      mapMarksRef.current ??
      (mapMarksRef.current = document.createElement("canvas"));
    marks.width = w; // resizing also clears the layer
    marks.height = h;
    mapNotchesRef.current = [];
    if (!visible.length || !w || !h) return;
    const ctx = marks.getContext("2d")!;
    const total = visible.length;
    const markH = Math.max(1, Math.round(h / total));
    // The map is only `h` pixels tall, so paint per pixel bucket (the last row
    // landing on a pixel wins, same as drawing rows in order) — O(rows + h)
    // instead of a fillRect per matched row.
    const bucket: (string | null)[] = new Array(h).fill(null);
    for (let ri = 0; ri < total; ri++) {
      const r = visible[ri];
      if (!r.winner) continue;
      const color =
        mapColorMode === "text" ? r.winner.f.textColor : r.winner.f.bgColor;
      const y = Math.round((ri / total) * h);
      for (let yy = y, end = Math.min(h, y + markH); yy < end; yy++)
        bucket[yy] = color;
    }
    for (let y = 0; y < h; ) {
      const color = bucket[y];
      if (color === null) {
        y++;
        continue;
      }
      let end = y + 1;
      while (end < h && bucket[end] === color) end++;
      ctx.fillStyle = color;
      ctx.fillRect(0, y, w, end - y);
      y = end;
    }
    if (markerMap.size) {
      for (let ri = 0; ri < total; ri++) {
        const mk = markerMap.get(visible[ri].n);
        if (!mk) continue;
        const y = Math.round((ri / total) * h);
        mapNotchesRef.current.push({
          y: Math.max(0, y - 1),
          h: Math.max(2, markH),
          color: markerColor(mk.icon),
        });
      }
    }
  }, [visible, viewH, mapColorMode, mapWidth, markerMap]);

  // Composite pass: marks layer + viewport indicator + bookmark notches. Runs
  // per scroll step but does O(1) work (plus one rect per bookmark). Declared
  // after the marks effect so a marks redraw (same render) lands before
  // compositing; its deps must therefore be a superset of the marks effect's.
  useEffect(() => {
    const canvas = mapCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    if (!visible.length) return;
    const marks = mapMarksRef.current;
    if (marks && marks.width === w && marks.height === h)
      ctx.drawImage(marks, 0, 0);
    const contentH = visible.length * rowH;
    const vpTop = Math.round((scrollTop / Math.max(1, contentH)) * h);
    const vpH = Math.max(6, Math.round((viewH / Math.max(1, contentH)) * h));
    ctx.fillStyle = "rgba(0,0,0,0.07)";
    ctx.fillRect(0, vpTop, w, vpH);
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, vpTop + 0.5, w - 1, Math.max(5, vpH - 1));
    // Bookmark notches on the left edge, drawn last so they sit above everything.
    const notchW = Math.min(4, w);
    for (const nt of mapNotchesRef.current) {
      ctx.fillStyle = nt.color;
      ctx.fillRect(0, nt.y, notchW, nt.h);
    }
  }, [visible, viewH, scrollTop, rowH, mapColorMode, mapWidth, markerMap]);

  function nav(dir: number) {
    if (!hits.length) return;
    setCurrent((c) => (c + dir + hits.length) % hits.length);
  }
  const currentKey = hits.length
    ? hits[Math.min(current, hits.length - 1)].key
    : null;

  // Scrub the view by clicking or dragging the match map: map a y position to a
  // row index and centre it.
  const mapDragRef = useRef(false);
  function scrollMapToY(clientY: number) {
    const canvas = mapCanvasRef.current;
    if (!canvas || !visible.length) return;
    const rect = canvas.getBoundingClientRect();
    const y = clientY - rect.top;
    const ri = Math.max(
      0,
      Math.min(
        visible.length - 1,
        Math.floor((y / rect.height) * visible.length),
      ),
    );
    rowVirtualizer.scrollToIndex(ri, { align: "center" });
  }
  function onMapPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    mapDragRef.current = true;
    scrollMapToY(e.clientY);
  }
  function onMapPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (mapDragRef.current) scrollMapToY(e.clientY);
  }
  function onMapPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    mapDragRef.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  // Open the bookmark editor with a fresh draft (seeded from the existing marker
  // when one is present). Nothing is created/changed until Done/Enter commits.
  function openMarkerEditor(n: number, x: number, y: number) {
    const ex = markerMap.get(n);
    setMarkerDraft(
      ex
        ? { icon: ex.icon, note: ex.note, isNew: false }
        : { icon: "bookmark", note: "", isNew: true },
    );
    setMarkerPop({ x, y, n });
  }
  function closeMarkerEditor() {
    setMarkerPop(null);
    setMarkerDraft(null);
  }
  function commitMarker() {
    if (markerPop && markerDraft)
      onSetMarker(markerPop.n, markerDraft.icon, markerDraft.note);
    closeMarkerEditor();
  }

  // Click the gutter marker lane: open the editor popover next to the icon.
  function onMarkClick(e: React.MouseEvent, n: number) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMarkerEditor(n, rect.right + 6, rect.top - 4);
  }

  function onRowClick(e: React.MouseEvent, ri: number, n: number) {
    if (e.altKey) {
      toggleExpand(n);
      return;
    } // Alt+click toggles the field table
    // Shift+click selects the inclusive range from the anchor. Handled before the
    // text-selection guard below: the browser extends a *text* selection on
    // shift+click, so clear it and range-select rows instead.
    if (e.shiftKey && anchorRi != null) {
      window.getSelection()?.removeAllRanges();
      const a = Math.min(anchorRi, ri),
        b = Math.max(anchorRi, ri);
      const set = new Set(e.ctrlKey || e.metaKey ? selectedLines : []);
      for (let i = a; i <= b && i < visible.length; i++) set.add(visible[i].n);
      setSelectedLines(set);
      return;
    }
    const s = window.getSelection();
    if (s && !s.isCollapsed) return; // a genuine text drag-selection — leave it be
    if (e.ctrlKey || e.metaKey) {
      const set = new Set(selectedLines);
      if (set.has(n)) set.delete(n);
      else set.add(n);
      setSelectedLines(set);
      setAnchorRi(ri);
    } else {
      setSelectedLines(new Set([n]));
      setAnchorRi(ri);
    }
  }

  function handleRowMouseDown(e: React.MouseEvent, ri: number) {
    if (e.altKey) {
      e.preventDefault();
      return;
    } // don't start a text selection on Alt+click
    if (e.shiftKey) {
      e.preventDefault();
      return;
    } // shift+click range-selects rows, not text
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault(); // prevent text selection during ctrl+drag
    dragStartRiRef.current = ri;
    isDragSelectingRef.current = false;
    // Begin on a selected row → the drag deselects rows it covers; begin on an
    // unselected row → it selects them. Fixing the direction here (rather than
    // always adding) makes back-dragging symmetric and lets a drag clear lines a
    // previous drag selected, by starting it on one of them.
    const startN = visible[ri]?.n;
    dragModeRef.current =
      startN != null && selectedLines.has(startN) ? "remove" : "add";
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
    // Rebuild from the pre-drag base each move so dragging back reverts rows to
    // their original state; the paint direction decides add vs. remove.
    const a = Math.min(start, ri),
      b = Math.max(start, ri);
    const next = new Set(dragBaseSetRef.current);
    for (let i = a; i <= b && i < visible.length; i++) {
      if (dragModeRef.current === "remove") next.delete(visible[i].n);
      else next.add(visible[i].n);
    }
    setSelectedLines(next);
  }

  useEffect(() => {
    function onUp() {
      isDragSelectingRef.current = false;
      dragStartRiRef.current = null;
      dragMouseYRef.current = null;
      if (dragScrollRAFRef.current !== null) {
        cancelAnimationFrame(dragScrollRAFRef.current);
        dragScrollRAFRef.current = null;
      }
    }
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  // Auto-scroll during ctrl+drag: when the cursor goes above or below the scroll
  // container's edges, scroll and extend the selection to the row now at that edge.
  useEffect(() => {
    function tick() {
      dragScrollRAFRef.current = null;
      const el = scrollRef.current;
      const mouseY = dragMouseYRef.current;
      const start = dragStartRiRef.current;
      if (!el || start === null || mouseY === null) return;

      const rect = el.getBoundingClientRect();
      const EDGE = 60;
      const MAX_SPEED = 12;
      let delta = 0;
      if (mouseY < rect.top + EDGE)
        delta = -MAX_SPEED * Math.min(1, (rect.top + EDGE - mouseY) / EDGE);
      else if (mouseY > rect.bottom - EDGE)
        delta = MAX_SPEED * Math.min(1, (mouseY - (rect.bottom - EDGE)) / EDGE);

      if (Math.abs(delta) < 0.5) return; // cursor not near edge — let normal mouseenter handle selection

      el.scrollTop = Math.max(
        0,
        Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + delta),
      );

      // Find which row is now at the clamped cursor position and extend selection.
      const clampedY = Math.max(rect.top, Math.min(rect.bottom - 1, mouseY));
      const vis = visibleRef.current;
      const rh = rowHRef.current;
      const ri = Math.max(
        0,
        Math.min(
          vis.length - 1,
          Math.floor((el.scrollTop + (clampedY - rect.top)) / rh),
        ),
      );

      if (!isDragSelectingRef.current) {
        isDragSelectingRef.current = true;
        dragBaseSetRef.current = new Set(selectedLinesRef.current);
        setAnchorRi(start);
      }
      const lo = Math.min(start, ri),
        hi = Math.max(start, ri);
      const next = new Set(dragBaseSetRef.current);
      for (let i = lo; i <= hi && i < vis.length; i++) {
        if (dragModeRef.current === "remove") next.delete(vis[i].n);
        else next.add(vis[i].n);
      }
      setSelectedLines(next);

      dragScrollRAFRef.current = requestAnimationFrame(tick);
    }

    function onMove(e: MouseEvent) {
      if (dragStartRiRef.current === null) return;
      dragMouseYRef.current = e.clientY;
      if (dragScrollRAFRef.current === null) {
        dragScrollRAFRef.current = requestAnimationFrame(tick);
      }
    }

    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  function handleMouseUp() {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!text || !sel?.rangeCount) {
      setSelMenu(null);
      return;
    }
    if (!scrollRef.current?.contains(sel.anchorNode)) {
      setSelMenu(null);
      return;
    }
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
      .map((r) =>
        showLineNumbers ? `${String(r.n).padStart(8)}  ${r.text}` : r.text,
      )
      .join("\n");
    navigator.clipboard.writeText(out).catch(() => {});
    toast.success(
      `Copied ${selectedLines.size.toLocaleString()} line${selectedLines.size > 1 ? "s" : ""}`,
    );
    return true;
  }

  // Toggle a bookmark on a line from the keyboard: instant add (default icon, no
  // note) / remove — the note+icon editor stays a click/right-click away.
  function toggleBookmarkAt(n: number) {
    if (markerMap.has(n)) onRemoveMarker(n);
    else onSetMarker(n, "bookmark", "");
  }

  // Jump to the next (dir +1) / previous (dir −1) bookmarked line among the
  // currently-visible rows, relative to the single selected line (or the ends
  // when nothing is selected). Wraps around. Selects + centers the target.
  function navMarker(dir: 1 | -1) {
    const marked = visible.filter((r) => markerMap.has(r.n)).map((r) => r.n); // ascending (visible is in line order)
    if (!marked.length) return;
    const ref = selectedLines.size === 1 ? [...selectedLines][0] : null;
    let target: number;
    if (ref == null) {
      target = dir === 1 ? marked[0] : marked[marked.length - 1];
    } else if (dir === 1) {
      target = marked.find((n) => n > ref) ?? marked[0];
    } else {
      const before = marked.filter((n) => n < ref);
      target = before.length
        ? before[before.length - 1]
        : marked[marked.length - 1];
    }
    const idx = visible.findIndex((r) => r.n === target);
    if (idx < 0) return;
    setSelectedLines(new Set([target]));
    setAnchorRi(idx);
    rowVirtualizer.scrollToIndex(idx, { align: "center" });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
        // Select every currently-visible line.
        e.preventDefault();
        setSelectedLines(new Set(visible.map((r) => r.n)));
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
        const s = window.getSelection();
        if (s && !s.isCollapsed) return;
        if (selectedLines.size) {
          e.preventDefault();
          copySelectedLines();
        }
      } else if (e.key === "Escape" && selectedLines.size) {
        setSelectedLines(new Set());
      } else if (e.key === " " && selectedLines.size === 1) {
        // Space toggles the single selected line's parsed-field table (if any).
        const n = [...selectedLines][0];
        if (visible.find((r) => r.n === n)?.fieldsFromId !== undefined) {
          e.preventDefault();
          toggleExpand(n);
        }
      } else if (e.key === "ArrowRight" && selectedLines.size === 1) {
        // Expand the single selected line's parsed fields (if it has any).
        const n = [...selectedLines][0];
        if (visible.find((r) => r.n === n)?.fieldsFromId !== undefined) {
          e.preventDefault();
          setExpandedLines((s) => new Set(s).add(n));
        }
      } else if (e.key === "ArrowLeft" && selectedLines.size === 1) {
        const n = [...selectedLines][0];
        setExpandedLines((s) => {
          const x = new Set(s);
          x.delete(n);
          return x;
        });
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "d" || e.key === "D")) {
        // Bookmark keys: Ctrl+D toggle · Ctrl+, prev · Ctrl+. next (, . are the
        // < > keys, so prev/next sit adjacent and stay on the home row).
        e.preventDefault();
        if (selectedLines.size === 1) toggleBookmarkAt([...selectedLines][0]);
      } else if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        navMarker(-1);
      } else if ((e.ctrlKey || e.metaKey) && e.key === ".") {
        e.preventDefault();
        navMarker(1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedLines, visible, showLineNumbers, markerMap]);

  function exportView() {
    const text = visible
      .map((r) => String(r.n).padStart(8) + "  " + r.text)
      .join("\n");
    const base = file.name.replace(/\.log$/i, "");
    onExportView?.(base + ".filtered.log", text);
  }

  // Counted once in computeView — scanning view.rows here would run on every
  // render, i.e. on every scroll step.
  const matchedCount = view.matchedCount;
  const hiddenByExclude = view.excludedCount;

  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  function onRowContextMenu(e: React.MouseEvent, ri: number, n: number) {
    e.preventDefault();
    setSelMenu(null);
    // Right-clicking highlights the row — unless it's already part of a
    // multi-selection, which we keep (so "Add N lines to compare" still works).
    if (!selectedLines.has(n)) {
      setSelectedLines(new Set([n]));
      setAnchorRi(ri);
    }
    setRowMenu({ x: e.clientX, y: e.clientY, n });
  }

  useEffect(() => {
    if (!rowMenu) return;
    function h(e: MouseEvent) {
      const menu = document.querySelector(".row-menu");
      if (menu && !menu.contains(e.target as Node)) setRowMenu(null);
    }
    function esc(e: KeyboardEvent) {
      if (e.key === "Escape") setRowMenu(null);
    }
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", esc);
    };
  }, [rowMenu]);

  // Dismiss the bookmark popover on an outside click (discards uncommitted edits;
  // Esc is handled in-input).
  useEffect(() => {
    if (!markerPop) return;
    function h(e: MouseEvent) {
      const pop = document.querySelector(".marker-pop");
      if (pop && !pop.contains(e.target as Node)) closeMarkerEditor();
    }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [markerPop]);

  return (
    <div
      className="logview"
      style={{ ...style, "--log-gut-w": `${gutterW}px` } as CSSProperties}
    >
      {/* header */}
      <div className="logview-bar">
        <div className="lv-title">
          <FileText size={15} style={{ color: "#4f8cff" }} />
          {file.name}
          {file.encoding && (
            <Tooltip>
              <TooltipTrigger render={<span className="enc-badge" />}>
                {file.encoding}
              </TooltipTrigger>
              <TooltipContent>Detected text encoding</TooltipContent>
            </Tooltip>
          )}
        </div>
        {soloPattern != null && (
          <div
            className="lv-solo"
            title="Showing only lines matched by this one filter"
          >
            <Eye size={13} />
            <span className="lv-solo-label">
              Viewing only: <code>{soloPattern}</code>
            </span>
            <button
              className="lv-solo-x"
              title="Exit filter-only view"
              onClick={onExitSolo}
            >
              <X size={12} />
            </button>
          </div>
        )}
        <div className="lv-spacer" />
        <div className="lv-stat">
          <b>{visible.length.toLocaleString()}</b>
          {" / " + view.rows.length.toLocaleString() + " lines"}
          {view.hasHighlights && (
            <span>
              {"  ·  "}
              <b>{matchedCount.toLocaleString()}</b>
              {" matched"}
            </span>
          )}
          {hiddenByExclude > 0 && (
            <span style={{ color: "var(--error)" }}>
              {"  ·  " + hiddenByExclude.toLocaleString() + " excluded"}
            </span>
          )}
          {selectedLines.size > 0 && (
            <span className="lv-sel">
              {"  ·  "}
              <b>{selectedLines.size.toLocaleString()}</b>
              {" selected"}
            </span>
          )}
        </div>
        <div className="lv-actions">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  className={
                    "dock-btn lv-toggle" +
                    (viewMode === "matches" ? " active" : "")
                  }
                  disabled={!view.hasHighlights}
                  onClick={() =>
                    onToggleViewMode(viewMode === "matches" ? "all" : "matches")
                  }
                />
              }
            >
              <Filter size={14} />
            </TooltipTrigger>
            <TooltipContent>
              {!view.hasHighlights
                ? "No filters to match"
                : viewMode === "matches"
                  ? "Showing matched lines only  (Ctrl+H)"
                  : "Show only matched lines  (Ctrl+H)"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  className={"dock-btn lv-toggle" + (findOpen ? " active" : "")}
                  onClick={onToggleFind}
                />
              }
            >
              <Search size={14} />
            </TooltipTrigger>
            <TooltipContent>Find (Ctrl+F)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={<button className="dock-btn" onClick={exportView} />}
            >
              <Download size={14} />
            </TooltipTrigger>
            <TooltipContent>Export filtered view</TooltipContent>
          </Tooltip>
        </div>
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
              if (e.key === "Enter") {
                e.preventDefault();
                nav(e.shiftKey ? -1 : 1);
              }
              if (e.key === "Escape") onCloseFind();
            }}
          />
          <div className="find-opts">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    className={"find-opt" + (findCase ? " active" : "")}
                    aria-pressed={findCase}
                    onClick={() => setFindCase((v) => !v)}
                  />
                }
              >
                Aa
              </TooltipTrigger>
              <TooltipContent>Match case</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    className={"find-opt" + (findRegex ? " active" : "")}
                    aria-pressed={findRegex}
                    onClick={() => setFindRegex((v) => !v)}
                  />
                }
              >
                .*
              </TooltipTrigger>
              <TooltipContent>Use regular expression</TooltipContent>
            </Tooltip>
          </div>
          <span className={"find-count" + (findInvalid ? " invalid" : "")}>
            {findInvalid
              ? "Invalid regex"
              : hits.length
                ? `${Math.min(current + 1, hits.length)} / ${hits.length}`
                : query
                  ? "0 / 0"
                  : ""}
          </span>
          <div className="find-divider" />
          <div className="find-nav">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => nav(-1)}
                  />
                }
              >
                <ArrowUp size={15} />
              </TooltipTrigger>
              <TooltipContent>Previous (Shift+Enter)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => nav(1)}
                  />
                }
              >
                <ArrowDown size={15} />
              </TooltipTrigger>
              <TooltipContent>Next (Enter)</TooltipContent>
            </Tooltip>
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="icon-sm" onClick={onCloseFind} />
              }
            >
              <X size={15} />
            </TooltipTrigger>
            <TooltipContent>Close (Esc)</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* content */}
      {visible.length === 0 ? (
        <div className="log-empty">
          <Filter
            size={24}
            style={{ color: "var(--text-3)", marginBottom: 4 }}
          />
          <div>No lines match the active filters.</div>
          <div style={{ fontSize: 12 }}>
            Switch to "Show all" or disable a filter.
          </div>
        </div>
      ) : (
        <div className="log-content-area">
          <div
            className={
              "log-scroll scroll" +
              (showLineNumbers ? "" : " no-gutter") +
              (altDown ? " alt-mode" : "")
            }
            ref={scrollRef}
            onMouseDown={() => setSelMenu(null)}
            onMouseUp={handleMouseUp}
            onScroll={clearHover}
            style={{ overflowY: "auto", overflowX: "auto" }}
          >
            <div
              className="log-inner"
              style={{
                minWidth: minW,
                height: totalSize,
                position: "relative",
              }}
            >
              {virtualItems.map((vItem) => {
                const r = visible[vItem.index];
                const w = r.winner;
                const dim = viewMode === "all" && view.hasHighlights && !w;
                const sel = selectedLines.has(r.n);
                const mk = markerMap.get(r.n);
                const canExpand = r.fieldsFromId !== undefined;
                const expanded = expandedLines.has(r.n);
                const expFields = expanded ? view.fieldsFor(r.n) : undefined;
                const rowStyle: CSSProperties = {
                  height: rowH,
                  // --strip colors the sticky left rail's 3px strip (see .log-left).
                  ...(w
                    ? {
                        background: w.f.bgColor,
                        color: w.f.textColor,
                        ["--strip" as string]: w.f.bgColor,
                      }
                    : {}),
                } as CSSProperties;
                return (
                  <div
                    key={r.n}
                    data-index={vItem.index}
                    ref={rowVirtualizer.measureElement}
                    className="log-rowwrap"
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vItem.start}px)`,
                    }}
                  >
                    <div
                      className={
                        "log-row" +
                        (w ? " matched" : "") +
                        (dim ? " dim" : "") +
                        (sel ? " selected" : "") +
                        (canExpand ? " expandable" : "")
                      }
                      style={rowStyle}
                      onMouseDown={(e) => {
                        clearHover();
                        handleRowMouseDown(e, vItem.index);
                      }}
                      onMouseEnter={(e) => {
                        handleRowMouseEnter(vItem.index);
                        armHover(e, r.n);
                      }}
                      onMouseLeave={clearHover}
                      onClick={(e) => onRowClick(e, vItem.index, r.n)}
                      onContextMenu={(e) => {
                        clearHover();
                        onRowContextMenu(e, vItem.index, r.n);
                      }}
                    >
                      {/* sticky left rail: marker + chevron + line number stay
                          pinned to the left edge while the row scrolls right */}
                      <span className="log-left">
                        <span
                          className={"log-mark" + (mk ? " on" : "")}
                          title={
                            mk ? mk.note || "Edit bookmark" : "Add bookmark"
                          }
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            onMarkClick(e, r.n);
                          }}
                        >
                          {mk ? (
                            <MarkerGlyph icon={mk.icon} />
                          ) : (
                            <Bookmark size={12} />
                          )}
                        </span>
                        {canExpand && (
                          <span
                            className={"log-exp" + (expanded ? " on" : "")}
                            title={
                              expanded
                                ? "Collapse fields (Alt+click)"
                                : "Expand parsed fields (Alt+click)"
                            }
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleExpand(r.n);
                            }}
                          >
                            {expanded ? (
                              <ChevronDown size={13} />
                            ) : (
                              <ChevronRight size={13} />
                            )}
                          </span>
                        )}
                        {showLineNumbers && (
                          <span className="log-gut">{r.n}</span>
                        )}
                      </span>
                      <span className="log-txt">
                        {renderLine(r.text, findRe, currentKey, vItem.index)}
                      </span>
                    </div>
                    {expFields && (
                      <div className="log-fieldpanel">
                        <FieldTable fields={expFields} />
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
              title="Match map — click or drag to scrub"
              onPointerDown={onMapPointerDown}
              onPointerMove={onMapPointerMove}
              onPointerUp={onMapPointerUp}
            >
              <canvas ref={mapCanvasRef} width={mapWidth} height={viewH} />
            </div>
          )}
        </div>
      )}

      {/* selection popup */}
      {selMenu && (
        <div className="sel-menu" style={{ left: selMenu.x, top: selMenu.y }}>
          <button
            onClick={() => {
              onBuildFilter(selMenu.text, "exact");
              setSelMenu(null);
            }}
            title="Add the selected text as a new filter"
          >
            <Filter size={13} /> Filter exact text…
          </button>
          <button
            onClick={() => {
              onBuildFilter(selMenu.text, "pattern");
              setSelMenu(null);
            }}
            title="Generalize the selection into a regex — numbers, hex and timestamps become patterns"
          >
            <Sparkles size={13} /> Filter as pattern…
          </button>
        </div>
      )}

      {/* logline right-click menu */}
      {rowMenu &&
        (() => {
          // The menu acts on the multi-selection when the clicked row is part of
          // it, else on the clicked row alone. Lines already in the comparison
          // and lines not yet there each get their own action, so a mixed
          // selection shows both.
          const menu = rowMenu;
          const sel =
            selectedLines.has(menu.n) && selectedLines.size > 1
              ? [...selectedLines]
              : [menu.n];
          // Only parsed lines (those with extracted fields) can join the
          // comparison, so the add/remove counts must exclude raw lines.
          const parsed = sel.filter(
            (n) => view.rows[n - 1]?.fieldsFromId !== undefined,
          );
          const inCmp = parsed.filter((n) => compareLines.has(n));
          const notIn = parsed.filter((n) => !compareLines.has(n));
          const inTl = parsed.filter((n) => timelineLines.has(n));
          const notInTl = parsed.filter((n) => !timelineLines.has(n));
          return (
            <div
              className="menu-pop row-menu"
              style={{
                position: "fixed",
                left: menu.x,
                top: menu.y,
                zIndex: 60,
              }}
            >
              <div
                className="menu-item"
                onClick={() => {
                  copySelectedLines();
                  setRowMenu(null);
                }}
              >
                <span className="mi-ico">
                  <Copy size={14} />
                </span>
                {selectedLines.size > 1 && selectedLines.has(menu.n)
                  ? `Copy ${selectedLines.size} lines`
                  : "Copy line"}
              </div>
              <div className="menu-sep" />
              {markerMap.has(menu.n) ? (
                <>
                  <div
                    className="menu-item"
                    onClick={() => {
                      openMarkerEditor(menu.n, menu.x, menu.y);
                      setRowMenu(null);
                    }}
                  >
                    <span className="mi-ico">
                      <Bookmark size={14} />
                    </span>{" "}
                    Edit bookmark…
                  </div>
                  <div
                    className="menu-item danger"
                    onClick={() => {
                      onRemoveMarker(menu.n);
                      setRowMenu(null);
                    }}
                  >
                    <span className="mi-ico">
                      <Trash2 size={14} />
                    </span>{" "}
                    Remove bookmark
                  </div>
                </>
              ) : (
                <div
                  className="menu-item"
                  onClick={() => {
                    openMarkerEditor(menu.n, menu.x, menu.y);
                    setRowMenu(null);
                  }}
                >
                  <span className="mi-ico">
                    <Bookmark size={14} />
                  </span>{" "}
                  Add bookmark…
                </div>
              )}
              <div className="menu-sep" />
              {parsed.length === 0 ? (
                <div className="menu-item disabled">
                  <span className="mi-ico">
                    <Columns3 size={14} />
                  </span>{" "}
                  No parsed fields
                </div>
              ) : (
                notIn.length > 0 && (
                  <div
                    className="menu-item"
                    onClick={() => {
                      onAddToCompare(notIn);
                      setRowMenu(null);
                    }}
                  >
                    <span className="mi-ico">
                      <Columns3 size={14} />
                    </span>
                    {notIn.length > 1
                      ? `Add ${notIn.length} lines to compare`
                      : "Add to compare"}
                  </div>
                )
              )}
              {inCmp.length > 0 && (
                <div
                  className="menu-item mi-remove"
                  onClick={() => {
                    onRemoveFromCompare(inCmp);
                    setRowMenu(null);
                  }}
                >
                  <span className="mi-ico">
                    <Minus size={14} />
                  </span>
                  {inCmp.length > 1
                    ? `Remove ${inCmp.length} lines from compare`
                    : "Remove from compare"}
                </div>
              )}
              {parsed.length > 0 && notInTl.length > 0 && (
                <div
                  className="menu-item"
                  onClick={() => {
                    onAddToTimeline(notInTl);
                    setRowMenu(null);
                  }}
                >
                  <span className="mi-ico">
                    <ChartGantt size={14} />
                  </span>
                  {notInTl.length > 1
                    ? `Add ${notInTl.length} lines to timeline`
                    : "Add to timeline"}
                </div>
              )}
              {inTl.length > 0 && (
                <div
                  className="menu-item mi-remove"
                  onClick={() => {
                    onRemoveFromTimeline(inTl);
                    setRowMenu(null);
                  }}
                >
                  <span className="mi-ico">
                    <Minus size={14} />
                  </span>
                  {inTl.length > 1
                    ? `Remove ${inTl.length} lines from timeline`
                    : "Remove from timeline"}
                </div>
              )}
            </div>
          );
        })()}

      {/* logline hover card — one shared element, anchored at the cursor; only
          shown when there's something to say (matches, panel membership, or
          parsed fields), so raw unmatched lines stay quiet. */}
      {hover &&
        (() => {
          const n = hover.n;
          const matched = view.matchedFiltersFor(n);
          const inCmp = compareLines.has(n);
          const inTl = timelineLines.has(n);
          const fields = view.fieldsFor(n);
          const fieldEntries = fields ? Object.entries(fields) : [];
          if (!matched.length && !inCmp && !inTl && !fieldEntries.length)
            return null;
          const cardW = 300;
          const flipLeft = hover.x > window.innerWidth - (cardW + 16);
          const flipUp = hover.y > window.innerHeight / 2;
          const pos: CSSProperties = {
            maxWidth: cardW,
            left: flipLeft ? undefined : hover.x + 14,
            right: flipLeft ? window.innerWidth - hover.x + 14 : undefined,
            top: flipUp ? undefined : hover.y + 14,
            bottom: flipUp ? window.innerHeight - hover.y + 14 : undefined,
          };
          return (
            <div className="logrow-hover" style={pos}>
              <div className="lrh-head">Line {n}</div>
              {matched.length > 0 && (
                <div>
                  <div className="lrh-label">Matched</div>
                  <div className="lrh-chips">
                    {matched.map((f) => (
                      <span
                        key={f.id}
                        className="lrh-chip"
                        style={{
                          background: f.bgColor,
                          color: f.textColor,
                          borderColor: f.textColor,
                        }}
                      >
                        #{filterSerial.get(f.id) ?? "?"}
                        {f.description ? ` ${f.description}` : ""}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {(inCmp || inTl) && (
                <div className="lrh-badges">
                  {inCmp && (
                    <span className="lrh-badge cmp">
                      <Columns3 size={11} /> In Compare
                    </span>
                  )}
                  {inTl && (
                    <span className="lrh-badge tl">
                      <ChartGantt size={11} /> In Timeline
                    </span>
                  )}
                </div>
              )}
              {fieldEntries.length > 0 && (
                <div className="lrh-fields">
                  {fieldEntries.slice(0, 5).map(([k, v]) => (
                    <div className="lrh-field" key={k}>
                      <span className="lrh-k">{k}</span>
                      <span className="lrh-v">{v.raw}</span>
                    </div>
                  ))}
                  {fieldEntries.length > 5 && (
                    <div className="lrh-more">
                      +{fieldEntries.length - 5} more
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })()}

      {/* bookmark editor popover — edits are a local draft, committed on Done/Enter */}
      {markerPop && markerDraft && (
        <div
          className="marker-pop"
          style={{
            position: "fixed",
            left: markerPop.x,
            top: markerPop.y,
            zIndex: 70,
          }}
        >
          <div className="mp-head">Line {markerPop.n}</div>
          <div className="mp-icons">
            {MARKER_ICONS.map((opt) => (
              <button
                key={opt.id}
                className={
                  "mp-ico" + (markerDraft.icon === opt.id ? " active" : "")
                }
                title={opt.label}
                onClick={() =>
                  setMarkerDraft((d) => d && { ...d, icon: opt.id })
                }
              >
                <opt.Icon
                  size={15}
                  color={opt.color}
                  fill={opt.color}
                  fillOpacity={0.18}
                />
              </button>
            ))}
          </div>
          <input
            className="mp-note"
            placeholder="Add a note…"
            autoFocus
            value={markerDraft.note}
            onChange={(e) =>
              setMarkerDraft((d) => d && { ...d, note: e.target.value })
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitMarker();
              } else if (e.key === "Escape") closeMarkerEditor();
            }}
          />
          <div className="mp-foot">
            {markerDraft.isNew ? (
              <Button size="xs" variant="ghost" onClick={closeMarkerEditor}>
                Cancel
              </Button>
            ) : (
              <Button
                size="xs"
                variant="destructive"
                onClick={() => {
                  onRemoveMarker(markerPop.n);
                  closeMarkerEditor();
                }}
              >
                <Trash2 size={13} /> Remove
              </Button>
            )}
            <Button size="xs" onClick={commitMarker}>
              Done
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
