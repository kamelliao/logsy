import { useEffect, useRef, useDeferredValue } from "react";
import type { PanelImperativeHandle, PanelSize } from "react-resizable-panels";
import type { AppState, PanelTab } from "@/types";
import { PANEL_TABS } from "@/types";
import { useStore } from "@/store";
import { activeFile } from "@/state/selectors";

export type { PanelTab };

// Collapsed strip size — shared by both docks so the popped dock collapses to the
// same tab-bar strip as the main one.
const MAIN_COLLAPSED = "34px";
const POP_COLLAPSED = MAIN_COLLAPSED;
// A dock at (or near) its collapsed strip size — used to read collapse back OUT of a
// drag. Well below either dock's expanded floor (140px / 240px) and above the 34px
// strip, so it can't be confused with a small-but-open dock.
const COLLAPSE_DETECT_PX = 70;
// Fallback expand size, used only until a dock has a remembered size of its own
// (see `AppState.dockSizes`). The popped dock opens larger than the filter dock —
// its tables/canvas benefit.
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

  // ── Remembered dock size ────────────────────────────────────────────────────
  // Each dock re-opens at the size the user last left it at. The live size comes
  // in through `onResize` (every drag frame), so we keep the latest EXPANDED px
  // in a ref — free, no re-render — and only commit it to the document at the
  // moment the dock collapses, where a state write happens anyway. Keyed by dock
  // AND side, because the popped dock (and the main one, via "Dock right") can
  // move: a bottom dock's height must not become a right dock's width.
  const lastPx = useRef<Record<string, number>>({});
  const sideOf = (id: "fp" | "pop", s: AppState): "bottom" | "right" =>
    id === "fp" ? s.panelPos : s.panelPos === "bottom" ? "right" : "bottom";
  const dockKey = (id: "fp" | "pop", s: AppState) => `${id}:${sideOf(id, s)}`;
  // The `dockSizes` patch to fold into a state update that collapses `id`.
  const rememberSize = (id: "fp" | "pop", s: AppState): Partial<AppState> => {
    const px = lastPx.current[dockKey(id, s)];
    if (!px || px <= COLLAPSE_DETECT_PX) return {};
    return { dockSizes: { ...(s.dockSizes ?? {}), [dockKey(id, s)]: px } };
  };
  // Size to expand a dock to: what it was last left at, else the generous default.
  const expandSize = (id: "fp" | "pop", fallback: string): string => {
    const s = getDoc();
    const px = s.dockSizes?.[dockKey(id, s)] ?? lastPx.current[dockKey(id, s)];
    return px && px > COLLAPSE_DETECT_PX ? `${Math.round(px)}px` : fallback;
  };

  const setFilterPos = (pos: "bottom" | "right") =>
    setState((s) => ({ ...s, panelPos: pos }));
  const toggleFilterCollapsed = () =>
    setState((s) => ({
      ...s,
      filterCollapsed: !s.filterCollapsed,
      // Collapsing: capture the size we're collapsing away from.
      ...(s.filterCollapsed ? {} : rememberSize("fp", s)),
    }));
  const togglePoppedCollapsed = () =>
    setState((s) => ({
      ...s,
      poppedCollapsed: !s.poppedCollapsed,
      ...(s.poppedCollapsed ? {} : rememberSize("pop", s)),
    }));

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

  // Collapse/expand is a two-way binding between the persisted boolean (which drives
  // the dock CHROME: strip vs. tab-bar) and the panel's own collapsible behavior:
  //
  //  • Button toggle → flips the boolean → this effect drives the panel imperatively.
  //  • Drag past the threshold → the library collapses/expands the panel natively →
  //    onDockResize below reads that back into the boolean.
  //
  // The effect only acts when the panel DISAGREES with the desired state, so a
  // drag-driven change (where the panel already matches the freshly-synced boolean)
  // never triggers an imperative resize that would fight the ongoing drag.
  useEffect(() => {
    const p = fpRef.current;
    if (!p || p.isCollapsed() === state.filterCollapsed) return;
    if (state.filterCollapsed) p.collapse();
    // Defer expand a frame so the panel settles before we size it.
    else requestAnimationFrame(() => p.resize(expandSize("fp", EXPAND_FP)));
  }, [state.filterCollapsed]);
  useEffect(() => {
    const p = popRef.current;
    if (!p || p.isCollapsed() === state.poppedCollapsed) return;
    if (state.poppedCollapsed) p.collapse();
    else requestAnimationFrame(() => p.resize(expandSize("pop", EXPAND_POP)));
  }, [state.poppedCollapsed]);

  // Read a drag-driven collapse/expand back into the persisted boolean, and track
  // the dock's live expanded size for `dockSizes`. Attached to each dock panel's
  // onResize, so it fires on every drag frame: the size tracking is a ref write,
  // and the state write is a no-op unless the panel just crossed the strip line
  // (guarded so the effect above and this handler can't ping-pong).
  const onDockResize =
    (id: "fp" | "pop", key: "filterCollapsed" | "poppedCollapsed") =>
    (size: PanelSize) => {
      const collapsed = size.inPixels <= COLLAPSE_DETECT_PX;
      const s = getDoc();
      if (!collapsed) lastPx.current[dockKey(id, s)] = size.inPixels;
      if (!!s[key] === collapsed) return;
      setState((st) => ({
        ...st,
        [key]: collapsed,
        // Dragged shut: persist the size it had just before crossing the line.
        ...(collapsed ? rememberSize(id, st) : {}),
      }));
    };
  const onFpResize = onDockResize("fp", "filterCollapsed");
  const onPopResize = onDockResize("pop", "poppedCollapsed");

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
    onFpResize,
    onPopResize,
    MAIN_COLLAPSED,
    POP_COLLAPSED,
  };
}
