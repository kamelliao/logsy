import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUpToLine, ChevronDown, ChevronRight, Download, ListX, ListPlus, X } from "lucide-react";
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
  /** Group ids currently collapsed (header only). Lifted to the app so the dock's
   *  collapse-all toggle and each table's chevron share one source of truth. */
  collapsed: Set<string>;
  /** Flip one group's collapsed state (its header chevron). */
  onToggleCollapse: (id: string) => void;
}

// Column widths are estimated from content in `ch` (mono font). Sized to the
// widest content (header or value) so cells show in full — the table grows past
// its box and scrolls horizontally rather than truncating. A small floor keeps a
// short column readable.
const MIN_COL_CH = 3;
const CELL_PAD = 26; // 13px each side — matches the cell padding in CSS
// A table's body is capped to this many rows; past it the body scrolls WITHIN
// itself (its own vertical scrollbar) so one huge table never forces the whole
// panel into an endless scroll. Tables shorter than the cap shrink to fit.
const MAX_BODY_ROWS = 12;

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
      // The header renders in ui-font, uppercase, with letter-spacing — a touch
      // wider per glyph than the mono `ch` the track is sized in — so size the
      // column to the header's name with a little slack, otherwise a name no
      // longer than its values would still get ellipsized. Values use their raw
      // length as-is (they share the mono font with the `ch` track).
      let w = Math.ceil(c.length * 1.18) + 1;
      for (const r of grpRows) {
        const raw = r.fields?.[c]?.raw;
        if (raw && raw.length > w) w = raw.length;
      }
      return Math.max(MIN_COL_CH, w);
    });
    const lnCh = Math.max(4, String(maxN).length + 1);
    // Fixed (non-shrinking) tracks sized to full content; the row's
    // `width: max-content` (in CSS) lets the table overflow → horizontal scroll.
    const dataTracks = widths.map((w) => `calc(${w}ch + ${CELL_PAD}px)`).join(" ");
    // remove · line · data… · greedy pad (absorbs slack so columns hug content
    // when the table is narrower than its box)
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

/** Compares parsed fields of selected lines, one table per pattern. Each table is
 *  its own bounded 2D scroll box: rows scroll vertically inside it (capped height,
 *  virtualized) and the table scrolls horizontally on its own native scrollbar —
 *  so a wide or tall table never drags the whole panel around. */
export function CompareTable({ rows, rowH, onRemove, labelFor, colorFor, indexFor, onExport, onClearGroup, onImportMatching, onJump, onFocusFilter, collapsed, onToggleCollapse }: CompareTableProps) {
  const groups = useMemo(() => buildGroups(rows, labelFor, colorFor, indexFor), [rows, labelFor, colorFor, indexFor]);

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

  return (
    <div className="cmp-scroll scroll">
      {groups.map((g) => (
        <CompareGroup
          key={g.id}
          g={g}
          rowH={rowH}
          collapsed={collapsed.has(g.id)}
          onToggleCollapse={onToggleCollapse}
          onRemove={onRemove}
          onExport={onExport}
          onClearGroup={onClearGroup}
          onImportMatching={onImportMatching}
          onJump={onJump}
          onFocusFilter={onFocusFilter}
        />
      ))}
    </div>
  );
}

interface CompareGroupProps {
  g: Group;
  rowH: number;
  collapsed: boolean;
  onToggleCollapse: (id: string) => void;
  onRemove: (n: number) => void;
  onExport: (id: string | undefined, label: string) => void;
  onClearGroup: (id: string | undefined) => void;
  onImportMatching: (id: string | undefined) => void;
  onJump: (n: number) => void;
  onFocusFilter: (id: string) => void;
}

/** One pattern's table: a sticky toolbar header plus (when expanded) a bounded,
 *  self-scrolling body. The toolbar pins to the panel top via CSS sticky as you
 *  scroll between tables. */
function CompareGroup({ g, rowH, collapsed, onToggleCollapse, onRemove, onExport, onClearGroup, onImportMatching, onJump, onFocusFilter }: CompareGroupProps) {
  // Shared with CompareGroupBody: it mounts the scroll element here, and the
  // toolbar's "scroll to top" reaches the same element. null while collapsed.
  const bodyRef = useRef<HTMLDivElement>(null);
  return (
    <div className="cmp-group">
      <div className="cmp-group-head">
        <Button
          variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground"
          title={collapsed ? "Expand this table" : "Collapse this table"}
          onClick={() => onToggleCollapse(g.id)}
        >
          {collapsed ? <ChevronRight /> : <ChevronDown />}
        </Button>
        <button
          className="cmp-group-jump"
          title={g.key ? `Go to filter #${g.index + 1} in Filters` : "This filter no longer exists"}
          onClick={() => g.key && onFocusFilter(g.key)}
          disabled={!g.key}
        >
          <span className="cmp-dot" style={{ background: g.color }} />
          {g.index >= 0 && (
            <>
              <span className="cmp-group-idx">#{g.index + 1}</span>
              <span className="cmp-group-mid">·</span>
            </>
          )}
          <span className="cmp-group-label">{g.label}</span>
        </button>
        <span className="cmp-group-spacer" />
        <span className="count-badge">{g.rows.length}</span>
        <div className="cmp-group-actions">
          <Button
            variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground"
            title="Scroll this table to the top"
            disabled={collapsed}
            onClick={() => bodyRef.current?.scrollTo({ top: 0 })}
          >
            <ArrowUpToLine />
          </Button>
          <Button
            variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground"
            title="Import this table's matching lines into the comparison"
            onClick={() => onImportMatching(g.key)}
          >
            <ListPlus />
          </Button>
          <Button
            variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground"
            title="Remove this table's lines from the comparison"
            onClick={() => onClearGroup(g.key)}
          >
            <ListX />
          </Button>
          <Button
            variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground"
            title="Export this table as CSV"
            onClick={() => onExport(g.key, g.label)}
          >
            <Download />
          </Button>
        </div>
      </div>
      {!collapsed && <CompareGroupBody g={g} rowH={rowH} bodyRef={bodyRef} onRemove={onRemove} onJump={onJump} />}
    </div>
  );
}

interface CompareGroupBodyProps {
  g: Group;
  rowH: number;
  bodyRef: React.RefObject<HTMLDivElement | null>;
  onRemove: (n: number) => void;
  onJump: (n: number) => void;
}

/** The scrollable body of one table. Lives in its own component so its
 *  virtualizer mounts with the scroll element present (and unmounts cleanly when
 *  the table collapses). The scroll box scrolls both axes: rows vertically
 *  (virtualized, capped to MAX_BODY_ROWS tall) and the grid horizontally; the
 *  column header is `position: sticky` so it stays put on vertical scroll while
 *  riding along on horizontal scroll (same scroll container → no JS sync). */
function CompareGroupBody({ g, rowH, bodyRef, onRemove, onJump }: CompareGroupBodyProps) {
  const virt = useVirtualizer({
    count: g.rows.length,
    getScrollElement: () => bodyRef.current,
    estimateSize: () => rowH,
    overscan: 12,
    getItemKey: (i) => g.rows[i]?.n ?? i,
  });
  // Font zoom changes rowH; reflow the fixed-size rows.
  useEffect(() => { virt.measure(); }, [rowH]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cap the box at MAX_BODY_ROWS data rows + the sticky column-header row. Shorter
  // tables shrink to content (no inner scrollbar); taller ones scroll internally.
  const maxH = (MAX_BODY_ROWS + 1) * rowH;
  const vItems = virt.getVirtualItems();
  return (
    <div ref={bodyRef} className="cmp-table-scroll scroll" style={{ maxHeight: maxH }}>
      <div className="cmp-colhead" style={{ gridTemplateColumns: g.template }}>
        <span className="cmp-ch cmp-rm" />
        <span className="cmp-ch cmp-ln">line</span>
        {g.cols.map((c) => <span key={c} className="cmp-ch" title={c}>{c}</span>)}
        <span className="cmp-ch cmp-pad" />
      </div>
      <div className="cmp-body" style={{ height: virt.getTotalSize() }}>
        {vItems.map((vi) => {
          const r = g.rows[vi.index];
          if (!r) return null;
          return (
            <div
              key={vi.key}
              className={"cmp-vrow" + (vi.index % 2 ? " odd" : "")}
              style={{ transform: `translateY(${vi.start}px)`, height: vi.size, gridTemplateColumns: g.template }}
            >
              <span className="cmp-cell cmp-rm">
                <button
                  className="cmp-rm-btn"
                  aria-label="Remove from compare"
                  title="Remove from compare"
                  onClick={() => onRemove(r.n)}
                >
                  <X size={13} />
                </button>
              </span>
              <span className="cmp-cell cmp-ln">
                <button className="cmp-ln-btn" title={`Jump to line ${r.n}`} onClick={() => onJump(r.n)}>
                  {r.n}
                </button>
              </span>
              {g.cols.map((c) => {
                const fv = r.fields?.[c];
                const isNum = fv && typeof fv.value === "number";
                return (
                  <span key={c} className={"cmp-cell" + (isNum ? " num" : "")} title={fv ? fv.raw : undefined}>
                    {fv ? fv.raw : "—"}
                  </span>
                );
              })}
              <span className="cmp-cell cmp-pad" />
            </div>
          );
        })}
      </div>
    </div>
  );
}
