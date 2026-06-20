import { Fragment, type ReactNode } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronUp,
  Eraser,
  PanelBottom,
  PanelBottomClose,
  PanelRightClose,
  PanelLeftOpen,
  PanelRight,
  PanelTopOpen,
} from "lucide-react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { useDockLayout, PoppedTab } from "@/hooks/useDockLayout";
import type { useCompareCollapse } from "@/hooks/useCompareCollapse";

type DockLayout = ReturnType<typeof useDockLayout>;
type CompareCollapse = ReturnType<typeof useCompareCollapse>;

interface Props {
  // Pre-built panel bodies (constructed in App, which owns their data deps).
  logview: ReactNode;
  filterBody: ReactNode;
  compareBody: ReactNode;
  bookmarksBody: ReactNode;
  timelineBody: ReactNode;

  // Dock layout + per-table compare collapse bundles.
  dock: DockLayout;
  compareCollapse: CompareCollapse;

  // Dock position / collapse state (mirrors the persisted app state).
  panelPos: "bottom" | "right";
  filterCollapsed: boolean;
  poppedCollapsed: boolean;

  // Tab badge counts.
  compareCount: number;
  markerCount: number;
  markCount: number;
  showCompare: boolean;

  // Dock-head actions not owned by useDockLayout.
  clearCompare: () => void;
  clearTimeline: () => void;
  onSelectPoppedTab: (t: PoppedTab) => void;
}

const foldChevron = (pos: "bottom" | "right", collapsed: boolean) =>
  pos === "bottom" ? (
    collapsed ? (
      <ChevronUp size={15} />
    ) : (
      <ChevronDown size={15} />
    )
  ) : collapsed ? (
    <ChevronLeft size={15} />
  ) : (
    <ChevronRight size={15} />
  );

type PanelDesc = {
  id: string;
  node: ReactNode;
  collapsible?: boolean;
  collapsed?: boolean;
  collapsedSize?: string;
  minSize?: string;
  ref?: React.RefObject<PanelImperativeHandle | null>;
};

/**
 * The resizable workspace: the log view plus the filter/compare/timeline docks.
 * Owns the dock chrome (tab strips, collapse/pop buttons) and the
 * react-resizable-panels layout assembly. App constructs the panel bodies and
 * passes them in, since their data comes from App's hooks.
 */
export function Workspace({
  logview,
  filterBody,
  compareBody,
  bookmarksBody,
  timelineBody,
  dock,
  compareCollapse,
  panelPos,
  filterCollapsed,
  poppedCollapsed,
  compareCount,
  markerCount,
  markCount,
  showCompare,
  clearCompare,
  clearTimeline,
  onSelectPoppedTab,
}: Props): ReactNode {
  const {
    isPanelPending,
    fpRef,
    popRef,
    setFilterPos,
    toggleFilterCollapsed,
    togglePoppedCollapsed,
    selectPanelTab,
    popCompareOut,
    dockCompareBack,
    popTimelineOut,
    dockTimelineBack,
    compareTabAvailable,
    timelineTabAvailable,
    poppedTabs,
    popOpen,
    poppedActiveTab,
    activePanelTab,
    poppedPos,
    layoutFor,
    onLayoutFor,
    MAIN_COLLAPSED,
    POP_COLLAPSED,
  } = dock;

  // The main panel: a tab bar switching between Filters and (when present and
  // not popped out) Compare. Collapses to its tab strip.
  const mainDockNode = (): ReactNode => {
    const collapsed = filterCollapsed;
    const pos = panelPos;
    const chevron = foldChevron(pos, collapsed);

    // Right-docked + collapsed: a thin vertical strip labelled with the active tab.
    if (collapsed && pos === "right") {
      return (
        <div className="dock dock-right collapsed panel-dock">
          <div
            className="dock-head"
            onClick={toggleFilterCollapsed}
            title="Expand  (Ctrl+B)"
          >
            <span className="dock-chevron">{chevron}</span>
            <span className="dock-title">
              {activePanelTab === "compare"
                ? `Compare · ${compareCount}`
                : activePanelTab === "bookmarks"
                  ? `Bookmarks · ${markerCount}`
                  : activePanelTab === "timeline"
                    ? `Timeline · ${markCount}`
                    : "Filters"}
            </span>
          </div>
        </div>
      );
    }

    return (
      <div
        className={
          "dock dock-" + pos + (collapsed ? " collapsed" : "") + " panel-dock"
        }
      >
        <div className="dock-head tabbed">
          <div className="panel-tabs">
            <button
              className={
                "ptab" + (activePanelTab === "filters" ? " active" : "")
              }
              onClick={() => selectPanelTab("filters")}
            >
              Filters
            </button>
            <button
              className={
                "ptab" + (activePanelTab === "bookmarks" ? " active" : "")
              }
              onClick={() => selectPanelTab("bookmarks")}
            >
              Bookmarks
              {markerCount > 0 && (
                <span className="ptab-badge">{markerCount}</span>
              )}
            </button>
            {timelineTabAvailable && (
              <button
                className={
                  "ptab" + (activePanelTab === "timeline" ? " active" : "")
                }
                onClick={() => selectPanelTab("timeline")}
              >
                Timeline
                {markCount > 0 && (
                  <span className="ptab-badge">{markCount}</span>
                )}
              </button>
            )}
            {compareTabAvailable && (
              <button
                className={
                  "ptab" + (activePanelTab === "compare" ? " active" : "")
                }
                onClick={() => selectPanelTab("compare")}
              >
                Compare
                {showCompare && (
                  <span className="ptab-badge">{compareCount}</span>
                )}
              </button>
            )}
          </div>
          <div className="dock-spacer" />
          {activePanelTab === "compare" && (
            <>
              <button
                className="dock-btn"
                title={
                  compareCollapse.allCollapsed
                    ? "Expand all tables"
                    : "Collapse all tables"
                }
                disabled={!compareCollapse.hasGroups}
                onClick={compareCollapse.toggleAll}
              >
                {compareCollapse.allCollapsed ? (
                  <ChevronsUpDown size={14} />
                ) : (
                  <ChevronsDownUp size={14} />
                )}
              </button>
              <button
                className="dock-btn"
                title="Clear comparison"
                onClick={clearCompare}
              >
                <Eraser size={14} />
              </button>
              <button
                className="dock-btn"
                title="Pop out beside Filters"
                onClick={popCompareOut}
              >
                {pos === "bottom" ? (
                  <PanelLeftOpen size={14} />
                ) : (
                  <PanelTopOpen size={14} />
                )}
              </button>
            </>
          )}
          {activePanelTab === "timeline" && (
            <>
              <button
                className="dock-btn"
                title="Clear timeline"
                onClick={clearTimeline}
              >
                <Eraser size={14} />
              </button>
              <button
                className="dock-btn"
                title="Pop out beside Filters"
                onClick={popTimelineOut}
              >
                {pos === "bottom" ? (
                  <PanelLeftOpen size={14} />
                ) : (
                  <PanelTopOpen size={14} />
                )}
              </button>
            </>
          )}
          <button
            className="dock-btn"
            title={pos === "bottom" ? "Dock right" : "Dock bottom"}
            onClick={() => setFilterPos(pos === "bottom" ? "right" : "bottom")}
          >
            {pos === "bottom" ? (
              <PanelRight size={14} />
            ) : (
              <PanelBottom size={14} />
            )}
          </button>
          <button
            className="dock-btn"
            title={(collapsed ? "Expand" : "Collapse") + "  (Ctrl+B)"}
            onClick={toggleFilterCollapsed}
          >
            {chevron}
          </button>
        </div>
        {!collapsed && (
          <div className={"dock-body" + (isPanelPending ? " pending" : "")}>
            {activePanelTab === "filters"
              ? filterBody
              : activePanelTab === "compare"
                ? compareBody
                : activePanelTab === "timeline"
                  ? timelineBody
                  : bookmarksBody}
          </div>
        )}
      </div>
    );
  };

  // The shared popped dock: Compare and Timeline, when popped out, live here as
  // tabs (one or both). It docks on the side opposite the main panel so the two
  // never sit on the same edge. Collapsing mirrors the main dock exactly (same
  // shared tab-strip look): right → a thin vertical title strip, otherwise the
  // tab bar stays visible (just the body is dropped).
  const popDockNode = (): ReactNode => {
    const collapsed = poppedCollapsed;
    const pos = poppedPos;
    const chevron = foldChevron(pos, collapsed);
    const activeTitle =
      poppedActiveTab === "compare"
        ? `Compare · ${compareCount}`
        : `Timeline · ${markCount}`;

    // Right-docked + collapsed: a thin vertical strip labelled with the active tab.
    if (collapsed && pos === "right") {
      return (
        <div className="dock dock-right collapsed panel-dock">
          <div
            className="dock-head"
            onClick={togglePoppedCollapsed}
            title="Expand"
          >
            <span className="dock-chevron">{chevron}</span>
            <span className="dock-title">{activeTitle}</span>
          </div>
        </div>
      );
    }

    return (
      <div
        className={
          "dock dock-" + pos + (collapsed ? " collapsed" : "") + " panel-dock"
        }
      >
        <div className="dock-head tabbed">
          <div className="panel-tabs">
            {poppedTabs.map((t) => (
              <button
                key={t}
                className={"ptab" + (poppedActiveTab === t ? " active" : "")}
                onClick={() => onSelectPoppedTab(t)}
              >
                {t === "compare" ? (
                  <>
                    Compare
                    {showCompare && (
                      <span className="ptab-badge">{compareCount}</span>
                    )}
                  </>
                ) : (
                  <>
                    Timeline
                    {markCount > 0 && (
                      <span className="ptab-badge">{markCount}</span>
                    )}
                  </>
                )}
              </button>
            ))}
          </div>
          <div className="dock-spacer" />
          {poppedActiveTab === "compare" ? (
            <>
              <button
                className="dock-btn"
                title={
                  compareCollapse.allCollapsed
                    ? "Expand all tables"
                    : "Collapse all tables"
                }
                disabled={!compareCollapse.hasGroups}
                onClick={(e) => {
                  e.stopPropagation();
                  compareCollapse.toggleAll();
                }}
              >
                {compareCollapse.allCollapsed ? (
                  <ChevronsUpDown size={14} />
                ) : (
                  <ChevronsDownUp size={14} />
                )}
              </button>
              <button
                className="dock-btn"
                title="Clear comparison"
                onClick={(e) => {
                  e.stopPropagation();
                  clearCompare();
                }}
              >
                <Eraser size={14} />
              </button>
            </>
          ) : (
            <button
              className="dock-btn"
              title="Clear timeline"
              onClick={(e) => {
                e.stopPropagation();
                clearTimeline();
              }}
            >
              <Eraser size={14} />
            </button>
          )}
          <button
            className="dock-btn"
            title="Dock back into panel"
            onClick={(e) => {
              e.stopPropagation();
              if (poppedActiveTab === "compare") dockCompareBack();
              else dockTimelineBack();
            }}
          >
            {pos === "bottom" ? (
              <PanelRightClose size={14} />
            ) : (
              <PanelBottomClose size={14} />
            )}
          </button>
          <button
            className="dock-btn"
            title={collapsed ? "Expand" : "Collapse"}
            onClick={togglePoppedCollapsed}
          >
            {chevron}
          </button>
        </div>
        {!collapsed && (
          <div className="dock-body">
            {poppedActiveTab === "compare" ? compareBody : timelineBody}
          </div>
        )}
      </div>
    );
  };

  const buildGroup = (
    orientation: "vertical" | "horizontal",
    gid: string,
    panels: PanelDesc[],
  ): ReactNode => {
    const ids = panels.map((p) => p.id);
    // Remount the set when its panel set changes — the library can't have a
    // Panel inserted into / removed from a live set ("constraints not found").
    const groupKey = gid + ":" + ids.join(",");
    const dl = layoutFor(groupKey, ids);
    return (
      <ResizablePanelGroup
        key={groupKey}
        orientation={orientation}
        className="main"
        id={groupKey}
        defaultLayout={dl}
        onLayoutChanged={onLayoutFor(groupKey)}
      >
        {panels.map((p, i) => {
          const cs = p.collapsedSize ?? "26px";
          return (
            <Fragment key={p.id}>
              <ResizablePanel
                id={p.id}
                defaultSize={p.collapsed ? cs : `${dl[p.id]}%`}
                // A collapsed dock is pinned to the strip height (min == max) so
                // neither dragging nor a sibling's collapse can grow it back.
                // A side dock carries a px floor (p.minSize) so it can't be
                // dragged into an unusably narrow sliver.
                minSize={
                  p.collapsed
                    ? cs
                    : (p.minSize ?? (p.collapsible ? "8%" : "15%"))
                }
                maxSize={p.collapsed ? cs : "100%"}
                panelRef={p.ref}
              >
                {p.node}
              </ResizablePanel>
              {i < panels.length - 1 && <ResizableHandle withHandle />}
            </Fragment>
          );
        })}
      </ResizablePanelGroup>
    );
  };

  // The main panel is always present; Compare and Timeline share the one popped
  // dock, present only when at least one of them is popped out.
  const docks = [
    { id: "fp", pos: panelPos, ref: fpRef },
    ...(popOpen ? [{ id: "pop", pos: poppedPos, ref: popRef }] : []),
  ];
  // Keep array order (main panel before the popped dock).
  const side = (s: "bottom" | "right") => docks.filter((d) => d.pos === s);
  const bottomDocks = side("bottom");
  const rightDocks = side("right");
  const dockPanel = (d: {
    id: string;
    ref: React.RefObject<PanelImperativeHandle | null>;
  }): PanelDesc => ({
    id: d.id,
    node: d.id === "fp" ? mainDockNode() : popDockNode(),
    collapsible: true,
    ref: d.ref,
    collapsed: d.id === "fp" ? filterCollapsed : poppedCollapsed,
    collapsedSize: d.id === "fp" ? MAIN_COLLAPSED : POP_COLLAPSED,
  });

  let center: ReactNode = logview;
  if (bottomDocks.length) {
    center = buildGroup("vertical", "grp-v", [
      { id: "lv", node: logview },
      ...bottomDocks.map(dockPanel),
    ]);
  }
  if (rightDocks.length) {
    // Side docks get a px floor so a drag can't shrink them into an unusable
    // sliver (the content needs room for a pattern + hit count). When collapsed
    // they stay pinned to their strip width instead.
    const RIGHT_DOCK_MIN = "240px";
    return buildGroup("horizontal", "grp-h", [
      { id: bottomDocks.length ? "center" : "lv", node: center },
      ...rightDocks
        .map(dockPanel)
        .map((p) => (p.collapsed ? p : { ...p, minSize: RIGHT_DOCK_MIN })),
    ]);
  }
  return center;
}
