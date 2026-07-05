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
  closestCorners,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
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
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import type {
  AppState,
  FileGroup,
  FileIcon,
  LogFile,
  FilterLabelMode,
} from "@/types";
import { FILE_ICONS, FileGlyph } from "@/components/widgets/fileIcons";
import { Button } from "@/components/ui/button";
import { useStore } from "@/store";
import { UNGROUPED } from "@/store/slices/fileGroupSlice";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: file.id });
  const sortStyle: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging ? { position: "relative", zIndex: 5, opacity: 0.4 } : {}),
  };

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
  onSetPanelPos: (pos: "bottom" | "right") => void;
  onSetMapColorMode: (mode: "bg" | "text") => void;
  onSetMapWidth: (w: number) => void;
  onSetFontWeight: (w: number) => void;
  onSetTimelineIconSize: (sz: "S" | "M" | "L") => void;
  onSetFilterLabel: (mode: FilterLabelMode) => void;
  onManagePalette: () => void;
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
  onSetPanelPos,
  onSetMapColorMode,
  onSetMapWidth,
  onSetFontWeight,
  onSetTimelineIconSize,
  onSetFilterLabel,
  onManagePalette,
}: SidebarProps) {
  const createFileGroup = useStore((s) => s.createFileGroup);
  const renameFileGroup = useStore((s) => s.renameFileGroup);
  const toggleFileGroupCollapsed = useStore((s) => s.toggleFileGroupCollapsed);
  const deleteFileGroup = useStore((s) => s.deleteFileGroup);
  const moveFileToGroup = useStore((s) => s.moveFileToGroup);
  const applyFileLayout = useStore((s) => s.applyFileLayout);

  const groups = state.fileGroups ?? [];
  const fileById = new Map(state.files.map((f) => [f.id, f] as const));

  // Which group header just got created and should open straight into rename.
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);

  // Base container map derived from the document; the live drag overlay overrides
  // it while a file is being dragged so rows shift between groups in real time.
  const baseMap: ContainerMap = { [UNGROUPED]: [] };
  for (const g of groups) baseMap[g.id] = [];
  for (const f of state.files) {
    const c = f.groupId && baseMap[f.groupId] ? f.groupId : UNGROUPED;
    baseMap[c].push(f.id);
  }
  const [overlay, setOverlay] = useState<ContainerMap | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const map = overlay ?? baseMap;

  // Click vs. drag: a 4px activation distance lets a plain click still select.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const onDragStart = (e: DragStartEvent) => {
    setDragId(e.active.id as string);
    setOverlay(structuredClone(baseMap));
  };

  const onDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (!over) return;
    const activeId = active.id as string;
    const overId = over.id as string;
    const cur = overlay ?? baseMap;
    const from = findContainer(activeId, cur);
    const to = overId.startsWith("cont:")
      ? overId.slice(5)
      : findContainer(overId, cur);
    if (!from || !to || from === to) return;
    setOverlay(() => {
      const next: ContainerMap = {};
      for (const k of Object.keys(cur)) next[k] = [...cur[k]];
      const fromItems = next[from];
      const overItems = next[to];
      fromItems.splice(fromItems.indexOf(activeId), 1);
      const overIndex = overId.startsWith("cont:")
        ? overItems.length
        : overItems.indexOf(overId);
      overItems.splice(
        overIndex < 0 ? overItems.length : overIndex,
        0,
        activeId,
      );
      return next;
    });
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    const cur = overlay ?? baseMap;
    if (over) {
      const activeId = active.id as string;
      const overId = over.id as string;
      const from = findContainer(activeId, cur);
      const to = overId.startsWith("cont:")
        ? overId.slice(5)
        : findContainer(overId, cur);
      if (from && to && from === to) {
        const items = cur[to];
        const oldIndex = items.indexOf(activeId);
        const newIndex = overId.startsWith("cont:")
          ? items.length - 1
          : items.indexOf(overId);
        if (oldIndex >= 0 && newIndex >= 0 && oldIndex !== newIndex)
          cur[to] = arrayMove(items, oldIndex, newIndex);
      }
    }
    applyFileLayout(
      cur,
      groups.map((g) => g.id),
    );
    setDragId(null);
    setOverlay(null);
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
          collisionDetection={closestCorners}
          modifiers={[restrictToVerticalAxis]}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={() => {
            setDragId(null);
            setOverlay(null);
          }}
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
              {map[g.id].map(renderFile)}
            </GroupSection>
          ))}

          <FileDropZone
            cid={UNGROUPED}
            fileIds={map[UNGROUPED]}
            className="fg-ungrouped"
          >
            {map[UNGROUPED].map(renderFile)}
          </FileDropZone>

          <DragOverlay>
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
        <Popover>
          <PopoverTrigger
            nativeButton={false}
            render={
              <div className="settings-row" role="button">
                <Settings size={16} />
                <span>Settings</span>
                {!collapsed && <span className="gear" />}
              </div>
            }
          />
          <PopoverContent>
            <div
              style={{ fontWeight: 600, fontSize: 13, padding: "2px 4px 6px" }}
            >
              Settings
            </div>
            <div className="sp-row">
              Filter panel
              <div className="seg" style={{ marginLeft: 8 }}>
                <button
                  className={
                    (state.panelPos ?? "bottom") === "bottom" ? "on" : ""
                  }
                  onClick={() => onSetPanelPos("bottom")}
                >
                  Bottom
                </button>
                <button
                  className={
                    (state.panelPos ?? "bottom") === "right" ? "on" : ""
                  }
                  onClick={() => onSetPanelPos("right")}
                >
                  Right
                </button>
              </div>
            </div>
            <div className="sp-row">
              Theme
              <span style={{ color: "var(--text-3)" }}>Light</span>
            </div>
            <div className="sp-row">
              Match map color
              <div className="seg" style={{ marginLeft: 8 }}>
                <button
                  className={(state.mapColorMode ?? "bg") === "bg" ? "on" : ""}
                  onClick={() => onSetMapColorMode("bg")}
                >
                  BG
                </button>
                <button
                  className={
                    (state.mapColorMode ?? "bg") === "text" ? "on" : ""
                  }
                  onClick={() => onSetMapColorMode("text")}
                >
                  Text
                </button>
              </div>
            </div>
            <div className="sp-row">
              Match map width
              <div className="seg" style={{ marginLeft: 8 }}>
                {[
                  { label: "S", value: 12 },
                  { label: "M", value: 16 },
                  { label: "L", value: 20 },
                ].map(({ label, value }) => (
                  <button
                    key={label}
                    className={(state.mapWidth ?? 20) === value ? "on" : ""}
                    onClick={() => onSetMapWidth(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="sp-row">
              Log font weight
              <div className="seg" style={{ marginLeft: 8 }}>
                {[
                  { label: "Light", value: 300 },
                  { label: "Regular", value: 400 },
                  { label: "Medium", value: 500 },
                ].map(({ label, value }) => (
                  <button
                    key={label}
                    className={(state.fontWeight ?? 400) === value ? "on" : ""}
                    onClick={() => onSetFontWeight(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="sp-row">
              Timeline icon size
              <div className="seg" style={{ marginLeft: 8 }}>
                {(["S", "M", "L"] as const).map((sz) => (
                  <button
                    key={sz}
                    className={
                      (state.timelineIconSize ?? "M") === sz ? "on" : ""
                    }
                    onClick={() => onSetTimelineIconSize(sz)}
                  >
                    {sz}
                  </button>
                ))}
              </div>
            </div>
            <div
              className="sp-row"
              style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}
            >
              Filter row label
              <div className="seg" style={{ alignSelf: "stretch" }}>
                {(
                  [
                    { label: "Pattern", value: "pattern" },
                    { label: "Description", value: "description" },
                    { label: "Auto", value: "desc-first" },
                  ] as const
                ).map(({ label, value }) => (
                  <button
                    key={value}
                    style={{ flex: 1, justifyContent: "center" }}
                    title={
                      value === "pattern"
                        ? "Always show the regex pattern"
                        : value === "description"
                          ? "Always show the description"
                          : "Show the description if set, otherwise the pattern"
                    }
                    className={
                      (state.filterLabel ?? "desc-first") === value ? "on" : ""
                    }
                    onClick={() => onSetFilterLabel(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="sp-sep" />
            <div
              className="sp-row sp-row-link"
              onClick={onManagePalette}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onManagePalette();
              }}
            >
              Color palette
              <ChevronRight size={14} style={{ color: "var(--text-3)" }} />
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
