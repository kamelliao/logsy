import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUpToLine, ChevronDown, ChevronRight, Download, ListPlus, ListX, X } from "lucide-react";
import type { ViewRow } from "../types";
import { Button } from "./ui/button";
import { PanelEmpty } from "./PanelEmpty";

interface CompareTableProps {
  rows: ViewRow[];
  /** Log row height (px) — matched so compare rows align with the log view. */
  rowH: number;
  onRemove: (n: number) => void;
  /** Human label for the filter (pattern) that produced a group of fields. */
  labelFor: (fieldsFromId: string | undefined) => string;
  /** Accent colour for the filter that produced a group of fields. */
  colorFor: (fieldsFromId: string | undefined) => string;
  /** 0-based position of the filter in the set (for the "#N" serial); -1 if gone. */
  indexFor: (fieldsFromId: string | undefined) => number;
  /** Export a single pattern-group's rows as CSV (opens a save dialog). */
  onExport: (fieldsFromId: string | undefined, label: string) => void;
  /** Remove just one pattern-group's lines from the comparison. */
  onClearGroup: (fieldsFromId: string | undefined) => void;
  /** Pull every line this filter parses into the comparison (per-group import). */
  onImportMatching: (fieldsFromId: string | undefined) => void;
  /** Scroll the log view to a compared line (clicking its line number). */
  onJump: (n: number) => void;
  /** Reveal + flash the filter row that produced a group (clicking its header). */
  onFocusFilter: (id: string) => void;
}

// Column widths are estimated from content in `ch` (mono font), clamped so a
// stray long value can't blow out the row and a short one stays readable.
const MIN_COL_CH = 3;
const MAX_COL_CH = 48;
const CELL_PAD = 26; // 13px each side — matches the cell padding in CSS
// A head item = group bar + column-header row. Its height beyond one row is
// fixed in CSS: .cmp-group-head-wrap padding-top (15) + .cmp-group-head (31).
// Keep this in sync with those rules so the fixed-size virtualizer stays exact.
const HEAD_EXTRA = 46;

interface Group {
  id: string;                 // "" for ungrouped/unknown
  key: string | undefined;    // the filter id, or undefined when unknown
  label: string;
  color: string;
  index: number;              // 0-based filter serial, -1 if the filter is gone
  rows: ViewRow[];
  cols: string[];
  template: string;           // grid-template-columns shared by header + rows
}

type Item =
  | { kind: "head"; g: Group }
  | { kind: "row"; g: Group; r: ViewRow; ri: number; last: boolean };

function buildGroups(
  rows: ViewRow[],
  labelFor: CompareTableProps["labelFor"],
  colorFor: CompareTableProps["colorFor"],
  indexFor: CompareTableProps["indexFor"],
): Group[] {
  // Group compared rows by the filter that parsed them (one table per pattern).
  const map = new Map<string, ViewRow[]>();
  for (const r of rows) {
    const id = r.fieldsFromId ?? "";
    (map.get(id) ?? map.set(id, []).get(id)!).push(r);
  }
  const out: Group[] = [];
  for (const [id, grpRows] of map) {
    const key = id || undefined;
    // Columns in first-seen order; widest content (incl. header) sizes each one.
    const cols: string[] = [];
    const seen = new Set<string>();
    let maxN = 1;
    for (const r of grpRows) {
      if (r.n > maxN) maxN = r.n;
      for (const k of Object.keys(r.fields ?? {})) if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
    const widths = cols.map((c) => {
      let w = c.length;
      for (const r of grpRows) {
        const raw = r.fields?.[c]?.raw;
        if (raw && raw.length > w) w = raw.length;
      }
      return Math.min(MAX_COL_CH, Math.max(MIN_COL_CH, w));
    });
    const lnCh = Math.max(4, String(maxN).length + 1);
    const dataTracks = widths.map((w) => `minmax(0, calc(${w}ch + ${CELL_PAD}px))`).join(" ");
    // remove · line · data… · greedy pad (absorbs slack so columns hug content)
    const template = `34px calc(${lnCh}ch + ${CELL_PAD}px) ${dataTracks} minmax(0, 1fr)`;
    out.push({ id, key, label: labelFor(key), color: colorFor(key), index: indexFor(key), rows: grpRows, cols, template });
  }
  // Order the tables by their filter's position in the set (the #N serial), NOT
  // by Map insertion order — that latter follows whichever group's earliest line
  // appears first, so removing a table's first row would change its earliest line
  // and make the whole table jump to a new slot. Filters that no longer exist
  // (index -1) sort to the end. The sort is stable, so same-index groups keep order.
  out.sort((a, b) => (a.index < 0 ? Infinity : a.index) - (b.index < 0 ? Infinity : b.index));
  return out;
}

/** Compares parsed fields of selected lines, one virtualized table per pattern. */
export function CompareTable({ rows, rowH, onRemove, labelFor, colorFor, indexFor, onExport, onClearGroup, onImportMatching, onJump, onFocusFilter }: CompareTableProps) {
  const groups = useMemo(() => buildGroups(rows, labelFor, colorFor, indexFor), [rows, labelFor, colorFor, indexFor]);

  // Per-group collapse: a collapsed table shows only its header (rows omitted
  // from the virtualizer list). Keyed by group id; local UI state.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggleCollapse = useCallback((id: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    }), []);

  // Flatten groups into one list of (header | row) items so a single virtualizer
  // can window everything — performance stays flat no matter how many rows join.
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const g of groups) {
      out.push({ kind: "head", g });
      if (collapsed.has(g.id)) continue;
      g.rows.forEach((r, ri) => out.push({ kind: "row", g, r, ri, last: ri === g.rows.length - 1 }));
    }
    return out;
  }, [groups, collapsed]);

  // Indexes of the group-header items, for the sticky-header range extractor.
  const headIndexes = useMemo(
    () => items.reduce<number[]>((acc, it, i) => { if (it.kind === "head") acc.push(i); return acc; }, []),
    [items],
  );
  // The header that should be pinned at the top right now (last head scrolled to
  // or past). A ref because rangeExtractor runs during measurement; scroll
  // re-renders read it fresh when deciding which item renders sticky.
  const activeStickyRef = useRef(0);

  const parentRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    // Heights are deterministic (border-box), so fixed sizes keep sticky headers
    // robust — no measureElement jitter when an item flips to position:sticky.
    // `items[i]` is optional-chained: when a row is removed the virtualizer can
    // briefly call these with a stale index past the (now shorter) list, and an
    // unguarded `items[i].kind` would throw and unmount the whole table.
    estimateSize: (i) => {
      const it = items[i];
      if (it?.kind !== "head") return rowH;
      // A collapsed table drops its column-header row, so the head is just the
      // group bar (HEAD_EXTRA) without the extra log-row of column labels.
      return collapsed.has(it.g.id) ? HEAD_EXTRA : rowH + HEAD_EXTRA;
    },
    overscan: 16,
    getItemKey: (i) => {
      const it = items[i];
      if (!it) return i;
      return it.kind === "head" ? `h:${it.g.id}` : `r:${it.g.id}:${it.r.n}`;
    },
    // Always keep the active group header in the rendered range so it can pin.
    rangeExtractor: useCallback((range: { startIndex: number; endIndex: number; overscan: number; count: number }) => {
      let active = headIndexes[0] ?? 0;
      for (const hi of headIndexes) { if (hi <= range.startIndex) active = hi; else break; }
      activeStickyRef.current = active;
      const next = new Set([active, ...defaultRangeExtractor(range)]);
      return [...next].sort((a, b) => a - b);
    }, [headIndexes]),
  });
  // Recompute positions when the shared row height changes (font zoom) or a
  // table collapses/expands (head size + row count change).
  useEffect(() => { virt.measure(); }, [rowH, collapsed]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rows.length) {
    return (
      <PanelEmpty title="Nothing to compare yet">
        <p>
          Right-click a parsed line in the log (or select several, then right-click) ▸{" "}
          <b>Add to compare</b> to line up its extracted fields side by side here.
        </p>
        <p className="panel-empty-hint">Only lines a filter has parsed fields from can be compared.</p>
      </PanelEmpty>
    );
  }

  const vItems = virt.getVirtualItems();
  return (
    <div ref={parentRef} className="cmp-scroll scroll">
      <div className="cmp-vsizer" style={{ height: virt.getTotalSize() }}>
        {vItems.map((vi) => {
          const it = items[vi.index];
          // The virtualizer can briefly hand back an index past the (just-shrunk)
          // item list right after a row is removed — guard so a stale index never
          // dereferences undefined and blanks the whole table.
          if (!it) return null;
          const stuck = it.kind === "head" && activeStickyRef.current === vi.index;
          return (
            <div
              key={vi.key}
              className={"cmp-vitem" + (stuck ? " stuck" : "")}
              style={stuck
                ? { position: "sticky", top: 0, height: vi.size }
                : { transform: `translateY(${vi.start}px)`, height: vi.size }}
            >
              {it.kind === "head" ? (
                (() => {
                const isCollapsed = collapsed.has(it.g.id);
                return (
                <div className="cmp-group-head-wrap">
                  <div className="cmp-group-head">
                    <Button
                      variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground"
                      title={isCollapsed ? "Expand this table" : "Collapse this table"}
                      onClick={() => toggleCollapse(it.g.id)}
                    >
                      {isCollapsed ? <ChevronRight /> : <ChevronDown />}
                    </Button>
                    <button
                      className="cmp-group-jump"
                      title={it.g.key ? `Go to filter #${it.g.index + 1} in Filters` : "This filter no longer exists"}
                      onClick={() => it.g.key && onFocusFilter(it.g.key)}
                      disabled={!it.g.key}
                    >
                      <span className="cmp-dot" style={{ background: it.g.color }} />
                      {it.g.index >= 0 && <span className="cmp-group-idx">#{it.g.index + 1}</span>}
                      <span className="cmp-group-label">{it.g.label}</span>
                    </button>
                    <span className="cmp-group-count">{it.g.rows.length}</span>
                    <span className="cmp-group-spacer" />
                    <div className="cmp-group-actions">
                      <Button
                        variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground"
                        title="Scroll this table to the top"
                        disabled={isCollapsed}
                        onClick={() => virt.scrollToIndex(vi.index, { align: "start" })}
                      >
                        <ArrowUpToLine />
                      </Button>
                      <Button
                        variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground"
                        title="Import every line this filter parses into the comparison"
                        onClick={() => onImportMatching(it.g.key)}
                      >
                        <ListPlus />
                      </Button>
                      <Button
                        variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground"
                        title="Clear this table's lines"
                        onClick={() => onClearGroup(it.g.key)}
                      >
                        <ListX />
                      </Button>
                      <Button
                        variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground"
                        title="Export this table as CSV"
                        onClick={() => onExport(it.g.key, it.g.label)}
                      >
                        <Download />
                      </Button>
                    </div>
                  </div>
                  {!isCollapsed && (
                    <div className="cmp-colhead" style={{ gridTemplateColumns: it.g.template }}>
                      <span className="cmp-ch cmp-rm" />
                      <span className="cmp-ch cmp-ln">line</span>
                      {it.g.cols.map((c) => <span key={c} className="cmp-ch" title={c}>{c}</span>)}
                      <span className="cmp-ch cmp-pad" />
                    </div>
                  )}
                </div>
                );
                })()
              ) : (
                <div
                  className={"cmp-vrow" + (it.ri % 2 ? " odd" : "") + (it.last ? " last" : "")}
                  style={{ gridTemplateColumns: it.g.template }}
                >
                  <span className="cmp-cell cmp-rm">
                    <button
                      className="cmp-rm-btn"
                      aria-label="Remove from compare"
                      title="Remove from compare"
                      onClick={() => onRemove(it.r.n)}
                    >
                      <X size={13} />
                    </button>
                  </span>
                  <span className="cmp-cell cmp-ln">
                    <button className="cmp-ln-btn" title={`Jump to line ${it.r.n}`} onClick={() => onJump(it.r.n)}>
                      {it.r.n}
                    </button>
                  </span>
                  {it.g.cols.map((c) => {
                    const fv = it.r.fields?.[c];
                    const isNum = fv && typeof fv.value === "number";
                    return (
                      <span key={c} className={"cmp-cell" + (isNum ? " num" : "")} title={fv ? fv.raw : undefined}>
                        {fv ? fv.raw : "—"}
                      </span>
                    );
                  })}
                  <span className="cmp-cell cmp-pad" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
