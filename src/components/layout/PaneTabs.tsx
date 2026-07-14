import {
  Fragment,
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { useDraggable } from "@dnd-kit/core";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** A file as the tab strip shows it: its name, the parent-dir suffix that tells
 *  same-named logs apart (VS Code style; undefined when the name is unique), and
 *  its full path for the hover tooltip. */
export interface TabFile {
  id: string;
  name: string;
  dir?: string;
  path?: string | null;
}

interface Props {
  /** Which pane (editor group) this strip belongs to. */
  pane: string;
  /** Ordered file ids shown as tabs in this pane. */
  tabs: string[];
  /** The pane's active tab (file id), highlighted. */
  activeId: string | null;
  /** Whether this pane is the focused one (its active tab is the app's file). */
  focused: boolean;
  /** All open files, for resolving a tab id to its display name. */
  files: TabFile[];
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
  dir,
  path,
  active,
  onActivate,
  onClose,
}: {
  pane: string;
  id: string;
  name: string;
  dir?: string;
  path?: string | null;
  active: boolean;
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
    // Hovering a tab shows the log's full path, in the same styled tooltip the
    // sidebar's file rows use (`.file-tip`) — a tab is often truncated, and with a
    // disambiguation suffix it still only shows one parent dir. The trigger renders
    // the draggable tab itself, so dnd-kit's ref/listeners ride along on it.
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            ref={setNodeRef}
            style={style}
            className={"pane-tab" + (active ? " active" : "")}
            onClick={onActivate}
            {...attributes}
            {...listeners}
            // After the spread: dnd-kit's `attributes` carry role="button", and a
            // tab in a strip is a tab.
            role="tab"
            aria-selected={active}
            // Middle-click closes the tab, like a browser / editor (the sidebar's
            // file rows do the same). It has to be handled on POINTERDOWN, not on
            // auxclick: the strip scrolls horizontally, so a middle press puts the
            // webview into autoscroll mode and no auxclick is ever delivered.
            // preventDefault() is what suppresses that. dnd-kit's own pointerdown
            // (its drag activator) is chained on for every other button.
            onPointerDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose();
                return;
              }
              listeners?.onPointerDown?.(e);
            }}
          />
        }
      >
        <span className="pane-tab-name">{name}</span>
        {dir && <span className="pane-tab-dir">{dir}</span>}
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
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <div className="file-tip">
          <div className="file-tip-path">{path || name}</div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A VS Code-style tab strip for one pane ("editor group"). Each tab is an open
 * file; clicking one activates it in this pane (and makes it the app's active
 * file). Closing a tab removes it from this pane only — the log stays open in the
 * sidebar. Tabs can be dragged to another pane (or reordered) — App's DndContext +
 * a pointer-driven caret handle the drop position. A pane that loses its last tab
 * is closed, unless it's the only one.
 */
export function PaneTabs({
  pane,
  tabs,
  activeId,
  focused,
  files,
  caretIndex,
  onActivate,
  onClose,
}: Props): ReactNode {
  const fileOf = (id: string) => files.find((f) => f.id === id);
  const caret = <span className="pane-tab-caret" aria-hidden />;
  // Mouse-wheel support: translate a plain vertical wheel into horizontal tab
  // scrolling. Attached natively (not via React's onWheel, which is passive so
  // preventDefault would no-op) to the ScrollArea viewport. Only claims the wheel
  // when the strip actually overflows and the gesture is vertical (a real trackpad
  // horizontal scroll passes straight through).
  const vpRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0 || e.deltaX !== 0) return;
      if (vp.scrollWidth <= vp.clientWidth) return;
      e.preventDefault();
      vp.scrollLeft += e.deltaY;
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, []);
  // Keep the active tab reachable: opening a file (which appends/activates a tab)
  // or GAINING focus scrolls the strip just far enough to reveal it. The two
  // triggers are tracked by hand because a re-render alone must not scroll — in
  // particular the pane that LOSES focus also re-renders with a new `focused`, and
  // it has no business moving. Done without scrollIntoView, which would also scroll
  // the app's other scroll containers (the pane's LogView sits in one). A no-op when
  // the tab is already in view, so clicking a visible tab never shifts the strip.
  const lastActive = useRef<string | null>(null);
  const wasFocused = useRef(false);
  useEffect(() => {
    const moved = activeId !== lastActive.current;
    const gainedFocus = focused && !wasFocused.current;
    lastActive.current = activeId;
    wasFocused.current = focused;
    if (!moved && !gainedFocus) return;
    const vp = vpRef.current;
    const tab = vp?.querySelector<HTMLElement>(".pane-tab.active");
    if (!vp || !tab) return;
    const v = vp.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    const pad = 8; // leave a sliver of the neighbouring tab showing
    if (t.left < v.left) vp.scrollLeft -= v.left - t.left + pad;
    else if (t.right > v.right) vp.scrollLeft += t.right - v.right + pad;
  }, [activeId, focused]);
  // Base UI ScrollArea (same overlay-scrollbar chrome as the filter panel's group
  // tabs): the native scrollbar is hidden and replaced by a thin overlay in a
  // reserved bottom lane, so an overflowing strip never rubber-bands the tabs or
  // steals height from them. Tabs + carets render inside `.scroll-area-content`.
  return (
    <ScrollArea
      orientation="horizontal"
      className="pane-tabs"
      data-strip={pane}
      viewportProps={{ ref: vpRef }}
    >
      {tabs.map((id, i) => (
        <Fragment key={id}>
          {caretIndex === i && caret}
          <PaneTab
            pane={pane}
            id={id}
            name={fileOf(id)?.name ?? id}
            dir={fileOf(id)?.dir}
            path={fileOf(id)?.path}
            active={id === activeId}
            onActivate={() => onActivate(id)}
            onClose={() => onClose(id)}
          />
        </Fragment>
      ))}
      {caretIndex === tabs.length && caret}
      {/* Fills the rest of the strip so the caret can sit after the last tab. */}
      <div className="pane-tabs-rest" />
    </ScrollArea>
  );
}
