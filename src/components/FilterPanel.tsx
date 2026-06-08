import { useState, useRef, useEffect, useCallback, CSSProperties, ReactNode } from "react";
import {
  ChevronDown, ChevronRight, Copy, Eye, EyeOff,
  Filter as FilterIcon, FileDown, FolderPlus, GripVertical,
  ListChecks, ListX, MoreVertical, MoreHorizontal, Pencil,
  Plus, Save, Search, Trash2, Upload, X,
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
  MeasuringStrategy,
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
import type { LogFile, FilterGroup, FilterSection, Filter, FilterLayout } from "../types";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { ScrollArea, ScrollBar } from "./ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "./ui/context-menu";

// ---- shared menu item groups ----
// Rendered inside both the "⋮" dropdown and the right-click context menu.
// (base-ui's ContextMenu reuses the same MenuItem/Separator parts, so these
// fragments work in either popup.)

function RowMenuItems({ onEdit, onViewOnly, onDuplicate, onDelete }: {
  onEdit: () => void; onViewOnly: () => void; onDuplicate: () => void; onDelete: () => void;
}) {
  return (
    <>
      <DropdownMenuItem onClick={onEdit}>
        <span className="mi-ico"><Pencil size={15} /></span>Edit
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onViewOnly}>
        <span className="mi-ico"><Eye size={15} /></span>View this filter only
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onDuplicate}>
        <span className="mi-ico"><Copy size={15} /></span>Duplicate
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={onDelete}>
        <span className="mi-ico"><Trash2 size={15} /></span>Delete
      </DropdownMenuItem>
    </>
  );
}

function GroupTabMenuItems({ onRename, onDuplicate, onDelete, canDelete }: {
  onRename: () => void; onDuplicate: () => void; onDelete: () => void; canDelete: boolean;
}) {
  return (
    <>
      <DropdownMenuItem onClick={onRename}>
        <span className="mi-ico"><Pencil size={15} /></span>Rename set
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onDuplicate}>
        <span className="mi-ico"><Copy size={15} /></span>Duplicate set
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" disabled={!canDelete} onClick={() => { if (canDelete) onDelete(); }}>
        <span className="mi-ico"><Trash2 size={15} /></span>Delete set
      </DropdownMenuItem>
    </>
  );
}

function SectionMenuItems({ onRename, onAddFilter, onSetEnabled, onDelete }: {
  onRename: () => void; onAddFilter: () => void;
  onSetEnabled: (enabled: boolean) => void; onDelete: () => void;
}) {
  return (
    <>
      <DropdownMenuItem onClick={onRename}>
        <span className="mi-ico"><Pencil size={15} /></span>Rename group
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onAddFilter}>
        <span className="mi-ico"><Plus size={15} /></span>Add filter
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => onSetEnabled(true)}>
        <span className="mi-ico"><ListChecks size={15} /></span>Enable all in group
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onSetEnabled(false)}>
        <span className="mi-ico"><ListX size={15} /></span>Disable all in group
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={onDelete}>
        <span className="mi-ico"><Trash2 size={15} /></span>Delete group (keep filters)
      </DropdownMenuItem>
    </>
  );
}

function PanelMenuItems({ onAddFilter, onAddSection, onBulk }: {
  onAddFilter: () => void; onAddSection: () => void; onBulk: (action: string) => void;
}) {
  return (
    <>
      <DropdownMenuItem onClick={onAddFilter}>
        <span className="mi-ico"><Plus size={15} /></span>Add filter
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onAddSection}>
        <span className="mi-ico"><FolderPlus size={15} /></span>New group
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => onBulk("enableAll")}>
        <span className="mi-ico"><ListChecks size={15} /></span>Enable all filters
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onBulk("disableAll")}>
        <span className="mi-ico"><ListX size={15} /></span>Disable all filters
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => onBulk("save")}>
        <span className="mi-ico"><Save size={15} /></span>Save filters
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onBulk("saveAs")}>
        <span className="mi-ico"><FileDown size={15} /></span>Save filters as…
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onBulk("import")}>
        <span className="mi-ico"><Upload size={15} /></span>Import filters…
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={() => onBulk("clear")}>
        <span className="mi-ico"><Trash2 size={15} /></span>Delete all filters
      </DropdownMenuItem>
    </>
  );
}

// ---- group tab ----

interface GroupTabProps {
  group: FilterGroup;
  active: boolean;
  dot: string;
  canDelete: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}

function GroupTab({ group, active, dot, canDelete, onSelect, onRename, onDelete, onDuplicate }: GroupTabProps) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(group.name);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: group.id });

  function commit() {
    const v = val.trim();
    if (v) onRename(v); else setVal(group.name);
    setEditing(false);
  }

  const style: CSSProperties = {
    // lock to the horizontal axis so vertical dragging can't trigger a scrollbar
    transform: CSS.Transform.toString(transform ? { ...transform, y: 0 } : null),
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
            onDoubleClick={() => { setVal(group.name); setEditing(true); }}
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
              if (e.key === "Escape") { setVal(group.name); setEditing(false); }
            }}
          />
        ) : (
          <span className="gtab-name">{group.name}</span>
        )}
        <span className="gtab-count">{group.filters.length}</span>
        {canDelete && (
          <button
            className="gtab-x"
            title="Delete set"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
          >
            <X size={12} />
          </button>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <GroupTabMenuItems
          onRename={() => { setVal(group.name); setEditing(true); }}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          canDelete={canDelete}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ---- filter row ----

interface FilterRowProps {
  f: Filter;
  count: number;
  searching: boolean;
  onUpdate: (patch: Partial<Filter>) => void;
  onEdit: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onViewOnly: () => void;
}

function FilterRow({ f, count, searching, onUpdate, onEdit, onDelete, onDuplicate, onViewOnly }: FilterRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: f.id,
    disabled: searching,
    data: { type: "filter", sectionId: f.sectionId },
  });

  const flags: { t: string; title: string }[] = [];
  if (f.caseSensitive) flags.push({ t: "Aa", title: "Case sensitive" });
  if (f.regex) flags.push({ t: ".*", title: "Regex" });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    alignItems: "center",
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            ref={setNodeRef}
            style={style}
            className={"filter-row" + (f.enabled ? "" : " disabled") + (isDragging ? " dragging" : "")}
            title="Click to edit · right-click for menu · drag to reorder"
            onClick={onEdit}
            {...attributes}
            {...(searching ? {} : listeners)}
          />
        }
      >
        <span className="fr-handle" title="Drag to reorder">
          <GripVertical size={12} />
        </span>

        {/* Stop clicks here from bubbling to the row (which would open the editor). */}
        <span
          className="fr-check-wrap"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={f.enabled}
            onCheckedChange={(checked) => onUpdate({ enabled: !!checked })}
            title={f.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
          />
        </span>

        <button
          className="fr-color"
          title="Edit color"
          style={{ background: f.bgColor, borderColor: f.textColor }}
          onPointerDown={(e) => e.stopPropagation()}
        />

        <div className="fr-pattern" title={f.pattern || "untitled filter"}>
          {f.pattern || <span className="placeholder">untitled filter</span>}
        </div>

        <div className="fr-desc" title={f.description}>
          {f.description}
        </div>

        {f.fields && f.fields.length > 0 && (
          <div
            className="fr-flags"
            title={"Parses: " + f.fields.map((x) => x.name).join(", ")}
          >
            {f.fields.slice(0, 4).map((x) => <span key={x.name} className="fr-flag">{x.name}</span>)}
            {f.fields.length > 4 && <span className="fr-flag more">+{f.fields.length - 4}</span>}
          </div>
        )}

        {flags.length > 0 && (
          <div className="fr-flags">
            {flags.map((fl, i) => <span key={i} className="fr-flag" title={fl.title}>{fl.t}</span>)}
          </div>
        )}

        {f.exclude && (
          <span className="fr-flag ex" title="Exclude — hides matching lines">
            <EyeOff size={12} />
          </span>
        )}

        <div className={"fr-count" + (f.exclude ? " ex" : "")}>
          <b>{count.toLocaleString()}</b>{" hits"}
        </div>

        <div className="fr-actions" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" title="More" />}>
              <MoreVertical />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end">
              <RowMenuItems onEdit={onEdit} onViewOnly={onViewOnly} onDuplicate={onDuplicate} onDelete={onDelete} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <RowMenuItems onEdit={onEdit} onViewOnly={onViewOnly} onDuplicate={onDuplicate} onDelete={onDelete} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ---- section ----

interface SectionBlockProps {
  section: FilterSection;
  filters: Filter[];
  onToggle: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onAddFilter: () => void;
  onSetEnabled: (enabled: boolean) => void;
  renderRow: (f: Filter) => ReactNode;
}

function SectionBlock({
  section, filters, onToggle, onRename, onDelete, onAddFilter, onSetEnabled, renderRow,
}: SectionBlockProps) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(section.name);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: section.id,
    data: { type: "section" },
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `body:${section.id}`,
    data: { type: "body", sectionId: section.id },
  });
  // A filter can be dropped anywhere on the section (header or body) to move in.
  const { setNodeRef: setHeadRef, isOver: headOver, active: dragActive } = useDroppable({
    id: `head:${section.id}`,
    data: { type: "header", sectionId: section.id },
  });
  // Light up the whole section while a filter row is dragged over its header or body.
  const nestTarget = (headOver || isOver) && dragActive?.data.current?.type === "filter";

  function commit() {
    const v = val.trim();
    if (v) onRename(v); else setVal(section.name);
    setEditing(false);
  }

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className={"fsection" + (nestTarget ? " nest-target" : "") + (isDragging ? " dragging" : "")}>
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
          title={section.collapsed ? "Expand" : "Collapse"}
          onClick={onToggle}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {section.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
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
              if (e.key === "Escape") { setVal(section.name); setEditing(false); }
            }}
          />
        ) : (
          <span
            className="fs-name"
            onClick={onToggle}
            onDoubleClick={() => { setVal(section.name); setEditing(true); }}
            title="Click to collapse · double-click to rename"
          >
            {section.name}
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
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" title="Group actions" onPointerDown={(e) => e.stopPropagation()} />}>
            <MoreVertical />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="end">
            <SectionMenuItems
              onRename={() => { setVal(section.name); setEditing(true); }}
              onAddFilter={onAddFilter}
              onSetEnabled={onSetEnabled}
              onDelete={onDelete}
            />
          </DropdownMenuContent>
        </DropdownMenu>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <SectionMenuItems
            onRename={() => { setVal(section.name); setEditing(true); }}
            onAddFilter={onAddFilter}
            onSetEnabled={onSetEnabled}
            onDelete={onDelete}
          />
        </ContextMenuContent>
      </ContextMenu>

      {!section.collapsed && (
        <div
          ref={setDropRef}
          className={"fsection-body" + (isOver ? " drop-over" : "")}
        >
          <SortableContext items={filters.map((f) => f.id)} strategy={verticalListSortingStrategy}>
            {filters.length === 0 ? (
              <div className="fs-empty">Drop a filter on the title above, or click +</div>
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
    data: { type: "body", sectionId: null },
  });
  return (
    <div ref={setNodeRef} className={"fp-toplevel" + (isOver ? " drop-over" : "")}>
      {children}
    </div>
  );
}

// A loose drop target below every top-level item — so a filter can be dropped
// past the last section to become the bottom-most free filter (the section body
// itself always nests). Collapses to nothing unless a filter drag is active.
function BottomSlot({ active }: { active: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: "bottomslot", data: { type: "bottomslot" } });
  return <div ref={setNodeRef} className={"fp-bottomslot" + (active ? " on" : "") + (isOver ? " drop-over" : "")} />;
}

// ---- panel-level right-click zone (wraps the scrollable filter list) ----

function PanelListZone({ onAddFilter, onAddSection, onBulk, children }: {
  onAddFilter: () => void; onAddSection: () => void; onBulk: (action: string) => void; children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="filter-list scroll" />}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <PanelMenuItems onAddFilter={onAddFilter} onAddSection={onAddSection} onBulk={onBulk} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ---- drag overlays (the floating clone shown while dragging) ----

function FilterRowOverlay({ f, count }: { f: Filter; count: number }) {
  const flags: string[] = [];
  if (f.caseSensitive) flags.push("Aa");
  if (f.regex) flags.push(".*");
  return (
    <div className={"filter-row drag-overlay" + (f.enabled ? "" : " disabled")} style={{ alignItems: "center" }}>
      <span className="fr-handle"><GripVertical size={12} /></span>
      <span className="fr-check-wrap"><Checkbox checked={f.enabled} onCheckedChange={() => {}} /></span>
      <button className="fr-color" style={{ background: f.bgColor, borderColor: f.textColor }} />
      <div className="fr-pattern">{f.pattern || <span className="placeholder">untitled filter</span>}</div>
      <div className="fr-desc">{f.description}</div>
      {flags.length > 0 && <div className="fr-flags">{flags.map((t, i) => <span key={i} className="fr-flag">{t}</span>)}</div>}
      {f.exclude && <span className="fr-flag ex"><EyeOff size={12} /></span>}
      <div className={"fr-count" + (f.exclude ? " ex" : "")}><b>{count.toLocaleString()}</b>{" hits"}</div>
    </div>
  );
}

function SectionOverlay({ section, count }: { section: FilterSection; count: number }) {
  return (
    <div className="fsection drag-overlay">
      <div className="fsection-head">
        <span className="fs-grip"><GripVertical size={12} /></span>
        <span className="fs-chevron">{section.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</span>
        <span className="fs-name">{section.name}</span>
        <span className="fs-count">{count}</span>
      </div>
    </div>
  );
}

// ---- panel ----

interface FilterPanelProps {
  file: LogFile;
  group: FilterGroup;
  counts: Record<string, number>;
  style?: CSSProperties;
  onSwitchGroup: (id: string) => void;
  onAddGroup: () => void;
  onRenameGroup: (id: string, name: string) => void;
  onDeleteGroup: (id: string) => void;
  onDuplicateGroup: (id: string) => void;
  onReorderGroup: (from: number, to: number) => void;
  onAddSection: () => void;
  onRenameSection: (id: string, name: string) => void;
  onToggleSection: (id: string) => void;
  onDeleteSection: (id: string) => void;
  onSetSectionEnabled: (id: string, enabled: boolean) => void;
  onUpdateFilter: (id: string, patch: Partial<Filter>) => void;
  onAddFilter: (sectionId?: string | null) => void;
  onDeleteFilter: (id: string) => void;
  onDuplicateFilter: (id: string) => void;
  onViewFilterOnly: (id: string) => void;
  onEditFilter: (id: string) => void;
  /** Commit a whole-group drag arrangement in one undoable step. */
  onApplyLayout: (model: FilterLayout) => void;
  onBulk: (action: string) => void;
}

export function FilterPanel({
  file, group, counts, style,
  onSwitchGroup, onAddGroup, onRenameGroup, onDeleteGroup, onDuplicateGroup, onReorderGroup,
  onAddSection, onRenameSection, onToggleSection, onDeleteSection, onSetSectionEnabled,
  onUpdateFilter, onAddFilter, onDeleteFilter, onDuplicateFilter, onViewFilterOnly, onEditFilter,
  onApplyLayout, onBulk,
}: FilterPanelProps) {
  const [search, setSearch] = useState("");

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const q = search.trim().toLowerCase();
  const filters = group.filters;
  const sections = group.sections;
  const searching = !!q;
  const filtered = q ? filters.filter((f) => f.pattern.toLowerCase().includes(q)) : filters;

  // Section / filter metadata lookups (stable across a drag — only order moves).
  const sectionById = new Map(sections.map((s) => [s.id, s] as const));
  const filterById = new Map(filters.map((f) => [f.id, f] as const));

  // Snapshot the committed arrangement as a FilterLayout: the interleaved
  // top-level order plus each section's ordered members. Appends anything
  // `order` is missing so a row never disappears.
  const buildLayout = (): FilterLayout => {
    const top: FilterLayout["top"] = [];
    const seen = new Set<string>();
    for (const id of group.order) {
      if (seen.has(id)) continue;
      if (sectionById.has(id)) { top.push({ kind: "section", id }); seen.add(id); continue; }
      const f = filterById.get(id);
      if (f && f.sectionId === null) { top.push({ kind: "filter", id }); seen.add(id); }
    }
    for (const f of filters) if (f.sectionId === null && !seen.has(f.id)) { top.push({ kind: "filter", id: f.id }); seen.add(f.id); }
    for (const s of sections) if (!seen.has(s.id)) { top.push({ kind: "section", id: s.id }); seen.add(s.id); }
    const inSection: Record<string, string[]> = {};
    for (const s of sections) inSection[s.id] = filters.filter((f) => f.sectionId === s.id).map((f) => f.id);
    return { top, inSection };
  };

  // While a drag is in flight we render from this local model and commit once
  // (one undoable step) on drop; otherwise we render straight from props.
  const [drag, setDrag] = useState<{ activeId: string; type: "filter" | "section"; model: FilterLayout } | null>(null);
  const layout = drag ? drag.model : buildLayout();

  const bySection = (sid: string) =>
    (layout.inSection[sid] ?? []).map((id) => filterById.get(id)).filter(Boolean) as Filter[];
  const topItems = layout.top
    .map((e) => e.kind === "section"
      ? { kind: "section" as const, section: sectionById.get(e.id) }
      : { kind: "filter" as const, filter: filterById.get(e.id) })
    .filter((it) => (it.kind === "section" ? it.section : it.filter)) as
      ({ kind: "section"; section: FilterSection } | { kind: "filter"; filter: Filter })[];
  const topIds = layout.top.map((e) => e.id);

  function renderRow(f: Filter) {
    return (
      <FilterRow
        key={f.id}
        f={f}
        count={counts[f.id] ?? 0}
        searching={searching}
        onUpdate={(patch) => onUpdateFilter(f.id, patch)}
        onEdit={() => onEditFilter(f.id)}
        onDelete={() => onDeleteFilter(f.id)}
        onDuplicate={() => onDuplicateFilter(f.id)}
        onViewOnly={() => onViewFilterOnly(f.id)}
      />
    );
  }

  // ---- drag-and-drop (dnd-kit "multiple lists") ----
  // Refs the recipe uses to keep collision stable when an item jumps containers.
  const lastOverId = useRef<UniqueIdentifier | null>(null);
  const recentlyMovedToNewContainer = useRef(false);
  useEffect(() => {
    requestAnimationFrame(() => { recentlyMovedToNewContainer.current = false; });
  }, [drag?.model]);

  // Locate an id in a model: which container ("__top__" or a section id) + index.
  const locate = (id: string, m: FilterLayout): { container: string; index: number } | null => {
    const ti = m.top.findIndex((e) => e.id === id);
    if (ti >= 0) return { container: "__top__", index: ti };
    for (const sid of Object.keys(m.inSection)) {
      const i = m.inSection[sid].indexOf(id);
      if (i >= 0) return { container: sid, index: i };
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
  // header resolves INTO its section, except its *upper half* drops the filter as
  // a loose row BEFORE the section (so it can become the top-most free filter); a
  // body appends into its section (or the top level); a row or section block uses
  // its live position in the model.
  const resolveDrop = (
    over: DragEndEvent["over"], m: FilterLayout, pointerY?: number,
  ): { container: string; index: number } | null => {
    if (!over) return null;
    const d = over.data.current as { type?: string; sectionId?: string | null } | undefined;
    if (d?.type === "header") {
      const sid = d.sectionId as string;
      const r = over.rect;
      if (pointerY != null && r && pointerY < r.top + r.height / 2) {
        const idx = m.top.findIndex((e) => e.id === sid);
        return { container: "__top__", index: idx < 0 ? m.top.length : idx };
      }
      return { container: sid, index: (m.inSection[sid] ?? []).length };
    }
    if (d?.type === "body") {
      const sid = (d.sectionId ?? null) as string | null;
      return sid === null
        ? { container: "__top__", index: m.top.length }
        : { container: sid, index: (m.inSection[sid] ?? []).length };
    }
    if (d?.type === "bottomslot") return { container: "__top__", index: m.top.length };
    return locate(String(over.id), m);
  };

  const cloneModel = (m: FilterLayout): FilterLayout => ({
    top: m.top.map((e) => ({ ...e })),
    inSection: Object.fromEntries(Object.entries(m.inSection).map(([k, v]) => [k, [...v]])),
  });
  const removeFromModel = (m: FilterLayout, id: string) => {
    const ti = m.top.findIndex((e) => e.id === id);
    if (ti >= 0) { m.top.splice(ti, 1); return; }
    for (const sid of Object.keys(m.inSection)) {
      const i = m.inSection[sid].indexOf(id);
      if (i >= 0) { m.inSection[sid].splice(i, 1); return; }
    }
  };
  const insertIntoModel = (m: FilterLayout, container: string, id: string, index: number) => {
    if (container === "__top__") {
      m.top.splice(Math.max(0, Math.min(index, m.top.length)), 0, { kind: "filter", id });
    } else {
      const arr = (m.inSection[container] ??= []);
      arr.splice(Math.max(0, Math.min(index, arr.length)), 0, id);
    }
  };

  function resetDnd() {
    lastOverId.current = null;
    recentlyMovedToNewContainer.current = false;
  }

  function handleDragStart(e: DragStartEvent) {
    const type = e.active.data.current?.type === "section" ? "section" : "filter";
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
    if (!cur) { resetDnd(); return; }
    const { active, over } = e;
    const activeId = String(active.id);
    let model = cur.model;
    if (over) {
      const src = locate(activeId, model);
      const target = resolveDrop(over, model, pointerYOf(e));
      if (src && target) {
        const next = cloneModel(model);
        if (cur.type === "section") {
          next.top = arrayMove(next.top, src.index, target.index);
        } else {
          // Filter: remove then insert at the resolved slot, compensating for the
          // gap the removal leaves when the source precedes the target in the same
          // container. Unifies same- and cross-container drops (incl. popping a
          // filter out to a loose row before a section).
          let idx = target.index;
          if (src.container === target.container && src.index < idx) idx -= 1;
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

  // Recipe collision: a section drag snaps to top-level slots; a filter drag uses
  // a pointer-first strategy that ignores section *blocks* (a filter targets a
  // section via its header/body/rows, never the block itself), with a stable
  // fallback so the hovered container doesn't flicker mid-jump.
  const collisionDetection: CollisionDetection = useCallback((args) => {
    if (drag?.type === "section") {
      const topSet = new Set(layout.top.map((e) => e.id));
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter(
          (c) => topSet.has(String(c.id)) || String(c.id) === "body:__null__"),
      });
    }
    const sectionIdSet = new Set(sections.map((s) => s.id));
    const containers = args.droppableContainers.filter((c) => !sectionIdSet.has(String(c.id)));
    const pointer = pointerWithin({ ...args, droppableContainers: containers });
    const intersections = pointer.length ? pointer : rectIntersection({ ...args, droppableContainers: containers });
    const overId = getFirstCollision(intersections, "id");
    if (overId != null) { lastOverId.current = overId; return [{ id: overId }]; }
    if (recentlyMovedToNewContainer.current) lastOverId.current = drag?.activeId ?? null;
    return lastOverId.current ? [{ id: lastOverId.current }] : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, layout.top, sections]);

  function handleGroupDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = file.groups.findIndex((g) => g.id === active.id);
    const to = file.groups.findIndex((g) => g.id === over.id);
    if (from >= 0 && to >= 0) onReorderGroup(from, to);
  }

  return (
    <div className="filter-panel" style={style}>
      {/* group tabs */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleGroupDragEnd}>
        <SortableContext items={file.groups.map((g) => g.id)} strategy={horizontalListSortingStrategy}>
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
            {file.groups.map((g) => (
              <GroupTab
                key={g.id}
                group={g}
                active={g.id === file.activeGroupId}
                dot={(g.filters.find((f) => f.enabled && !f.exclude) ?? g.filters[0])?.textColor ?? "#9aa0a6"}
                canDelete={file.groups.length > 1}
                onSelect={() => onSwitchGroup(g.id)}
                onRename={(name) => onRenameGroup(g.id, name)}
                onDelete={() => onDeleteGroup(g.id)}
                onDuplicate={() => onDuplicateGroup(g.id)}
              />
            ))}
            <div className="gtab-add" title="New filter set" onClick={onAddGroup}>
              <Plus size={16} />
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </SortableContext>
      </DndContext>

      {/* toolbar */}
      <div className="filter-toolbar">
        <div className="search-box">
          <Search size={15} />
          <input
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
          <DropdownMenuTrigger render={<Button variant="outline" size="icon-xs" title="More actions" />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="end">
            <PanelMenuItems onAddFilter={() => onAddFilter()} onAddSection={onAddSection} onBulk={onBulk} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* filter list */}
      {filters.length === 0 ? (
        <PanelListZone onAddFilter={() => onAddFilter()} onAddSection={onAddSection} onBulk={onBulk}>
          <div className="filter-empty">
            <FilterIcon size={26} style={{ color: "var(--text-3)" }} />
            <div className="fe-title">No filters yet</div>
            <div className="fe-sub">Click "Add filter" to highlight or hide lines.</div>
          </div>
        </PanelListZone>
      ) : searching ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter}>
          <PanelListZone onAddFilter={() => onAddFilter()} onAddSection={onAddSection} onBulk={onBulk}>
            {filtered.length === 0 ? (
              <div className="filter-empty">
                <FilterIcon size={26} style={{ color: "var(--text-3)" }} />
                <div className="fe-title">No filters match your search</div>
                <div className="fe-sub">Try a different term.</div>
              </div>
            ) : (
              <SortableContext items={filtered.map((f) => f.id)} strategy={verticalListSortingStrategy}>
                {filtered.map((f) => renderRow(f))}
              </SortableContext>
            )}
          </PanelListZone>
        </DndContext>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={() => { setDrag(null); resetDnd(); }}
        >
          <PanelListZone onAddFilter={() => onAddFilter()} onAddSection={onAddSection} onBulk={onBulk}>
            <TopDropZone>
              <SortableContext items={topIds} strategy={verticalListSortingStrategy}>
                {topItems.map((it) =>
                  it.kind === "section" ? (
                    <SectionBlock
                      key={it.section.id}
                      section={it.section}
                      filters={bySection(it.section.id)}
                      onToggle={() => onToggleSection(it.section.id)}
                      onRename={(name) => onRenameSection(it.section.id, name)}
                      onDelete={() => onDeleteSection(it.section.id)}
                      onAddFilter={() => onAddFilter(it.section.id)}
                      onSetEnabled={(enabled) => onSetSectionEnabled(it.section.id, enabled)}
                      renderRow={renderRow}
                    />
                  ) : (
                    renderRow(it.filter)
                  )
                )}
              </SortableContext>
              <BottomSlot active={drag?.type === "filter"} />
            </TopDropZone>

            <button className="fsection-add" onClick={onAddSection}>
              <FolderPlus size={14} /> New group
            </button>
          </PanelListZone>

          <DragOverlay>
            {drag?.type === "filter" && filterById.get(drag.activeId) ? (
              <FilterRowOverlay f={filterById.get(drag.activeId)!} count={counts[drag.activeId] ?? 0} />
            ) : drag?.type === "section" && sectionById.get(drag.activeId) ? (
              <SectionOverlay section={sectionById.get(drag.activeId)!} count={bySection(drag.activeId).length} />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}
