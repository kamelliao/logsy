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
import type { useDockLayout } from "@/hooks/useDockLayout";
import type { useCompareCollapse } from "@/hooks/useCompareCollapse";
import type { PanelTab } from "@/types";

type DockLayout = ReturnType<typeof useDockLayout>;
type CompareCollapse = ReturnType<typeof useCompareCollapse>;

interface Props {
  // Pre-built panel bodies (constructed in App, which owns their data deps).
  logview: ReactNode;
  filterBody: ReactNode;
  compareBody: ReactNode;
  timelineBody: ReactNode;
  notebookBody: ReactNode;

  // Dock layout + per-table compare collapse bundles.
  dock: DockLayout;
  compareCollapse: CompareCollapse;

  // Dock position / collapse state (mirrors the persisted app state).
  panelPos: "bottom" | "right";
  filterCollapsed: boolean;
  poppedCollapsed: boolean;

  // Split view only: the name of the document the dock panels currently act on
  // (the focused pane's file). null in single-pane mode → no chip, no accent.
  docChip: string | null;

  // Tab badge counts.
  compareCount: number;
  markCount: number;
  showCompare: boolean;

  // Dock-head actions not owned by useDockLayout.
  clearCompare: () => void;
  clearTimeline: () => void;
}

const PANEL_LABEL: Record<PanelTab, string> = {
  filters: "Filters",
  timeline: "Timeline",
  compare: "Compare",
  notebook: "Notebook",
};

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
  timelineBody,
  notebookBody,
  dock,
  compareCollapse,
  panelPos,
  filterCollapsed,
  poppedCollapsed,
  docChip,
  compareCount,
  markCount,
  showCompare,
  clearCompare,
  clearTimeline,
}: Props): ReactNode {
  const {
    isPanelPending,
    fpRef,
    popRef,
    setFilterPos,
    toggleFilterCollapsed,
    togglePoppedCollapsed,
    selectPanelTab,
    selectPoppedTab,
    popOut,
    dockBack,
    canPop,
    mainTabs,
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

  const bodyOf: Record<PanelTab, ReactNode> = {
    filters: filterBody,
    timeline: timelineBody,
    compare: compareBody,
    notebook: notebookBody,
  };
  // The count a tab shows as its badge; null = this panel has no count concept.
  const countOf = (t: PanelTab): number | null =>
    t === "timeline"
      ? markCount
      : t === "compare"
        ? showCompare
          ? compareCount
          : 0
        : null;
  // The label a collapsed right-hand dock shows on its vertical strip.
  const stripTitle = (t: PanelTab): string => {
    const n = countOf(t);
    return n === null ? PANEL_LABEL[t] : `${PANEL_LABEL[t]} · ${n}`;
  };

  // The panel-specific buttons in a dock head (everything left of the dock's own
  // pop/dock/position/collapse controls). Same for a panel whichever dock it sits
  // on, which is the point: a popped-out panel keeps its actions.
  const panelActions = (t: PanelTab): ReactNode => {
    if (t === "compare")
      return (
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
        </>
      );
    if (t === "timeline")
      return (
        <button
          className="dock-btn"
          title="Clear timeline"
          onClick={clearTimeline}
        >
          <Eraser size={14} />
        </button>
      );
    return null;
  };

  /**
   * One dock: a tab strip over the active panel's body. Both docks are this — the
   * MAIN one (the panels not popped out) and the POPPED one beside it (those that
   * are). They share the chrome so a panel looks and behaves the same on either.
   */
  const dockNode = (which: "main" | "popped"): ReactNode => {
    const isMain = which === "main";
    const tabs = isMain ? mainTabs : poppedTabs;
    const active = isMain ? activePanelTab : poppedActiveTab;
    const collapsed = isMain ? filterCollapsed : poppedCollapsed;
    const pos = isMain ? panelPos : poppedPos;
    const toggleCollapsed = isMain
      ? toggleFilterCollapsed
      : togglePoppedCollapsed;
    const selectTab = isMain ? selectPanelTab : selectPoppedTab;
    const chevron = foldChevron(pos, collapsed);
    const hint = isMain ? "  (Ctrl+B)" : "";

    // Right-docked + collapsed: a thin vertical strip labelled with the active tab.
    if (collapsed && pos === "right") {
      return (
        <div className="dock dock-right collapsed panel-dock" data-dock={which}>
          <div
            className="dock-head"
            onClick={toggleCollapsed}
            title={"Expand" + hint}
          >
            <span className="dock-chevron">{chevron}</span>
            <span className="dock-title">{stripTitle(active)}</span>
          </div>
        </div>
      );
    }

    return (
      <div
        className={
          "dock dock-" + pos + (collapsed ? " collapsed" : "") + " panel-dock"
        }
        // Which dock this is, independent of where it sits: the popped dock renders
        // BEFORE the main one whenever the main is right-docked, so DOM order can't
        // identify them.
        data-dock={which}
      >
        <div className="dock-head tabbed">
          <div className="panel-tabs">
            {tabs.map((t) => {
              const n = countOf(t);
              return (
                <button
                  key={t}
                  className={"ptab" + (active === t ? " active" : "")}
                  onClick={() => selectTab(t)}
                >
                  {PANEL_LABEL[t]}
                  {n !== null && n > 0 && (
                    <span className="ptab-badge">{n}</span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="dock-spacer" />
          {/* Split view: which document these panels act on (focused pane's file). */}
          {isMain && docChip && (
            <span className="dock-doc" title={`Panels act on ${docChip}`}>
              <span className="dock-doc-caret" aria-hidden>
                ▸
              </span>
              <span className="dock-doc-name">{docChip}</span>
            </span>
          )}
          {panelActions(active)}
          {isMain ? (
            <>
              {/* The last remaining tab can't be popped — the main dock keeps one. */}
              {canPop && (
                <button
                  className="dock-btn"
                  title={`Pop ${PANEL_LABEL[active]} out to the side`}
                  onClick={() => popOut(active)}
                >
                  {pos === "bottom" ? (
                    <PanelLeftOpen size={14} />
                  ) : (
                    <PanelTopOpen size={14} />
                  )}
                </button>
              )}
              <button
                className="dock-btn"
                title={pos === "bottom" ? "Dock right" : "Dock bottom"}
                onClick={() =>
                  setFilterPos(pos === "bottom" ? "right" : "bottom")
                }
              >
                {pos === "bottom" ? (
                  <PanelRight size={14} />
                ) : (
                  <PanelBottom size={14} />
                )}
              </button>
            </>
          ) : (
            <button
              className="dock-btn"
              title={`Dock ${PANEL_LABEL[active]} back into the panel`}
              onClick={() => dockBack(active)}
            >
              {pos === "bottom" ? (
                <PanelRightClose size={14} />
              ) : (
                <PanelBottomClose size={14} />
              )}
            </button>
          )}
          <button
            className="dock-btn"
            title={(collapsed ? "Expand" : "Collapse") + hint}
            onClick={toggleCollapsed}
          >
            {chevron}
          </button>
        </div>
        {!collapsed && (
          <div
            className={
              "dock-body" + (isMain && isPanelPending ? " pending" : "")
            }
          >
            {bodyOf[active]}
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
    node: dockNode(d.id === "fp" ? "main" : "popped"),
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
