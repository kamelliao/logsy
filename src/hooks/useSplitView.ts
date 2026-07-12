import { useEffect } from "react";
import type { Pane, SplitView } from "@/types";
import { uid } from "@/lib/defaults";
import { useStore } from "@/store";

/** Which edge of the single pane a file was dropped on (opens a pane there). */
export type Zone = "left" | "right" | "top" | "bottom";

/**
 * Pane sizes as percentages summing to 100: the persisted size where a pane has
 * one, an even share of what's left for panes that don't (a freshly split pane, or
 * a restored layout saved before it was resized). Mirrors useDockLayout's
 * `layoutFor` — react-resizable-panels wants a normalized layout up front.
 */
export function paneLayout(
  panes: Pane[],
  sizes?: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const unknown: string[] = [];
  let known = 0;
  for (const p of panes) {
    const v = sizes?.[p.id];
    if (typeof v === "number" && v > 0) {
      out[p.id] = v;
      known += v;
    } else unknown.push(p.id);
  }
  if (unknown.length) {
    const rem = Math.max(unknown.length * 5, 100 - known);
    for (const id of unknown) out[id] = rem / unknown.length;
  }
  const sum = panes.reduce((a, p) => a + out[p.id], 0) || 1;
  for (const p of panes) out[p.id] = (out[p.id] / sum) * 100;
  return out;
}

interface Deps {
  /** Make a file the app's active document (bumps the read nonce, closes the
   *  open screen). Pane focus/activation routes through it so the dock panels
   *  follow the focused pane. */
  selectFile: (fileId: string) => void;
}

/**
 * Owns the split view: an ordered list of panes (VS Code "editor groups"), each
 * with its own file tabs + active tab, laid out in one row or one column. There
 * is no cap on the pane count and no nesting — a pane is added beside the focused
 * one and the row/column just grows.
 *
 * The FOCUSED pane's active tab is the app's active file, so the filter / compare
 * / timeline / bookmark panels and every write action follow whichever pane you
 * last touched. A pane does NOT own a filter set: the set follows the document it
 * shows (`LogFile.activeSetId`), so two panes on different files apply different
 * sets with no syncing here.
 *
 * The layout lives on the doc (`AppState.splitView`) so it survives a reload, but
 * every write here is a RAW (`setDoc`) edit — window layout must never land on
 * the undo stack, exactly like the dock layout in useDockLayout.
 */
export function useSplitView({ selectFile }: Deps) {
  const setState = useStore((s) => s.setDoc);
  const files = useStore((s) => s.doc.files);
  const activeFileId = useStore((s) => s.doc.activeFileId);
  const sv = useStore((s) => s.doc.splitView) as SplitView;

  const { panes, activePaneId, dir } = sv;
  /** The split is "on" once there's more than one pane. */
  const splitOn = panes.length > 1;
  const paneOf = (id: string): Pane | undefined =>
    panes.find((p) => p.id === id);
  const activePane = paneOf(activePaneId) ?? panes[0];

  // Every mutation is a function of the LIVE layout, read from the store rather
  // than closed over — pane edits often fire back-to-back (focus + activate), and
  // a stale closure would drop one.
  const edit = (fn: (sv: SplitView) => SplitView) =>
    setState((s) => ({ ...s, splitView: fn(s.splitView as SplitView) }));

  /** Point the app's active file at a pane's active tab (no-op when unchanged). */
  const syncActiveFile = (fileId: string | null) => {
    if (fileId && fileId !== useStore.getState().doc.activeFileId)
      selectFile(fileId);
  };

  /** Focus a pane: it becomes active and its active tab becomes the app's file. */
  const focusPane = (paneId: string) => {
    if (paneId === activePaneId) return;
    edit((v) => ({ ...v, activePaneId: paneId }));
    syncActiveFile(paneOf(paneId)?.active ?? null);
  };

  /** Click a tab: focus its pane, activate it, make it the app's active file. */
  const activateTab = (paneId: string, fileId: string) => {
    edit((v) => ({
      ...v,
      activePaneId: paneId,
      panes: v.panes.map((p) =>
        p.id !== paneId
          ? p
          : {
              ...p,
              tabs: p.tabs.includes(fileId) ? p.tabs : [...p.tabs, fileId],
              active: fileId,
            },
      ),
    }));
    syncActiveFile(fileId);
  };

  /**
   * Remove a pane from the layout, keeping ≥1. Its size entry goes too, so the
   * survivors re-share the freed space. Focus lands on the neighbour that took
   * its place; the last remaining pane can't be closed (it's the main group).
   */
  const closePane = (paneId: string) => {
    if (panes.length < 2) return;
    const i = panes.findIndex((p) => p.id === paneId);
    if (i < 0) return;
    const next = panes[i + 1] ?? panes[i - 1];
    edit((v) => {
      const sizes = { ...(v.sizes ?? {}) };
      delete sizes[paneId];
      return {
        ...v,
        panes: v.panes.filter((p) => p.id !== paneId),
        activePaneId: v.activePaneId === paneId ? next.id : v.activePaneId,
        ...(Object.keys(sizes).length ? { sizes } : { sizes: undefined }),
      };
    });
    if (activePaneId === paneId) syncActiveFile(next.active);
  };

  /**
   * Split the focused pane (Ctrl+\ / the header's split button): insert a new
   * pane right after it, showing the same document — VS Code's "split editor".
   * The new pane takes focus. The two share the focused pane's old size, so the
   * other panes keep theirs.
   */
  const splitPane = () => {
    const src = activePane;
    const seed = src?.active ?? activeFileId ?? null;
    const fresh: Pane = {
      id: uid("pane"),
      tabs: seed ? [seed] : [],
      active: seed,
    };
    edit((v) => {
      const i = v.panes.findIndex((p) => p.id === v.activePaneId);
      const at = i < 0 ? v.panes.length : i + 1;
      const nextPanes = [...v.panes];
      nextPanes.splice(at, 0, fresh);
      // Halve the source pane's share and give the other half to the new pane, so
      // splitting never disturbs the panes either side of it.
      const sizes = { ...(v.sizes ?? {}) };
      const share = (src && sizes[src.id]) || 100 / v.panes.length;
      if (src) sizes[src.id] = share / 2;
      sizes[fresh.id] = share / 2;
      return { ...v, panes: nextPanes, activePaneId: fresh.id, sizes };
    });
    if (seed) syncActiveFile(seed);
  };

  /**
   * Close a file tab in a pane (the file stays open globally — the sidebar still
   * lists it). A pane that loses its last tab is removed, unless it's the only
   * pane, whose strip is allowed to run empty (App then shows the open screen).
   */
  const closeTab = (paneId: string, fileId: string) => {
    const g = paneOf(paneId);
    if (!g) return;
    const remaining = g.tabs.filter((id) => id !== fileId);
    if (!remaining.length && panes.length > 1) {
      closePane(paneId);
      return;
    }
    const nextActive =
      g.active === fileId
        ? (remaining[remaining.length - 1] ?? null)
        : g.active;
    edit((v) => ({
      ...v,
      panes: v.panes.map((p) =>
        p.id === paneId ? { ...p, tabs: remaining, active: nextActive } : p,
      ),
    }));
    if (paneId === activePaneId) syncActiveFile(nextActive);
  };

  /**
   * Drop a dragged tab into `toPane` at `index` (a cross-pane move, or a reorder
   * when from === to). A source pane emptied by the move is removed, collapsing
   * the layout by one — dragging a 2-pane split's last tab across thus merges it
   * back to a single view.
   */
  const moveTabTo = (
    fromPaneId: string,
    toPaneId: string,
    fileId: string,
    index: number,
  ) => {
    edit((v) => {
      const from = v.panes.find((p) => p.id === fromPaneId);
      const to = v.panes.find((p) => p.id === toPaneId);
      if (!from || !to) return v;
      // Insert at the caret slot, adjusting when the file already sat before it.
      const toBase = to.tabs.filter((id) => id !== fileId);
      const origIdx = to.tabs.indexOf(fileId);
      let idx = index;
      if (origIdx >= 0 && origIdx < index) idx -= 1;
      toBase.splice(Math.max(0, Math.min(idx, toBase.length)), 0, fileId);

      if (fromPaneId === toPaneId) {
        return {
          ...v,
          activePaneId: toPaneId,
          panes: v.panes.map((p) =>
            p.id === toPaneId ? { ...p, tabs: toBase, active: fileId } : p,
          ),
        };
      }
      const fromTabs = from.tabs.filter((id) => id !== fileId);
      const emptied = fromTabs.length === 0 && v.panes.length > 1;
      const sizes = { ...(v.sizes ?? {}) };
      if (emptied) delete sizes[fromPaneId];
      return {
        ...v,
        activePaneId: toPaneId,
        panes: v.panes
          .filter((p) => !(emptied && p.id === fromPaneId))
          .map((p) => {
            if (p.id === toPaneId)
              return { ...p, tabs: toBase, active: fileId };
            if (p.id === fromPaneId)
              return {
                ...p,
                tabs: fromTabs,
                active:
                  from.active === fileId
                    ? (fromTabs[fromTabs.length - 1] ?? null)
                    : from.active,
              };
            return p;
          }),
        sizes,
      };
    });
    syncActiveFile(fileId);
  };

  /** Add already-opened files to a pane as tabs and show the last one. */
  const addFilesToPane = (paneId: string, ids: string[]) => {
    if (!ids.length) return;
    edit((v) => ({
      ...v,
      activePaneId: paneId,
      panes: v.panes.map((p) =>
        p.id !== paneId
          ? p
          : {
              ...p,
              tabs: [...p.tabs, ...ids.filter((id) => !p.tabs.includes(id))],
              active: ids[ids.length - 1],
            },
      ),
    }));
    syncActiveFile(ids[ids.length - 1]);
  };

  /**
   * A file dropped on an EDGE of a pane opens a new pane on that side, taking the
   * dropped files as its tabs. The edge also picks the layout axis: left/right
   * lay the panes out in a row, top/bottom in a column. Since the layout is a
   * single row or column, the new pane goes immediately before or after the pane
   * that was dropped on.
   */
  const openPaneAtEdge = (targetPaneId: string, zone: Zone, ids: string[]) => {
    const fileId = ids[ids.length - 1] ?? null;
    const fresh: Pane = { id: uid("pane"), tabs: [...ids], active: fileId };
    const before = zone === "left" || zone === "top";
    edit((v) => {
      const i = v.panes.findIndex((p) => p.id === targetPaneId);
      const at = i < 0 ? v.panes.length : before ? i : i + 1;
      const nextPanes = [...v.panes];
      nextPanes.splice(at, 0, fresh);
      // The new pane splits the target's share (as `splitPane` does).
      const sizes = { ...(v.sizes ?? {}) };
      const share = sizes[targetPaneId] || 100 / v.panes.length;
      sizes[targetPaneId] = share / 2;
      sizes[fresh.id] = share / 2;
      return {
        ...v,
        // The drop edge sets the axis only while there's nothing to disturb (a
        // single pane); once panes exist, flipping the axis would re-lay them all.
        dir:
          v.panes.length < 2
            ? zone === "left" || zone === "right"
              ? "h"
              : "v"
            : v.dir,
        panes: nextPanes,
        activePaneId: fresh.id,
        sizes,
      };
    });
    if (fileId) syncActiveFile(fileId);
  };

  const setDir = (d: "h" | "v") => edit((v) => ({ ...v, dir: d }));
  /** Persist a drag of the pane splitters (percent per pane id). */
  const setSizes = (sizes: Record<string, number>) =>
    edit((v) => ({ ...v, sizes: { ...(v.sizes ?? {}), ...sizes } }));

  // Keep the FOCUSED pane's active tab in sync with the app's active file, which
  // the sidebar / open dialog / notebook jumps also drive: selecting a file shows
  // it in the focused pane, adding a tab when it's new (VS Code's "open into the
  // active group"). The single-pane case keeps the older, tidier rule: a file
  // outside the strip REPLACES it, so merely opening logs doesn't accumulate a
  // runaway tab strip.
  useEffect(() => {
    if (!activeFileId) return;
    setState((s) => {
      const v = s.splitView as SplitView;
      const pane =
        v.panes.find((p) => p.id === v.activePaneId) ?? v.panes[0] ?? null;
      if (!pane) return s;
      if (pane.active === activeFileId && pane.tabs.includes(activeFileId))
        return s;
      const many = v.panes.length > 1;
      const tabs = pane.tabs.includes(activeFileId)
        ? pane.tabs
        : many
          ? [...pane.tabs, activeFileId]
          : [activeFileId];
      return {
        ...s,
        splitView: {
          ...v,
          panes: v.panes.map((p) =>
            p.id === pane.id ? { ...p, tabs, active: activeFileId } : p,
          ),
        },
      };
    });
  }, [activeFileId, setState]);

  // A file closed from the sidebar drops out of every pane's strip; a pane left
  // with no tabs is removed (keeping the last one, which may run empty).
  useEffect(() => {
    const ids = new Set(files.map((f) => f.id));
    setState((s) => {
      const v = s.splitView as SplitView;
      let dirty = false;
      const kept: Pane[] = [];
      for (const p of v.panes) {
        const tabs = p.tabs.filter((id) => ids.has(id));
        if (tabs.length === p.tabs.length) {
          kept.push(p);
          continue;
        }
        dirty = true;
        if (!tabs.length) continue; // pane emptied → drop it (unless it's the last)
        kept.push({
          ...p,
          tabs,
          active:
            p.active && tabs.includes(p.active)
              ? p.active
              : (tabs[tabs.length - 1] ?? null),
        });
      }
      if (!dirty) return s;
      if (!kept.length) kept.push({ ...v.panes[0], tabs: [], active: null });
      const activeId = kept.some((p) => p.id === v.activePaneId)
        ? v.activePaneId
        : kept[0].id;
      return {
        ...s,
        splitView: { ...v, panes: kept, activePaneId: activeId },
      };
    });
  }, [files, setState]);

  return {
    panes,
    dir,
    splitOn,
    activePaneId,
    activePane,
    focusPane,
    activateTab,
    closeTab,
    moveTabTo,
    splitPane,
    closePane,
    addFilesToPane,
    openPaneAtEdge,
    setDir,
    setSizes,
  };
}
