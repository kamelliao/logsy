import { useMemo, type ReactNode } from "react";
import type { Filter, LogFile, Marker, ViewResult } from "@/types";
import { compileAll, computeView } from "@/lib/engine";

/** Everything one split pane needs to render its document. */
export interface PaneBundle {
  file: LogFile;
  view: ViewResult;
  lines: string[];
  filters: Filter[];
  viewMode: "all" | "matches";
  markers: Marker[];
  compareLines: Set<number>;
  timelineLines: Set<number>;
  /** The soloed filter's pattern ("view this filter only"), focused pane only. */
  soloPattern: string | null;
}

const EMPTY_LINES: string[] = [];
const EMPTY_FILTERS: Filter[] = [];
const EMPTY_NUMS: number[] = [];

interface Props {
  /** The document this pane shows (null → the pane has no tab open). */
  file: LogFile | null;
  /** The filter set that document has active — its own `activeSetId`, so two
   *  panes on different files apply different sets. */
  filters: Filter[] | null;
  /** The document's lines, from the caller's cache (`linesFor`). */
  lines: string[];
  /** Line numbers this document has in the compare panel / timeline. */
  compareLineNums: number[];
  timelineLineNums: number[];
  /**
   * The FOCUSED pane's bundle, already computed by App (it drives the dock panels
   * too). When set, this component skips its own — otherwise the active file's
   * view would be computed twice, and solo mode wouldn't reach the pane.
   */
  override: PaneBundle | null;
  children: (bundle: PaneBundle | null) => ReactNode;
}

/**
 * Computes one pane's view of its document, so the split view can hold any number
 * of panes: App can't `useMemo` a view per pane (hooks can't run in a loop over a
 * variable-length list), but a component per pane can.
 *
 * App renders this around EVERY pane — including the focused one, which passes its
 * ready-made bundle as `override`. That keeps the element tree the same shape
 * whichever pane has focus, so moving focus between panes doesn't remount LogView
 * (which would throw away its scroll position).
 */
export function PaneData({
  file,
  filters,
  lines,
  compareLineNums,
  timelineLineNums,
  override,
  children,
}: Props): ReactNode {
  // With an override in hand this pane's own derivation is dead weight, so feed
  // the memos empty inputs: compiling nothing and computing a view over no lines
  // are both trivial, and the hooks still run unconditionally.
  const ownFilters = override ? EMPTY_FILTERS : (filters ?? EMPTY_FILTERS);
  const ownLines = override ? EMPTY_LINES : lines;
  const compiled = useMemo(() => compileAll(ownFilters), [ownFilters]);
  const view = useMemo(
    () => computeView(ownLines, compiled),
    [ownLines, compiled],
  );
  const compareLines = useMemo(
    () => new Set(override ? EMPTY_NUMS : compareLineNums),
    [override, compareLineNums],
  );
  const timelineLines = useMemo(
    () => new Set(override ? EMPTY_NUMS : timelineLineNums),
    [override, timelineLineNums],
  );

  if (override) return children(override);
  if (!file) return children(null);
  return children({
    file,
    view,
    lines,
    filters: ownFilters,
    viewMode: file.viewMode ?? "all",
    markers: file.markers ?? [],
    compareLines,
    timelineLines,
    soloPattern: null,
  });
}
