import { useMemo, useState, useRef, useEffect, CSSProperties } from "react";
import {
  Eye, EyeOff, GripVertical, Trash2, Plus,
  Circle, Square, Triangle, Diamond,
} from "lucide-react";
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, useSortable, arrayMove, verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Filter, TimelineSource, TimeUnit, EventMark, EventShape } from "../types";
import { trackFieldsOf } from "../logic";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "./ui/select";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
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
  marks: EventMark[];
  /** How many log lines the user has added to the timeline. */
  lineCount: number;
  onSetTrack: (tr: TimelineSource) => void;
  onAddTrack: (filterId: string, timeField: string) => void;
  onRemoveTrack: (id: string) => void;
  onReorderTracks: (ids: string[]) => void;
  onClear: () => void;
  onJump: (lineN: number) => void;
  /** Open the Edit modal for a filter (from a track row's filter chip). */
  onEditFilter: (id: string) => void;
}

const TITLE = "mt-3 mb-1.5 text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground";
const EMPTY = "px-0.5 py-1 text-muted-foreground leading-relaxed";
// Sized down to the tiny xs trigger it hangs off: the default popup uses text-sm
// with roomy padding, which dwarfs the xs trigger. Shrink item/label text +
// padding to match. Width stays >= the trigger (default min-w-anchor) and grows
// to fit a long field name rather than truncating it.
const COMPACT =
  "[&_[data-slot=select-item]]:gap-1 [&_[data-slot=select-item]]:py-1 [&_[data-slot=select-item]]:pl-1.5 [&_[data-slot=select-item]]:pr-6 [&_[data-slot=select-item]]:text-[11px] " +
  "[&_[data-slot=select-label]]:px-1.5";

export function TimelinePanel({
  tracks, filters, marks, lineCount,
  onSetTrack, onAddTrack, onRemoveTrack, onReorderTracks, onClear, onJump, onEditFilter,
}: Props) {
  const lanes = tracks.filter((t) => !t.hidden).map((t) => t.lane);
  // Filters that expose at least one parsed field can back a track.
  const usableFilters = useMemo(
    () => filters.filter((f) => trackFieldsOf(f).length > 0),
    [filters],
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
    tracks.length === 0 ? (
      <>
        A track plots one parsed field of one filter. Add a regex filter with a named
        group like <code className="rounded bg-muted px-1">{"(?<ts>…)"}</code>, then
        right-click the filter → <b>Add to timeline track</b> (or <b>+ Add track</b> below),
        and right-click log lines → <b>Add to timeline</b>.
      </>
    ) : lineCount === 0 ? (
      <>Right-click log lines → <b>Add to timeline</b> to place their timestamps here.</>
    ) : marks.length === 0 ? (
      <>The added lines don't match any track's filter, or expose no track field.</>
    ) : null;

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden px-2.5 py-2 text-xs text-foreground">
      {/* header */}
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">
          {marks.length} event{marks.length === 1 ? "" : "s"} · {lineCount} line{lineCount === 1 ? "" : "s"}
        </span>
        {lineCount > 0 && (
          <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground" onClick={onClear}>
            Clear lines
          </Button>
        )}
      </div>

      {/* canvas — always shown (even empty), sticky above the scrolling rows */}
      <div className="mt-1.5">
        <TimelineCanvas marks={marks} lanes={lanes} onJump={onJump} placeholder={placeholder} />
      </div>
      {hint && <p className={EMPTY}>{hint}</p>}

      {/* tracks header (fixed) */}
      <div className="flex items-center gap-2">
        <div className={TITLE}>Tracks</div>
        <AddTrack filters={usableFilters} onAdd={onAddTrack} className="ml-auto mt-3 mb-1.5" />
      </div>

      {/* track rows (scroll) — `scroll` matches the filter panel's scrollbar chrome;
          stable gutter keeps rows from shifting when the bar appears; the negative
          right margin cancels the panel's px-2.5 so the bar hugs the panel edge
          (like the filter panel) instead of floating inset */}
      <div className="scroll -mr-2.5 flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable]">
        {tracks.length === 0 ? (
          <p className={EMPTY}>No tracks. Use <b>+ Add track</b> to pick a filter and a field.</p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={tracks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
              {tracks.map((tr) => (
                <TrackRow
                  key={tr.id} tr={tr} filters={filters}
                  onSet={onSetTrack} onRemove={() => onRemoveTrack(tr.id)} onEditFilter={onEditFilter}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}

/** "+ Add track" — pick a filter, then a field; adds on field choice. */
function AddTrack({ filters, onAdd, className }: {
  filters: Filter[]; onAdd: (filterId: string, field: string) => void; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [filterId, setFilterId] = useState<string>("");
  const filter = filters.find((f) => f.id === filterId);
  const fields = filter ? trackFieldsOf(filter) : [];

  if (filters.length === 0) return null;

  if (!open) {
    return (
      <Button variant="ghost" size="xs" className={className} onClick={() => setOpen(true)}>
        <Plus className="size-3" /> Add track
      </Button>
    );
  }
  return (
    <div className={`flex items-center gap-1.5 ${className ?? ""}`}>
      <Select value={filterId} onValueChange={(v) => v != null && setFilterId(v)}>
        <SelectTrigger size="sm" className="w-[120px]"><SelectValue placeholder="filter…" /></SelectTrigger>
        <SelectContent>
          {filters.map((f) => (
            <SelectItem key={f.id} value={f.id}>{f.description || f.pattern || f.id}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value=""
        onValueChange={(v) => { if (v != null && filterId) { onAdd(filterId, v); setOpen(false); setFilterId(""); } }}
      >
        <SelectTrigger size="sm" className="w-[100px]" disabled={!filter}>
          <SelectValue placeholder="field…" />
        </SelectTrigger>
        <SelectContent>
          {fields.map((d) => <SelectItem key={d.name} value={d.name}>{d.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button variant="ghost" size="xs" className="text-muted-foreground"
        onClick={() => { setOpen(false); setFilterId(""); }}>
        cancel
      </Button>
    </div>
  );
}

function TrackRow({ tr, filters, onSet, onRemove, onEditFilter }: {
  tr: TimelineSource; filters: Filter[];
  onSet: (tr: TimelineSource) => void; onRemove: () => void; onEditFilter: (id: string) => void;
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
  const fields = filter ? trackFieldsOf(filter) : [];
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
      <button
        type="button"
        className="max-w-[150px] cursor-pointer truncate rounded px-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:hover:bg-transparent"
        title={filter ? `Edit filter — ${filterName}` : "Filter not found"}
        disabled={!filter}
        onClick={() => filter && onEditFilter(filter.id)}
      >
        <span className="font-semibold tabular-nums">{serial}</span> · {filterName}
      </button>

      {/* config selects — small, pushed to the right (left of hide/delete).
          Mark kind (point/span) sits left of the time field. */}
      <Select value={tr.kind} onValueChange={(v) => v != null && onSet({ ...tr, kind: v as "point" | "span" })}>
        <SelectTrigger size="xs" className="ml-auto w-[66px]"><SelectValue /></SelectTrigger>
        <SelectContent className={COMPACT}>
          <SelectGroup>
            <SelectLabel>Mark kind</SelectLabel>
            <SelectItem value="point">point</SelectItem>
            <SelectItem value="span" disabled={otherFields.length === 0}>span</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      <Select value={tr.timeField} onValueChange={(v) => v != null && onSet({ ...tr, timeField: v })}>
        <SelectTrigger size="xs" className="w-[78px]"><SelectValue placeholder="field…" /></SelectTrigger>
        <SelectContent className={COMPACT}>
          <SelectGroup>
            <SelectLabel>Time field</SelectLabel>
            {fields.map((d) => <SelectItem key={d.name} value={d.name}>{d.name}</SelectItem>)}
          </SelectGroup>
        </SelectContent>
      </Select>
      {tr.kind === "span" && (
        <Select value={tr.endField ?? ""} onValueChange={(v) => v != null && onSet({ ...tr, endField: v })}>
          <SelectTrigger size="xs" className="w-[78px]"><SelectValue placeholder="end…" /></SelectTrigger>
          <SelectContent className={COMPACT}>
            <SelectGroup>
              <SelectLabel>End field</SelectLabel>
              {otherFields.map((d) => <SelectItem key={d.name} value={d.name}>→ {d.name}</SelectItem>)}
            </SelectGroup>
          </SelectContent>
        </Select>
      )}
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
        variant="ghost" size="icon-xs"
        className={`${tr.hidden ? "text-muted-foreground/50" : "text-muted-foreground"}`}
        title={tr.hidden ? "Show track" : "Hide track"}
        onClick={() => onSet({ ...tr, hidden: tr.hidden ? undefined : true })}
      >
        {tr.hidden ? <EyeOff /> : <Eye />}
      </Button>
      <Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-destructive"
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
