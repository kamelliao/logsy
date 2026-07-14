import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  Folder,
  FolderPlus,
  MoreVertical,
  PanelLeft,
  Search,
  Settings,
  X,
} from "lucide-react";
import {
  DndContext,
  DragOverlay,
  pointerWithin,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { AppState, FileGroup, FileIcon, LogFile } from "@/types";
import { FILE_ICONS, FileGlyph } from "@/components/widgets/fileIcons";
import { disambiguationSuffixes } from "@/lib/path";
import { fuzzyMatch, substringMatch } from "@/lib/fuzzy";
import { Button } from "@/components/ui/button";
import { useStore } from "@/store";
import { UNGROUPED } from "@/store/slices/fileGroupSlice";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Container id → ordered file ids (UNGROUPED bucket plus one per group). */
type ContainerMap = Record<string, string[]>;

const CONT = (cid: string) => "cont:" + cid;
const findContainer = (id: string, map: ContainerMap): string | null => {
  if (id.startsWith("cont:")) return id.slice(5);
  for (const k of Object.keys(map)) if (map[k].includes(id)) return k;
  return null;
};

interface FileItemProps {
  file: LogFile;
  active: boolean;
  canDelete: boolean;
  /** In the sidebar's multi-selection (Ctrl/Shift-click), which the batch acts on. */
  selected: boolean;
  /** Currently displayed in some split pane — the row gets an accent edge. */
  inPane: boolean;
  /** Reordering is off while the list is filtered (the order shown isn't the real one). */
  dndDisabled: boolean;
  /** Parent-dir suffix disambiguating same-named files (VS Code style); dim. */
  suffix?: string;
  groups: FileGroup[];
  /** Click with its modifiers — the sidebar turns it into select / toggle / range. */
  onClick: (e: React.MouseEvent) => void;
  onDelete: () => void;
  onSetIcon: (icon: FileIcon) => void;
  onMoveToGroup: (groupId: string | null) => void;
  onNewGroupWith: () => void;
  /** Batch close, offered by the context menu when the row is part of a selection. */
  selectedCount: number;
  onCloseSelected: () => void;
}

function FileItem({
  file,
  active,
  canDelete,
  selected,
  inPane,
  dndDisabled,
  suffix,
  groups,
  onClick,
  onDelete,
  onSetIcon,
  onMoveToGroup,
  onNewGroupWith,
  selectedCount,
  onCloseSelected,
}: FileItemProps) {
  // Right-click context menu, anchored at the cursor.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // The row is part of a multi-selection → its menu acts on the batch, not on it alone.
  const batch = selected && selectedCount > 1;

  // Drag-to-reorder. The whole row is the drag handle; a small activation
  // distance (set on the sensor) keeps a plain click selecting the file rather
  // than starting a drag.
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id: file.id,
    disabled: dndDisabled,
  });
  // The row stays put while dragging (no transform / live reorder) — a clone in the
  // DragOverlay follows the cursor and a drop line marks the target, like the pane
  // tab strips. Just dim the source.
  const sortStyle: CSSProperties = isDragging ? { opacity: 0.4 } : {};

  useEffect(() => {
    if (!menu) return;
    function down(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest(".file-menu")) setMenu(null);
    }
    function esc(e: KeyboardEvent) {
      if (e.key === "Escape") setMenu(null);
    }
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  return (
    <div
      ref={setNodeRef}
      style={sortStyle}
      className={"file-sortrow" + (isDragging ? " dragging" : "")}
      {...attributes}
      {...listeners}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              className={
                "file-item" +
                (active ? " active" : "") +
                (selected ? " selected" : "") +
                (inPane ? " in-pane" : "")
              }
              onClick={onClick}
              onAuxClick={(e) => {
                // Middle-click closes the row, like a browser / editor tab.
                if (e.button !== 1) return;
                e.preventDefault();
                onDelete();
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY });
              }}
            />
          }
        >
          <span className="file-ico">
            <FileGlyph icon={file.icon} size={16} />
          </span>
          <span className="file-name">{file.name}</span>
          {suffix && (
            <span className="file-dir" title={file.path ?? undefined}>
              {suffix}
            </span>
          )}
          {file.encoding && !/^utf-?8$/i.test(file.encoding) && (
            <span
              className="file-enc"
              title={`Detected encoding: ${file.encoding}`}
            >
              {file.encoding}
            </span>
          )}
          <span className="file-lines">{file.lineCount.toLocaleString()}</span>
          {canDelete && (
            <button
              className="file-x"
              title="Close file"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              <X size={13} />
            </button>
          )}
        </TooltipTrigger>
        <TooltipContent side="right">
          <div className="file-tip">
            <div className="file-tip-name">{file.name}</div>
            {file.path && <div className="file-tip-path">{file.path}</div>}
            <div className="file-tip-meta">
              {file.lineCount.toLocaleString()} lines
              {file.encoding ? ` · ${file.encoding}` : ""}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>

      {menu && (
        <div
          className="menu-pop file-menu"
          style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 200 }}
        >
          <div className="menu-section">Icon</div>
          <div className="file-icon-grid">
            {FILE_ICONS.map(({ id, label, Icon }) => (
              <button
                key={id}
                className={
                  "fi-pick" + ((file.icon ?? "file") === id ? " on" : "")
                }
                title={label}
                onClick={() => {
                  setMenu(null);
                  onSetIcon(id);
                }}
              >
                <Icon size={15} />
              </button>
            ))}
          </div>
          <div className="menu-sep" />
          {/* Every action below acts on the whole selection when this row is part of
              one — the row's own id alone otherwise. */}
          <div className="menu-section">
            {batch ? `Move ${selectedCount} files to group` : "Move to group"}
          </div>
          {groups.map((g) => (
            <div
              key={g.id}
              className={"menu-item" + (file.groupId === g.id ? " on" : "")}
              onClick={() => {
                setMenu(null);
                onMoveToGroup(g.id);
              }}
            >
              <span className="mi-ico">
                <Folder size={14} />
              </span>{" "}
              {g.name}
            </div>
          ))}
          <div
            className="menu-item"
            onClick={() => {
              setMenu(null);
              onNewGroupWith();
            }}
          >
            <span className="mi-ico">
              <FolderPlus size={14} />
            </span>{" "}
            {batch ? `New group with ${selectedCount} files…` : "New group…"}
          </div>
          {(batch || file.groupId != null) && (
            <div
              className="menu-item"
              onClick={() => {
                setMenu(null);
                onMoveToGroup(null);
              }}
            >
              <span className="mi-ico">
                <X size={14} />
              </span>{" "}
              Remove from group
            </div>
          )}
          <div className="menu-sep" />
          {/* Batch close. "Close N selected" only shows for a row that's part of the
              selection — closing from outside it would be a surprise. */}
          {batch && (
            <div
              className="menu-item danger"
              onClick={() => {
                setMenu(null);
                onCloseSelected();
              }}
            >
              <span className="mi-ico">
                <X size={14} />
              </span>{" "}
              Close {selectedCount} selected
            </div>
          )}
          <div
            className="menu-item danger"
            onClick={() => {
              setMenu(null);
              onDelete();
            }}
          >
            <span className="mi-ico">
              <X size={14} />
            </span>{" "}
            Close file
          </div>
        </div>
      )}
    </div>
  );
}

/** A drop target wrapping one container's file rows (its own SortableContext). */
function FileDropZone({
  cid,
  fileIds,
  className,
  children,
}: {
  cid: string;
  fileIds: string[];
  className?: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: CONT(cid) });
  return (
    <div
      ref={setNodeRef}
      className={(className ?? "") + (isOver ? " drop-over" : "")}
    >
      <SortableContext items={fileIds} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </div>
  );
}

interface GroupSectionProps {
  group: FileGroup;
  fileIds: string[];
  collapsed: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onUngroup: () => void;
  /** Close every log in the group (the group itself goes with its last file). */
  onCloseFiles: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  /** While the list is filtered the group is force-expanded, showing only matches. */
  forceOpen: boolean;
  startRenaming: boolean;
  onRenameHandled: () => void;
  children: React.ReactNode;
}

function GroupSection({
  group,
  fileIds,
  collapsed,
  canMoveUp,
  canMoveDown,
  onToggle,
  onRename,
  onUngroup,
  onCloseFiles,
  onMoveUp,
  onMoveDown,
  forceOpen,
  startRenaming,
  onRenameHandled,
  children,
}: GroupSectionProps) {
  const open = forceOpen || !group.collapsed;
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (startRenaming) {
      setEditing(true);
      setDraft(group.name);
      onRenameHandled();
    }
  }, [startRenaming, group.name, onRenameHandled]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!menu) return;
    function down(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest(".fg-menu")) setMenu(false);
    }
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [menu]);

  const commit = () => {
    const n = draft.trim();
    if (n && n !== group.name) onRename(n);
    setEditing(false);
  };

  return (
    <div className="file-group">
      <div className="fg-header">
        <button
          className="fg-chevron"
          title={open ? "Collapse group" : "Expand group"}
          onClick={onToggle}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {editing ? (
          <input
            ref={inputRef}
            className="fg-name-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <span
            className="fg-name"
            title={group.name}
            onDoubleClick={() => {
              setDraft(group.name);
              setEditing(true);
            }}
            onClick={onToggle}
          >
            {group.name}
          </span>
        )}
        <span className="fg-count">{fileIds.length}</span>
        <button
          className="fg-kebab"
          title="Group options"
          onClick={(e) => {
            e.stopPropagation();
            setMenu((v) => !v);
          }}
        >
          <MoreVertical size={14} />
        </button>
        {menu && (
          <div className="menu-pop fg-menu">
            <div
              className="menu-item"
              onClick={() => {
                setMenu(false);
                setDraft(group.name);
                setEditing(true);
              }}
            >
              Rename
            </div>
            {canMoveUp && (
              <div
                className="menu-item"
                onClick={() => {
                  setMenu(false);
                  onMoveUp();
                }}
              >
                Move up
              </div>
            )}
            {canMoveDown && (
              <div
                className="menu-item"
                onClick={() => {
                  setMenu(false);
                  onMoveDown();
                }}
              >
                Move down
              </div>
            )}
            <div className="menu-sep" />
            <div
              className="menu-item"
              onClick={() => {
                setMenu(false);
                onUngroup();
              }}
            >
              Ungroup (keep files)
            </div>
            {fileIds.length > 0 && (
              <div
                className="menu-item danger"
                onClick={() => {
                  setMenu(false);
                  onCloseFiles();
                }}
              >
                Close {fileIds.length} {fileIds.length === 1 ? "log" : "logs"}
              </div>
            )}
          </div>
        )}
      </div>
      <FileDropZone
        cid={group.id}
        fileIds={collapsed || !open ? [] : fileIds}
        className="fg-body"
      >
        {open && children}
      </FileDropZone>
    </div>
  );
}

interface SidebarProps {
  state: AppState;
  collapsed: boolean;
  /** When the center is showing the "open a file" screen, no file is active. */
  openScreen: boolean;
  onToggleCollapse: () => void;
  onSelectFile: (id: string) => void;
  onOpenFile: () => void;
  onDeleteFile: (id: string) => void;
  /** Close several logs behind one confirm (the multi-selection, a group, "close all"). */
  onDeleteFiles: (ids: string[]) => void;
  onSetFileIcon: (id: string, icon: FileIcon) => void;
  /** Opens the Settings dialog (the sidebar row is just its launcher). */
  onOpenSettings: () => void;
  /** While a file row is dragged, its live cursor (CSS px) — lets App light up the
   *  drop indicator (a split pane, or a right/bottom edge that opens a new split).
   *  null on drag end. */
  onFileDragOver?: (pt: { x: number; y: number } | null) => void;
  /** On drop at (x,y) CSS px, let App claim it (open in a pane / edge-split);
   *  returns true when handled, so the sidebar skips its own reorder. */
  onFileDropAt?: (fileId: string, x: number, y: number) => boolean;
}

export function Sidebar({
  state,
  collapsed,
  openScreen,
  onToggleCollapse,
  onSelectFile,
  onOpenFile,
  onDeleteFile,
  onDeleteFiles,
  onSetFileIcon,
  onOpenSettings,
  onFileDragOver,
  onFileDropAt,
}: SidebarProps) {
  const createFileGroup = useStore((s) => s.createFileGroup);
  const renameFileGroup = useStore((s) => s.renameFileGroup);
  const toggleFileGroupCollapsed = useStore((s) => s.toggleFileGroupCollapsed);
  const deleteFileGroup = useStore((s) => s.deleteFileGroup);
  const moveFileToGroup = useStore((s) => s.moveFileToGroup);
  const applyFileLayout = useStore((s) => s.applyFileLayout);

  const groups = state.fileGroups ?? [];
  const fileById = new Map(state.files.map((f) => [f.id, f] as const));
  // VS Code–style suffixes for files that share a basename (derived, not stored).
  const dirSuffixes = disambiguationSuffixes(state.files);

  // Which group header just got created and should open straight into rename.
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);

  // Container map derived from the document (rows never live-reorder during a drag —
  // a drop line marks the target instead, applied on drop).
  const baseMap: ContainerMap = { [UNGROUPED]: [] };
  for (const g of groups) baseMap[g.id] = [];
  for (const f of state.files) {
    const c = f.groupId && baseMap[f.groupId] ? f.groupId : UNGROUPED;
    baseMap[c].push(f.id);
  }
  const [dragId, setDragId] = useState<string | null>(null);
  // The drop target for the insertion line: which container + the file id to draw
  // the line before (null = at the container's end). Set on drag-over, no live
  // reorder — the rows stay put (like the pane tab strips).
  const [dropTarget, setDropTarget] = useState<{
    container: string;
    beforeId: string | null;
  } | null>(null);

  // ---------- filter box ----------
  // Fuzzy-narrows the list by name or path. While it's on, every group is shown
  // expanded (a match must never hide inside a collapsed group) and reordering is
  // off — the order on screen isn't the document's, so a drop would be ambiguous.
  const [query, setQuery] = useState("");
  const filtering = query.trim().length > 0;
  const matchIds = useMemo(() => {
    const q = query.trim();
    if (!q) return null;
    const hits = new Set<string>();
    for (const f of state.files)
      if (fuzzyMatch(q, f.name) || (f.path && substringMatch(q, f.path)))
        hits.add(f.id);
    return hits;
  }, [query, state.files]);

  const map: ContainerMap = matchIds
    ? Object.fromEntries(
        Object.keys(baseMap).map((k) => [
          k,
          baseMap[k].filter((id) => matchIds.has(id)),
        ]),
      )
    : baseMap;
  const matchCount = matchIds ? matchIds.size : state.files.length;
  // Rows top-to-bottom as rendered (groups, then the ungrouped bucket) — the order a
  // Shift-click range walks.
  const visibleOrder = [...groups.flatMap((g) => map[g.id]), ...map[UNGROUPED]];

  // ---------- multi-selection ----------
  // Ctrl-click toggles a row, Shift-click takes the range from the last anchor. The
  // selection is what the batch actions (close, group) operate on; it's independent
  // of the ACTIVE file, which only a plain click moves.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  // Closing a file leaves its id behind — resolve against the live document.
  const selected = useMemo(() => {
    const live = new Set(state.files.map((f) => f.id));
    return new Set(selectedIds.filter((id) => live.has(id)));
  }, [selectedIds, state.files]);

  // Escape drops the selection, like the filter panel's select mode. Ignored inside a
  // text field, so Escape in the filter box still clears the QUERY first.
  useEffect(() => {
    if (!selectedIds.length) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, [contenteditable="true"]')) return;
      setSelectedIds([]);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIds.length]);

  const onRowClick = (e: React.MouseEvent, fid: string) => {
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds((prev) =>
        prev.includes(fid) ? prev.filter((x) => x !== fid) : [...prev, fid],
      );
      setAnchorId(fid);
      return;
    }
    if (e.shiftKey && anchorId) {
      const a = visibleOrder.indexOf(anchorId);
      const b = visibleOrder.indexOf(fid);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelectedIds(visibleOrder.slice(lo, hi + 1));
        return;
      }
    }
    // A plain click is the old behaviour: drop the selection and open the file.
    setSelectedIds([]);
    setAnchorId(fid);
    onSelectFile(fid);
  };

  /** What a row's action applies to: the whole selection when the row is in it. */
  const targetsOf = (fid: string) =>
    selected.has(fid) && selected.size > 1 ? [...selected] : [fid];

  const closeIds = (ids: string[]) => {
    if (!ids.length) return;
    setSelectedIds([]);
    onDeleteFiles(ids);
  };
  const closeSelected = () => closeIds([...selected]);
  const moveToGroup = (fid: string, gid: string | null) => {
    for (const id of targetsOf(fid)) moveFileToGroup(id, gid);
    setSelectedIds([]);
  };
  const newGroupWith = (fid: string) => {
    const gid = createFileGroup();
    for (const id of targetsOf(fid)) moveFileToGroup(id, gid);
    setSelectedIds([]);
    setRenamingGroupId(gid);
  };
  const groupSelected = () => {
    const ids = [...selected];
    if (!ids.length) return;
    const gid = createFileGroup();
    for (const id of ids) moveFileToGroup(id, gid);
    setSelectedIds([]);
    setRenamingGroupId(gid);
  };

  // ---------- pane occupancy ----------
  // Files a split pane is currently SHOWING (its active tab) — the row gets an accent
  // edge, so with the view split you can see at a glance which logs are on screen.
  const shownInPane = new Set(
    (state.splitView?.panes ?? [])
      .map((p) => p.active)
      .filter((id): id is string => !!id),
  );

  // Click vs. drag: a 4px activation distance lets a plain click still select.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  // Prefer the file row the pointer is directly over; when it's only over a
  // container (e.g. the empty area below the last file) return that → drop at end.
  const collisionDetection: CollisionDetection = (args) => {
    const hits = pointerWithin(args);
    const file = hits.find((h) => !String(h.id).startsWith("cont:"));
    return file ? [file] : hits;
  };

  // Track the live cursor during a file-row drag so onDragEnd can tell whether the
  // row was dropped over the log area (a pane / edge-split) vs the sidebar.
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const overLog = useRef(false);
  const pointerCleanup = useRef<(() => void) | null>(null);
  const onDragStart = (e: DragStartEvent) => {
    setDragId(e.active.id as string);
    const move = (ev: PointerEvent) => {
      lastPointer.current = { x: ev.clientX, y: ev.clientY };
      onFileDragOver?.({ x: ev.clientX, y: ev.clientY });
      // Over the log area (a pane / edge-split zone) → App shows the drop hint and
      // the sidebar line is hidden (the drop opens the file there, not a reorder).
      overLog.current = isOverLog(ev.clientX, ev.clientY);
      if (overLog.current) setDropTarget(null);
    };
    window.addEventListener("pointermove", move);
    pointerCleanup.current = () =>
      window.removeEventListener("pointermove", move);
  };

  // Whether a CSS coord is over the log view area (either single pane or a split
  // pane) — rect hit-test, robust against the drag clone under the pointer.
  const isOverLog = (x: number, y: number): boolean => {
    let over = false;
    document.querySelectorAll(".logview").forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
        over = true;
    });
    return over;
  };

  // Compute the insertion line target from the hovered droppable (no live reorder).
  const onDragOver = (e: DragOverEvent) => {
    const { over } = e;
    // Over the log area: App's drop hint shows instead of a sidebar line.
    if (overLog.current) {
      setDropTarget(null);
      return;
    }
    if (!over) {
      setDropTarget(null);
      return;
    }
    const overId = over.id as string;
    if (overId.startsWith("cont:")) {
      setDropTarget({ container: overId.slice(5), beforeId: null });
      return;
    }
    const container = findContainer(overId, baseMap);
    if (!container) {
      setDropTarget(null);
      return;
    }
    // Draw the line before the hovered row.
    setDropTarget({ container, beforeId: overId });
  };

  const endDrag = () => {
    pointerCleanup.current?.();
    pointerCleanup.current = null;
    overLog.current = false;
    onFileDragOver?.(null);
    setDragId(null);
    setDropTarget(null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    const activeId = e.active.id as string;
    const pt = lastPointer.current;
    const dt = dropTarget;
    lastPointer.current = null;
    endDrag();
    // Dropped over the log area → let App open it in a pane / edge-split.
    if (pt && onFileDropAt && onFileDropAt(activeId, pt.x, pt.y)) return;
    if (!dt || dt.beforeId === activeId) return; // no target / dropped on own slot
    const from = findContainer(activeId, baseMap);
    if (!from) return;
    // Rebuild the layout: pull the file out of its container, insert into the
    // target container before `beforeId` (or at the end).
    const next: ContainerMap = {};
    for (const k of Object.keys(baseMap)) next[k] = [...baseMap[k]];
    next[from].splice(next[from].indexOf(activeId), 1);
    const toArr = next[dt.container];
    let idx = dt.beforeId ? toArr.indexOf(dt.beforeId) : toArr.length;
    if (idx < 0) idx = toArr.length;
    toArr.splice(idx, 0, activeId);
    applyFileLayout(
      next,
      groups.map((g) => g.id),
    );
  };

  const renderFile = (fid: string) => {
    const f = fileById.get(fid);
    if (!f) return null;
    return (
      <FileItem
        key={f.id}
        file={f}
        active={!openScreen && f.id === state.activeFileId}
        canDelete={true}
        selected={selected.has(f.id)}
        inPane={!openScreen && shownInPane.has(f.id)}
        dndDisabled={filtering}
        suffix={dirSuffixes[f.id]}
        groups={groups}
        onClick={(e) => onRowClick(e, f.id)}
        onDelete={() => onDeleteFile(f.id)}
        onSetIcon={(icon) => onSetFileIcon(f.id, icon)}
        onMoveToGroup={(gid) => moveToGroup(f.id, gid)}
        onNewGroupWith={() => newGroupWith(f.id)}
        selectedCount={selected.size}
        onCloseSelected={closeSelected}
      />
    );
  };

  // Render a container's file rows with the drop line inserted at the target slot
  // (no drop line while filtering — reordering is off).
  const renderFiles = (fileIds: string[], cid: string): React.ReactNode[] => {
    const line = (key: string) => (
      <div key={key} className="file-drop-line" aria-hidden />
    );
    const out: React.ReactNode[] = [];
    for (const fid of fileIds) {
      if (
        !filtering &&
        dropTarget?.container === cid &&
        dropTarget.beforeId === fid
      )
        out.push(line("dl-" + fid));
      out.push(renderFile(fid));
    }
    if (
      !filtering &&
      dropTarget?.container === cid &&
      dropTarget.beforeId === null
    )
      out.push(line("dl-end"));
    return out;
  };

  const dragFile = dragId ? fileById.get(dragId) : null;

  return (
    <div className={"sidebar" + (collapsed ? " collapsed" : "")}>
      <div className="sidebar-top">
        <Button
          variant="ghost"
          size="icon"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={onToggleCollapse}
        >
          <PanelLeft size={18} />
        </Button>
      </div>

      {/* Filter box + selection bar sit ABOVE the scroll box, so they stay put while
          the list scrolls. Both are meaningless in the icon-only rail. */}
      {!collapsed && state.files.length > 0 && (
        <div className="file-filter">
          <Search size={13} className="ff-ico" />
          <input
            className="ff-input"
            placeholder="Filter files…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setQuery("");
              }
            }}
          />
          {filtering && (
            <>
              <span className="ff-count">{matchCount}</span>
              <button
                className="ff-x"
                title="Clear filter"
                onClick={() => setQuery("")}
              >
                <X size={13} />
              </button>
            </>
          )}
        </div>
      )}

      {!collapsed && (selected.size > 0 || filtering) && (
        <div className="file-selbar">
          {selected.size > 0 ? (
            <>
              <span className="fs-count">{selected.size} selected</span>
              <button className="fs-btn" onClick={groupSelected}>
                Group
              </button>
              <button className="fs-btn danger" onClick={closeSelected}>
                Close
              </button>
              <button className="fs-btn" onClick={() => setSelectedIds([])}>
                Clear
              </button>
            </>
          ) : (
            <>
              <span className="fs-count">
                {matchCount} {matchCount === 1 ? "match" : "matches"}
              </span>
              <button
                className="fs-btn"
                disabled={!matchCount}
                onClick={() => setSelectedIds(visibleOrder)}
              >
                Select all
              </button>
            </>
          )}
        </div>
      )}

      {/* Clicking the empty space around the rows drops the selection (a file explorer's
          "click away to deselect"). Rows, group headers and the row menus handle their
          own clicks, so they're excluded. */}
      <div
        className="file-list scroll"
        onClick={(e) => {
          if (!selectedIds.length) return;
          const t = e.target as HTMLElement;
          if (t.closest(".file-item, .fg-header, .menu-pop, .new-tab")) return;
          setSelectedIds([]);
        }}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          // No axis lock: the drag clone follows the cursor freely so a file can be
          // dragged out of the sidebar onto either split pane (matches the pane tabs).
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={endDrag}
        >
          {/* Groups first (like a file explorer's folders), then the loose
              ungrouped files below them. A group with no match drops out of a
              filtered list entirely. */}
          {groups.map((g, i) =>
            filtering && !map[g.id].length ? null : (
              <GroupSection
                key={g.id}
                group={g}
                fileIds={map[g.id]}
                collapsed={collapsed}
                canMoveUp={i > 0}
                canMoveDown={i < groups.length - 1}
                onToggle={() => toggleFileGroupCollapsed(g.id)}
                onRename={(name) => renameFileGroup(g.id, name)}
                onUngroup={() => deleteFileGroup(g.id)}
                onCloseFiles={() => closeIds(baseMap[g.id])}
                // The layout must always be rebuilt from the FULL map — `map` is the
                // filtered view, and passing it would drop every unmatched file.
                onMoveUp={() =>
                  applyFileLayout(
                    baseMap,
                    arrayMove(
                      groups.map((x) => x.id),
                      i,
                      i - 1,
                    ),
                  )
                }
                onMoveDown={() =>
                  applyFileLayout(
                    baseMap,
                    arrayMove(
                      groups.map((x) => x.id),
                      i,
                      i + 1,
                    ),
                  )
                }
                forceOpen={filtering}
                startRenaming={renamingGroupId === g.id}
                onRenameHandled={() => setRenamingGroupId(null)}
              >
                {renderFiles(map[g.id], g.id)}
              </GroupSection>
            ),
          )}

          <FileDropZone
            cid={UNGROUPED}
            fileIds={map[UNGROUPED]}
            className="fg-ungrouped"
          >
            {renderFiles(map[UNGROUPED], UNGROUPED)}
          </FileDropZone>

          <DragOverlay dropAnimation={null}>
            {dragFile ? (
              <div className="file-item drag-ghost">
                <span className="file-ico">
                  <FileGlyph icon={dragFile.icon} size={16} />
                </span>
                <span className="file-name">{dragFile.name}</span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>

        <div className="sidebar-actions">
          <div
            className="new-tab"
            onClick={() => setRenamingGroupId(createFileGroup())}
            title="Create a file group"
          >
            <FolderPlus size={16} />
            <span>New Group</span>
          </div>
          <div
            className="new-tab"
            onClick={onOpenFile}
            title="Open a log file (Ctrl O)"
          >
            <FilePlus size={16} />
            <span>Open File</span>
          </div>
        </div>
      </div>
      <div className="sidebar-bottom">
        <div
          className="settings-row"
          role="button"
          tabIndex={0}
          title="Settings"
          onClick={onOpenSettings}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") onOpenSettings();
          }}
        >
          <Settings size={16} />
          <span>Settings</span>
          {!collapsed && <span className="gear" />}
        </div>
      </div>
    </div>
  );
}
