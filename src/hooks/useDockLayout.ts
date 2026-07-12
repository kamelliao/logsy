import { useEffect, useRef, useDeferredValue } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import type { AppState, PanelTab } from "@/types";
import { PANEL_TABS } from "@/types";
import { useStore } from "@/store";
import { activeFile } from "@/state/selectors";

export type { PanelTab };

// Collapsed strip size — shared by both docks so the popped dock collapses to the
// same tab-bar strip as the main one.
const MAIN_COLLAPSED = "34px";
const POP_COLLAPSED = MAIN_COLLAPSED;
// The popped dock opens larger than the filter dock — its tables/canvas benefit.
const EXPAND_FP = "30%";
const EXPAND_POP = "30%";
// Default share (weight) for a panel that has no persisted size yet. Docks
// open generously so they reveal a useful amount of content.
const DEFAULT_WEIGHT: Record<string, number> = {
  lv: 100,
  center: 100,
  fp: 82,
  pop: 120,
};

/**
 * Owns the dock layout: where the panels dock, which tab is active, the popped
 * Compare/Timeline dock, persisted panel sizes, and the collapse/expand resize
 * effects. The deferred panel transition (isPanelPending) lives here too, since
 * both tab selection and filter-set switching use it to keep large re-renders
 * off the click's critical path. Layout writes are raw (non-undoable) document
 * edits, sourced straight from the store.
 */
export function useDockLayout() {
  const state = useStore((s) => s.doc);
  const setState = useStore((s) => s.setDoc);
  // Latest document, read without a render dependency — the old `stateRef.current`.
  const getDoc = (): AppState => useStore.getState().doc;

  // Switching the dock tab or filter set mounts/renders a large list — a long
  // task that would block the click's paint (high INP). We keep that off the
  // critical path by rendering a *deferred* copy of the panel-view selection
  // (the active tab + active set id, below) via useDeferredValue, then dim the
  // body (isPanelPending) until the background render catches up.
  //
  // Note: the old code used useTransition here, but the doc now lives in a
  // Zustand store (useSyncExternalStore), and React forces external-store updates
  // to render synchronously even inside a transition — so the transition no
  // longer deferred anything. useDeferredValue works on the value, in render, so
  // it survives the move to an external store.
  const fpRef = useRef<PanelImperativeHandle | null>(null);
  const popRef = useRef<PanelImperativeHandle | null>(null);

  const setFilterPos = (pos: "bottom" | "right") =>
    setState((s) => ({ ...s, panelPos: pos }));
  const toggleFilterCollapsed = () =>
    setState((s) => ({ ...s, filterCollapsed: !s.filterCollapsed }));
  const togglePoppedCollapsed = () =>
    setState((s) => ({ ...s, poppedCollapsed: !s.poppedCollapsed }));

  // Which panels are where. ANY panel can be popped out into the shared side dock;
  // the main dock keeps whatever is left, and always at least one (`canPop` gates
  // the pop-out button on the last remaining tab).
  const poppedFor = (s: AppState): PanelTab[] => {
    const popped = PANEL_TABS.filter((t) => s.poppedPanels?.includes(t));
    // Defensive: never let the main dock run empty (normalizeState enforces this
    // too, but a live edit shouldn't be able to break it either).
    return popped.length >= PANEL_TABS.length ? popped.slice(0, -1) : popped;
  };
  const mainFor = (s: AppState): PanelTab[] => {
    const popped = poppedFor(s);
    return PANEL_TABS.filter((t) => !popped.includes(t));
  };
  const poppedTabs = poppedFor(state);
  const mainTabs = mainFor(state);
  const popOpen = poppedTabs.length > 0;
  const canPop = mainTabs.length > 1;

  // Which tab each dock actually shows, resolved the same way the render does: a
  // pointer at a panel that now lives on the OTHER dock falls back to that dock's
  // first tab. `resolveActiveTab` is also used to skip a no-op tab switch, so we
  // don't start a panel transition (the dim animation) for the already-visible tab.
  const resolveActiveTab = (s: AppState): PanelTab => {
    const main = mainFor(s);
    return main.includes(s.activePanelTab) ? s.activePanelTab : main[0];
  };
  // REVEAL a panel — the app's single "show me this panel" entry point (used by
  // "add to timeline", "add to notebook", jump-to-filter, …). It surfaces the panel
  // on whichever dock it currently lives on, so popping a panel out doesn't stop
  // those actions from bringing it into view. Expands the dock if it was collapsed.
  // When the panel is already the visible tab, do nothing — re-running the
  // transition would needlessly dim the body even though no content re-renders.
  const selectPanelTab = (tab: PanelTab) => {
    const s = getDoc();
    if (poppedFor(s).includes(tab)) {
      if (s.poppedActiveTab === tab && !s.poppedCollapsed) return;
      setState((st) => ({
        ...st,
        poppedActiveTab: tab,
        poppedCollapsed: false,
      }));
      return;
    }
    if (resolveActiveTab(s) === tab && !s.filterCollapsed) return;
    setState((st) => ({
      ...st,
      activePanelTab: tab,
      filterCollapsed: false,
    }));
  };
  const selectPoppedTab = (tab: PanelTab) =>
    setState((s) => ({ ...s, poppedActiveTab: tab, poppedCollapsed: false }));

  // Pop a panel out of the main dock into the shared side dock, where it becomes
  // the active (and expanded) tab. If it was the main dock's active tab, the first
  // remaining panel takes over there. Popping the LAST main tab is refused — the
  // main dock always keeps one.
  const popOut = (tab: PanelTab) =>
    setState((s) => {
      const popped = [...poppedFor(s), tab];
      const main = PANEL_TABS.filter((t) => !popped.includes(t));
      if (!main.length) return s;
      return {
        ...s,
        poppedPanels: PANEL_TABS.filter((t) => popped.includes(t)),
        poppedCollapsed: false,
        poppedActiveTab: tab,
        activePanelTab: main.includes(s.activePanelTab)
          ? s.activePanelTab
          : main[0],
      };
    });
  // Merge a popped panel back into the main dock as a tab, and focus it there.
  const dockBack = (tab: PanelTab) =>
    setState((s) => {
      const popped = poppedFor(s).filter((t) => t !== tab);
      return {
        ...s,
        poppedPanels: popped.length ? popped : undefined,
        poppedActiveTab: popped[0],
        activePanelTab: tab,
        filterCollapsed: false,
      };
    });

  // The popped dock's active tab, resolved against the panels actually on it.
  const poppedActiveTab: PanelTab =
    state.poppedActiveTab && poppedTabs.includes(state.poppedActiveTab)
      ? state.poppedActiveTab
      : poppedTabs[0];
  // We render the *deferred* resolution so switching tabs keeps the (large) body
  // swap off the click's critical path (see the note above).
  const liveActiveTab = resolveActiveTab(state);
  const deferredTab = useDeferredValue(liveActiveTab);
  // …but the deferred value lags by a render, and popping a panel out moves it to
  // the other dock IN THE SAME COMMIT. For that one frame the stale value would name
  // a panel the popped dock is already showing, so its body would mount TWICE — and
  // the notebook's TipTap editor registers a *keyed* ProseMirror plugin, so the
  // second instance throws ("Adding different instances of a keyed plugin
  // (dragHandle$)") and takes the whole app down. Only defer while the deferred tab
  // is still one of ours; otherwise snap to the live one.
  const activePanelTab = mainTabs.includes(deferredTab)
    ? deferredTab
    : liveActiveTab;

  // The active set id, deferred for the same reason — switching sets re-renders
  // the whole filter list. The selection is per-document, so read the active file's
  // `activeSetId` (the set LIST is global).
  const liveSetId = activeFile(state)?.activeSetId ?? null;
  const deferredActiveSetId = useDeferredValue(liveSetId);

  // Dim the panel body while either deferral is still catching up.
  const isPanelPending =
    activePanelTab !== liveActiveTab ||
    (deferredActiveSetId !== liveSetId &&
      deferredActiveSetId != null &&
      state.filterSets.some((g) => g.id === deferredActiveSetId));
  // The popped dock docks on the side opposite the main panel.
  const poppedPos: "bottom" | "right" =
    state.panelPos === "bottom" ? "right" : "bottom";

  // Build a set's initial layout from its persisted-size bucket, normalised to 100%.
  const layoutFor = (
    groupKey: string,
    ids: string[],
  ): Record<string, number> => {
    const bucket = state.panelSizes?.[groupKey] ?? {};
    const out: Record<string, number> = {};
    let known = 0;
    const unknown: string[] = [];
    for (const id of ids) {
      const v = bucket[id];
      if (typeof v === "number") {
        out[id] = v;
        known += v;
      } else unknown.push(id);
    }
    if (unknown.length) {
      const totalW =
        unknown.reduce((a, id) => a + (DEFAULT_WEIGHT[id] ?? 100), 0) || 1;
      const rem = Math.max(unknown.length * 10, 100 - known);
      for (const id of unknown)
        out[id] = (rem * (DEFAULT_WEIGHT[id] ?? 100)) / totalW;
    }
    const sum = ids.reduce((a, id) => a + out[id], 0) || 1;
    for (const id of ids) out[id] = (out[id] / sum) * 100;
    return out;
  };
  const onLayoutFor = (groupKey: string) => (layout: Record<string, number>) =>
    setState((s) => {
      const bucket = { ...(s.panelSizes?.[groupKey] ?? {}) };
      for (const [id, v] of Object.entries(layout)) {
        if (id === "fp" && s.filterCollapsed) continue; // don't persist a collapsed size
        if (id === "pop" && s.poppedCollapsed) continue;
        bucket[id] = v;
      }
      return {
        ...s,
        panelSizes: { ...(s.panelSizes ?? {}), [groupKey]: bucket },
      };
    });

  // Drive collapse/expand by resizing the panel directly (the library's own
  // collapse() records the pre-collapse size, which our maxSize pin corrupts).
  // Resize only on the actual collapse↔expand transition; the panel's
  // defaultSize handles fresh mounts. Expanded → a generous height.
  const prevFp = useRef(state.filterCollapsed);
  const prevPop = useRef(state.poppedCollapsed);
  useEffect(() => {
    const p = fpRef.current;
    if (!p) return;
    if (state.filterCollapsed) p.resize(MAIN_COLLAPSED);
    // Defer expand so the maxSize pin (strip → 100%) settles before resizing.
    else if (prevFp.current) requestAnimationFrame(() => p.resize(EXPAND_FP));
    prevFp.current = state.filterCollapsed;
  }, [state.filterCollapsed]);
  useEffect(() => {
    const p = popRef.current;
    if (!p) return;
    if (state.poppedCollapsed) p.resize(POP_COLLAPSED);
    else if (prevPop.current) requestAnimationFrame(() => p.resize(EXPAND_POP));
    prevPop.current = state.poppedCollapsed;
  }, [state.poppedCollapsed]);

  return {
    isPanelPending,
    deferredActiveSetId,
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
  };
}
