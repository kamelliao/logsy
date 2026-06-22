import {
  memo,
  useState,
  useMemo,
  useRef,
  useEffect,
  useCallback,
  CSSProperties,
  ReactNode,
  MouseEvent as ReactMouseEvent,
} from "react";
import {
  ChartGantt,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Columns3,
  Copy,
  Eye,
  EyeOff,
  Filter as FilterIcon,
  FileDown,
  FilePlus,
  FolderPlus,
  GripVertical,
  ListChecks,
  ListX,
  MoreVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  Save,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  pointerWithin,
  rectIntersection,
  getFirstCollision,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  DragStartEvent,
  DragOverEvent,
  DragEndEvent,
  CollisionDetection,
  UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  LogFile,
  FilterSet,
  FilterGroup,
  Filter,
  FilterLayout,
  FieldDef,
} from "@/types";
import { trackFieldsOf } from "@/lib/engine";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

// Shared empty array so rows whose filter has no tracks all get the same
// reference — keeps FilterRow's memo from breaking on every panel render.
const NO_TRACKED_FIELDS: string[] = [];

// ---- shared menu item groups ----
// Rendered inside both the "⋮" dropdown and the right-click context menu.
// (base-ui's ContextMenu reuses the same MenuItem/Separator parts, so these
// fragments work in either popup.)

function RowMenuItems({
  onEdit,
  onViewOnly,
  onDuplicate,
  onDelete,
  timeFields,
  trackedFields,
  onToggleTrack,
  hasFields,
  onCompare,
}: {
  onEdit: () => void;
  onViewOnly: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** Numeric fields of this filter that can back a timeline track. */
  timeFields: FieldDef[];
  /** Names of this filter's fields already plotted as a timeline track. */
  trackedFields: string[];
  onToggleTrack: (field: string) => void;
  /** Whether this filter has any parsed (named-capture) field — gates Compare. */
  hasFields: boolean;
  /** Pull every line this filter parsed into the comparison + reveal Compare. */
  onCompare: () => void;
}) {
  // Timeline items behave like checkboxes: a ✓ marks a tracked field, and
  // clicking toggles it (add when off, remove when on).
  const isTracked = (name: string) => trackedFields.includes(name);
  // Single-field item: the leading icon doubles as the tracked indicator.
  const singleTracked =
    timeFields.length === 1 && isTracked(timeFields[0].name);
  // Sub-trigger: ✓ when every usable field is already a track.
  const allTracked =
    timeFields.length > 0 && timeFields.every((d) => isTracked(d.name));
  return (
    <>
      <DropdownMenuItem onClick={onEdit}>
        <span className="mi-ico">
          <Pencil size={15} />
        </span>
        Edit
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onViewOnly}>
        <span className="mi-ico">
          <Eye size={15} />
        </span>
        View this filter only
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onDuplicate}>
        <span className="mi-ico">
          <Copy size={15} />
        </span>
        Duplicate
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {timeFields.length === 0 ? (
        // No capture field → the action can't work. Show it disabled (not
        // hidden) with a one-line reason, so the path isn't a silent dead end.
        <DropdownMenuItem
          disabled
          className="disabled"
          title="Needs a named capture field, e.g. (?<ts>\d+)"
        >
          <span className="mi-ico">
            <ChartGantt size={15} />
          </span>
          Add to timeline track
        </DropdownMenuItem>
      ) : (
        <>
          {timeFields.length === 1 ? (
            <DropdownMenuItem onClick={() => onToggleTrack(timeFields[0].name)}>
              <span className="mi-ico">
                {singleTracked ? <Check size={15} /> : <ChartGantt size={15} />}
              </span>
              {singleTracked
                ? "Remove from timeline track"
                : "Add to timeline track"}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span className="mi-ico">
                  {allTracked ? <Check size={15} /> : <ChartGantt size={15} />}
                </span>
                Add to timeline tracks
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {timeFields.map((d) => (
                  <DropdownMenuItem
                    key={d.name}
                    onClick={() => onToggleTrack(d.name)}
                  >
                    <span className="mi-ico">
                      {isTracked(d.name) ? <Check size={15} /> : null}
                    </span>
                    {d.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
        </>
      )}
      {hasFields ? (
        <DropdownMenuItem onClick={onCompare}>
          <span className="mi-ico">
            <Columns3 size={15} />
          </span>
          Compare matching lines
        </DropdownMenuItem>
      ) : (
        // No parsed field → nothing to line up. Disabled with a reason, mirroring
        // the timeline item, so the path isn't a silent dead end.
        <DropdownMenuItem
          disabled
          className="disabled"
          title="Needs a named capture field, e.g. (?<ts>\d+)"
        >
          <span className="mi-ico">
            <Columns3 size={15} />
          </span>
          Compare matching lines
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={onDelete}>
        <span className="mi-ico">
          <Trash2 size={15} />
        </span>
        Delete
      </DropdownMenuItem>
    </>
  );
}

function SetTabMenuItems({
  onRename,
  onDuplicate,
  onDelete,
  canDelete,
}: {
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  canDelete: boolean;
}) {
  return (
    <>
      <DropdownMenuItem onClick={onRename}>
        <span className="mi-ico">
          <Pencil size={15} />
        </span>
        Rename set
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onDuplicate}>
        <span className="mi-ico">
          <Copy size={15} />
        </span>
        Duplicate set
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        variant="destructive"
        disabled={!canDelete}
        onClick={() => {
          if (canDelete) onDelete();
        }}
      >
        <span className="mi-ico">
          <Trash2 size={15} />
        </span>
        Delete set
      </DropdownMenuItem>
    </>
  );
}

function GroupMenuItems({
  onRename,
  onAddFilter,
  onSetEnabled,
  onDelete,
}: {
  onRename: () => void;
  onAddFilter: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  return (
    <>
      <DropdownMenuItem onClick={onRename}>
        <span className="mi-ico">
          <Pencil size={15} />
        </span>
        Rename group
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onAddFilter}>
        <span className="mi-ico">
          <Plus size={15} />
        </span>
        Add filter
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => onSetEnabled(true)}>
        <span className="mi-ico">
          <ListChecks size={15} />
        </span>
        Enable all in group
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onSetEnabled(false)}>
        <span className="mi-ico">
          <ListX size={15} />
        </span>
        Disable all in group
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={onDelete}>
        <span className="mi-ico">
          <Trash2 size={15} />
        </span>
        Delete group (keep filters)
      </DropdownMenuItem>
    </>
  );
}

function PanelMenuItems({
  onAddFilter,
  onAddGroup,
  onBulk,
  onEnterSelect,
}: {
  onAddFilter: () => void;
  onAddGroup: () => void;
  onBulk: (action: string) => void;
  onEnterSelect: () => void;
}) {
  return (
    <>
      <DropdownMenuItem onClick={onAddFilter}>
        <span className="mi-ico">
          <Plus size={15} />
        </span>
        Add filter
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onAddGroup}>
        <span className="mi-ico">
          <FolderPlus size={15} />
        </span>
        New group
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={onEnterSelect}>
        <span className="mi-ico">
          <CheckSquare size={15} />
        </span>
        Select filters…
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => onBulk("enableAll")}>
        <span className="mi-ico">
          <ListChecks size={15} />
        </span>
        Enable all filters
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onBulk("disableAll")}>
        <span className="mi-ico">
          <ListX size={15} />
        </span>
        Disable all filters
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => onBulk("save")}>
        <span className="mi-ico">
          <Save size={15} />
        </span>
        Save filters
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onBulk("saveAs")}>
        <span className="mi-ico">
          <FileDown size={15} />
        </span>
        Save filters as…
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onBulk("import")}>
        <span className="mi-ico">
          <Upload size={15} />
        </span>
        Import filters…
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onBulk("append")}>
        <span className="mi-ico">
          <FilePlus size={15} />
        </span>
        Append filters…
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={() => onBulk("clear")}>
        <span className="mi-ico">
          <Trash2 size={15} />
        </span>
        Delete all filters
      </DropdownMenuItem>
    </>
  );
}

// ---- set tab ----

interface SetTabProps {
  set: FilterSet;
  active: boolean;
  dot: string;
  canDelete: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}

function SetTab({
  set,
  active,
  dot,
  canDelete,
  onSelect,
  onRename,
  onDelete,
  onDuplicate,
}: SetTabProps) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(set.name);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: set.id });

  function commit() {
    const v = val.trim();
    if (v) onRename(v);
    else setVal(set.name);
    setEditing(false);
  }

  const style: CSSProperties = {
    // lock to the horizontal axis so vertical dragging can't trigger a scrollbar
    transform: CSS.Transform.toString(
      transform ? { ...transform, y: 0 } : null,
    ),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            ref={setNodeRef}
            style={style}
            className={"gtab" + (active ? " active" : "")}
            onClick={onSelect}
            onDoubleClick={() => {
              setVal(set.name);
              setEditing(true);
            }}
            title="Drag to reorder · double-click to rename · right-click for menu"
            {...attributes}
            {...(editing ? {} : listeners)}
          />
        }
      >
        <span className="gtab-dot" style={{ background: dot }} />
        {editing ? (
          <input
            className="gtab-name-input"
            value={val}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setVal(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setVal(set.name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <span className="gtab-name">{set.name}</span>
        )}
        <span className="gtab-count">{set.filters.length}</span>
        {canDelete && (
          <button
            className="gtab-x"
            title="Delete set"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <X size={12} />
          </button>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <SetTabMenuItems
          onRename={() => {
            setVal(set.name);
            setEditing(true);
          }}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          canDelete={canDelete}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ---- filter row ----

/** Row actions, id-based and identity-stable so memoized rows never re-render
 *  just because the panel did. */
interface RowApi {
  update: (id: string, patch: Partial<Filter>) => void;
  edit: (id: string) => void;
  remove: (id: string) => void;
  duplicate: (id: string) => void;
  viewOnly: (id: string) => void;
  toggleTrack: (filterId: string, timeField: string) => void;
  compareFilter: (id: string) => void;
  /** Select mode: toggle this row's selection (Shift extends a range). */
  selectClick: (id: string, e: ReactMouseEvent) => void;
  /** Ctrl/Cmd-click on a row (outside select mode): enter select mode on it. */
  beginSelect: (id: string, e: ReactMouseEvent) => void;
}

interface FilterRowProps {
  f: Filter;
  /** 0-based position in the set; shown as a 1-based "#N" serial (matches the timeline). */
  index: number;
  count: number;
  /** Names of this filter's fields already plotted as a timeline track (stable ref). */
  trackedFields: string[];
  searching: boolean;
  /** Selection mode is active: row-click selects instead of opening the editor. */
  selectMode: boolean;
  /** This row is part of the current selection. */
  selected: boolean;
  api: RowApi;
}

function sameFields(a?: FieldDef[], b?: FieldDef[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++)
    if (a[i].name !== b[i].name || a[i].type !== b[i].type) return false;
  return true;
}
// patchState structured-clones the whole state, so every filter object has a
// fresh identity after any edit — rows must compare by value to skip renders.
function sameFilter(a: Filter, b: Filter): boolean {
  return (
    a.id === b.id &&
    a.pattern === b.pattern &&
    a.description === b.description &&
    a.enabled === b.enabled &&
    a.caseSensitive === b.caseSensitive &&
    a.regex === b.regex &&
    a.exclude === b.exclude &&
    a.textColor === b.textColor &&
    a.bgColor === b.bgColor &&
    a.groupId === b.groupId &&
    sameFields(a.fields, b.fields)
  );
}

// The heavy half of a row: three floating-ui wrappers (hover card, context
// menu, dropdown) plus every cell. Memoized so the dnd context churn during a
// drag — dnd-kit re-renders every sortable subscriber on drag start and again
// each time the pointer crosses a row — only re-runs the thin shell below,
// not 100+ of these trees per step.
const FilterRowCells = memo(
  function FilterRowCells({
    f,
    index,
    count,
    trackedFields,
    api,
    dragging,
    selectMode,
    selected,
  }: {
    f: Filter;
    index: number;
    count: number;
    trackedFields: string[];
    api: RowApi;
    dragging: boolean;
    selectMode: boolean;
    selected: boolean;
  }) {
    const onEdit = () => api.edit(f.id);
    const onDelete = () => api.remove(f.id);
    const onDuplicate = () => api.duplicate(f.id);
    const onViewOnly = () => api.viewOnly(f.id);
    const timeFields = trackFieldsOf(f);
    const onToggleTrack = (field: string) => api.toggleTrack(f.id, field);
    const hasFields = !!f.fields?.length;
    const onCompare = () => api.compareFilter(f.id);

    return (
      <HoverCard>
        <ContextMenu>
          {/* The row div is, at once, the right-click target and the hover-card
            trigger — base-ui merges the nested render props onto the single
            div. (The dnd-sortable node is the shell wrapping this.) */}
          {/* Snappier than the 600ms default so the detail card feels responsive on hover. */}
          <HoverCardTrigger
            delay={150}
            render={
              <ContextMenuTrigger
                render={
                  <div
                    style={{ alignItems: "center" }}
                    className={
                      "filter-row" +
                      (f.enabled ? "" : " disabled") +
                      (dragging ? " dragging" : "") +
                      (selectMode ? " selecting" : "") +
                      (selected ? " selected" : "")
                    }
                    onClick={
                      selectMode
                        ? (e) => api.selectClick(f.id, e)
                        : (e) =>
                            e.ctrlKey || e.metaKey
                              ? api.beginSelect(f.id, e)
                              : onEdit()
                    }
                  />
                }
              />
            }
          >
            {selectMode ? (
              // Selection indicator: the same Checkbox primitive, recoloured (see
              // .fr-sel-check) so it's distinct from the enable toggle beside it.
              // Presentational only: pointer-events:none (see CSS) so the click
              // lands on the row, which drives selection.
              <span className="fr-select">
                <Checkbox
                  checked={selected}
                  onCheckedChange={() => {}}
                  className="fr-sel-check"
                />
              </span>
            ) : (
              <span className="fr-handle" title="Drag to reorder">
                <GripVertical size={12} />
              </span>
            )}

            {/* Stop clicks here from bubbling to the row (which would open the editor). */}
            <span
              className="fr-check-wrap"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <Checkbox
                checked={f.enabled}
                onCheckedChange={(checked) =>
                  api.update(f.id, { enabled: !!checked })
                }
                title={
                  f.enabled
                    ? "Enabled — click to disable"
                    : "Disabled — click to enable"
                }
              />
            </span>

            {index >= 0 && (
              <span className="fr-serial" title={`Filter #${index + 1}`}>
                #{index + 1}
              </span>
            )}

            {/* Description-first: when a filter has a description it's the primary
            label and the pattern lives in the hover card; otherwise show the
            pattern. The label wears the filter's own highlight (its log colour
            pair) as a chip so the row reads at a glance like its matches do. No
            per-cell titles — the hover card carries full detail. */}
            {f.description || f.pattern ? (
              <div className="fr-pattern">
                <span
                  className="fr-pattern-chip"
                  style={{ background: f.bgColor, color: f.textColor }}
                >
                  {f.description || f.pattern}
                </span>
              </div>
            ) : (
              <div className="fr-pattern">
                <span className="placeholder">untitled filter</span>
              </div>
            )}

            {/* Field-name and Aa/.* flag chips live only in the hover card now —
            the row keeps just the exclude badge (a semantic flag, easy to miss
            otherwise), hit count, and the actions menu. */}
            {f.exclude && (
              <span className="fr-flag ex">
                <EyeOff size={12} />
              </span>
            )}

            <div className={"fr-count" + (f.exclude ? " ex" : "")}>
              <b>{count.toLocaleString()}</b>
              <span className="fr-hits">&nbsp;hits</span>
            </div>

            <div
              className="fr-actions"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="ghost" size="icon-xs" title="More" />
                  }
                >
                  <MoreVertical />
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="end">
                  <RowMenuItems
                    onEdit={onEdit}
                    onViewOnly={onViewOnly}
                    onDuplicate={onDuplicate}
                    onDelete={onDelete}
                    timeFields={timeFields}
                    trackedFields={trackedFields}
                    onToggleTrack={onToggleTrack}
                    hasFields={hasFields}
                    onCompare={onCompare}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </HoverCardTrigger>
          <ContextMenuContent>
            <RowMenuItems
              onEdit={onEdit}
              onViewOnly={onViewOnly}
              onDuplicate={onDuplicate}
              onDelete={onDelete}
              timeFields={timeFields}
              trackedFields={trackedFields}
              onToggleTrack={onToggleTrack}
              hasFields={hasFields}
              onCompare={onCompare}
            />
          </ContextMenuContent>
        </ContextMenu>

        <HoverCardContent
          side="left"
          align="start"
          sideOffset={8}
          className="w-72 p-0 overflow-hidden"
        >
          <div className="fr-card">
            <div className="fr-card-head">
              <span
                className="fr-card-swatch"
                style={{ background: f.bgColor, borderColor: f.textColor }}
              />
              <code className="fr-card-pattern">
                {f.pattern || (
                  <span className="placeholder">untitled filter</span>
                )}
              </code>
            </div>
            <div className="fr-card-body">
              {f.description && (
                <div className="fr-card-desc">{f.description}</div>
              )}

              <div className="fr-card-stat">
                <span className={"fr-card-count" + (f.exclude ? " ex" : "")}>
                  {count.toLocaleString()}
                </span>
                <span className="fr-card-unit">
                  {f.exclude ? "lines hidden" : "matches"}
                </span>
              </div>

              {(f.regex || f.caseSensitive || f.exclude) && (
                <div className="fr-card-pills">
                  {f.regex && (
                    <span className="fr-pill">
                      <span className="fr-pill-g">.*</span>regex
                    </span>
                  )}
                  {f.caseSensitive && (
                    <span className="fr-pill">
                      <span className="fr-pill-g">Aa</span>case-sensitive
                    </span>
                  )}
                  {f.exclude && (
                    <span className="fr-pill ex">
                      <EyeOff size={11} />
                      exclude
                    </span>
                  )}
                </div>
              )}

              {f.fields && f.fields.length > 0 && (
                <div className="fr-card-fields">
                  <span className="fr-card-flabel">Parses</span>
                  <div className="fr-card-chips">
                    {f.fields.map((x) => (
                      <span key={x.name} className="fr-chip-field">
                        {x.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Timeline membership lives here (not on the row): which fields
                  of this filter are plotted as tracks. */}
              {trackedFields.length > 0 && (
                <div className="fr-card-fields">
                  <span className="fr-card-flabel">Timeline</span>
                  <div className="fr-card-chips">
                    {trackedFields.map((name) => (
                      <span key={name} className="fr-chip-field tl">
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </HoverCardContent>
      </HoverCard>
    );
  },
  (prev, next) =>
    sameFilter(prev.f, next.f) &&
    prev.index === next.index &&
    prev.count === next.count &&
    prev.trackedFields === next.trackedFields &&
    prev.dragging === next.dragging &&
    prev.api === next.api &&
    prev.selectMode === next.selectMode &&
    prev.selected === next.selected,
);

// Thin sortable shell: just the dnd hook and a wrapper div carrying the drag
// transform/listeners. This is all that re-renders when dnd-kit's contexts
// change mid-drag; the memoized cells above are skipped while their props are
// stable. (memo on the shell itself covers parent-driven re-renders; context
// updates from inside useSortable bypass it by design.)
const FilterRow = memo(
  function FilterRow({
    f,
    index,
    count,
    trackedFields,
    searching,
    selectMode,
    selected,
    api,
  }: FilterRowProps) {
    const {
      attributes,
      listeners,
      setNodeRef,
      transform,
      transition,
      isDragging,
    } = useSortable({
      id: f.id,
      // No reordering while searching or picking a selection — drag listeners off.
      disabled: searching || selectMode,
      data: { type: "filter", groupId: f.groupId },
    });
    const style: CSSProperties = {
      transform: CSS.Transform.toString(transform),
      transition,
    };
    return (
      <div
        ref={setNodeRef}
        data-filter-id={f.id}
        style={style}
        {...attributes}
        {...(searching || selectMode ? {} : listeners)}
      >
        <FilterRowCells
          f={f}
          index={index}
          count={count}
          trackedFields={trackedFields}
          api={api}
          dragging={isDragging}
          selectMode={selectMode}
          selected={selected}
        />
      </div>
    );
  },
  (prev, next) =>
    sameFilter(prev.f, next.f) &&
    prev.index === next.index &&
    prev.count === next.count &&
    prev.trackedFields === next.trackedFields &&
    prev.searching === next.searching &&
    prev.api === next.api &&
    prev.selectMode === next.selectMode &&
    prev.selected === next.selected,
);

// ---- group ----

interface GroupBlockProps {
  group: FilterGroup;
  filters: Filter[];
  onToggle: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onAddFilter: () => void;
  onSetEnabled: (enabled: boolean) => void;
  renderRow: (f: Filter) => ReactNode;
}

function GroupBlock({
  group,
  filters,
  onToggle,
  onRename,
  onDelete,
  onAddFilter,
  onSetEnabled,
  renderRow,
}: GroupBlockProps) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(group.name);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: group.id,
    data: { type: "group" },
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `body:${group.id}`,
    data: { type: "body", groupId: group.id },
  });
  // A filter can be dropped anywhere on the group (header or body) to move in.
  const {
    setNodeRef: setHeadRef,
    isOver: headOver,
    active: dragActive,
  } = useDroppable({
    id: `head:${group.id}`,
    data: { type: "header", groupId: group.id },
  });
  // Light up the whole group while a filter row is dragged over its header or body.
  const nestTarget =
    (headOver || isOver) && dragActive?.data.current?.type === "filter";

  function commit() {
    const v = val.trim();
    if (v) onRename(v);
    else setVal(group.name);
    setEditing(false);
  }

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={
        "fsection" +
        (nestTarget ? " nest-target" : "") +
        (isDragging ? " dragging" : "")
      }
    >
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              ref={setHeadRef}
              className="fsection-head"
              title="Right-click for menu · drag to reorder · drop a filter here to add it"
              {...attributes}
              {...listeners}
            />
          }
        >
          <span className="fs-grip">
            <GripVertical size={12} />
          </span>
          <button
            className="fs-chevron"
            title={group.collapsed ? "Expand" : "Collapse"}
            onClick={onToggle}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {group.collapsed ? (
              <ChevronRight size={14} />
            ) : (
              <ChevronDown size={14} />
            )}
          </button>
          {editing ? (
            <input
              className="fs-name-input"
              value={val}
              autoFocus
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => setVal(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") {
                  setVal(group.name);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <span
              className="fs-name"
              onClick={onToggle}
              onDoubleClick={() => {
                setVal(group.name);
                setEditing(true);
              }}
              title="Click to collapse · double-click to rename"
            >
              {group.name}
            </span>
          )}
          <span className="fs-count">{filters.length}</span>
          <button
            className="fs-add"
            title="Add filter to this group"
            onClick={onAddFilter}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Plus size={14} />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="Group actions"
                  onPointerDown={(e) => e.stopPropagation()}
                />
              }
            >
              <MoreVertical />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end">
              <GroupMenuItems
                onRename={() => {
                  setVal(group.name);
                  setEditing(true);
                }}
                onAddFilter={onAddFilter}
                onSetEnabled={onSetEnabled}
                onDelete={onDelete}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <GroupMenuItems
            onRename={() => {
              setVal(group.name);
              setEditing(true);
            }}
            onAddFilter={onAddFilter}
            onSetEnabled={onSetEnabled}
            onDelete={onDelete}
          />
        </ContextMenuContent>
      </ContextMenu>

      {!group.collapsed && (
        <div
          ref={setDropRef}
          className={"fsection-body" + (isOver ? " drop-over" : "")}
        >
          <SortableContext
            items={filters.map((f) => f.id)}
            strategy={verticalListSortingStrategy}
          >
            {filters.length === 0 ? (
              <div className="fs-empty">
                Drop a filter on the title above, or click +
              </div>
            ) : (
              filters.map((f) => renderRow(f))
            )}
          </SortableContext>
        </div>
      )}
    </div>
  );
}

// ---- top-level drop zone (the "loose / ungrouped" target) ----

function TopDropZone({ children }: { children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({
    id: "body:__null__",
    data: { type: "body", groupId: null },
  });
  return (
    <div
      ref={setNodeRef}
      className={"fp-toplevel" + (isOver ? " drop-over" : "")}
    >
      {children}
    </div>
  );
}

// A loose drop target below every top-level item — so a filter can be dropped
// past the last group to become the bottom-most free filter (the group body
// itself always nests). Collapses to nothing unless a filter drag is active.
function BottomSlot({ active }: { active: boolean }) {
  const { setNodeRef, isOver } = useDroppable({
    id: "bottomslot",
    data: { type: "bottomslot" },
  });
  return (
    <div
      ref={setNodeRef}
      className={
        "fp-bottomslot" + (active ? " on" : "") + (isOver ? " drop-over" : "")
      }
    />
  );
}

// ---- panel-level right-click zone (wraps the scrollable filter list) ----

function PanelListZone({
  onAddFilter,
  onAddGroup,
  onBulk,
  onEnterSelect,
  children,
}: {
  onAddFilter: () => void;
  onAddGroup: () => void;
  onBulk: (action: string) => void;
  onEnterSelect: () => void;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="filter-list scroll" />}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <PanelMenuItems
          onAddFilter={onAddFilter}
          onAddGroup={onAddGroup}
          onBulk={onBulk}
          onEnterSelect={onEnterSelect}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ---- drag overlays (the floating clone shown while dragging) ----

function FilterRowOverlay({
  f,
  index,
  count,
}: {
  f: Filter;
  index: number;
  count: number;
}) {
  return (
    <div
      className={"filter-row drag-overlay" + (f.enabled ? "" : " disabled")}
      style={{ alignItems: "center" }}
    >
      <span className="fr-handle">
        <GripVertical size={12} />
      </span>
      <span className="fr-check-wrap">
        <Checkbox checked={f.enabled} onCheckedChange={() => {}} />
      </span>
      {index >= 0 && <span className="fr-serial">#{index + 1}</span>}
      {f.description || f.pattern ? (
        <div className="fr-pattern">
          <span
            className="fr-pattern-chip"
            style={{ background: f.bgColor, color: f.textColor }}
          >
            {f.description || f.pattern}
          </span>
        </div>
      ) : (
        <div className="fr-pattern">
          <span className="placeholder">untitled filter</span>
        </div>
      )}
      {f.exclude && (
        <span className="fr-flag ex">
          <EyeOff size={12} />
        </span>
      )}
      <div className={"fr-count" + (f.exclude ? " ex" : "")}>
        <b>{count.toLocaleString()}</b>
        <span className="fr-hits">&nbsp;hits</span>
      </div>
    </div>
  );
}

function GroupOverlay({ group, count }: { group: FilterGroup; count: number }) {
  return (
    <div className="fsection drag-overlay">
      <div className="fsection-head">
        <span className="fs-grip">
          <GripVertical size={12} />
        </span>
        <span className="fs-chevron">
          {group.collapsed ? (
            <ChevronRight size={14} />
          ) : (
            <ChevronDown size={14} />
          )}
        </span>
        <span className="fs-name">{group.name}</span>
        <span className="fs-count">{count}</span>
      </div>
    </div>
  );
}

// ---- panel ----

interface FilterPanelProps {
  file: LogFile;
  set: FilterSet;
  counts: Record<string, number>;
  style?: CSSProperties;
  /** Toggle a timeline track bound to (filterId, timeField): add if absent, remove
   *  if present. Still a prop — owned by useTimeline, not yet in the store. */
  onToggleTimelineTrack: (filterId: string, timeField: string) => void;
  /** Pull a filter's parsed lines into the comparison + reveal the Compare tab
   *  (the Compare analogue of "Add to timeline track"). */
  onCompareFilter: (filterId: string) => void;
  /** Filter row to scroll into view + flash (e.g. from a Compare group header). */
  flashFilterId?: string | null;
  /** Bumps to re-trigger the flash even when the same id is re-requested. */
  flashNonce?: number;
  /** Called once a flash request has been consumed, so it doesn't replay on a
   *  later remount (panel open/close, dock switch). */
  onFlashConsumed?: () => void;
  /** Bumps to focus + select the filter search box (Ctrl+Shift+L). */
  focusSearchNonce?: number;
}

export function FilterPanel({
  file,
  set,
  counts,
  style,
  onToggleTimelineTrack,
  onCompareFilter,
  flashFilterId,
  flashNonce,
  onFlashConsumed,
  focusSearchNonce,
}: FilterPanelProps) {
  // Filter actions come straight from the store (stable refs); the panel no longer
  // receives them as props. Names are kept identical to the old props so the body
  // below is unchanged.
  const onSwitchSet = useStore((s) => s.switchSet);
  const onAddSet = useStore((s) => s.addSet);
  const onRenameSet = useStore((s) => s.renameSet);
  const onDeleteSet = useStore((s) => s.deleteSet);
  const onDuplicateSet = useStore((s) => s.duplicateSet);
  const onReorderSet = useStore((s) => s.reorderSets);
  const onAddGroup = useStore((s) => s.addGroup);
  const onRenameGroup = useStore((s) => s.renameGroup);
  const onToggleGroup = useStore((s) => s.toggleGroup);
  const onDeleteGroup = useStore((s) => s.deleteGroup);
  const onSetGroupEnabled = useStore((s) => s.setGroupEnabled);
  const onUpdateFilter = useStore((s) => s.updateFilter);
  const onAddFilter = useStore((s) => s.openNewFilter);
  const onDeleteFilter = useStore((s) => s.deleteFilter);
  const onDeleteFilters = useStore((s) => s.deleteFilters);
  const onSetFiltersEnabled = useStore((s) => s.setFiltersEnabled);
  const onDuplicateFilter = useStore((s) => s.duplicateFilter);
  const onViewFilterOnly = useStore((s) => s.setSoloFilterId);
  const onEditFilter = useStore((s) => s.openEditFilter);
  const onApplyLayout = useStore((s) => s.applyLayout);
  const onBulk = useStore((s) => s.bulk);
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // ---- batch selection mode ----
  // Ephemeral UI state (not persisted, not on the undo stack): while active,
  // a row click toggles its membership in `selected` instead of opening the
  // editor, and the action bar at the panel's foot drives batch ops.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // Anchor for Shift-click range selection, and the latest visible row order the
  // range is computed against (read through a ref so the stable rowApi sees it).
  const lastClickedRef = useRef<string | null>(null);
  const visibleIdsRef = useRef<string[]>([]);

  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
    lastClickedRef.current = null;
  }, []);

  const selectClick = useCallback((id: string, e: ReactMouseEvent) => {
    const order = visibleIdsRef.current;
    setSelected((prev) => {
      const next = new Set(prev);
      const anchor = lastClickedRef.current;
      if (e.shiftKey && anchor) {
        const a = order.indexOf(anchor),
          b = order.indexOf(id);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) next.add(order[i]);
        } else if (next.has(id)) next.delete(id);
        else next.add(id);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastClickedRef.current = id;
  }, []);

  // Ctrl/Cmd-click a row while not in select mode: enter it and select that row.
  // selectClick toggles, so on the (empty) first selection it adds.
  const beginSelect = useCallback(
    (id: string, e: ReactMouseEvent) => {
      setSelectMode(true);
      selectClick(id, e);
    },
    [selectClick],
  );

  // Focus + select the search box when App bumps the nonce (Ctrl+Shift+L). The
  // panel is already revealed by selectPanelTab before the bump lands.
  useEffect(() => {
    if (!focusSearchNonce) return;
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [focusSearchNonce]);

  // Esc leaves select mode.
  useEffect(() => {
    if (!selectMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitSelect();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode, exitSelect]);

  // Switching set or file would leave the selection pointing at filters that are
  // no longer on screen — drop it and exit select mode.
  useEffect(() => {
    exitSelect();
  }, [set.id, file.id, exitSelect]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // When the dock is narrow, wheel events over the toolbar / tabs have no scrollable
  // ancestor — forward them to the filter list so the list still scrolls.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    function onWheel(e: WheelEvent) {
      if (e.deltaY === 0) return;
      const target = e.target as HTMLElement;
      if (target.closest(".filter-list")) return; // already handled by its own overflow
      if (target.closest(".group-tabs")) return; // tabs translate the wheel into horizontal scroll
      const list = panel!.querySelector<HTMLElement>(".filter-list");
      if (!list) return;
      const atTop = e.deltaY < 0 && list.scrollTop <= 0;
      const atBottom =
        e.deltaY > 0 && list.scrollTop >= list.scrollHeight - list.clientHeight;
      if (atTop || atBottom) return;
      e.preventDefault();
      list.scrollTop += e.deltaY;
    }
    panel.addEventListener("wheel", onWheel, { passive: false });
    return () => panel.removeEventListener("wheel", onWheel);
  }, []);

  // Scroll a requested filter row into view and flash it (driven by App, e.g.
  // from a Compare group header). rAF lets a just-switched-to tab finish mounting
  // and an expanded group settle before we measure/scroll.
  useEffect(() => {
    if (!flashFilterId || !flashNonce) return;
    const raf = requestAnimationFrame(() => {
      const list = panelRef.current?.querySelector<HTMLElement>(".filter-list");
      const row = list?.querySelector<HTMLElement>(
        `[data-filter-id="${window.CSS.escape(flashFilterId)}"]`,
      );
      // Consume the request either way so it can't replay when the panel later
      // remounts (open/close, dock switch) with the same id/nonce still in state.
      onFlashConsumed?.();
      if (!row) return;
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.classList.add("fr-flash");
      setTimeout(() => row.classList.remove("fr-flash"), 1300);
    });
    return () => cancelAnimationFrame(raf);
  }, [flashFilterId, flashNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // "New group" appends at the end of the list, which can be below the fold;
  // scroll the freshly added group into view once it has rendered.
  const scrollToBottomNext = useRef(false);
  const handleAddGroup = () => {
    scrollToBottomNext.current = true;
    onAddGroup();
  };
  useEffect(() => {
    if (!scrollToBottomNext.current) return;
    scrollToBottomNext.current = false;
    const list = panelRef.current?.querySelector<HTMLElement>(".filter-list");
    if (list) list.scrollTop = list.scrollHeight;
  }, [set.groups.length]);

  const q = search.trim().toLowerCase();
  const filters = set.filters;
  const groups = set.groups;
  const searching = !!q;
  // Match the pattern OR the description, so filters named only by their
  // description are still findable.
  const filtered = q
    ? filters.filter(
        (f) =>
          f.pattern.toLowerCase().includes(q) ||
          (f.description ?? "").toLowerCase().includes(q),
      )
    : filters;

  // Section / filter metadata lookups (stable across a drag — only order moves).
  const groupById = new Map(groups.map((s) => [s.id, s] as const));
  const filterById = new Map(filters.map((f) => [f.id, f] as const));
  // 0-based position in the set, shown on each row as a 1-based "#N" serial. Keyed
  // off set.filters so it matches the serial the timeline panel renders.
  const indexById = new Map(filters.map((f, i) => [f.id, i] as const));

  // Snapshot the committed arrangement as a FilterLayout: the interleaved
  // top-level order plus each group's ordered members. Appends anything
  // `order` is missing so a row never disappears.
  const buildLayout = (): FilterLayout => {
    const top: FilterLayout["top"] = [];
    const seen = new Set<string>();
    for (const id of set.order) {
      if (seen.has(id)) continue;
      if (groupById.has(id)) {
        top.push({ kind: "group", id });
        seen.add(id);
        continue;
      }
      const f = filterById.get(id);
      if (f && f.groupId === null) {
        top.push({ kind: "filter", id });
        seen.add(id);
      }
    }
    for (const f of filters)
      if (f.groupId === null && !seen.has(f.id)) {
        top.push({ kind: "filter", id: f.id });
        seen.add(f.id);
      }
    for (const s of groups)
      if (!seen.has(s.id)) {
        top.push({ kind: "group", id: s.id });
        seen.add(s.id);
      }
    const inGroup: Record<string, string[]> = {};
    for (const s of groups)
      inGroup[s.id] = filters
        .filter((f) => f.groupId === s.id)
        .map((f) => f.id);
    return { top, inGroup };
  };

  // While a drag is in flight we render from this local model and commit once
  // (one undoable step) on drop; otherwise we render straight from props.
  const [drag, setDrag] = useState<{
    activeId: string;
    type: "filter" | "group";
    model: FilterLayout;
  } | null>(null);
  const layout = drag ? drag.model : buildLayout();

  const byGroup = (gid: string) =>
    (layout.inGroup[gid] ?? [])
      .map((id) => filterById.get(id))
      .filter(Boolean) as Filter[];
  const topItems = layout.top
    .map((e) =>
      e.kind === "group"
        ? { kind: "group" as const, group: groupById.get(e.id) }
        : { kind: "filter" as const, filter: filterById.get(e.id) },
    )
    .filter((it) => (it.kind === "group" ? it.group : it.filter)) as (
    | { kind: "group"; group: FilterGroup }
    | { kind: "filter"; filter: Filter }
  )[];
  const topIds = layout.top.map((e) => e.id);

  // One identity-stable api object for every row; the latest handlers are read
  // through a ref so the rows' memo never breaks when App re-renders.
  const rowCbRef = useRef({
    onUpdateFilter,
    onEditFilter,
    onDeleteFilter,
    onDuplicateFilter,
    onViewFilterOnly,
    onToggleTimelineTrack,
    onCompareFilter,
    selectClick,
    beginSelect,
  });
  rowCbRef.current = {
    onUpdateFilter,
    onEditFilter,
    onDeleteFilter,
    onDuplicateFilter,
    onViewFilterOnly,
    onToggleTimelineTrack,
    onCompareFilter,
    selectClick,
    beginSelect,
  };
  const rowApi = useMemo<RowApi>(
    () => ({
      update: (id, patch) => rowCbRef.current.onUpdateFilter(id, patch),
      edit: (id) => rowCbRef.current.onEditFilter(id),
      remove: (id) => rowCbRef.current.onDeleteFilter(id),
      duplicate: (id) => rowCbRef.current.onDuplicateFilter(id),
      viewOnly: (id) => rowCbRef.current.onViewFilterOnly(id),
      toggleTrack: (filterId, timeField) =>
        rowCbRef.current.onToggleTimelineTrack(filterId, timeField),
      compareFilter: (id) => rowCbRef.current.onCompareFilter(id),
      selectClick: (id, e) => rowCbRef.current.selectClick(id, e),
      beginSelect: (id, e) => rowCbRef.current.beginSelect(id, e),
    }),
    [],
  );

  // filterId → its field names already plotted as timeline tracks. Memoized so
  // each row gets a stable array ref (its memo compares trackedFields by identity).
  const trackedByFilter = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of set.sources ?? []) {
      const list = m.get(s.filterId);
      if (list) list.push(s.timeField);
      else m.set(s.filterId, [s.timeField]);
    }
    return m;
  }, [set.sources]);

  // Flat top-to-bottom order of the rows currently on screen — the axis a
  // Shift-click range runs along. Members of a collapsed group aren't rendered,
  // so they're excluded (a range can't reach into hidden rows).
  const visibleIds = searching
    ? filtered.map((f) => f.id)
    : topItems.flatMap((it) =>
        it.kind === "filter"
          ? [it.filter.id]
          : it.group.collapsed
            ? []
            : byGroup(it.group.id).map((f) => f.id),
      );
  visibleIdsRef.current = visibleIds;

  const selectedCount = selected.size;
  // Master checkbox doubles as "clear selection": anything selected → clear all;
  // nothing selected → select every filter in the set. Note this spans ALL
  // filters, not just `visibleIds` — rows inside a collapsed group must be
  // selected too (visibleIds is only the axis for Shift-click ranges).
  const toggleSelectAll = () =>
    setSelected((prev) =>
      prev.size > 0 ? new Set() : new Set(filters.map((f) => f.id)),
    );
  const deleteSelected = async () => {
    if (selectedCount === 0) return;
    if (await onDeleteFilters([...selected])) exitSelect();
  };

  function renderRow(f: Filter) {
    return (
      <FilterRow
        key={f.id}
        f={f}
        index={indexById.get(f.id) ?? -1}
        count={counts[f.id] ?? 0}
        trackedFields={trackedByFilter.get(f.id) ?? NO_TRACKED_FIELDS}
        searching={searching}
        selectMode={selectMode}
        selected={selected.has(f.id)}
        api={rowApi}
      />
    );
  }

  // ---- drag-and-drop (dnd-kit "multiple lists") ----
  // Refs the recipe uses to keep collision stable when an item jumps containers.
  const lastOverId = useRef<UniqueIdentifier | null>(null);
  const recentlyMovedToNewContainer = useRef(false);
  useEffect(() => {
    requestAnimationFrame(() => {
      recentlyMovedToNewContainer.current = false;
    });
  }, [drag?.model]);

  // Locate an id in a model: which container ("__top__" or a group id) + index.
  const locate = (
    id: string,
    m: FilterLayout,
  ): { container: string; index: number } | null => {
    const ti = m.top.findIndex((e) => e.id === id);
    if (ti >= 0) return { container: "__top__", index: ti };
    for (const gid of Object.keys(m.inGroup)) {
      const i = m.inGroup[gid].indexOf(id);
      if (i >= 0) return { container: gid, index: i };
    }
    return null;
  };

  // Current pointer Y, reconstructed from the activator pointerdown + drag delta.
  const pointerYOf = (e: DragOverEvent | DragEndEvent): number | undefined => {
    const ae = e.activatorEvent as { clientY?: number } | null;
    if (!ae || typeof ae.clientY !== "number") return undefined;
    return ae.clientY + (e.delta?.y ?? 0);
  };

  // Resolve the drop target (container + index) from the hovered droppable. A
  // header resolves INTO its group, except its *upper half* drops the filter as
  // a loose row BEFORE the group (so it can become the top-most free filter); a
  // body appends into its group (or the top level); a row or group block uses
  // its live position in the model.
  //
  // `slot` records which index semantics the target carries — it decides the
  // removal compensation at drop time:
  //  - slot: true  → "insert before this position" (header upper half, body
  //    append, bottomslot). Removing the dragged row from earlier in the same
  //    container shifts the slot down by one, so the index must be decremented.
  //  - slot: false → an index measured *over an item* (locate). dnd-kit reports
  //    it against the rects captured at drag start, which is exactly
  //    arrayMove's `to`: remove-then-insert at that index as-is. Decrementing
  //    here made every downward same-container drop land one row short.
  const resolveDrop = (
    over: DragEndEvent["over"],
    m: FilterLayout,
    pointerY?: number,
  ): { container: string; index: number; slot: boolean } | null => {
    if (!over) return null;
    const d = over.data.current as
      | { type?: string; groupId?: string | null }
      | undefined;
    if (d?.type === "header") {
      const gid = d.groupId as string;
      const r = over.rect;
      if (pointerY != null && r && pointerY < r.top + r.height / 2) {
        const idx = m.top.findIndex((e) => e.id === gid);
        return {
          container: "__top__",
          index: idx < 0 ? m.top.length : idx,
          slot: true,
        };
      }
      return {
        container: gid,
        index: (m.inGroup[gid] ?? []).length,
        slot: true,
      };
    }
    if (d?.type === "body") {
      const gid = (d.groupId ?? null) as string | null;
      return gid === null
        ? { container: "__top__", index: m.top.length, slot: true }
        : { container: gid, index: (m.inGroup[gid] ?? []).length, slot: true };
    }
    if (d?.type === "bottomslot")
      return { container: "__top__", index: m.top.length, slot: true };
    const loc = locate(String(over.id), m);
    return loc ? { ...loc, slot: false } : null;
  };

  const cloneModel = (m: FilterLayout): FilterLayout => ({
    top: m.top.map((e) => ({ ...e })),
    inGroup: Object.fromEntries(
      Object.entries(m.inGroup).map(([k, v]) => [k, [...v]]),
    ),
  });
  const removeFromModel = (m: FilterLayout, id: string) => {
    const ti = m.top.findIndex((e) => e.id === id);
    if (ti >= 0) {
      m.top.splice(ti, 1);
      return;
    }
    for (const gid of Object.keys(m.inGroup)) {
      const i = m.inGroup[gid].indexOf(id);
      if (i >= 0) {
        m.inGroup[gid].splice(i, 1);
        return;
      }
    }
  };
  const insertIntoModel = (
    m: FilterLayout,
    container: string,
    id: string,
    index: number,
  ) => {
    if (container === "__top__") {
      m.top.splice(Math.max(0, Math.min(index, m.top.length)), 0, {
        kind: "filter",
        id,
      });
    } else {
      const arr = (m.inGroup[container] ??= []);
      arr.splice(Math.max(0, Math.min(index, arr.length)), 0, id);
    }
  };

  function resetDnd() {
    lastOverId.current = null;
    recentlyMovedToNewContainer.current = false;
  }

  function handleDragStart(e: DragStartEvent) {
    const type = e.active.data.current?.type === "group" ? "group" : "filter";
    setDrag({ activeId: String(e.active.id), type, model: buildLayout() });
  }

  // Live cross-container move: only when a *filter* enters a different container.
  // Within-container reordering is previewed for free by each SortableContext, so
  // we leave it to drop time.
  function handleDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over || drag?.type !== "filter") return;
    const activeId = String(active.id);
    const pointerY = pointerYOf(e);
    setDrag((cur) => {
      if (!cur) return cur;
      const src = locate(activeId, cur.model);
      const target = resolveDrop(over, cur.model, pointerY);
      if (!src || !target || target.container === src.container) return cur;
      const next = cloneModel(cur.model);
      removeFromModel(next, activeId);
      insertIntoModel(next, target.container, activeId, target.index);
      recentlyMovedToNewContainer.current = true;
      return { ...cur, model: next };
    });
  }

  function handleDragEnd(e: DragEndEvent) {
    const cur = drag;
    if (!cur) {
      resetDnd();
      return;
    }
    const { active, over } = e;
    const activeId = String(active.id);
    let model = cur.model;
    if (over) {
      const src = locate(activeId, model);
      const target = resolveDrop(over, model, pointerYOf(e));
      if (src && target) {
        const next = cloneModel(model);
        if (cur.type === "group") {
          next.top = arrayMove(next.top, src.index, target.index);
        } else {
          // Filter: remove then insert at the resolved index. Only slot-semantics
          // targets need the removal-gap compensation (see resolveDrop) — item
          // targets already carry arrayMove semantics.
          let idx = target.index;
          if (
            target.slot &&
            src.container === target.container &&
            src.index < idx
          )
            idx -= 1;
          removeFromModel(next, activeId);
          insertIntoModel(next, target.container, activeId, idx);
        }
        model = next;
      }
    }
    onApplyLayout(model);
    setDrag(null);
    resetDnd();
  }

  // Recipe collision: a group drag snaps to top-level slots; a filter drag uses
  // a pointer-first strategy that ignores group *blocks* (a filter targets a
  // group via its header/body/rows, never the block itself), with a stable
  // fallback so the hovered container doesn't flicker mid-jump.
  // The id sets are hoisted — this callback runs on every pointermove.
  const topIdSet = useMemo(
    () => new Set(layout.top.map((e) => e.id)),
    [layout.top],
  );
  const groupIdSet = useMemo(() => new Set(groups.map((s) => s.id)), [groups]);
  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      if (drag?.type === "group") {
        return closestCenter({
          ...args,
          droppableContainers: args.droppableContainers.filter(
            (c) =>
              topIdSet.has(String(c.id)) || String(c.id) === "body:__null__",
          ),
        });
      }
      const containers = args.droppableContainers.filter(
        (c) => !groupIdSet.has(String(c.id)),
      );
      const pointer = pointerWithin({
        ...args,
        droppableContainers: containers,
      });
      const intersections = pointer.length
        ? pointer
        : rectIntersection({ ...args, droppableContainers: containers });
      const overId = getFirstCollision(intersections, "id");
      if (overId != null) {
        lastOverId.current = overId;
        return [{ id: overId }];
      }
      if (recentlyMovedToNewContainer.current)
        lastOverId.current = drag?.activeId ?? null;
      return lastOverId.current ? [{ id: lastOverId.current }] : [];
    },
    [drag, topIdSet, groupIdSet],
  );

  function handleSetDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = file.sets.findIndex((g) => g.id === active.id);
    const to = file.sets.findIndex((g) => g.id === over.id);
    if (from >= 0 && to >= 0) onReorderSet(from, to);
  }

  return (
    <div className="filter-panel" style={style} ref={panelRef}>
      {/* group tabs */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleSetDragEnd}
      >
        <SortableContext
          items={file.sets.map((g) => g.id)}
          strategy={horizontalListSortingStrategy}
        >
          <ScrollArea
            orientation="horizontal"
            className="group-tabs"
            viewportProps={{
              onWheel: (e) => {
                // translate a plain vertical wheel into horizontal tab scrolling
                if (e.deltaX === 0 && e.deltaY !== 0) {
                  e.preventDefault();
                  e.currentTarget.scrollLeft += e.deltaY;
                }
              },
            }}
          >
            {file.sets.map((g) => (
              <SetTab
                key={g.id}
                set={g}
                active={g.id === file.activeSetId}
                dot={
                  (
                    g.filters.find((f) => f.enabled && !f.exclude) ??
                    g.filters[0]
                  )?.textColor ?? "#9aa0a6"
                }
                canDelete={file.sets.length > 1}
                onSelect={() => onSwitchSet(g.id)}
                onRename={(name) => onRenameSet(g.id, name)}
                onDelete={() => onDeleteSet(g.id)}
                onDuplicate={() => onDuplicateSet(g.id)}
              />
            ))}
            <div className="gtab-add" title="New filter set" onClick={onAddSet}>
              <Plus size={16} />
            </div>
          </ScrollArea>
        </SortableContext>
      </DndContext>

      {/* toolbar */}
      <div className="filter-toolbar">
        <div className="search-box">
          <Search size={15} />
          <input
            ref={searchInputRef}
            placeholder="Search filters…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <span className="clear-x" onClick={() => setSearch("")}>
              <X size={14} />
            </span>
          )}
        </div>

        <Button size="xs" onClick={() => onAddFilter()}>
          <Plus data-icon="inline-start" />
          <span className="add-filter-label">Add filter</span>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="icon-xs" title="More actions" />
            }
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="end">
            <PanelMenuItems
              onAddFilter={() => onAddFilter()}
              onAddGroup={handleAddGroup}
              onBulk={onBulk}
              onEnterSelect={() => setSelectMode(true)}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* filter list */}
      {filters.length === 0 ? (
        <PanelListZone
          onAddFilter={() => onAddFilter()}
          onAddGroup={handleAddGroup}
          onBulk={onBulk}
          onEnterSelect={() => setSelectMode(true)}
        >
          <div className="filter-empty">
            <FilterIcon size={26} style={{ color: "var(--text-3)" }} />
            <div className="fe-title">No filters yet</div>
            <div className="fe-sub">
              Click "Add filter" to highlight or hide lines.
            </div>
          </div>
        </PanelListZone>
      ) : searching ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter}>
          <PanelListZone
            onAddFilter={() => onAddFilter()}
            onAddGroup={handleAddGroup}
            onBulk={onBulk}
            onEnterSelect={() => setSelectMode(true)}
          >
            {filtered.length === 0 ? (
              <div className="filter-empty">
                <FilterIcon size={26} style={{ color: "var(--text-3)" }} />
                <div className="fe-title">No filters match your search</div>
                <div className="fe-sub">Try a different term.</div>
              </div>
            ) : (
              <SortableContext
                items={filtered.map((f) => f.id)}
                strategy={verticalListSortingStrategy}
              >
                {filtered.map((f) => renderRow(f))}
              </SortableContext>
            )}
          </PanelListZone>
        </DndContext>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          // Default measuring (WhileDragging) is enough: SortableContext queues a
          // re-measure itself when its items change mid-drag, and Always would
          // also re-measure every droppable (100+ rows) outside drags — e.g. on
          // each search keystroke as rows mount/unmount.
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={() => {
            setDrag(null);
            resetDnd();
          }}
        >
          <PanelListZone
            onAddFilter={() => onAddFilter()}
            onAddGroup={handleAddGroup}
            onBulk={onBulk}
            onEnterSelect={() => setSelectMode(true)}
          >
            <TopDropZone>
              <SortableContext
                items={topIds}
                strategy={verticalListSortingStrategy}
              >
                {topItems.map((it) =>
                  it.kind === "group" ? (
                    <GroupBlock
                      key={it.group.id}
                      group={it.group}
                      filters={byGroup(it.group.id)}
                      onToggle={() => onToggleGroup(it.group.id)}
                      onRename={(name) => onRenameGroup(it.group.id, name)}
                      onDelete={() => onDeleteGroup(it.group.id)}
                      onAddFilter={() => onAddFilter(it.group.id)}
                      onSetEnabled={(enabled) =>
                        onSetGroupEnabled(it.group.id, enabled)
                      }
                      renderRow={renderRow}
                    />
                  ) : (
                    renderRow(it.filter)
                  ),
                )}
              </SortableContext>
              <BottomSlot active={drag?.type === "filter"} />
            </TopDropZone>

            <button className="fsection-add" onClick={handleAddGroup}>
              <FolderPlus size={14} /> New group
            </button>
          </PanelListZone>

          <DragOverlay>
            {drag?.type === "filter" && filterById.get(drag.activeId) ? (
              <FilterRowOverlay
                f={filterById.get(drag.activeId)!}
                index={indexById.get(drag.activeId) ?? -1}
                count={counts[drag.activeId] ?? 0}
              />
            ) : drag?.type === "group" && groupById.get(drag.activeId) ? (
              <GroupOverlay
                group={groupById.get(drag.activeId)!}
                count={byGroup(drag.activeId).length}
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {selectMode && (
        <div className="select-bar">
          <span
            className="sb-all"
            title={selectedCount > 0 ? "Clear selection" : "Select all"}
          >
            <Checkbox
              checked={selectedCount > 0}
              onCheckedChange={() => toggleSelectAll()}
            />
          </span>
          <span className="sb-count" title={`${selectedCount} selected`}>
            {selectedCount} &nbsp;selected
          </span>
          <span className="sb-spacer" />
          <Button
            size="xs"
            variant="outline"
            disabled={selectedCount === 0}
            title="Enable selected"
            onClick={() => onSetFiltersEnabled([...selected], true)}
          >
            <Eye data-icon="inline-start" />
            <span className="sb-label">Enable</span>
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={selectedCount === 0}
            title="Disable selected"
            onClick={() => onSetFiltersEnabled([...selected], false)}
          >
            <EyeOff data-icon="inline-start" />
            <span className="sb-label">Disable</span>
          </Button>
          <Button
            size="xs"
            variant="destructive"
            disabled={selectedCount === 0}
            title="Delete selected"
            onClick={() => void deleteSelected()}
          >
            <Trash2 data-icon="inline-start" />
            <span className="sb-label">Delete</span>
          </Button>
          <Button size="xs" title="Done" onClick={exitSelect}>
            <Check data-icon="inline-start" />
            <span className="sb-label">Done</span>
          </Button>
        </div>
      )}
    </div>
  );
}
