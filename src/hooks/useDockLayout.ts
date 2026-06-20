import { useEffect, useRef, useTransition } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import type { AppState } from "@/types";

export type PanelTab = "filters" | "compare" | "bookmarks" | "timeline";
export type PoppedTab = "compare" | "timeline";

// Collapsed strip size — shared by both docks so the popped Compare/Timeline
// dock collapses to the same tab-bar strip as the Filters/Bookmarks dock.
const MAIN_COLLAPSED = "34px";
const POP_COLLAPSED = MAIN_COLLAPSED;
// The popped dock opens larger than the filter dock — its tables/canvas benefit.
const EXPAND_FP = "30%";
const EXPAND_POP = "30%";
// Default share (weight) for a panel that has no persisted size yet. Docks
// open generously so they reveal a useful amount of content.
const DEFAULT_WEIGHT: Record<string, number> = { lv: 100, center: 100, fp: 82, pop: 120 };

interface Deps {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  stateRef: React.RefObject<AppState>;
}

/**
 * Owns the dock layout: where the panels dock, which tab is active, the popped
 * Compare/Timeline dock, persisted panel sizes, and the collapse/expand resize
 * effects. The deferred panel transition (isPanelPending) lives here too, since
 * both tab selection and filter-set switching use it to keep large re-renders
 * off the click's critical path.
 */
export function useDockLayout({ state, setState, stateRef }: Deps) {
  // Switching the dock tab or filter set mounts/renders a large list — a long
  // task that would block the click's paint (high INP). Deferring it keeps the
  // interaction responsive; isPanelPending dims the panel body while it renders.
  const [isPanelPending, startPanelTransition] = useTransition();
  const fpRef = useRef<PanelImperativeHandle | null>(null);
  const popRef = useRef<PanelImperativeHandle | null>(null);

  const setFilterPos = (pos: "bottom" | "right") => setState((s) => ({ ...s, panelPos: pos }));
  const toggleFilterCollapsed = () => setState((s) => ({ ...s, filterCollapsed: !s.filterCollapsed }));
  const togglePoppedCollapsed = () => setState((s) => ({ ...s, poppedCollapsed: !s.poppedCollapsed }));

  // Which tab the main dock actually shows, resolved the same way the render does
  // (a popped-out Compare/Timeline falls back to Filters). Used to skip a no-op
  // tab switch so we don't start a panel transition (the dim animation) when the
  // target tab is already the visible one.
  const resolveActiveTab = (s: AppState): PanelTab =>
    s.activePanelTab === "bookmarks" ? "bookmarks"
      : s.activePanelTab === "timeline" && !s.timelinePopped ? "timeline"
      : s.activePanelTab === "compare" && !s.comparePopped ? "compare"
      : "filters";
  // Select a tab in the main panel (always expands it if it was collapsed). When
  // that tab is already shown expanded, do nothing — re-running the transition
  // would needlessly dim the panel body even though no content re-renders.
  const selectPanelTab = (tab: PanelTab) => {
    const s = stateRef.current;
    if (resolveActiveTab(s) === tab && !s.filterCollapsed) return;
    startPanelTransition(() => setState((st) => ({ ...st, activePanelTab: tab, filterCollapsed: false })));
  };

  // Compare and Timeline, when popped, share ONE dock beside Filters. Popping a
  // panel out focuses it as the active tab in that shared dock and expands it;
  // Filters takes over the main tab area if the popped panel was active there.
  const popCompareOut = () => setState((s) => ({
    ...s, comparePopped: true, poppedCollapsed: false, poppedActiveTab: "compare",
    activePanelTab: s.activePanelTab === "compare" ? "filters" : s.activePanelTab,
  }));
  // Merge Compare back into the main panel as a tab, and focus it.
  const dockCompareBack = () => setState((s) => ({
    ...s, comparePopped: false, activePanelTab: "compare", filterCollapsed: false,
    poppedActiveTab: "timeline",
  }));
  const popTimelineOut = () => setState((s) => ({
    ...s, timelinePopped: true, poppedCollapsed: false, poppedActiveTab: "timeline",
    activePanelTab: s.activePanelTab === "timeline" ? "filters" : s.activePanelTab,
  }));
  // Merge Timeline back into the main panel as a tab, and focus it.
  const dockTimelineBack = () => setState((s) => ({
    ...s, timelinePopped: false, activePanelTab: "timeline", filterCollapsed: false,
    poppedActiveTab: "compare",
  }));

  // Compare is a permanent tab (shows an empty-state when it has no rows); it's a
  // main-panel tab unless popped out into the shared dock.
  const compareTabAvailable = !state.comparePopped;
  // Timeline is a tab unless it's popped out into the shared popped dock.
  const timelineTabAvailable = !state.timelinePopped;
  // Compare and Timeline share ONE popped dock. Its tab set is whichever are
  // popped; the active tab is resolved against that set.
  const poppedTabs: PoppedTab[] = [
    ...(state.comparePopped ? ["compare" as const] : []),
    ...(state.timelinePopped ? ["timeline" as const] : []),
  ];
  const popOpen = poppedTabs.length > 0;
  const poppedActiveTab: PoppedTab =
    poppedTabs.includes(state.poppedActiveTab ?? "compare")
      ? (state.poppedActiveTab ?? "compare")
      : (poppedTabs[0] ?? "compare");
  // Bookmarks is always a tab. Compare/Timeline fall back to Filters when unavailable.
  const activePanelTab: PanelTab =
    state.activePanelTab === "bookmarks" ? "bookmarks"
      : state.activePanelTab === "timeline" && timelineTabAvailable ? "timeline"
      : state.activePanelTab === "compare" && compareTabAvailable ? "compare"
      : "filters";
  // The popped dock docks on the side opposite the main panel.
  const poppedPos: "bottom" | "right" = state.panelPos === "bottom" ? "right" : "bottom";

  // Build a set's initial layout from its persisted-size bucket, normalised to 100%.
  const layoutFor = (groupKey: string, ids: string[]): Record<string, number> => {
    const bucket = state.panelSizes?.[groupKey] ?? {};
    const out: Record<string, number> = {};
    let known = 0; const unknown: string[] = [];
    for (const id of ids) { const v = bucket[id]; if (typeof v === "number") { out[id] = v; known += v; } else unknown.push(id); }
    if (unknown.length) {
      const totalW = unknown.reduce((a, id) => a + (DEFAULT_WEIGHT[id] ?? 100), 0) || 1;
      const rem = Math.max(unknown.length * 10, 100 - known);
      for (const id of unknown) out[id] = rem * (DEFAULT_WEIGHT[id] ?? 100) / totalW;
    }
    const sum = ids.reduce((a, id) => a + out[id], 0) || 1;
    for (const id of ids) out[id] = (out[id] / sum) * 100;
    return out;
  };
  const onLayoutFor = (groupKey: string) => (layout: Record<string, number>) => setState((s) => {
    const bucket = { ...(s.panelSizes?.[groupKey] ?? {}) };
    for (const [id, v] of Object.entries(layout)) {
      if (id === "fp" && s.filterCollapsed) continue;   // don't persist a collapsed size
      if (id === "pop" && s.poppedCollapsed) continue;
      bucket[id] = v;
    }
    return { ...s, panelSizes: { ...(s.panelSizes ?? {}), [groupKey]: bucket } };
  });

  // Drive collapse/expand by resizing the panel directly (the library's own
  // collapse() records the pre-collapse size, which our maxSize pin corrupts).
  // Resize only on the actual collapse↔expand transition; the panel's
  // defaultSize handles fresh mounts. Expanded → a generous height.
  const prevFp = useRef(state.filterCollapsed);
  const prevPop = useRef(state.poppedCollapsed);
  useEffect(() => {
    const p = fpRef.current; if (!p) return;
    if (state.filterCollapsed) p.resize(MAIN_COLLAPSED);
    // Defer expand so the maxSize pin (strip → 100%) settles before resizing.
    else if (prevFp.current) requestAnimationFrame(() => p.resize(EXPAND_FP));
    prevFp.current = state.filterCollapsed;
  }, [state.filterCollapsed]);
  useEffect(() => {
    const p = popRef.current; if (!p) return;
    if (state.poppedCollapsed) p.resize(POP_COLLAPSED);
    else if (prevPop.current) requestAnimationFrame(() => p.resize(EXPAND_POP));
    prevPop.current = state.poppedCollapsed;
  }, [state.poppedCollapsed]);

  return {
    isPanelPending, startPanelTransition, fpRef, popRef,
    setFilterPos, toggleFilterCollapsed, togglePoppedCollapsed, selectPanelTab,
    popCompareOut, dockCompareBack, popTimelineOut, dockTimelineBack,
    compareTabAvailable, timelineTabAvailable, poppedTabs, popOpen,
    poppedActiveTab, activePanelTab, poppedPos, layoutFor, onLayoutFor,
    MAIN_COLLAPSED, POP_COLLAPSED,
  };
}
