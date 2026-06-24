import {
  useCallback,
  useMemo,
  useState,
  useRef,
  useEffect,
  CSSProperties,
} from "react";
import {
  Eye,
  EyeOff,
  GripVertical,
  Trash2,
  Plus,
  ListPlus,
  ListX,
  MoveRight,
  X,
  Circle,
  Square,
  Triangle,
  Diamond,
  ChartGantt,
  ChevronDown,
  ChevronUp,
  ChevronsLeftRight,
  StickyNote,
  StickyNoteOff,
  AlertTriangle,
  MoreHorizontal,
  createLucideIcon,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  Filter,
  FieldDef,
  TimelineSource,
  TimeUnit,
  EventMark,
  EventShape,
} from "@/types";
import { trackFieldsOf } from "@/lib/engine";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { PanelEmpty } from "@/components/PanelEmpty";
import { TimelineCanvas } from "@/components/TimelineCanvas";

const UNITS: TimeUnit[] = ["hms", "s", "ms", "us", "ns", "date", "custom"];

// Compact track palette + the four point shapes for the per-row color/shape picker.
const TRACK_COLORS = [
  "#dbeafe",
  "#bfdbfe",
  "#60a5fa",
  "#a7f3d0",
  "#86efac",
  "#4ade80",
  "#fde68a",
  "#fcd34d",
  "#fdba74",
  "#fca5a5",
  "#f9a8d4",
  "#d8b4fe",
  "#c7d2fe",
  "#99f6e4",
  "#cbd5e1",
  "#94a3b8",
];
const SHAPES: { id: EventShape; Icon: typeof Circle; label: string }[] = [
  { id: "circle", Icon: Circle, label: "Circle" },
  { id: "square", Icon: Square, label: "Square" },
  { id: "triangle", Icon: Triangle, label: "Triangle" },
  { id: "diamond", Icon: Diamond, label: "Diamond" },
];

interface Props {
  /** User-owned, ordered track list (FilterSet.sources). */
  tracks: TimelineSource[];
  /** All filters of the active set — source of the field pickers. */
  filters: Filter[];
  /** Per-filter set of field names allowed as a time field (numeric / time-like). */
  timeFields: Map<string, Set<string>>;
  marks: EventMark[];
  /** Span track ids whose end field resolved BEFORE the start (illegal span):
   *  the end is dropped and the row shows a warning. */
  badEndTracks: Set<string>;
  /** Custom-unit track ids whose `format` is empty / un-parseable / fails on the
   *  field's actual values — the row shows a warning next to the format box. */
  badFormatTracks: Set<string>;
  /** How many log lines the user has added to the timeline. */
  lineCount: number;
  onSetTrack: (tr: TimelineSource) => void;
  onRemoveTrack: (id: string) => void;
  onReorderTracks: (ids: string[]) => void;
  /** Pull every visible track's matching lines onto the timeline (empty-state bridge). */
  onAddMatchingLines: () => void;
  /** Header "… all" bulk actions, applied across every track. */
  onImportAll: () => void;
  onClearAll: () => void;
  /** Merge a partial onto every track in one undoable patch (the bulk toggles). */
  onSetAll: (patch: Partial<TimelineSource>) => void;
  onDeleteAll: () => void;
  /** Import one track's matching lines (per-row button). */
  onImportTrackLines: (tr: TimelineSource) => void;
  /** Remove one track's matching lines from the timeline (per-row button). */
  onClearTrackLines: (tr: TimelineSource) => void;
  /** Per track id: how many lines its filter+field matches, and how many of those
   *  are on the timeline — drives the import/clear states and the per-row badge. */
  trackLineStats: Map<string, { matching: number; inTl: number }>;
  /** On the timeline but plotting no mark (no track / field) — the "added but
   *  nothing shows" case, surfaced as a bounded hint. */
  orphanLines: number[];
  /** Remove the given lines from the timeline (orphan-hint "Remove" action). */
  onRemoveLines: (ns: number[]) => void;
  onJump: (lineN: number) => void;
  /** Reveal + flash a track's filter row in the Filters panel (same action as the
   *  Compare group header). */
  onFocusFilter: (filterId: string) => void;
  /** Persisted height (px) of the draggable bottom sheet. */
  sheetH: number;
  onSetSheetH: (h: number) => void;
  /** Global event-marker size setting. */
  iconSize?: "S" | "M" | "L";
}

// The always-present (collapsed) handle height: the canvas reserves this much
// bottom padding so its lanes are never hidden behind the peeking sheet. Must
// match `.tl-sheet-handle` height in logsy.css.
const HANDLE_H = 34;
// How much of the panel the sheet can never cover — caps how far it pulls up so a
// usable strip of canvas (minimap + axis + a lane) stays uncovered above it.
const MIN_PLOT_H = 120;
// Fixed height the chevron expands the sheet to (it does not restore the last
// dragged height — every expand opens to this size).
const EXPANDED_H = 200;
// Sized down to the tiny xs trigger it hangs off: the default popup uses text-sm
// with roomy padding, which dwarfs the xs trigger. Shrink item/label text +
// padding to match. Width stays >= the trigger (default min-w-anchor) and grows
// to fit a long field name rather than truncating it.
const COMPACT =
  "[&_[data-slot=select-item]]:gap-1 [&_[data-slot=select-item]]:py-1 [&_[data-slot=select-item]]:pl-1.5 [&_[data-slot=select-item]]:pr-6 [&_[data-slot=select-item]]:text-[11px] " +
  "[&_[data-slot=select-label]]:px-1.5";

// A track's per-row toggles (expand cards / show deltas) flip between a solid and
// a slashed icon (StickyNote/StickyNoteOff, ChevronsLeftRight/…Off) — the "on" icon
// at the usual muted strength, the "off" icon dimmed to /50, matching the Eye/EyeOff
// hide-track button to its right.
const TOGGLE_ON = "text-muted-foreground hover:text-foreground";
const TOGGLE_OFF = "text-muted-foreground/50 hover:text-foreground";

// Lucide has no `chevrons-left-right-off`, so we synthesize the "deltas hidden"
// glyph: the stock ChevronsLeftRight `<->` paths (kept, since `<->` is the clearest
// metaphor for an inter-point time delta) plus the diagonal slash lucide adds to
// every `-off` icon — so it reads as off and matches the slashed Eye/StickyNote
// states beside it, without a coloured background.
const ChevronsLeftRightOff = createLucideIcon("chevrons-left-right-off", [
  ["path", { d: "m9 7-5 5 5 5", key: "j5w590" }],
  ["path", { d: "m15 7 5 5-5 5", key: "1bl6da" }],
  ["path", { d: "m2 2 20 20", key: "1ooewy" }],
]);

export function TimelinePanel({
  tracks,
  filters,
  timeFields,
  marks,
  badEndTracks,
  badFormatTracks,
  lineCount,
  onSetTrack,
  onRemoveTrack,
  onReorderTracks,
  onAddMatchingLines,
  onImportAll,
  onClearAll,
  onSetAll,
  onDeleteAll,
  onImportTrackLines,
  onClearTrackLines,
  trackLineStats,
  orphanLines,
  onRemoveLines,
  onJump,
  onFocusFilter,
  sheetH,
  onSetSheetH,
  iconSize,
}: Props) {
  // The bottom sheet's height is driven locally during a drag (no per-move
  // round-trip through app state); the final value is committed on release.
  const rootRef = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(sheetH);
  const hRef = useRef(h);
  hRef.current = h;
  const drag = useRef<{ y: number; h: number } | null>(null);
  // Adopt an externally changed height only while not dragging (e.g. on reload).
  useEffect(() => {
    if (!drag.current) setH(sheetH);
  }, [sheetH]);

  // Track the panel's height so a persisted sheet height taller than the current
  // panel (e.g. a short bottom dock) can't push the handle out of reach.
  const [panelH, setPanelH] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPanelH(el.clientHeight));
    ro.observe(el);
    setPanelH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const maxH = panelH > 0 ? Math.max(HANDLE_H, panelH - MIN_PLOT_H) : Infinity;
  const renderH = Math.min(h, maxH);
  const collapsed = renderH <= HANDLE_H + 1;
  // The chevron toggles between collapsed and a fixed expanded height — it does
  // not restore the last dragged height.
  const toggleCollapse = () => {
    const next = collapsed ? EXPANDED_H : HANDLE_H;
    setH(next);
    onSetSheetH(next);
  };

  const onHandleDown = (e: React.PointerEvent) => {
    // Let the Clear button (and any future controls) work without starting a drag.
    if ((e.target as HTMLElement).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, h: renderH };
  };
  const onHandleMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setH(Math.min(maxH, Math.max(HANDLE_H, d.h + (d.y - e.clientY))));
  };
  const onHandleUp = () => {
    if (drag.current) {
      drag.current = null;
      onSetSheetH(hRef.current);
    }
  };

  // Aggregate track state for the header "… all" toggles: a button mirrors the
  // per-row icon's "on" look only when EVERY track is in that state, and the click
  // drives all tracks to the opposite of that aggregate.
  const allExpanded = tracks.length > 0 && tracks.every((t) => t.expanded);
  const allDeltas = tracks.length > 0 && tracks.every((t) => t.showDeltas);
  const anyVisible = tracks.some((t) => !t.hidden);

  const lanes = tracks.filter((t) => !t.hidden).map((t) => t.lane);
  // Lane names whose track draws inter-point deltas / shows expanded cards. Keyed
  // off `tracks` so the Set identity is stable between unrelated re-renders.
  const deltaLanes = useMemo(
    () =>
      new Set(
        tracks.filter((t) => !t.hidden && t.showDeltas).map((t) => t.lane),
      ),
    [tracks],
  );
  const expandedLanes = useMemo(
    () =>
      new Set(tracks.filter((t) => !t.hidden && t.expanded).map((t) => t.lane)),
    [tracks],
  );
  // A filter's fields that may back a time field: restricted to the numeric /
  // time-like ones (the timeline can only plot numbers / clocks).
  const fieldsOf = useCallback(
    (f: Filter): FieldDef[] => {
      const allow = timeFields.get(f.id);
      return trackFieldsOf(f).filter((d) => allow?.has(d.name));
    },
    [timeFields],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = tracks.map((t) => t.id);
    const from = ids.indexOf(active.id as string);
    const to = ids.indexOf(over.id as string);
    if (from < 0 || to < 0) return;
    onReorderTracks(arrayMove(ids, from, to));
  }

  // Short centered placeholder on the (always-rendered) empty canvas, plus a
  // longer guidance line below it.
  const placeholder =
    tracks.length === 0
      ? "Add a track, then add log lines — events appear here"
      : lineCount === 0
        ? "Right-click log lines → Add to timeline"
        : marks.length === 0
          ? "Added lines expose no field for these tracks"
          : undefined;
  const hint =
    // No tracks → the Tracks empty state below carries the guidance.
    tracks.length === 0 ? null : lineCount === 0 ? (
      <>
        Right-click log lines → <b>Add to timeline</b>, or{" "}
        <button
          type="button"
          className="cursor-pointer font-medium text-foreground underline underline-offset-2 hover:text-primary"
          onClick={onAddMatchingLines}
        >
          add all matching lines
        </button>{" "}
        now.
      </>
    ) : marks.length === 0 ? (
      <>
        The added lines don't match any track's filter, or expose no track
        field.
      </>
    ) : null;

  return (
    <div
      ref={rootRef}
      className="relative flex flex-1 min-h-0 flex-col overflow-hidden text-xs text-foreground"
    >
      {/* canvas fills the whole panel; bottom padding reserves room for the
          always-present (collapsed) sheet handle so no lane hides under it */}
      {/* The canvas stays full height; the sheet overlays its bottom. We pass the
          covered height (renderH − handle) as `bottomInset` so the canvas adds that
          much extra scroll range — lanes hidden behind the sheet can be scrolled up
          into view, while the canvas itself never resizes (no jump on sheet drag). */}
      <div className="min-h-0 flex-1 pt-2" style={{ paddingBottom: HANDLE_H }}>
        <TimelineCanvas
          marks={marks}
          lanes={lanes}
          onJump={onJump}
          placeholder={placeholder}
          bottomInset={Math.max(0, renderH - HANDLE_H)}
          iconSize={iconSize}
          deltaLanes={deltaLanes}
          expandedLanes={expandedLanes}
        />
      </div>

      {/* draggable bottom sheet: handle bar (grip + counts + clear), the contextual
          hint, then the scrolling track list overlaying the canvas bottom */}
      <div className="tl-sheet" style={{ height: renderH }}>
        <div
          className="tl-sheet-handle"
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
        >
          <span className="tl-sheet-grip" />
          <span className="tl-sheet-counts">
            {marks.length} event{marks.length === 1 ? "" : "s"} · {lineCount}{" "}
            line{lineCount === 1 ? "" : "s"}
          </span>
          {hint && <span className="tl-sheet-counts">{hint}</span>}

          {/* "… all" bulk actions: the per-row icons applied to every track at
              once. Mirrors the per-row order (import / remove lines / cards /
              deltas / show / delete) so the icons read the same in both places.
              The right margin lands the cluster's right edge at the same inset as a
              track row's buttons (handle pad 8 + 21 = 29px = 12px scrollbar gutter
              + 10px body pad + 1px row border + 6px row pad), so the six icons line
              up in columns. The collapse chevron is absolutely positioned past this
              margin (see below) so it can stay on the right without shoving the
              cluster out of column. */}
          {tracks.length > 0 && (
            <div
              className="ml-auto flex shrink-0 items-center gap-0.5 border-l border-border/60 pl-1"
              style={{ marginRight: 21 }}
            >
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-foreground"
                title="Import every track's matching lines onto the timeline"
                onClick={onImportAll}
              >
                <ListPlus />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-foreground"
                title="Remove every track's lines from the timeline"
                onClick={onClearAll}
              >
                <ListX />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className={allExpanded ? TOGGLE_ON : TOGGLE_OFF}
                title={allExpanded ? "Collapse all cards" : "Expand all cards"}
                aria-pressed={allExpanded}
                onClick={() =>
                  onSetAll({ expanded: allExpanded ? undefined : true })
                }
              >
                {allExpanded ? <StickyNote /> : <StickyNoteOff />}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className={allDeltas ? TOGGLE_ON : TOGGLE_OFF}
                title={
                  allDeltas ? "Hide all time deltas" : "Show all time deltas"
                }
                aria-pressed={allDeltas}
                onClick={() =>
                  onSetAll({ showDeltas: allDeltas ? undefined : true })
                }
              >
                {allDeltas ? <ChevronsLeftRight /> : <ChevronsLeftRightOff />}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className={
                  anyVisible
                    ? "text-muted-foreground hover:text-foreground"
                    : "text-muted-foreground/50 hover:text-foreground"
                }
                title={anyVisible ? "Hide all tracks" : "Show all tracks"}
                onClick={() =>
                  onSetAll({ hidden: anyVisible ? true : undefined })
                }
              >
                {anyVisible ? <Eye /> : <EyeOff />}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-destructive"
                title="Delete all tracks"
                onClick={onDeleteAll}
              >
                <Trash2 />
              </Button>
            </div>
          )}
          {/* Collapse toggle: kept on the right (natural), but absolutely placed in
              the rightmost gutter zone so it floats past the cluster's 21px margin
              instead of pushing the "… all" icons left out of column. */}
          <Button
            variant="ghost"
            size="icon-xs"
            className="absolute top-0 right-0.5 bottom-0 my-auto shrink-0 text-muted-foreground hover:text-foreground"
            title={collapsed ? "Expand tracks" : "Collapse tracks"}
            onClick={toggleCollapse}
          >
            {collapsed ? <ChevronUp /> : <ChevronDown />}
          </Button>
        </div>

        {/* The one thing not visible elsewhere: lines on the timeline that no track
            plots (added, but nothing shows). Bounded to a count + actions. */}
        {/* TODO: should not show this warning when "hide track" */}
        {/* eslint-disable-next-line no-constant-binary-expression */}
        {false && orphanLines.length > 0 && (
          <p className="tl-sheet-hint flex items-center gap-1.5">
            <AlertTriangle className="size-3 shrink-0 text-amber-500" />
            <span>
              <b className="font-semibold tabular-nums">{orphanLines.length}</b>{" "}
              added line{orphanLines.length === 1 ? "" : "s"} not plotted by any
              track.
            </span>
            <button
              type="button"
              className="cursor-pointer font-medium text-foreground underline underline-offset-2 hover:text-primary"
              onClick={() => onJump(orphanLines[0])}
            >
              Jump
            </button>
            <button
              type="button"
              className="cursor-pointer font-medium text-foreground underline underline-offset-2 hover:text-primary"
              onClick={() => onRemoveLines(orphanLines)}
            >
              Remove
            </button>
          </p>
        )}
        {/* Empty state owns its OWN scroll (PanelEmpty is a scroll container), so
            it must NOT sit inside the scrolling `.tl-sheet-body` — that nests two
            scrollers and shows a double scrollbar. Give it a plain flex:1 box. */}
        {tracks.length === 0 ? (
          <div className="min-h-0 flex-1">
            <PanelEmpty icon={<ChartGantt size={22} />} title="No tracks yet">
              <ol className="mt-1 space-y-1.5 text-left text-xs text-muted-foreground">
                <li>
                  <span className="mr-1 font-semibold text-foreground tabular-nums">
                    1.
                  </span>
                  In the <b className="text-foreground">Filters</b> tab,
                  right-click a filter →{" "}
                  <b className="text-foreground">Add to timeline track</b>.
                </li>
                <li>
                  <span className="mr-1 font-semibold text-foreground tabular-nums">
                    2.
                  </span>
                  In the log view, right-click the lines you want →{" "}
                  <b className="text-foreground">Add to timeline</b>.
                </li>
              </ol>
            </PanelEmpty>
          </div>
        ) : (
          <div className="tl-sheet-body scroll">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={onDragEnd}
              modifiers={[restrictToVerticalAxis]}
            >
              <SortableContext
                items={tracks.map((t) => t.id)}
                strategy={verticalListSortingStrategy}
              >
                {tracks.map((tr) => {
                  const st = trackLineStats.get(tr.id);
                  return (
                    <TrackRow
                      key={tr.id}
                      tr={tr}
                      filters={filters}
                      fieldsOf={fieldsOf}
                      onSet={onSetTrack}
                      onRemove={() => onRemoveTrack(tr.id)}
                      onImport={() => onImportTrackLines(tr)}
                      onClearLines={() => onClearTrackLines(tr)}
                      onFocusFilter={onFocusFilter}
                      badEnd={badEndTracks.has(tr.id)}
                      badFormat={badFormatTracks.has(tr.id)}
                      inTl={st?.inTl ?? 0}
                      matching={st?.matching ?? 0}
                      canImport={
                        !!st && st.matching > 0 && st.inTl < st.matching
                      }
                      canClear={!!st && st.inTl > 0}
                    />
                  );
                })}
              </SortableContext>
            </DndContext>
          </div>
        )}
      </div>
    </div>
  );
}

function TrackRow({
  tr,
  filters,
  fieldsOf,
  onSet,
  onRemove,
  onImport,
  onClearLines,
  onFocusFilter,
  badEnd,
  badFormat,
  inTl,
  matching,
  canImport,
  canClear,
}: {
  tr: TimelineSource;
  filters: Filter[];
  fieldsOf: (f: Filter) => FieldDef[];
  onSet: (tr: TimelineSource) => void;
  onRemove: () => void;
  onImport: () => void;
  onClearLines: () => void;
  onFocusFilter: (filterId: string) => void;
  badEnd: boolean;
  badFormat: boolean;
  inTl: number;
  matching: number;
  canImport: boolean;
  canClear: boolean;
}) {
  // "Add end field" opens an (empty) end picker rather than auto-selecting a
  // field — picking a wrong field can produce an end-before-start span. The span
  // is only committed once the user explicitly chooses the end field.
  const [addingEnd, setAddingEnd] = useState(false);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tr.id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  // Inline rename: double-click the title to edit; commit on Enter/blur.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tr.lane);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      setDraft(tr.lane);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, tr.lane]);
  const commitRename = () => {
    const v = draft.trim();
    if (v && v !== tr.lane) onSet({ ...tr, lane: v });
    setEditing(false);
  };

  // Custom-format draft: committed on blur/Enter (not per keystroke) so a typed
  // pattern is one undoable edit, not one per character — mirrors the rename box.
  const [fmtDraft, setFmtDraft] = useState(tr.format ?? "");
  useEffect(() => {
    setFmtDraft(tr.format ?? "");
  }, [tr.format]);
  const commitFormat = () => {
    const v = fmtDraft.trim();
    if (v !== (tr.format ?? "")) onSet({ ...tr, format: v || undefined });
  };

  // The filter is shown as "#N · description" (N = its 1-based order in the set);
  // the chip opens its Edit modal, so the full filter is one click away.
  const filterIndex = filters.findIndex((f) => f.id === tr.filterId);
  const filter = filterIndex >= 0 ? filters[filterIndex] : undefined;
  const fields = filter ? fieldsOf(filter) : [];
  const otherFields = fields.filter((d) => d.name !== tr.timeField);
  const filterName = filter
    ? filter.description?.trim() || filter.pattern || filter.id
    : "missing filter";
  const serial = filterIndex >= 0 ? `#${filterIndex + 1}` : "#?";

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="@container mb-1 flex flex-wrap items-center gap-1.5 rounded border border-border/60 bg-card/40 px-1.5 py-1"
    >
      <span
        className="cursor-grab text-muted-foreground/60 hover:text-muted-foreground"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={12} />
      </span>
      <ColorShapePicker tr={tr} onSet={onSet} />
      {editing ? (
        <input
          ref={inputRef}
          className="h-6 w-[110px] rounded border border-input bg-background px-1 text-[11px] font-medium outline-none focus:border-ring"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
        />
      ) : (
        <span
          className="max-w-[110px] cursor-text truncate text-[11px] font-medium"
          title="Double-click to rename"
          onDoubleClick={() => setEditing(true)}
        >
          {tr.lane}
        </span>
      )}
      {/* Filter chip: clicking jumps to + flashes the filter row in the Filters
          panel (same action as the Compare group header), which shows the filter's
          full pattern/fields — so no separate hover card is needed here. */}
      {filter ? (
        <span
          className="inline-flex max-w-[150px] min-w-0 cursor-pointer items-center rounded px-1 py-0.5 text-[11px] font-normal text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          title={`Go to filter ${serial} in Filters`}
          onClick={() => onFocusFilter(tr.filterId)}
        >
          <span className="min-w-0 truncate">
            <span className="font-semibold tabular-nums">{serial}</span> ·{" "}
            {filterName}
          </span>
        </span>
      ) : (
        <span
          className="max-w-[150px] min-w-0 truncate px-1 text-[11px] font-normal text-muted-foreground/70"
          title="Filter not found"
        >
          <span className="font-semibold tabular-nums">{serial}</span> ·{" "}
          {filterName}
        </span>
      )}

      {/* Line count (on-timeline / matchable). Plain muted text — NOT a bordered
          pill: it sits right next to the bordered field/unit selects, where a
          pill would read as another control. Anchors the right-hand cluster. */}
      <span
        className="ml-auto shrink-0 tabular-nums text-[10px] text-muted-foreground"
        title={`${inTl} on the timeline / ${matching} matchable line${matching === 1 ? "" : "s"}`}
      >
        {inTl}
        <span className="opacity-50">/{matching}</span>
      </span>

      {/* Field pill: the start time field and — for a span — the end field, grouped
          in ONE bordered control so the start→end relationship is self-contained.
          kind is derived from having an end field; a point shows just a "+" to add
          one. The unit select stays OUTSIDE the pill so it can't be mistaken for a
          span target. */}
      <div className="inline-flex items-center gap-0.5 rounded-md border border-input bg-background px-0.5">
        <Select
          value={tr.timeField}
          onValueChange={(v) => v != null && onSet({ ...tr, timeField: v })}
        >
          <SelectTrigger
            size="xs"
            className="w-[68px] border-0 bg-transparent shadow-none hover:bg-muted/60 data-[size=xs]:h-5"
          >
            <SelectValue placeholder="field…" />
          </SelectTrigger>
          <SelectContent className={COMPACT}>
            <SelectGroup>
              <SelectLabel>
                {tr.endField ? "Start field" : "Time field"}
              </SelectLabel>
              {fields.map((d) => (
                <SelectItem key={d.name} value={d.name}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {tr.endField ? (
          <>
            <MoveRight className="size-3 shrink-0 text-muted-foreground/60" />
            <Select
              value={tr.endField ?? ""}
              onValueChange={(v) =>
                v != null && onSet({ ...tr, kind: "span", endField: v })
              }
            >
              <SelectTrigger
                size="xs"
                className="w-[68px] border-0 bg-transparent shadow-none hover:bg-muted/60 data-[size=xs]:h-5"
              >
                <SelectValue placeholder="end…" />
              </SelectTrigger>
              <SelectContent className={COMPACT}>
                <SelectGroup>
                  <SelectLabel>End field</SelectLabel>
                  {otherFields.map((d) => (
                    <SelectItem key={d.name} value={d.name}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {/* End < start: the span is illegal, so its end was dropped (drawn as
                a point). Flag it so the user knows to fix the field. */}
            {badEnd && (
              <span
                className="flex shrink-0 items-center text-amber-500"
                title="End time is before start — this span is shown as a point. Pick a different end field."
              >
                <AlertTriangle className="size-3" />
              </span>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-4 shrink-0 rounded text-muted-foreground hover:text-foreground"
              title="Remove end field (make it a point)"
              onClick={() =>
                onSet({ ...tr, kind: "point", endField: undefined })
              }
            >
              <X className="size-3" />
            </Button>
          </>
        ) : addingEnd ? (
          // Adding a span: pick the end field explicitly (nothing pre-selected,
          // so we never commit a likely-wrong end). Committing the choice turns
          // the track into a span; Escape/cancel reverts to a point.
          <>
            <MoveRight className="size-3 shrink-0 text-muted-foreground/60" />
            <Select
              defaultOpen
              value=""
              onValueChange={(v) => {
                if (v) {
                  onSet({ ...tr, kind: "span", endField: v });
                  setAddingEnd(false);
                }
              }}
            >
              <SelectTrigger
                size="xs"
                className="w-[68px] border-0 bg-transparent shadow-none hover:bg-muted/60 data-[size=xs]:h-5"
              >
                <SelectValue placeholder="end…" />
              </SelectTrigger>
              <SelectContent className={COMPACT}>
                <SelectGroup>
                  <SelectLabel>End field</SelectLabel>
                  {otherFields.map((d) => (
                    <SelectItem key={d.name} value={d.name}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-4 shrink-0 rounded text-muted-foreground hover:text-foreground"
              title="Cancel"
              onClick={() => setAddingEnd(false)}
            >
              <X className="size-3" />
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-4 shrink-0 rounded text-muted-foreground/60 hover:text-foreground"
            title="Add an end field → draw as a span"
            onClick={() => setAddingEnd(true)}
            disabled={otherFields.length === 0}
          >
            <Plus className="size-3" />
          </Button>
        )}
      </div>
      <Select
        value={tr.unit}
        onValueChange={(v) =>
          v != null && onSet({ ...tr, unit: v as TimeUnit })
        }
      >
        <SelectTrigger size="xs" className="w-[58px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className={COMPACT}>
          <SelectGroup>
            <SelectLabel>Unit</SelectLabel>
            {UNITS.map((u) => (
              <SelectItem key={u} value={u}>
                {u}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      {/* Custom-format pattern: shown only for the "custom" unit. Tokens are
          moment/dayjs-style; everything else matches literally. Committed on
          blur/Enter. A monospace box so the pattern's columns read clearly. An
          amber triangle (like the bad-span warning) flags an empty / unparseable
          pattern, or one that doesn't match the field's actual values. */}
      {tr.unit === "custom" && (
        <span className="inline-flex shrink-0 items-center gap-0.5">
          <input
            className={`h-5 w-[124px] rounded border bg-background px-1 font-mono text-[11px] outline-none focus:border-ring ${
              badFormat ? "border-amber-500" : "border-input"
            }`}
            placeholder="MM-DD HH:mm:ss.SSS"
            value={fmtDraft}
            spellCheck={false}
            title="Custom time format. Tokens: YYYY YY MMM MM M DD D HH H mm m ss s, and a run of S for fractional seconds. Any other character matches literally."
            onChange={(e) => setFmtDraft(e.target.value)}
            onBlur={commitFormat}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitFormat();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setFmtDraft(tr.format ?? "");
                e.currentTarget.blur();
              }
            }}
          />
          {badFormat && (
            <span
              className="flex shrink-0 items-center text-amber-500"
              title={
                tr.format
                  ? "This time format doesn't parse the field's values — check the pattern (tokens: YYYY MM DD HH mm ss, S for fractions)."
                  : "Enter a time format pattern (e.g. MM-DD HH:mm:ss.SSS)."
              }
            >
              <AlertTriangle className="size-3" />
            </span>
          )}
        </span>
      )}

      {/* Trailing action buttons. When the row is wide enough they sit inline;
          below ~340px (a narrow side dock) they collapse into a ⋯ overflow menu
          so single icons never wrap onto a second line. */}
      <div className="hidden items-center gap-0.5 @[340px]:flex">
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground"
          title="Import this track's matching lines onto the timeline"
          disabled={!canImport}
          onClick={onImport}
        >
          <ListPlus />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground"
          title="Remove this track's lines from the timeline"
          disabled={!canClear}
          onClick={onClearLines}
        >
          <ListX />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className={tr.expanded ? TOGGLE_ON : TOGGLE_OFF}
          title={
            tr.expanded
              ? "Collapse — hide per-point cards"
              : "Expand — show a detail card per point"
          }
          aria-pressed={!!tr.expanded}
          onClick={() =>
            onSet({ ...tr, expanded: tr.expanded ? undefined : true })
          }
        >
          {tr.expanded ? <StickyNote /> : <StickyNoteOff />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className={tr.showDeltas ? TOGGLE_ON : TOGGLE_OFF}
          title={
            tr.showDeltas
              ? "Hide time deltas between points"
              : "Show time deltas between points"
          }
          aria-pressed={!!tr.showDeltas}
          onClick={() =>
            onSet({ ...tr, showDeltas: tr.showDeltas ? undefined : true })
          }
        >
          {tr.showDeltas ? <ChevronsLeftRight /> : <ChevronsLeftRightOff />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className={`${tr.hidden ? "text-muted-foreground/50" : "text-muted-foreground"}`}
          title={tr.hidden ? "Show track" : "Hide track"}
          onClick={() => onSet({ ...tr, hidden: tr.hidden ? undefined : true })}
        >
          {tr.hidden ? <EyeOff /> : <Eye />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-[24px] text-muted-foreground hover:text-destructive"
          title="Delete track"
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-foreground @[340px]:hidden"
              title="Track actions"
            />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={!canImport} onClick={onImport}>
            <span className="mi-ico">
              <ListPlus size={15} />
            </span>
            Import matching lines
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canClear} onClick={onClearLines}>
            <span className="mi-ico">
              <ListX size={15} />
            </span>
            Remove lines from timeline
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              onSet({ ...tr, expanded: tr.expanded ? undefined : true })
            }
          >
            <span className="mi-ico">
              {tr.expanded ? (
                <StickyNote size={15} />
              ) : (
                <StickyNoteOff size={15} />
              )}
            </span>
            {tr.expanded ? "Collapse cards" : "Expand cards"}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              onSet({ ...tr, showDeltas: tr.showDeltas ? undefined : true })
            }
          >
            <span className="mi-ico">
              {tr.showDeltas ? (
                <ChevronsLeftRight size={15} />
              ) : (
                <ChevronsLeftRightOff size={15} />
              )}
            </span>
            {tr.showDeltas ? "Hide time deltas" : "Show time deltas"}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              onSet({ ...tr, hidden: tr.hidden ? undefined : true })
            }
          >
            <span className="mi-ico">
              {tr.hidden ? <EyeOff size={15} /> : <Eye size={15} />}
            </span>
            {tr.hidden ? "Show track" : "Hide track"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onRemove}>
            <span className="mi-ico">
              <Trash2 size={15} />
            </span>
            Delete track
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** The swatch left of the track title: opens a popover to pick color + shape. */
function ColorShapePicker({
  tr,
  onSet,
}: {
  tr: TimelineSource;
  onSet: (tr: TimelineSource) => void;
}) {
  const color = tr.color || "#cdd3da";
  const shape = tr.shape ?? "circle";
  const Active = SHAPES.find((s) => s.id === shape)?.Icon ?? Circle;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-border bg-background hover:bg-accent"
            title="Color & shape"
          />
        }
      >
        <Active size={12} style={{ color }} fill="currentColor" />
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-auto p-2">
        <div className="grid grid-cols-8 gap-1">
          {TRACK_COLORS.map((c) => (
            <button
              key={c}
              className={`size-4 rounded-sm border ${c.toLowerCase() === color.toLowerCase() ? "border-foreground" : "border-black/10"}`}
              style={{ background: c }}
              title={c}
              onClick={() => onSet({ ...tr, color: c })}
            />
          ))}
        </div>
        <div className="mt-2 flex items-center gap-1">
          {SHAPES.map(({ id, Icon, label }) => (
            <button
              key={id}
              className={`flex size-6 items-center justify-center rounded border ${id === shape ? "border-foreground bg-accent" : "border-border"}`}
              title={label}
              onClick={() => onSet({ ...tr, shape: id })}
            >
              <Icon size={12} fill="currentColor" style={{ color }} />
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
