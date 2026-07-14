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

/**
 * One stop of the keyboard walk over the list, in render order: the group headers and
 * the file rows of every OPEN group, then the ungrouped files. Arrow keys move between
 * these; `key` is what a row carries as `data-nav` and what `focusKey` holds.
 */
type Nav = { kind: "file" | "group"; id: string };
const navKey = (n: Nav) => (n.kind === "group" ? "grp:" + n.id : n.id);

interface FileItemProps {
  file: LogFile;
  active: boolean;
  canDelete: boolean;
  /** In the sidebar's multi-selection (Ctrl/Shift-click), which the batch acts on. */
  selected: boolean;
  /** Currently displayed in some split pane — the row gets an accent edge. */
  inPane: boolean;
  /** Part of a multi-row drag but not the row under the cursor — dim it like the source. */
  dimmed: boolean;
  /** The list's single tab stop (roving tabindex); arrow keys move it from row to row. */
  tabbable: boolean;
  /** 2 inside a group, 1 for a loose file — for `aria-level`. */
  level: number;
  /** Parent-dir suffix disambiguating same-named files (VS Code style); dim. */
  suffix?: string;
  groups: FileGroup[];
  /** Click with its modifiers — the sidebar turns it into select / toggle / range. */
  onClick: (e: React.MouseEvent) => void;
  /** However the row got focus (click, Tab, arrow key), the keyboard follows it here. */
  onFocus: () => void;
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
  dimmed,
  tabbable,
  level,
  suffix,
  groups,
  onClick,
  onFocus,
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
  });
  // dnd-kit's attributes make the drag handle a tab stop of its own — drop that: the
  // row's keyboard entry point is the `.file-item` below (one roving tab stop for the
  // whole list), and two focusable boxes per row would double every Tab press.
  const { role: _role, tabIndex: _tabIndex, ...dragAttrs } = attributes;
  // The row stays put while dragging (no transform / live reorder) — a clone in the
  // DragOverlay follows the cursor and a drop line marks the target, like the pane
  // tab strips. Just dim the source (and the rest of the batch, when several move).
  const sortStyle: CSSProperties = isDragging || dimmed ? { opacity: 0.4 } : {};

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
      {...dragAttrs}
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
              // Keyboard: the list is a tree with one tab stop; the arrow keys in
              // Sidebar's onListKeyDown move it (and focus) between the rows.
              role="treeitem"
              aria-level={level}
              aria-selected={selected}
              tabIndex={tabbable ? 0 : -1}
              data-nav={file.id}
              onFocus={onFocus}
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
            <FileGlyph icon={file.icon} size={14} />
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
  role,
  disabled,
  children,
}: {
  cid: string;
  fileIds: string[];
  className?: string;
  role?: string;
  /** A collapsed group has no body to drop into — its HEADER takes the drop instead,
   *  so the (empty) body must not register the same droppable id twice. */
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: CONT(cid), disabled });
  return (
    <div
      ref={setNodeRef}
      role={role}
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
  /** The list's single tab stop (roving tabindex) currently sits on this header. */
  tabbable: boolean;
  /** However the header got focus (click, Tab, arrow key), the keyboard follows it. */
  onFocus: () => void;
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
  tabbable,
  onFocus,
  startRenaming,
  onRenameHandled,
  children,
}: GroupSectionProps) {
  const open = !group.collapsed;
  // Options menu, anchored at the cursor (right-click) or under the kebab.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.name);
  const inputRef = useRef<HTMLInputElement>(null);
  // While the group is folded shut its body is gone, so the header stands in as the
  // drop target — a file can be filed away into a collapsed group without opening it.
  const { setNodeRef: setHeaderDropRef, isOver: headerOver } = useDroppable({
    id: CONT(group.id),
    disabled: open,
  });

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
      if (!(e.target as HTMLElement).closest(".fg-menu")) setMenu(null);
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

  const commit = () => {
    const n = draft.trim();
    if (n && n !== group.name) onRename(n);
    setEditing(false);
  };

  return (
    <div className="file-group">
      {/* A tree row like the files below it: one roving tab stop, arrow keys handled
          by the list (→ / ← expand and collapse, Enter toggles). The buttons inside
          are taken out of the tab order so the header stays a single stop. */}
      <div
        ref={setHeaderDropRef}
        className={"fg-header" + (headerOver ? " drop-over" : "")}
        role="treeitem"
        aria-level={1}
        aria-expanded={open}
        tabIndex={tabbable ? 0 : -1}
        data-nav={"grp:" + group.id}
        onFocus={onFocus}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <button
          className="fg-chevron"
          title={open ? "Collapse group" : "Expand group"}
          tabIndex={-1}
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
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            if (menu) {
              setMenu(null);
              return;
            }
            // Under the kebab, right-aligned with it (168px = `.menu-pop`'s min-width)
            // — the same menu a right-click on the header opens at the cursor.
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.right - 168, y: r.bottom + 2 });
          }}
        >
          <MoreVertical size={14} />
        </button>
        {menu && (
          <div
            className="menu-pop fg-menu"
            style={{ left: menu.x, top: menu.y }}
          >
            <div
              className="menu-item"
              onClick={() => {
                setMenu(null);
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
                  setMenu(null);
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
                  setMenu(null);
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
                setMenu(null);
                onUngroup();
              }}
            >
              Ungroup (keep files)
            </div>
            {fileIds.length > 0 && (
              <div
                className="menu-item danger"
                onClick={() => {
                  setMenu(null);
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
        role="group"
        disabled={!open}
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
  /** On drop at (x,y) CSS px, let App claim the dragged files (open in a pane /
   *  edge-split); returns true when handled, so the sidebar skips its own reorder.
   *  `fileIds` is the whole multi-selection when the dragged row was part of one. */
  onFileDropAt?: (fileIds: string[], x: number, y: number) => boolean;
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
  // Every file the drag carries: the whole multi-selection when the grabbed row was
  // part of one (the row menu's batch actions work that way too), else just that row.
  const [dragIds, setDragIds] = useState<string[]>([]);
  // The drop target for the insertion line: which container + the file id to draw
  // the line before (null = at the container's end). Set on drag-over, no live
  // reorder — the rows stay put (like the pane tab strips).
  const [dropTarget, setDropTarget] = useState<{
    container: string;
    beforeId: string | null;
  } | null>(null);

  // Every file, in the order the document holds them (groups first, then the loose
  // ones) — a multi-row drag carries its files in this order.
  const docOrder = [
    ...groups.flatMap((g) => baseMap[g.id]),
    ...baseMap[UNGROUPED],
  ];
  // The subset of those actually on screen: a collapsed group's files are not. This is
  // what a Shift range and Ctrl+A walk — neither may reach a row you can't see.
  const visibleOrder = [
    ...groups.flatMap((g) => (g.collapsed ? [] : baseMap[g.id])),
    ...baseMap[UNGROUPED],
  ];

  // ---------- keyboard walk ----------
  // Everything the arrow keys can land on, in render order: a group header, then its
  // files when it's open, and the loose files last. Files inside a collapsed group are
  // NOT here — they're off screen, and focus must never leave for a row you can't see.
  const navOrder: Nav[] = [];
  for (const g of groups) {
    navOrder.push({ kind: "group", id: g.id });
    if (!g.collapsed)
      for (const fid of baseMap[g.id]) navOrder.push({ kind: "file", id: fid });
  }
  for (const fid of baseMap[UNGROUPED])
    navOrder.push({ kind: "file", id: fid });

  // The row (or header) the keyboard is on. It's also the list's only tab stop — a
  // roving tabindex, so Tab enters the list once and the arrows do the rest. When it
  // points at nothing (nothing focused yet, row closed) the first row takes the stop.
  const listRef = useRef<HTMLDivElement>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const rovingKey = navOrder.some((n) => navKey(n) === focusKey)
    ? focusKey
    : navOrder.length
      ? navKey(navOrder[0])
      : null;
  // Only a keyboard move pulls DOM focus. A click already focuses the row it hit, and
  // stealing focus on every re-render would fight the group rename input.
  const pendingFocus = useRef(false);
  const moveFocus = (key: string | null) => {
    pendingFocus.current = key != null;
    setFocusKey(key);
  };
  useEffect(() => {
    if (!pendingFocus.current || !focusKey) return;
    pendingFocus.current = false;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-nav="${CSS.escape(focusKey)}"]`,
    );
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  }, [focusKey]);

  // ---------- multi-selection ----------
  // A plain click selects the clicked row (and opens it); Ctrl-click toggles a row and
  // Shift-click takes the range from the last anchor, so a selection can grow past one
  // file. The selection is what the row menu's batch actions (close, group) act on.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  // Closing a file leaves its id behind — resolve against the live document.
  const selected = useMemo(() => {
    const live = new Set(state.files.map((f) => f.id));
    return new Set(selectedIds.filter((id) => live.has(id)));
  }, [selectedIds, state.files]);

  // Escape drops the selection, like the filter panel's select mode. Ignored inside a
  // text field (a group's rename box gets its own Escape).
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

  /** Grow the selection from the anchor to `fid` — a Shift-click, or Shift+Arrow. */
  const extendTo = (fid: string) => {
    const from = anchorId && visibleOrder.includes(anchorId) ? anchorId : fid;
    const a = visibleOrder.indexOf(from);
    const b = visibleOrder.indexOf(fid);
    if (a < 0 || b < 0) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    setSelectedIds(visibleOrder.slice(lo, hi + 1));
    setAnchorId(from);
  };

  /** Open a file and make it the (single-row) selection — a plain click, or Enter. */
  const openRow = (fid: string) => {
    setSelectedIds([fid]);
    setAnchorId(fid);
    onSelectFile(fid);
  };

  const onRowClick = (e: React.MouseEvent, fid: string) => {
    // (The click already focused the row, and its onFocus put the keyboard there.)
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds((prev) =>
        prev.includes(fid) ? prev.filter((x) => x !== fid) : [...prev, fid],
      );
      setAnchorId(fid);
      return;
    }
    if (e.shiftKey && anchorId) {
      extendTo(fid);
      return;
    }
    // A plain click opens the file AND makes it the (single-row) selection — clicking
    // a row is already "selecting" it; Ctrl/Shift-click is only needed to extend that
    // selection to more files.
    openRow(fid);
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

  // ---------- keyboard ----------
  // One handler for the whole list (the rows bubble to it). Tree keys: ↑/↓ walk the
  // rows, ←/→ collapse and expand a group (and ← from a file jumps up to its header),
  // Enter opens, Delete closes, Shift+↑/↓ grows the selection, Ctrl+A takes all.
  const onListKeyDown = (e: React.KeyboardEvent) => {
    // Never swallow keys meant for the group's rename box.
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, [contenteditable="true"]')) return;
    if (!navOrder.length) return;

    const at = navOrder.findIndex((n) => navKey(n) === focusKey);
    const cur = at >= 0 ? navOrder[at] : null;
    const groupOf = (fid: string) => fileById.get(fid)?.groupId ?? null;
    const isOpen = (gid: string) =>
      !groups.find((g) => g.id === gid)?.collapsed;

    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        // Nothing focused yet: the first (or last) row takes it.
        const next =
          at < 0
            ? navOrder[step > 0 ? 0 : navOrder.length - 1]
            : navOrder[Math.min(Math.max(at + step, 0), navOrder.length - 1)];
        if (!next || navKey(next) === focusKey) return;
        // Shift extends the selection as it goes — but only over files; stepping across
        // a group header just moves through it.
        if (e.shiftKey && next.kind === "file") extendTo(next.id);
        moveFocus(navKey(next));
        return;
      }
      case "Home":
      case "End": {
        e.preventDefault();
        moveFocus(navKey(navOrder[e.key === "Home" ? 0 : navOrder.length - 1]));
        return;
      }
      case "ArrowRight": {
        if (cur?.kind !== "group") return;
        e.preventDefault();
        // Closed → open it. Already open → step into its first file.
        if (!isOpen(cur.id)) toggleFileGroupCollapsed(cur.id);
        else if (baseMap[cur.id].length) moveFocus(baseMap[cur.id][0]);
        return;
      }
      case "ArrowLeft": {
        if (!cur) return;
        e.preventDefault();
        if (cur.kind === "group") {
          if (isOpen(cur.id)) toggleFileGroupCollapsed(cur.id);
          return;
        }
        // From a file: up to the group that holds it (a loose file has none).
        const gid = groupOf(cur.id);
        if (gid) moveFocus("grp:" + gid);
        return;
      }
      case "Enter":
      case " ": {
        if (!cur) return;
        e.preventDefault();
        if (cur.kind === "group") toggleFileGroupCollapsed(cur.id);
        else openRow(cur.id);
        return;
      }
      case "Delete":
      case "Backspace": {
        if (cur?.kind !== "file") return;
        e.preventDefault();
        // Closes the whole selection when the focused row is part of one, like the
        // row menu does. Focus lands on the nearest row that survives.
        const doomed = new Set(targetsOf(cur.id));
        const alive = (n: Nav) => n.kind !== "file" || !doomed.has(n.id);
        const next =
          navOrder.slice(at + 1).find(alive) ??
          navOrder.slice(0, at).reverse().find(alive) ??
          null;
        closeIds([...doomed]);
        moveFocus(next && navKey(next));
        return;
      }
      case "a":
      case "A": {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        setSelectedIds(visibleOrder);
        return;
      }
    }
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
    const id = e.active.id as string;
    setDragId(id);
    // Grabbing a row that's in the selection drags the whole selection, in the order
    // the rows are shown (so they land in the target in the order you see them).
    setDragIds(
      selected.has(id) && selected.size > 1
        ? docOrder.filter((f) => selected.has(f))
        : [id],
    );
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
    setDragIds([]);
    setDropTarget(null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    const activeId = e.active.id as string;
    const ids = dragIds.length ? dragIds : [activeId];
    const pt = lastPointer.current;
    const dt = dropTarget;
    lastPointer.current = null;
    endDrag();
    // Dropped over the log area → let App open them in a pane / edge-split.
    if (pt && onFileDropAt && onFileDropAt(ids, pt.x, pt.y)) return;
    if (!dt) return;

    // Rebuild the layout: pull every dragged file out of wherever it sits, then insert
    // the batch into the target container at the drop line.
    const moving = new Set(ids);
    // The line is drawn before `beforeId` — but that row may itself be on the move, so
    // anchor on the first row at or after it that stays put (none → append at the end).
    let anchor: string | null = null;
    if (dt.beforeId) {
      const arr = baseMap[dt.container];
      for (let i = Math.max(arr.indexOf(dt.beforeId), 0); i < arr.length; i++)
        if (!moving.has(arr[i])) {
          anchor = arr[i];
          break;
        }
    }
    const next: ContainerMap = {};
    for (const k of Object.keys(baseMap))
      next[k] = baseMap[k].filter((id) => !moving.has(id));
    const toArr = next[dt.container];
    const idx = anchor ? toArr.indexOf(anchor) : toArr.length;
    toArr.splice(idx < 0 ? toArr.length : idx, 0, ...ids);

    // Dropped back where it already was — don't churn the document.
    const unchanged = Object.keys(baseMap).every(
      (k) =>
        next[k].length === baseMap[k].length &&
        next[k].every((id, i) => baseMap[k][i] === id),
    );
    if (unchanged) return;
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
        dimmed={dragIds.length > 1 && dragIds.includes(f.id)}
        tabbable={rovingKey === f.id}
        level={f.groupId ? 2 : 1}
        suffix={dirSuffixes[f.id]}
        groups={groups}
        onClick={(e) => onRowClick(e, f.id)}
        onFocus={() => setFocusKey(f.id)}
        onDelete={() => onDeleteFile(f.id)}
        onSetIcon={(icon) => onSetFileIcon(f.id, icon)}
        onMoveToGroup={(gid) => moveToGroup(f.id, gid)}
        onNewGroupWith={() => newGroupWith(f.id)}
        selectedCount={selected.size}
        onCloseSelected={closeSelected}
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

      {/* Clicking the empty space around the rows drops the selection (a file explorer's
          "click away to deselect"). Rows, group headers and the row menus handle their
          own clicks, so they're excluded. */}
      <div
        ref={listRef}
        className="file-list scroll"
        role="tree"
        aria-label="Open logs"
        aria-multiselectable
        onKeyDown={onListKeyDown}
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
              ungrouped files below them. */}
          {groups.map((g, i) => (
            <GroupSection
              key={g.id}
              group={g}
              fileIds={baseMap[g.id]}
              collapsed={collapsed}
              canMoveUp={i > 0}
              canMoveDown={i < groups.length - 1}
              onToggle={() => toggleFileGroupCollapsed(g.id)}
              onRename={(name) => renameFileGroup(g.id, name)}
              onUngroup={() => deleteFileGroup(g.id)}
              onCloseFiles={() => closeIds(baseMap[g.id])}
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
              tabbable={rovingKey === "grp:" + g.id}
              onFocus={() => setFocusKey("grp:" + g.id)}
              startRenaming={renamingGroupId === g.id}
              onRenameHandled={() => setRenamingGroupId(null)}
            >
              {renderFiles(baseMap[g.id], g.id)}
            </GroupSection>
          ))}

          <FileDropZone
            cid={UNGROUPED}
            fileIds={baseMap[UNGROUPED]}
            className="fg-ungrouped"
          >
            {renderFiles(baseMap[UNGROUPED], UNGROUPED)}
          </FileDropZone>

          <DragOverlay dropAnimation={null}>
            {dragFile ? (
              <div className="file-item drag-ghost">
                <span className="file-ico">
                  <FileGlyph icon={dragFile.icon} size={14} />
                </span>
                <span className="file-name">{dragFile.name}</span>
                {/* Dragging a whole selection: the clone says how many come along. */}
                {dragIds.length > 1 && (
                  <span className="drag-count">{dragIds.length}</span>
                )}
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
