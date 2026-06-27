import { useEffect, useMemo, useRef, useState } from "react";
import type { DraggableAttributes } from "@dnd-kit/core";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  restrictToVerticalAxis,
  restrictToParentElement,
} from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  EyeOff,
  FileDown,
  GripVertical,
  ListPlus,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
  Ungroup,
  X,
} from "lucide-react";
import type { Filter, FilterGroup, FilterLabelMode, FilterPack } from "@/types";
import { useStore } from "@/store";
import { SpectrumBar } from "./SpectrumBar";
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { PackTagEditor } from "./PackTagEditor";

const fmtDate = (ms: number) => {
  if (!ms) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(ms);
  } catch {
    return "";
  }
};

/** Row label per the global `filterLabel` setting — same resolution the filter
 *  panel uses, so a pack's rows read identically to the set they came from. */
function rowLabel(f: Filter, mode: FilterLabelMode | undefined): string {
  if (mode === "pattern") return f.pattern;
  if (mode === "description") return f.description ?? "";
  return f.description || f.pattern; // "desc-first" (default)
}

/** One filter in the expanded detail, styled to match the filter panel's row:
 *  the whole row drags to reorder (a move beats a click via the sensor's distance
 *  threshold), clicking opens the full editor, and the trash button pops a small
 *  confirm before removing the filter from the pack. */
function PackFilterRow({
  f,
  index,
  disabled,
  onEdit,
  onInsertToSet,
  onRemove,
}: {
  f: Filter;
  index: number;
  /** Reordering off (e.g. while a search shows only the matching subset). */
  disabled: boolean;
  onEdit: () => void;
  /** Drop just this one filter into the active set (right-click action). */
  onInsertToSet: () => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: f.id, disabled });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const labelMode = useStore((s) => s.doc.filterLabel);
  const label = rowLabel(f, labelMode);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            ref={setNodeRef}
            style={{
              transform: CSS.Transform.toString(transform),
              transition,
            }}
            className={
              "filter-row" +
              (f.enabled === false ? " disabled" : "") +
              (isDragging ? " dragging" : "")
            }
            onClick={onEdit}
            {...attributes}
            {...listeners}
          />
        }
      >
        <span className="fr-handle" title="Drag to reorder">
          <GripVertical size={12} />
        </span>
        <span className="fr-serial" title={`Filter #${index + 1}`}>
          #{index + 1}
        </span>
        {label ? (
          <div className="fr-pattern">
            <span
              className="fr-pattern-chip"
              style={{ background: f.bgColor, color: f.textColor }}
            >
              {label}
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
        <div className="fr-actions" onClick={stop} onPointerDown={stop}>
          <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="Remove from pack"
                />
              }
            >
              <X />
            </PopoverTrigger>
            <PopoverContent side="bottom" align="end" className="pack-del-pop">
              <div className="pdc-msg">Remove this filter from the pack?</div>
              <div className="pdc-actions">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setConfirmOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() => {
                    onRemove();
                    setConfirmOpen(false);
                  }}
                >
                  Remove
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent zIndex={130}>
        <DropdownMenuItem onClick={onInsertToSet}>
          <span className="mi-ico">
            <ListPlus size={15} />
          </span>
          Add to filters
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onEdit}>
          <span className="mi-ico">
            <Pencil size={15} />
          </span>
          Edit filter…
        </DropdownMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A collapsible group section header in the expanded detail, reusing the filter
 *  panel's `.fsection-head` look. Click toggles collapse; double-click the name
 *  (or the right-click menu) renames it inline; the menu also inserts the whole
 *  group into the active set or dissolves it (keeping its filters). */
function PackGroupHeader({
  group,
  count,
  onToggle,
  onRename,
  onInsert,
  onDissolve,
}: {
  group: FilterGroup;
  count: number;
  onToggle: () => void;
  onRename: (name: string) => void;
  onInsert: () => void;
  onDissolve: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(group.name);
  const startRename = () => {
    setVal(group.name);
    setEditing(true);
  };
  const commit = () => {
    const v = val.trim();
    if (v && v !== group.name) onRename(v);
    setEditing(false);
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            className="fsection-head"
            title="Click to collapse / expand · double-click name to rename · right-click for menu"
            onClick={editing ? undefined : onToggle}
          />
        }
      >
        <button
          className="fs-chevron"
          title={group.collapsed ? "Expand" : "Collapse"}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
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
            onClick={(e) => e.stopPropagation()}
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
            onDoubleClick={(e) => {
              e.stopPropagation();
              startRename();
            }}
          >
            {group.name}
          </span>
        )}
        <span className="fs-count">{count}</span>
      </ContextMenuTrigger>
      <ContextMenuContent zIndex={130}>
        <DropdownMenuItem onClick={onInsert}>
          <span className="mi-ico">
            <ListPlus size={15} />
          </span>
          Add to filters
        </DropdownMenuItem>
        <DropdownMenuItem onClick={startRename}>
          <span className="mi-ico">
            <Pencil size={15} />
          </span>
          Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onDissolve}>
          <span className="mi-ico">
            <Ungroup size={15} />
          </span>
          Ungroup (keep filters)
        </DropdownMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * One library pack: its colour spectrum (the recognizable bit), name, a terse
 * meta line, and an explicit Insert action. Inserting is deliberately NOT bound
 * to a card click — that made stray clicks pile filters into the set — so the
 * card body just expands the filter detail, and the Insert button is the only
 * thing that adds. The ⋯ menu carries the management verbs. Expanded, each filter
 * becomes an editable row (styled like the filter panel): drag to reorder, click
 * to edit, trash to remove.
 */
export function PackCard({
  pack,
  query = "",
  allTags = [],
  onInsert,
  onRename,
  onDuplicate,
  onSetTags,
  onExport,
  onDelete,
  onReorderFilter,
  onEditFilter,
  onInsertFilter,
  onRemoveFilter,
  onAddFilter,
  onToggleGroup,
  onRenameGroup,
  onInsertGroup,
  onDissolveGroup,
  dragHandle,
}: {
  pack: FilterPack;
  /** Active drawer search; a filter-content hit reveals + narrows the detail. */
  query?: string;
  /** Every tag used across the library — feeds the editor's type-ahead. */
  allTags?: string[];
  /** Insert this pack; may resolve `false` when the user cancels an overlap confirm. */
  onInsert: () => void | Promise<boolean>;
  /** Commit a new pack name (inline-edited on the card; empty input is ignored). */
  onRename: (name: string) => void;
  /** Fork this pack into an independent copy. */
  onDuplicate: () => void;
  /** Replace this pack's tag list. */
  onSetTags: (tags: string[]) => void;
  onExport: () => void;
  onDelete: () => void;
  onReorderFilter: (from: number, to: number) => void;
  onEditFilter: (filter: Filter) => void;
  /** Drop a single one of the pack's filters into the active set. */
  onInsertFilter: (filterId: string) => void;
  onRemoveFilter: (filterId: string) => void;
  onAddFilter: () => void;
  /** Collapse/expand a group shown in the expanded detail. */
  onToggleGroup: (groupId: string) => void;
  /** Rename a group shown in the expanded detail. */
  onRenameGroup: (groupId: string, name: string) => void;
  /** Insert a whole group (its filters, carrying the group) into the active set. */
  onInsertGroup: (groupId: string) => void;
  /** Dissolve a group (ungroup its filters; the filters stay in the pack). */
  onDissolveGroup: (groupId: string) => void;
  /** Drag-handle wiring from the sortable wrapper; absent disables reordering. */
  dragHandle?: {
    attributes: DraggableAttributes;
    listeners: SyntheticListenerMap | undefined;
  };
}) {
  const [expanded, setExpanded] = useState(false);
  const isEmpty = pack.filters.length === 0;
  // Post-insert cool-down: Insert flips to a disabled "Added ✓" state for a beat,
  // so a double/triple click can't pile the pack in two or three times. It both
  // confirms the insert and gates the accidental-repeat window; a deliberate
  // re-insert just waits out the ~1.1s.
  const [justInserted, setJustInserted] = useState(false);
  const insertTimer = useRef<number | null>(null);
  const handleInsert = async () => {
    if (justInserted) return;
    // Insert may pop an overlap confirm; only enter the "Added ✓" cool-down once
    // it actually inserts, so backing out of the confirm leaves the button live.
    const inserted = await onInsert();
    if (inserted === false) return;
    setJustInserted(true);
    if (insertTimer.current) clearTimeout(insertTimer.current);
    insertTimer.current = window.setTimeout(() => setJustInserted(false), 1100);
  };
  useEffect(
    () => () => {
      if (insertTimer.current) clearTimeout(insertTimer.current);
    },
    [],
  );
  // Inline rename, mirroring the set tab / group header: double-click the name (or
  // the ⋯ menu's Rename) edits in place; Enter/blur commits, Esc cancels.
  const [renaming, setRenaming] = useState(false);
  const [nameVal, setNameVal] = useState(pack.name);
  const startRename = () => {
    setNameVal(pack.name);
    setRenaming(true);
  };
  const commitRename = () => {
    const v = nameVal.trim();
    if (v && v !== pack.name) onRename(v);
    setRenaming(false);
  };
  // Tags: shown as read-only chips on the card; managed in the expanded detail
  // by PackTagEditor.
  const tags = pack.tags ?? [];
  const n = pack.filters.length;
  const meta = [
    `${n} filter${n === 1 ? "" : "s"}`,
    pack.groups.length > 0 ? `${pack.groups.length} groups` : "",
    fmtDate(pack.createdAt),
  ].filter(Boolean);

  // Search: when the query hit this pack's filter content (not just its name),
  // auto-open the detail and narrow it to the matching filters — mirroring the
  // filter panel's row-search — so it's obvious why the pack surfaced.
  const q = query.trim().toLowerCase();
  const searching = q !== "";
  const contentHits = searching
    ? pack.filters.filter(
        (f) =>
          f.pattern.toLowerCase().includes(q) ||
          (f.description ?? "").toLowerCase().includes(q),
      )
    : pack.filters;
  const hasContentHit = searching && contentHits.length > 0;
  const showExpanded = expanded || hasContentHit;
  // While searching a content hit, list only the matches (flat); otherwise the
  // full set, rendered grouped below.
  const rows = hasContentHit ? contentHits : pack.filters;

  // The normal (non-searching) detail mirrors the filter panel: groups shown as
  // collapsible sections interleaved with loose rows, following `pack.order`.
  type DetailItem =
    | { kind: "group"; group: FilterGroup; members: Filter[] }
    | { kind: "filter"; f: Filter };
  const grouped = useMemo<DetailItem[]>(() => {
    const byId = new Map(pack.filters.map((f) => [f.id, f] as const));
    const groupById = new Map(pack.groups.map((g) => [g.id, g] as const));
    const items: DetailItem[] = [];
    const seen = new Set<string>();
    for (const id of pack.order) {
      const g = groupById.get(id);
      if (g) {
        const members = pack.filters.filter((f) => f.groupId === g.id);
        members.forEach((m) => seen.add(m.id));
        items.push({ kind: "group", group: g, members });
      } else {
        const f = byId.get(id);
        if (f && !f.groupId) {
          items.push({ kind: "filter", f });
          seen.add(f.id);
        }
      }
    }
    // Any filter `order` didn't account for trails at the end (defensive).
    for (const f of pack.filters)
      if (!seen.has(f.id)) items.push({ kind: "filter", f });
    return items;
  }, [pack.filters, pack.groups, pack.order]);

  // The drag sort list = every row currently rendered, in display order (a
  // collapsed group's members aren't draggable while hidden).
  const visibleIds = useMemo(() => {
    const ids: string[] = [];
    for (const it of grouped) {
      if (it.kind === "filter") ids.push(it.f.id);
      else if (!it.group.collapsed) it.members.forEach((m) => ids.push(m.id));
    }
    return ids;
  }, [grouped]);

  // Its own context so a filter drag stays inside the card and never reaches the
  // outer pack-reorder context.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  const onFilterDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = pack.filters.findIndex((f) => f.id === active.id);
    const to = pack.filters.findIndex((f) => f.id === over.id);
    if (from >= 0 && to >= 0) onReorderFilter(from, to);
  };

  const renderRow = (f: Filter, isSearch: boolean) => (
    <PackFilterRow
      key={f.id}
      f={f}
      index={pack.filters.indexOf(f)}
      disabled={isSearch}
      onEdit={() => onEditFilter(f)}
      onInsertToSet={() => onInsertFilter(f.id)}
      onRemove={() => onRemoveFilter(f.id)}
    />
  );

  return (
    <div className={"pack-card" + (showExpanded ? " expanded" : "")}>
      <SpectrumBar filters={pack.filters} className="pack-spectrum" />
      <div className="pack-row">
        {dragHandle && (
          <span
            className="pack-grip"
            title="Drag to reorder"
            {...dragHandle.attributes}
            {...dragHandle.listeners}
          >
            <GripVertical size={13} />
          </span>
        )}
        <button
          className="pack-expand"
          aria-expanded={showExpanded}
          title={showExpanded ? "Hide filters" : "Show filters"}
          onClick={() => setExpanded((v) => !v)}
        >
          {showExpanded ? (
            <ChevronDown size={14} />
          ) : (
            <ChevronRight size={14} />
          )}
        </button>
        <div
          className="pack-text"
          title={
            renaming
              ? undefined
              : "Click to show filters · double-click to rename"
          }
          onClick={renaming ? undefined : () => setExpanded((v) => !v)}
        >
          {renaming ? (
            <input
              className="pack-rename-input"
              value={nameVal}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setNameVal(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <span
              className="pack-name"
              onDoubleClick={(e) => {
                e.stopPropagation();
                startRename();
              }}
            >
              {pack.name}
            </span>
          )}
          <span className="pack-meta">{meta.join(" · ")}</span>
          {tags.length > 0 && (
            <div className="pack-tags">
              {tags.map((t) => (
                <span key={t} className="tag-chip">
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
        {/* The action cluster top-aligns with the name line (align-self in CSS) so
            it never floats to the middle when the text block grows taller. */}
        <div className="pack-actions">
          <Button
            size="xs"
            variant="outline"
            className={"pack-insert-btn" + (justInserted ? " added" : "")}
            // An empty pack has nothing to insert — insertPack would no-op
            // silently, so gate the button rather than letting it dead-end.
            disabled={justInserted || isEmpty}
            title={
              isEmpty
                ? "This pack is empty — add filters to it first"
                : `Add "${pack.name}" to the current filters`
            }
            onClick={handleInsert}
          >
            {justInserted ? (
              <Check data-icon="inline-start" />
            ) : (
              <ListPlus data-icon="inline-start" />
            )}
            {justInserted ? "Added" : "Add to filters"}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="pack-add-btn"
            title="New filter in this pack"
            onClick={() => {
              setExpanded(true);
              onAddFilter();
            }}
          >
            <Plus />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-xs" title="Pack actions" />
              }
            >
              <MoreVertical />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end" zIndex={130}>
              <DropdownMenuItem onClick={startRename}>
                <span className="mi-ico">
                  <Pencil size={15} />
                </span>
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDuplicate}>
                <span className="mi-ico">
                  <Copy size={15} />
                </span>
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onExport}>
                <span className="mi-ico">
                  <FileDown size={15} />
                </span>
                Export to file…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <span className="mi-ico">
                  <Trash2 size={15} />
                </span>
                Delete pack
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {showExpanded && (
        <div className="pack-detail">
          {/* Tag editor sits at the top so it's reachable without scrolling past a
              long filter list. */}
          <PackTagEditor tags={tags} allTags={allTags} onSetTags={onSetTags} />

          {pack.filters.length === 0 ? (
            <div className="pack-filters-empty">
              This pack has no filters yet.
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis, restrictToParentElement]}
              onDragEnd={onFilterDragEnd}
            >
              {hasContentHit ? (
                // Searching: a flat list of just the matching rows.
                <SortableContext
                  items={rows.map((f) => f.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="pack-filters">
                    {rows.map((f) => renderRow(f, true))}
                  </div>
                </SortableContext>
              ) : (
                // Normal: groups as collapsible sections interleaved with loose rows.
                <SortableContext
                  items={visibleIds}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="pack-filters">
                    {grouped.map((it) =>
                      it.kind === "filter" ? (
                        renderRow(it.f, false)
                      ) : (
                        <div
                          key={it.group.id}
                          className="fsection pack-fsection"
                        >
                          <PackGroupHeader
                            group={it.group}
                            count={it.members.length}
                            onToggle={() => onToggleGroup(it.group.id)}
                            onRename={(name) =>
                              onRenameGroup(it.group.id, name)
                            }
                            onInsert={() => onInsertGroup(it.group.id)}
                            onDissolve={() => onDissolveGroup(it.group.id)}
                          />
                          {!it.group.collapsed && (
                            <div className="fsection-body">
                              {it.members.length === 0 ? (
                                <div className="fs-empty">
                                  No filters in this group.
                                </div>
                              ) : (
                                it.members.map((m) => renderRow(m, false))
                              )}
                            </div>
                          )}
                        </div>
                      ),
                    )}
                  </div>
                </SortableContext>
              )}
            </DndContext>
          )}
        </div>
      )}
    </div>
  );
}
