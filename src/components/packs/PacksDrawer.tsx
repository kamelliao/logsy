import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
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
  ArrowDownUp,
  Check,
  Package,
  Plus,
  Search,
  Upload,
  X,
} from "lucide-react";
import type { Filter, FilterGroup, FilterPack, PacksSort } from "@/types";
import { useStore } from "@/store";
import { DEFAULT_PALETTE } from "@/lib/palette";
import { FONT_DEFAULT } from "@/config";
import { makeFilter } from "@/lib/defaults";
import { EditModal } from "@/components/dialogs/EditModal";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { PackCard } from "./PackCard";

/** The pack filter currently open in the editor modal (null when closed). */
type EditTarget = { packId: string; filter: Filter; isNew: boolean } | null;
const NO_LINES: string[] = [];

// Stable empty reference: a selector returning a fresh `[]` each render makes
// useSyncExternalStore loop ("getSnapshot should be cached"). Share one array.
const NO_PACKS: FilterPack[] = [];
const DEFAULT_W = 360;

/** Sort modes offered in the drawer, in menu order. */
const SORT_OPTIONS: { value: PacksSort; label: string }[] = [
  { value: "manual", label: "Manual (drag)" },
  { value: "name", label: "Name (A–Z)" },
  { value: "created", label: "Newest first" },
  { value: "count", label: "Most filters" },
];

/** A reorderable pack card. Only the grip drags (the card body stays a click-to-
 *  insert target); reordering is disabled whenever the list isn't in its raw
 *  manual order (a search/tag filter or a name/date/count sort is active). */
function SortablePackCard({
  pack,
  disabled,
  query,
  allTags,
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
  onInsertGroup,
  onDissolveGroup,
}: {
  pack: FilterPack;
  disabled: boolean;
  /** Active search text — drives which filters a content match reveals. */
  query: string;
  /** Every tag in use across the library (for the editor's type-ahead). */
  allTags: string[];
  onInsert: () => void | Promise<boolean>;
  onRename: (name: string) => void;
  onDuplicate: () => void;
  onSetTags: (tags: string[]) => void;
  onExport: () => void;
  onDelete: () => void;
  onReorderFilter: (from: number, to: number) => void;
  onEditFilter: (filter: Filter) => void;
  onInsertFilter: (filterId: string) => void;
  onRemoveFilter: (filterId: string) => void;
  onAddFilter: () => void;
  onToggleGroup: (groupId: string) => void;
  onInsertGroup: (groupId: string) => void;
  onDissolveGroup: (groupId: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: pack.id, disabled });
  return (
    <div
      ref={setNodeRef}
      className="pack-sortable"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
    >
      <PackCard
        pack={pack}
        query={query}
        allTags={allTags}
        onInsert={onInsert}
        onRename={onRename}
        onDuplicate={onDuplicate}
        onSetTags={onSetTags}
        onExport={onExport}
        onDelete={onDelete}
        onReorderFilter={onReorderFilter}
        onEditFilter={onEditFilter}
        onInsertFilter={onInsertFilter}
        onRemoveFilter={onRemoveFilter}
        onAddFilter={onAddFilter}
        onToggleGroup={onToggleGroup}
        onInsertGroup={onInsertGroup}
        onDissolveGroup={onDissolveGroup}
        dragHandle={disabled ? undefined : { attributes, listeners }}
      />
    </div>
  );
}

/**
 * The filter-pack library as a NON-modal side panel: it coexists with the filter
 * panel (no backdrop, no focus trap) so you can scroll and edit your filters while
 * browsing packs. It docks on the side opposite the filter panel, and its width is
 * draggable + persisted. Clicking a card inserts that pack into the active set.
 */
export function PacksDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const packs = useStore((s) => s.doc.filterPacks ?? NO_PACKS);
  const panelPos = useStore((s) => s.doc.panelPos);
  const width = useStore((s) => s.doc.packsDrawerW ?? DEFAULT_W);
  const insertPack = useStore((s) => s.insertPack);
  const insertPackFilter = useStore((s) => s.insertPackFilter);
  const insertPackGroup = useStore((s) => s.insertPackGroup);
  const renamePack = useStore((s) => s.renamePack);
  const duplicatePack = useStore((s) => s.duplicatePack);
  const setPackTags = useStore((s) => s.setPackTags);
  const togglePackGroupCollapsed = useStore((s) => s.togglePackGroupCollapsed);
  const dissolvePackGroup = useStore((s) => s.dissolvePackGroup);
  const deletePack = useStore((s) => s.deletePack);
  const exportPackToFile = useStore((s) => s.exportPackToFile);
  const importPackFromFile = useStore((s) => s.importPackFromFile);
  const createEmptyPack = useStore((s) => s.createEmptyPack);
  const reorderPacks = useStore((s) => s.reorderPacks);
  const reorderPackFilter = useStore((s) => s.reorderPackFilter);
  const removePackFilter = useStore((s) => s.removePackFilter);
  const savePackFilter = useStore((s) => s.savePackFilter);
  const setPacksDrawerW = useStore((s) => s.setPacksDrawerW);
  const sort = useStore((s) => s.doc.packsSort ?? "manual");
  const setPacksSort = useStore((s) => s.setPacksSort);
  const palette = useStore((s) => s.doc.customPalette) ?? DEFAULT_PALETTE;
  // The expanded filter rows reuse the panel's `.filter-row` styles, which size
  // off `--log-font-size` / `--filter-row-h`. Those vars live on `.app`, but this
  // drawer portals to <body> outside it — so mirror them here (same derivation as
  // App) to keep pack rows at the panel's size and following its zoom/resize.
  const fontSize = useStore((s) => s.doc.fontSize ?? FONT_DEFAULT);
  const filterRowH = Math.round(fontSize * 1.58);
  const confirm = useStore((s) => s.confirm);

  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditTarget>(null);

  // The pack being edited, resolved live so its groups list (for the editor's
  // group combobox) stays current if the pack changes underneath the modal.
  const editingPack = editing && packs.find((p) => p.id === editing.packId);
  // Editor's group combobox order: follow the pack's top-level `order`, then any
  // stragglers — same shape FilterPanel feeds the modal for a set.
  const editingGroups: FilterGroup[] = editingPack
    ? editingPack.order
        .map((id) => editingPack.groups.find((g) => g.id === id))
        .filter((g): g is FilterGroup => !!g)
        .concat(
          editingPack.groups.filter((g) => !editingPack.order.includes(g.id)),
        )
    : [];

  // Dock on the side the filter panel isn't, so the panel stays fully visible.
  const side = panelPos === "right" ? "left" : "right";

  // Esc closes (we own dismissal — there's no modal layer to do it for us). While
  // the filter editor is open it owns Esc, so we stand down — otherwise one press
  // would close the modal AND the drawer beneath it.
  useEffect(() => {
    if (!open || editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, editing, onOpenChange]);

  // ---- width drag (the handle sits on the panel's inner edge) ----
  const drag = useRef<{ x: number; w: number } | null>(null);
  const onResizeDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    // Left-docked grows when dragging right; right-docked grows dragging left.
    setPacksDrawerW(drag.current.w + (side === "left" ? dx : -dx));
  };
  const onResizeUp = (e: React.PointerEvent) => {
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const searching = query.trim() !== "";
  // Drag-reorder only makes sense against the raw, unfiltered, manually-ordered
  // list: a search/tag filter hides cards, and a name/date/count sort owns the
  // order — letting a drag fight either would write a bogus manual order.
  const reorderable = !searching && !tagFilter && sort === "manual";
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = packs.findIndex((p) => p.id === active.id);
    const to = packs.findIndex((p) => p.id === over.id);
    if (from >= 0 && to >= 0) reorderPacks(from, to);
  };

  // Every tag in use across the library, for the filter strip.
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const p of packs) for (const t of p.tags ?? []) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [packs]);

  // Search matches a pack by its name, any group name, or any filter's pattern /
  // description — so you can find a pack by something you saved into it, not just
  // what you named it. A tag filter and the chosen sort then narrow/order it.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = packs;
    if (q)
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.groups.some((g) => g.name.toLowerCase().includes(q)) ||
          p.filters.some(
            (f) =>
              f.pattern.toLowerCase().includes(q) ||
              (f.description ?? "").toLowerCase().includes(q),
          ),
      );
    if (tagFilter) list = list.filter((p) => p.tags?.includes(tagFilter));
    if (sort !== "manual") {
      list = [...list].sort((a, b) => {
        if (sort === "name") return a.name.localeCompare(b.name);
        if (sort === "created") return b.createdAt - a.createdAt;
        return b.filters.length - a.filters.length; // "count"
      });
    }
    return list;
  }, [packs, query, tagFilter, sort]);

  const askDelete = async (id: string, name: string) => {
    const ok = await confirm({
      title: "Delete pack?",
      message: `Delete "${name}" from your packs? This can't be undone.`,
      okLabel: "Delete",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (ok) deletePack(id);
  };

  // Shared per-card wiring, so the sortable and the plain (non-reorderable)
  // renders stay identical bar the drag handle.
  const cardProps = (p: FilterPack) => ({
    pack: p,
    query,
    allTags,
    onInsert: () => insertPack(p.id),
    onRename: (name: string) => renamePack(p.id, name),
    onDuplicate: () => duplicatePack(p.id),
    onSetTags: (tags: string[]) => setPackTags(p.id, tags),
    onExport: () => void exportPackToFile(p.id),
    onDelete: () => void askDelete(p.id, p.name),
    onReorderFilter: (from: number, to: number) =>
      reorderPackFilter(p.id, from, to),
    onEditFilter: (filter: Filter) =>
      setEditing({ packId: p.id, filter, isNew: false }),
    onInsertFilter: (fid: string) => void insertPackFilter(p.id, fid),
    onRemoveFilter: (fid: string) => removePackFilter(p.id, fid),
    onToggleGroup: (gid: string) => togglePackGroupCollapsed(p.id, gid),
    onInsertGroup: (gid: string) => void insertPackGroup(p.id, gid),
    onDissolveGroup: (gid: string) => dissolvePackGroup(p.id, gid),
    onAddFilter: () =>
      setEditing({
        packId: p.id,
        filter: makeFilter("", { groupId: null }),
        isNew: true,
      }),
  });

  if (!open) return null;

  return createPortal(
    <>
      <aside
        className={"packs-drawer " + side}
        style={
          {
            width,
            "--log-font-size": `${fontSize}px`,
            "--filter-row-h": `${filterRowH}px`,
          } as CSSProperties
        }
      >
        <div
          className="packs-resize"
          title="Drag to resize"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
        />
        <header className="packs-head">
          <span className="packs-head-ico">
            <Package size={16} />
          </span>
          <span className="packs-title">Filter packs</span>
          <span className="packs-head-count">{packs.length}</span>
          <span className="packs-head-spacer" />
          <Button
            variant="ghost"
            size="icon-xs"
            title="New empty pack"
            onClick={() => createEmptyPack()}
          >
            <Plus />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            title="Import a pack from a file"
            onClick={() => void importPackFromFile()}
          >
            <Upload />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            title="Close"
            onClick={() => onOpenChange(false)}
          >
            <X />
          </Button>
        </header>

        <div className="packs-tools">
          <div className="packs-search">
            <Search size={14} />
            <input
              placeholder="Search packs…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <span className="clear-x" onClick={() => setQuery("")}>
                <X size={13} />
              </span>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant={sort === "manual" ? "ghost" : "default"}
                  size="icon-xs"
                  title="Sort packs"
                />
              }
            >
              <ArrowDownUp />
            </DropdownMenuTrigger>
            {/* Above the drawer (z-index 99) — matching the pack card's ⋯ menu —
                or the popup opens hidden behind it and clicks never land. */}
            <DropdownMenuContent side="bottom" align="end" zIndex={130}>
              {SORT_OPTIONS.map((o) => (
                <DropdownMenuItem
                  key={o.value}
                  onClick={() => setPacksSort(o.value)}
                >
                  <span className="mi-ico">
                    {sort === o.value && <Check size={15} />}
                  </span>
                  {o.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {allTags.length > 0 && (
          <div className="packs-tagbar">
            <button
              className={"packs-tagchip" + (tagFilter === null ? " on" : "")}
              onClick={() => setTagFilter(null)}
            >
              All
            </button>
            {allTags.map((t) => (
              <button
                key={t}
                className={"packs-tagchip" + (tagFilter === t ? " on" : "")}
                onClick={() => setTagFilter((cur) => (cur === t ? null : t))}
              >
                {t}
              </button>
            ))}
          </div>
        )}

        <ScrollArea className="packs-list">
          {packs.length === 0 ? (
            <Empty className="packs-empty">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Package />
                </EmptyMedia>
                <EmptyTitle>No packs yet</EmptyTitle>
                <EmptyDescription>
                  Select filters and save them as a reusable pack. Packs drop
                  into any file with one click.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : shown.length === 0 ? (
            <div className="packs-noresult">
              {query
                ? `No packs match “${query}”.`
                : tagFilter
                  ? `No packs tagged “${tagFilter}”.`
                  : "No packs match your filters."}
            </div>
          ) : reorderable ? (
            // Manual order, unfiltered: drag to reorder.
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis, restrictToParentElement]}
              onDragEnd={onDragEnd}
            >
              <SortableContext
                items={shown.map((p) => p.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="packs-cards">
                  {shown.map((p) => (
                    <SortablePackCard
                      key={p.id}
                      disabled={false}
                      {...cardProps(p)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          ) : (
            // Sorted or filtered: render plainly (no drag) so the list always
            // reflects `shown`'s order instead of dnd-kit's cached positions.
            <div className="packs-cards">
              {shown.map((p) => (
                <PackCard key={p.id} {...cardProps(p)} />
              ))}
            </div>
          )}
        </ScrollArea>
      </aside>

      {/* Full filter editor, reused for a pack's filter. A pack is file-agnostic,
          so there's no log to preview against — the modal still edits every field;
          the match count just reads zero. */}
      {editing && editingPack && (
        <EditModal
          filter={editing.filter}
          isNew={editing.isNew}
          lines={NO_LINES}
          groups={editingGroups}
          palette={palette}
          onSave={(draft) => {
            savePackFilter(editing.packId, draft);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
          onDelete={() => {
            removePackFilter(editing.packId, editing.filter.id);
            setEditing(null);
          }}
        />
      )}
    </>,
    document.body,
  );
}
