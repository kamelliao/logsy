import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  FolderPlus,
  MoreVertical,
  PanelLeft,
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
  /** Parent-dir suffix disambiguating same-named files (VS Code style); dim. */
  suffix?: string;
  groups: FileGroup[];
  onSelect: () => void;
  onDelete: () => void;
  onSetIcon: (icon: FileIcon) => void;
  onMoveToGroup: (groupId: string | null) => void;
  onNewGroupWith: () => void;
}

function FileItem({
  file,
  active,
  canDelete,
  suffix,
  groups,
  onSelect,
  onDelete,
  onSetIcon,
  onMoveToGroup,
  onNewGroupWith,
}: FileItemProps) {
  // Right-click context menu, anchored at the cursor.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  // Drag-to-reorder. The whole row is the drag handle; a small activation
  // distance (set on the sensor) keeps a plain click selecting the file rather
  // than starting a drag.
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id: file.id,
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
              className={"file-item" + (active ? " active" : "")}
              onClick={onSelect}
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
          <div className="menu-section">Move to group</div>
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
                <FolderPlus size={14} />
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
            New group…
          </div>
          {file.groupId != null && (
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
  onMoveUp: () => void;
  onMoveDown: () => void;
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
  onMoveUp,
  onMoveDown,
  startRenaming,
  onRenameHandled,
  children,
}: GroupSectionProps) {
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
          title={group.collapsed ? "Expand group" : "Collapse group"}
          onClick={onToggle}
        >
          {group.collapsed ? (
            <ChevronRight size={14} />
          ) : (
            <ChevronDown size={14} />
          )}
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
          </div>
        )}
      </div>
      <FileDropZone
        cid={group.id}
        fileIds={collapsed || group.collapsed ? [] : fileIds}
        className="fg-body"
      >
        {!group.collapsed && children}
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
  const map = baseMap;

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
        suffix={dirSuffixes[f.id]}
        groups={groups}
        onSelect={() => onSelectFile(f.id)}
        onDelete={() => onDeleteFile(f.id)}
        onSetIcon={(icon) => onSetFileIcon(f.id, icon)}
        onMoveToGroup={(gid) => moveFileToGroup(f.id, gid)}
        onNewGroupWith={() => {
          const gid = createFileGroup();
          moveFileToGroup(f.id, gid);
        }}
      />
    );
  };

  // Render a container's file rows with the drop line inserted at the target slot.
  const renderFiles = (fileIds: string[], cid: string): React.ReactNode[] => {
    const line = (key: string) => (
      <div key={key} className="file-drop-line" aria-hidden />
    );
    const out: React.ReactNode[] = [];
    for (const fid of fileIds) {
      if (dropTarget?.container === cid && dropTarget.beforeId === fid)
        out.push(line("dl-" + fid));
      out.push(renderFile(fid));
    }
    if (dropTarget?.container === cid && dropTarget.beforeId === null)
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
      <div className="file-list scroll">
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
              ungrouped files below them. */}
          {groups.map((g, i) => (
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
              onMoveUp={() =>
                applyFileLayout(
                  map,
                  arrayMove(
                    groups.map((x) => x.id),
                    i,
                    i - 1,
                  ),
                )
              }
              onMoveDown={() =>
                applyFileLayout(
                  map,
                  arrayMove(
                    groups.map((x) => x.id),
                    i,
                    i + 1,
                  ),
                )
              }
              startRenaming={renamingGroupId === g.id}
              onRenameHandled={() => setRenamingGroupId(null)}
            >
              {renderFiles(map[g.id], g.id)}
            </GroupSection>
          ))}

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
