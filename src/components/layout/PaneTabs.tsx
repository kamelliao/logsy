import { Fragment, type CSSProperties, type ReactNode } from "react";
import { X } from "lucide-react";
import { useDraggable } from "@dnd-kit/core";

interface Props {
  /** Which split pane (group) this strip belongs to. */
  pane: "a" | "b";
  /** Ordered file ids shown as tabs in this pane (group). */
  tabs: string[];
  /** The pane's active tab (file id), highlighted. */
  activeId: string | null;
  /** All open files, for resolving a tab id to its display name. */
  files: { id: string; name: string }[];
  /** While a tab is dragged over THIS pane, the insertion index to draw the `|`
   *  caret at (0..tabs.length); null when the drag isn't over this pane. */
  caretIndex: number | null;
  onActivate: (fileId: string) => void;
  onClose: (fileId: string) => void;
}

/** One draggable file tab. It stays put while dragging (no live reorder / no
 *  scrollbar); a clone follows the pointer in the DragOverlay and a `|` caret marks
 *  the drop position. A plain click activates the tab. Drag id: "<pane>:<fileId>". */
function PaneTab({
  pane,
  id,
  name,
  active,
  closable,
  onActivate,
  onClose,
}: {
  pane: "a" | "b";
  id: string;
  name: string;
  active: boolean;
  closable: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: pane + ":" + id,
  });
  // No transform: the source tab stays in place (the DragOverlay clone is what
  // moves), so tabs never shuffle mid-drag and the strip never grows a scrollbar.
  const style: CSSProperties = { opacity: isDragging ? 0.4 : 1 };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={"pane-tab" + (active ? " active" : "")}
      title={name}
      onClick={onActivate}
      {...attributes}
      {...listeners}
      role="tab"
      aria-selected={active}
    >
      <span className="pane-tab-name">{name}</span>
      {closable && (
        <button
          className="pane-tab-x"
          title="Close tab in this pane"
          // Pointer-down stop so a click on the X never starts a tab drag.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

/**
 * A VS Code-style tab strip for one split pane ("editor group"). Each tab is an
 * open file; clicking one activates it in this pane (and makes it the app's active
 * file). Closing a tab removes it from this pane only. Tabs can be dragged to the
 * other pane (or reordered) — App's DndContext + a pointer-driven caret handle the
 * drop position. A pane keeps at least one tab.
 */
export function PaneTabs({
  pane,
  tabs,
  activeId,
  files,
  caretIndex,
  onActivate,
  onClose,
}: Props): ReactNode {
  const nameOf = (id: string) => files.find((f) => f.id === id)?.name ?? id;
  const caret = <span className="pane-tab-caret" aria-hidden />;
  return (
    <div className="pane-tabs" role="tablist" data-strip={pane}>
      {tabs.map((id, i) => (
        <Fragment key={id}>
          {caretIndex === i && caret}
          <PaneTab
            pane={pane}
            id={id}
            name={nameOf(id)}
            active={id === activeId}
            // The last tab is closable too — closing it collapses this pane.
            closable
            onActivate={() => onActivate(id)}
            onClose={() => onClose(id)}
          />
        </Fragment>
      ))}
      {caretIndex === tabs.length && caret}
      {/* Fills the rest of the strip so the caret can sit after the last tab. */}
      <div className="pane-tabs-rest" />
    </div>
  );
}
