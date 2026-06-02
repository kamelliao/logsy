import { useState, CSSProperties, ReactNode } from "react";
import {
  ChevronDown, ChevronRight, Copy, EyeOff,
  Filter as FilterIcon, FileDown, FolderPlus, GripVertical,
  ListChecks, ListX, MoreVertical, MoreHorizontal, Pencil,
  Plus, Save, Search, Trash2, Upload, X,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
  pointerWithin,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  DragEndEvent,
  CollisionDetection,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { LogFile, FilterGroup, FilterSection, Filter } from "../types";
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

function RowMenuItems({ onEdit, onDuplicate, onDelete }: {
  onEdit: () => void; onDuplicate: () => void; onDelete: () => void;
}) {
  return (
    <>
      <DropdownMenuItem onClick={onEdit}>
        <span className="mi-ico"><Pencil size={15} /></span>Edit
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

function PanelMenuItems({ onAddSection, onBulk }: {
  onAddSection: () => void; onBulk: (action: string) => void;
}) {
  return (
    <>
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
}

function GroupTab({ group, active, dot, canDelete, onSelect, onRename, onDelete }: GroupTabProps) {
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
    <div
      ref={setNodeRef}
      style={style}
      className={"gtab" + (active ? " active" : "")}
      onClick={onSelect}
      onDoubleClick={() => { setVal(group.name); setEditing(true); }}
      title="Drag to reorder · double-click to rename"
      {...attributes}
      {...(editing ? {} : listeners)}
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
    </div>
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
}

function FilterRow({ f, count, searching, onUpdate, onEdit, onDelete, onDuplicate }: FilterRowProps) {
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
            className={"filter-row" + (f.enabled ? "" : " disabled")}
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
            className={"fr-fields" + (f.extractOnly ? " extract-only" : "")}
            title={(f.extractOnly ? "Extract only (no colour) · parses: " : "Parses: ") + f.fields.map((x) => x.name).join(", ")}
          >
            {f.fields.slice(0, 4).map((x) => <span key={x.name} className="fr-fchip">{x.name}</span>)}
            {f.fields.length > 4 && <span className="fr-fchip more">+{f.fields.length - 4}</span>}
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
              <RowMenuItems onEdit={onEdit} onDuplicate={onDuplicate} onDelete={onDelete} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <RowMenuItems onEdit={onEdit} onDuplicate={onDuplicate} onDelete={onDelete} />
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
  // The header is the *only* "move into this section" target.
  const { setNodeRef: setHeadRef, isOver: headOver, active: dragActive } = useDroppable({
    id: `head:${section.id}`,
    data: { type: "header", sectionId: section.id },
  });
  // Light up the whole section only while a filter row is being dragged onto the header.
  const nestTarget = headOver && dragActive?.data.current?.type === "filter";

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
    <div ref={setNodeRef} style={style} className={"fsection" + (nestTarget ? " nest-target" : "")}>
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

// ---- panel-level right-click zone (wraps the scrollable filter list) ----

function PanelListZone({ onAddSection, onBulk, children }: {
  onAddSection: () => void; onBulk: (action: string) => void; children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="filter-list scroll" />}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <PanelMenuItems onAddSection={onAddSection} onBulk={onBulk} />
      </ContextMenuContent>
    </ContextMenu>
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
  onReorderGroup: (from: number, to: number) => void;
  onAddSection: () => void;
  onRenameSection: (id: string, name: string) => void;
  onToggleSection: (id: string) => void;
  onDeleteSection: (id: string) => void;
  onReorderTop: (fromId: string, toId: string | null) => void;
  onSetSectionEnabled: (id: string, enabled: boolean) => void;
  onUpdateFilter: (id: string, patch: Partial<Filter>) => void;
  onAddFilter: (sectionId?: string | null) => void;
  onDeleteFilter: (id: string) => void;
  onDuplicateFilter: (id: string) => void;
  onEditFilter: (id: string) => void;
  onMoveFilter: (activeId: string, overId: string | null, targetSectionId: string | null) => void;
  onBulk: (action: string) => void;
}

export function FilterPanel({
  file, group, counts, style,
  onSwitchGroup, onAddGroup, onRenameGroup, onDeleteGroup, onReorderGroup,
  onAddSection, onRenameSection, onToggleSection, onDeleteSection, onReorderTop, onSetSectionEnabled,
  onUpdateFilter, onAddFilter, onDeleteFilter, onDuplicateFilter, onEditFilter,
  onMoveFilter, onBulk,
}: FilterPanelProps) {
  const [search, setSearch] = useState("");

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const q = search.trim().toLowerCase();
  const filters = group.filters;
  const sections = group.sections;
  const searching = !!q;
  const filtered = q ? filters.filter((f) => f.pattern.toLowerCase().includes(q)) : filters;

  const bySection = (sid: string) => filters.filter((f) => f.sectionId === sid);

  // Build the interleaved top-level layout from `group.order`: each entry is
  // either a section or a loose (ungrouped) filter row, in free order. We fall
  // back to appending anything `order` is missing so a row never disappears.
  const sectionById = new Map(sections.map((s) => [s.id, s] as const));
  const filterById = new Map(filters.map((f) => [f.id, f] as const));
  const topItems: ({ kind: "section"; section: FilterSection } | { kind: "filter"; filter: Filter })[] = [];
  const seen = new Set<string>();
  for (const id of group.order) {
    if (seen.has(id)) continue;
    const sec = sectionById.get(id);
    if (sec) { topItems.push({ kind: "section", section: sec }); seen.add(id); continue; }
    const f = filterById.get(id);
    if (f && f.sectionId === null) { topItems.push({ kind: "filter", filter: f }); seen.add(id); }
  }
  for (const f of filters) if (f.sectionId === null && !seen.has(f.id)) { topItems.push({ kind: "filter", filter: f }); seen.add(f.id); }
  for (const s of sections) if (!seen.has(s.id)) { topItems.push({ kind: "section", section: s }); seen.add(s.id); }
  const topIds = topItems.map((it) => (it.kind === "section" ? it.section.id : it.filter.id));

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
      />
    );
  }

  // Custom collision so that "move into a section" is *only* possible by dropping
  // on its header. Everything else resolves to a reorder:
  //   1. If the pointer is inside a section header → that header wins (nest).
  //   2. Otherwise fall back to closestCenter, but exclude the interior rows and
  //      body of sections the dragged row doesn't belong to — so a loose row can
  //      slide *between* sections (landing next to the whole section block)
  //      instead of being swallowed by one.
  const collisionDetection: CollisionDetection = (args) => {
    const activeSection = (args.active.data.current?.sectionId ?? null) as string | null;
    const headers = args.droppableContainers.filter((c) => c.data.current?.type === "header");
    const headerHit = pointerWithin({ ...args, droppableContainers: headers });
    if (headerHit.length) return headerHit;

    const rest = args.droppableContainers.filter((c) => {
      const d = c.data.current;
      if (d?.type === "header") return false;
      if (d?.type === "filter" || d?.type === "body") {
        const sid = (d.sectionId ?? null) as string | null;
        return sid === null || sid === activeSection;
      }
      return true; // section blocks + top-level zone
    });
    return closestCenter({ ...args, droppableContainers: rest });
  };

  // The top-level slot (section id or loose-filter id) a drag is hovering over.
  // null = drop at the end of the top level.
  function topLevelIdFromOver(over: DragEndEvent["over"]): string | null {
    const t = over?.data.current?.type;
    if (t === "section") return String(over!.id);
    if (t === "header") return (over!.data.current?.sectionId ?? null) as string | null;
    if (t === "filter") {
      const sid = (over!.data.current?.sectionId ?? null) as string | null;
      return sid === null ? String(over!.id) : sid;
    }
    if (t === "body") return (over!.data.current?.sectionId ?? null) as string | null;
    return null;
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || over.id === active.id) return;
    const aType = active.data.current?.type;
    const overType = over.data.current?.type as string | undefined;

    // Sections only ever reorder at the top level.
    if (aType === "section") {
      const overTop = topLevelIdFromOver(over);
      if (overTop === active.id) return;
      onReorderTop(String(active.id), overTop);
      return;
    }

    // --- filter row ---
    const activeId = String(active.id);

    // Drop on a header = move INTO that section (append).
    if (overType === "header") {
      onMoveFilter(activeId, null, (over.data.current?.sectionId ?? null) as string | null);
      return;
    }
    // Over another row: reorder at that row's level (loose, or the active's own section).
    if (overType === "filter") {
      onMoveFilter(activeId, String(over.id), (over.data.current?.sectionId ?? null) as string | null);
      return;
    }
    // Over a section block (not its header) = stay loose, land next to the block.
    if (overType === "section") {
      onMoveFilter(activeId, String(over.id), null);
      return;
    }
    // Over a body zone: own section → keep in it; top-level zone → loose at end.
    onMoveFilter(activeId, null, (over.data.current?.sectionId ?? null) as string | null);
  }

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
            <PanelMenuItems onAddSection={onAddSection} onBulk={onBulk} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* filter list */}
      {filters.length === 0 ? (
        <PanelListZone onAddSection={onAddSection} onBulk={onBulk}>
          <div className="filter-empty">
            <FilterIcon size={26} style={{ color: "var(--text-3)" }} />
            <div className="fe-title">No filters yet</div>
            <div className="fe-sub">Click "Add filter" to highlight or hide lines.</div>
          </div>
        </PanelListZone>
      ) : searching ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter}>
          <PanelListZone onAddSection={onAddSection} onBulk={onBulk}>
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
        <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragEnd={handleDragEnd}>
          <PanelListZone onAddSection={onAddSection} onBulk={onBulk}>
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
            </TopDropZone>

            <button className="fsection-add" onClick={onAddSection}>
              <FolderPlus size={14} /> New group
            </button>
          </PanelListZone>
        </DndContext>
      )}
    </div>
  );
}
