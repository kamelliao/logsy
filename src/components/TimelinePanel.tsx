import { useCallback, useState, useRef, useEffect, CSSProperties } from "react";
import {
  Eye, EyeOff, GripVertical, Trash2, Plus, ListPlus, ListMinus, MoveRight, X,
  Circle, Square, Triangle, Diamond, ChartNoAxesGantt,
} from "lucide-react";
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext, useSortable, arrayMove, verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Filter, FieldDef, TimelineSource, TimeUnit, EventMark, EventShape } from "../types";
import { trackFieldsOf } from "../logic";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "./ui/select";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyContent } from "./ui/empty";
import { TimelineCanvas } from "./TimelineCanvas";

const UNITS: TimeUnit[] = ["hms", "s", "ms", "us", "ns"];

// Compact track palette + the four point shapes for the per-row color/shape picker.
const TRACK_COLORS = [
  "#dbeafe", "#bfdbfe", "#60a5fa", "#a7f3d0", "#86efac", "#4ade80",
  "#fde68a", "#fcd34d", "#fdba74", "#fca5a5", "#f9a8d4", "#d8b4fe",
  "#c7d2fe", "#99f6e4", "#cbd5e1", "#94a3b8",
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
  /** How many log lines the user has added to the timeline. */
  lineCount: number;
  onSetTrack: (tr: TimelineSource) => void;
  onRemoveTrack: (id: string) => void;
  onReorderTracks: (ids: string[]) => void;
  onClear: () => void;
  /** Pull every visible track's matching lines onto the timeline (empty-state bridge). */
  onAddMatchingLines: () => void;
  /** Import one track's matching lines (per-row button). */
  onImportTrackLines: (tr: TimelineSource) => void;
  /** Remove one track's matching lines from the timeline (per-row button). */
  onClearTrackLines: (tr: TimelineSource) => void;
  /** Per track id: how many lines its filter+field matches, and how many of those
   *  are currently on the timeline — drives the import/clear disabled states. */
  trackLineStats: Map<string, { matching: number; inTl: number }>;
  onJump: (lineN: number) => void;
  /** Open the Edit modal for a filter (from a track row's filter chip). */
  onEditFilter: (id: string) => void;
}

const TITLE = "mt-3 mb-1.5 text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground";
// Sized down to the tiny xs trigger it hangs off: the default popup uses text-sm
// with roomy padding, which dwarfs the xs trigger. Shrink item/label text +
// padding to match. Width stays >= the trigger (default min-w-anchor) and grows
// to fit a long field name rather than truncating it.
const COMPACT =
  "[&_[data-slot=select-item]]:gap-1 [&_[data-slot=select-item]]:py-1 [&_[data-slot=select-item]]:pl-1.5 [&_[data-slot=select-item]]:pr-6 [&_[data-slot=select-item]]:text-[11px] " +
  "[&_[data-slot=select-label]]:px-1.5";

export function TimelinePanel({
  tracks, filters, timeFields, marks, lineCount,
  onSetTrack, onRemoveTrack, onReorderTracks, onClear, onAddMatchingLines,
  onImportTrackLines, onClearTrackLines, trackLineStats, onJump, onEditFilter,
}: Props) {
  const lanes = tracks.filter((t) => !t.hidden).map((t) => t.lane);
  // A filter's fields that may back a time field: restricted to the numeric /
  // time-like ones (the timeline can only plot numbers / clocks).
  const fieldsOf = useCallback(
    (f: Filter): FieldDef[] => {
      const allow = timeFields.get(f.id);
      return trackFieldsOf(f).filter((d) => allow?.has(d.name));
    },
    [timeFields],
  );
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

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
    tracks.length === 0 ? "Add a track, then add log lines — events appear here"
    : lineCount === 0 ? "Right-click log lines → Add to timeline"
    : marks.length === 0 ? "Added lines expose no field for these tracks"
    : undefined;
  const hint =
    // No tracks → the Tracks empty state below carries the guidance.
    tracks.length === 0 ? null
    : lineCount === 0 ? (
      <>
        Right-click log lines → <b>Add to timeline</b>, or{" "}
        <button
          type="button"
          className="cursor-pointer font-medium text-foreground underline underline-offset-2 hover:text-primary"
          onClick={onAddMatchingLines}
        >
          add all matching lines
        </button>
        {" "}now.
      </>
    ) : marks.length === 0 ? (
      <>The added lines don't match any track's filter, or expose no track field.</>
    ) : null;

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden px-2.5 py-2 text-xs text-foreground">
      {/* header: guidance on the left, event/line counts (+ clear) on the right */}
      <div className="flex items-center gap-2">
        {hint && <p className="flex-1 leading-relaxed text-muted-foreground">{hint}</p>}
        <span className="ml-auto shrink-0 whitespace-nowrap text-muted-foreground">
          {marks.length} event{marks.length === 1 ? "" : "s"} · {lineCount} line{lineCount === 1 ? "" : "s"}
        </span>
        <Button variant="ghost" size="xs" disabled={lineCount === 0} className="shrink-0 text-muted-foreground" onClick={onClear}>
          Clear lines
        </Button>
      </div>

      {/* canvas — always shown (even empty), sticky above the scrolling rows */}
      <div className="mt-1.5">
        <TimelineCanvas marks={marks} lanes={lanes} onJump={onJump} placeholder={placeholder} />
      </div>

      {/* tracks header (fixed) */}
      <div className={TITLE}>Tracks</div>

      {/* track rows (scroll) — `scroll` matches the filter panel's scrollbar chrome;
          stable gutter keeps rows from shifting when the bar appears; the negative
          right margin cancels the panel's px-2.5 so the bar hugs the panel edge
          (like the filter panel) instead of floating inset */}
      <div className="scroll -mr-2.5 flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable]">
        {tracks.length === 0 ? (
          <Empty className="h-full p-4">
            <EmptyHeader>
              <EmptyMedia variant="icon"><ChartNoAxesGantt /></EmptyMedia>
              <EmptyTitle className="text-sm">No tracks yet</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              <ol className="space-y-1.5 text-left text-xs text-muted-foreground">
                <li>
                  <span className="mr-1 font-semibold text-foreground tabular-nums">1.</span>
                  In the <b className="text-foreground">Filters</b> tab, right-click a filter →{" "}
                  <b className="text-foreground">Add to timeline track</b>.
                </li>
                <li>
                  <span className="mr-1 font-semibold text-foreground tabular-nums">2.</span>
                  In the log view, right-click the lines you want →{" "}
                  <b className="text-foreground">Add to timeline</b>.
                </li>
              </ol>
            </EmptyContent>
          </Empty>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} modifiers={[restrictToVerticalAxis]}>
            <SortableContext items={tracks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
              {tracks.map((tr) => {
                const st = trackLineStats.get(tr.id);
                return (
                <TrackRow
                  key={tr.id} tr={tr} filters={filters} fieldsOf={fieldsOf}
                  onSet={onSetTrack} onRemove={() => onRemoveTrack(tr.id)} onEditFilter={onEditFilter}
                  onImport={() => onImportTrackLines(tr)} onClearLines={() => onClearTrackLines(tr)}
                  canImport={!!st && st.matching > 0 && st.inTl < st.matching}
                  canClear={!!st && st.inTl > 0}
                />
                );
              })}
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}

function TrackRow({ tr, filters, fieldsOf, onSet, onRemove, onEditFilter, onImport, onClearLines, canImport, canClear }: {
  tr: TimelineSource; filters: Filter[]; fieldsOf: (f: Filter) => FieldDef[];
  onSet: (tr: TimelineSource) => void; onRemove: () => void; onEditFilter: (id: string) => void;
  onImport: () => void; onClearLines: () => void; canImport: boolean; canClear: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tr.id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  // Inline rename: double-click the title to edit; commit on Enter/blur.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tr.lane);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) { setDraft(tr.lane); inputRef.current?.focus(); inputRef.current?.select(); } }, [editing, tr.lane]);
  const commitRename = () => {
    const v = draft.trim();
    if (v && v !== tr.lane) onSet({ ...tr, lane: v });
    setEditing(false);
  };

  // The filter is shown as "#N · description" (N = its 1-based order in the set);
  // the chip opens its Edit modal, so the full filter is one click away.
  const filterIndex = filters.findIndex((f) => f.id === tr.filterId);
  const filter = filterIndex >= 0 ? filters[filterIndex] : undefined;
  const fields = filter ? fieldsOf(filter) : [];
  const otherFields = fields.filter((d) => d.name !== tr.timeField);
  const filterName = filter ? (filter.description?.trim() || filter.pattern || filter.id) : "missing filter";
  const serial = filterIndex >= 0 ? `#${filterIndex + 1}` : "#?";

  return (
    <div ref={setNodeRef} style={style} className="mb-1 flex flex-wrap items-center gap-1.5 rounded border border-border/60 bg-card/40 px-1.5 py-1">
      <span className="cursor-grab text-muted-foreground/60 hover:text-muted-foreground" {...attributes} {...listeners}>
        <GripVertical size={12} />
      </span>
      <ColorShapePicker tr={tr} onSet={onSet} />
      {editing ? (
        <input
          ref={inputRef}
          className="h-6 w-[110px] rounded border border-input bg-background px-1 text-xs font-medium outline-none focus:border-ring"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commitRename(); }
            else if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
          }}
        />
      ) : (
        <span
          className="max-w-[110px] cursor-text truncate font-medium"
          title="Double-click to rename"
          onDoubleClick={() => setEditing(true)}
        >
          {tr.lane}
        </span>
      )}
      <Button
        variant="ghost"
        size="xs"
        className="max-w-[150px] min-w-0 px-1 text-[10px] font-normal text-muted-foreground hover:text-foreground"
        title={filter ? `Edit filter — ${filterName}` : "Filter not found"}
        disabled={!filter}
        onClick={() => filter && onEditFilter(filter.id)}
      >
        <span className="min-w-0 truncate">
          <span className="font-semibold tabular-nums">{serial}</span> · {filterName}
        </span>
      </Button>

      {/* Field pill (pushed right, left of unit/hide/delete): the start time field
          and — for a span — the end field, grouped in ONE bordered control so the
          start→end relationship is self-contained. kind is derived from having an
          end field; a point shows just a "+" to add one. The unit select stays
          OUTSIDE the pill so it can't be mistaken for a span target. */}
      <div className="ml-auto inline-flex items-center gap-0.5 rounded-md border border-input bg-background px-0.5">
        <Select value={tr.timeField} onValueChange={(v) => v != null && onSet({ ...tr, timeField: v })}>
          <SelectTrigger size="xs" className="w-[68px] border-0 bg-transparent shadow-none hover:bg-muted/60 data-[size=xs]:h-5"><SelectValue placeholder="field…" /></SelectTrigger>
          <SelectContent className={COMPACT}>
            <SelectGroup>
              <SelectLabel>{tr.endField ? "Start field" : "Time field"}</SelectLabel>
              {fields.map((d) => <SelectItem key={d.name} value={d.name}>{d.name}</SelectItem>)}
            </SelectGroup>
          </SelectContent>
        </Select>
        {tr.endField ? (
          <>
            <MoveRight className="size-3 shrink-0 text-muted-foreground/60" />
            <Select value={tr.endField ?? ""} onValueChange={(v) => v != null && onSet({ ...tr, kind: "span", endField: v })}>
              <SelectTrigger size="xs" className="w-[68px] border-0 bg-transparent shadow-none hover:bg-muted/60 data-[size=xs]:h-5"><SelectValue placeholder="end…" /></SelectTrigger>
              <SelectContent className={COMPACT}>
                <SelectGroup>
                  <SelectLabel>End field</SelectLabel>
                  {otherFields.map((d) => <SelectItem key={d.name} value={d.name}>{d.name}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-4 shrink-0 rounded text-muted-foreground hover:text-foreground"
              title="Remove end field (make it a point)"
              onClick={() => onSet({ ...tr, kind: "point", endField: undefined })}
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
            onClick={() => onSet({ ...tr, kind: "span", endField: otherFields[0].name })}
            disabled={otherFields.length === 0}
          >
            <Plus className="size-3" />
          </Button>
        )}
      </div>
      <Select value={tr.unit} onValueChange={(v) => v != null && onSet({ ...tr, unit: v as TimeUnit })}>
        <SelectTrigger size="xs" className="w-[58px]"><SelectValue /></SelectTrigger>
        <SelectContent className={COMPACT}>
          <SelectGroup>
            <SelectLabel>Unit</SelectLabel>
            {UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
          </SelectGroup>
        </SelectContent>
      </Select>

      <Button
        variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground"
        title="Import this track's matching lines onto the timeline"
        disabled={!canImport}
        onClick={onImport}
      >
        <ListPlus />
      </Button>
      <Button
        variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground"
        title="Remove this track's lines from the timeline"
        disabled={!canClear}
        onClick={onClearLines}
      >
        <ListMinus />
      </Button>
      <Button
        variant="ghost" size="icon-xs"
        className={`${tr.hidden ? "text-muted-foreground/50" : "text-muted-foreground"}`}
        title={tr.hidden ? "Show track" : "Hide track"}
        onClick={() => onSet({ ...tr, hidden: tr.hidden ? undefined : true })}
      >
        {tr.hidden ? <EyeOff /> : <Eye />}
      </Button>
      <Button variant="ghost" size="icon-xs" className="size-[24px] text-muted-foreground hover:text-destructive"
        title="Delete track" onClick={onRemove}>
        <Trash2 />
      </Button>
    </div>
  );
}

/** The swatch left of the track title: opens a popover to pick color + shape. */
function ColorShapePicker({ tr, onSet }: { tr: TimelineSource; onSet: (tr: TimelineSource) => void }) {
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
