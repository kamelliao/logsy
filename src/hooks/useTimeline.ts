import { useMemo } from "react";
import { toast } from "sonner";
import type { LogFile, FilterSet, ViewResult, TimelineSource } from "@/types";
import { buildTimeline, laneColor, guessUnit, isTimeLike } from "@/lib/engine";
import { withSet } from "@/state/selectors";
import { useStore } from "@/store";
import type { PanelTab } from "@/hooks/useDockLayout";

interface Deps {
  view: ViewResult;
  file: LogFile | null;
  set: FilterSet | null;
  selectPanelTab: (tab: PanelTab) => void;
}

/**
 * The timeline: its tracks (per-set, undoable), the events its plotted lines
 * produce, and the derived helpers the panel and filter-row menu need (which
 * fields can back a time axis, per-track stats, orphaned lines). The plotted
 * lines themselves (`timelineLinesByFile`, persisted, not undoable) and their
 * add/remove/clear mutations live in the store's timeline slice; track edits are
 * undoable document mutations, so they go through the store's `patchState`.
 */
export function useTimeline({ view, file, set, selectPanelTab }: Deps) {
  const patchState = useStore((s) => s.patchState);
  const addToTimeline = useStore((s) => s.addToTimeline);
  const removeFromTimeline = useStore((s) => s.removeFromTimeline);
  const clearTimeline = useStore((s) => s.clearTimeline);
  // Timeline tracks: a user-owned, ordered list (no auto-derivation).
  const tracks = useMemo(() => set?.sources ?? [], [set?.sources]);
  // Lines the user added to the timeline. Persisted per file (survives reload),
  // keyed by file id so a file switch naturally shows that file's own set.
  const timelineLinesByFile = useStore((s) => s.doc.timelineLinesByFile);
  const timelineLines = useMemo(
    () => new Set(file ? (timelineLinesByFile?.[file.id] ?? []) : []),
    [timelineLinesByFile, file],
  );
  // Events come from the lines the user added to the timeline (like compare).
  // `badEndTracks` flags span tracks whose end field resolved BEFORE the start
  // (illegal, backwards span) — those ends are dropped; we warn on the row.
  const { marks, badEndTracks } = useMemo(() => {
    const bad = new Set<string>();
    const m = buildTimeline(view, timelineLines, tracks, bad);
    return { marks: m, badEndTracks: bad };
  }, [view, timelineLines, tracks]);
  // Field names per filter that may back a timeline TIME field. A field qualifies
  // if its declared type is numeric (int/hex/float/time) OR a sampled matched
  // value looks time-like (covers string-typed groups that actually hold numbers).
  // One O(rows) pass collects a few sample lines per provider filter that has any
  // string-typed field; recomputed when the view or filters change.
  const timeFieldsByFilter = useMemo(() => {
    const result = new Map<string, Set<string>>();
    const providers = (set?.filters ?? []).filter(
      (f) => f.fields && f.fields.length,
    );
    if (!providers.length) return result;
    const NUMERIC: Record<string, boolean> = {
      int: true,
      hex: true,
      float: true,
      time: true,
    };
    const needsSample = new Set<string>();
    for (const f of providers) {
      result.set(
        f.id,
        new Set(f.fields!.filter((d) => NUMERIC[d.type]).map((d) => d.name)),
      );
      if (f.fields!.some((d) => !NUMERIC[d.type])) needsSample.add(f.id);
    }
    if (needsSample.size) {
      const SAMPLE = 20;
      const sampleLines = new Map<string, number[]>();
      for (const fid of needsSample) sampleLines.set(fid, []);
      for (let n = 1; n <= view.rows.length; n++) {
        const fid = view.rows[n - 1]?.fieldsFromId;
        if (!fid || !needsSample.has(fid)) continue;
        const arr = sampleLines.get(fid)!;
        if (arr.length < SAMPLE) arr.push(n);
      }
      for (const fid of needsSample) {
        const have = result.get(fid)!;
        const strFields = providers
          .find((p) => p.id === fid)!
          .fields!.filter((d) => !NUMERIC[d.type]);
        for (const n of sampleLines.get(fid)!) {
          const fl = view.fieldsFor(n);
          if (!fl) continue;
          for (const d of strFields) {
            if (have.has(d.name)) continue;
            const v = fl[d.name]?.raw;
            if (v !== undefined && isTimeLike(v)) have.add(d.name);
          }
        }
      }
    }
    return result;
  }, [view, set]);

  // Tracks are a document edit → undoable; persisted on the set, keyed by id.
  const setTrack = (tr: TimelineSource) =>
    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      const list = [...(g.sources ?? [])];
      const i = list.findIndex((x) => x.id === tr.id);
      if (i >= 0) list[i] = tr;
      else list.push(tr);
      g.sources = list;
    });
  // All visible lines for which `filterId` is the first-match winner AND that
  // expose `timeField` — exactly the lines that will produce a mark on this track.
  const winnerLines = (filterId: string, timeField: string): number[] => {
    const out: number[] = [];
    for (let n = 1; n <= view.rows.length; n++) {
      if (view.rows[n - 1]?.fieldsFromId !== filterId) continue;
      if (view.fieldsFor(n)?.[timeField]) out.push(n);
    }
    return out;
  };
  // A fresh TimelineSource for (filter, field). `order` = the filter's serial
  // (lane label, e.g. "#3:ts"); `colorIdx` = position in the track list (palette).
  // `sample` lets the default unit be inferred from a real value's shape.
  const buildTrack = (
    filterId: string,
    timeField: string,
    order: number,
    colorIdx: number,
    sample?: string,
  ): TimelineSource => ({
    id:
      "tlt_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    filterId,
    timeField,
    lane: `#${order + 1}:${timeField}`,
    kind: "point",
    unit: guessUnit(timeField, sample),
    color: laneColor(colorIdx),
  });
  // Toggle a timeline track for (filter, time field): the filter-row menu shows a
  // ✓ when it's plotted, so clicking a checked field removes it and an unchecked
  // one adds it — a plain checkbox, no "already exists" dead-end. Creating a track
  // only defines *what* to plot; it does NOT pull lines in (the track row carries
  // an explicit "import matching lines" button instead).
  const toggleTimelineTrack = (filterId: string, timeField: string) => {
    if (!file || !set) return;
    // Track identity is (filter, time field).
    if (
      (set.sources ?? []).some(
        (x) => x.filterId === filterId && x.timeField === timeField,
      )
    ) {
      patchState((s) => {
        if (!file || !set) return;
        const g = withSet(s, file.id, set.id);
        g.sources = (g.sources ?? []).filter(
          (x) => !(x.filterId === filterId && x.timeField === timeField),
        );
      });
      return;
    }
    // Sample the field's first matched value so the default unit can be inferred
    // from its shape (a plain number ⇒ seconds), not just the field name.
    const lines = winnerLines(filterId, timeField);
    const sample = lines.length
      ? view.fieldsFor(lines[0])?.[timeField]?.raw
      : undefined;
    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      const list = [...(g.sources ?? [])];
      // Guard the race where the same pair was added between checks.
      if (
        list.some((x) => x.filterId === filterId && x.timeField === timeField)
      )
        return;
      const idx = g.filters.findIndex((f) => f.id === filterId);
      list.push(buildTrack(filterId, timeField, idx, list.length, sample));
      g.sources = list;
    });
  };
  // Track row "import matching lines": pull just this track's winner lines onto the
  // timeline (explicit, per-track — the affordance lives next to the track).
  const importTrackLines = (tr: TimelineSource) => {
    const lines = winnerLines(tr.filterId, tr.timeField);
    if (lines.length) {
      addToTimeline(lines);
    } else {
      toast(`No matching lines`, {
        description: `Nothing matches "${tr.lane}" yet.`,
      });
    }
  };
  // Track row "clear lines": remove just this track's matching lines.
  const clearTrackLines = (tr: TimelineSource) => {
    const lines = winnerLines(tr.filterId, tr.timeField);
    if (lines.length) removeFromTimeline(lines);
  };
  // Per-track stats for the row import/clear buttons and the per-row count badge:
  // how many lines the track matches, and how many of those are on the timeline.
  const trackLineStats = useMemo(() => {
    const m = new Map<string, { matching: number; inTl: number }>();
    for (const tr of tracks) {
      const lines = winnerLines(tr.filterId, tr.timeField);
      let inTl = 0;
      for (const n of lines) if (timelineLines.has(n)) inTl++;
      m.set(tr.id, { matching: lines.length, inTl });
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, view, timelineLines]);
  // Orphan lines: on the timeline but producing no mark (their first-match filter
  // has no track, or the track's field is absent) — the "added but nothing shows"
  // case. Surfaced as a bounded hint in the timeline panel.
  const orphanLines = useMemo(() => {
    const plotted = new Set(marks.map((mk) => mk.lineN));
    return [...timelineLines]
      .filter((n) => !plotted.has(n))
      .sort((a, b) => a - b);
  }, [marks, timelineLines]);
  // LogView "Add to timeline": add the lines, then bridge the common dead-end —
  // if any added line's first-match filter has no track yet, create one so the
  // events actually show. Line-first, so no autofill. A multi-filter selection is
  // batched into ONE undoable patch + one toast so it never spawns overlapping
  // prompts (one per filter, deduped).
  const addLinesToTimeline = (ns: number[]) => {
    addToTimeline(ns);
    if (!file || !set) return;
    const existing = new Set((set.sources ?? []).map((x) => x.filterId));
    const specs: { fid: string; fld: string }[] = [];
    const seen = new Set<string>();
    for (const n of ns) {
      const fid = view.rows[n - 1]?.fieldsFromId;
      if (!fid || existing.has(fid) || seen.has(fid)) continue;
      seen.add(fid);
      const f = set.filters.find((x) => x.id === fid);
      const allow = timeFieldsByFilter.get(fid);
      // First numeric/time-like field, in filter order.
      const fld = f?.fields?.find((d) => allow?.has(d.name))?.name;
      if (f && fld) specs.push({ fid, fld });
    }
    if (specs.length === 0) return;
    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      const list = [...(g.sources ?? [])];
      for (const { fid, fld } of specs) {
        if (list.some((x) => x.filterId === fid && x.timeField === fld))
          continue;
        const idx = g.filters.findIndex((f) => f.id === fid);
        list.push(buildTrack(fid, fld, idx, list.length));
      }
      g.sources = list;
    });
    selectPanelTab("timeline");
    const serials = specs
      .map((x) => `#${set.filters.findIndex((f) => f.id === x.fid) + 1}`)
      .join(", ");
    toast.success(
      specs.length > 1 ? `${specs.length} tracks added` : `Track added`,
      {
        description: `For filter${specs.length > 1 ? "s" : ""} ${serials}.`,
      },
    );
  };
  // "Add all matching lines" (timeline panel, when tracks exist but no lines yet):
  // pull every visible track's matching lines onto the timeline in one go.
  const addAllMatchingLines = () => {
    if (!set) return;
    const all = new Set<number>();
    for (const tr of set.sources ?? []) {
      if (tr.hidden) continue;
      for (const n of winnerLines(tr.filterId, tr.timeField)) all.add(n);
    }
    if (all.size) addToTimeline([...all]);
  };
  const removeTrack = (id: string) =>
    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      g.sources = (g.sources ?? []).filter((x) => x.id !== id);
    });
  const reorderTracks = (ids: string[]) =>
    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      const by = new Map((g.sources ?? []).map((x) => [x.id, x]));
      g.sources = ids.map((id) => by.get(id)!).filter(Boolean);
    });

  return {
    tracks,
    timelineLines,
    marks,
    badEndTracks,
    timeFieldsByFilter,
    orphanLines,
    trackLineStats,
    removeFromTimeline,
    clearTimeline,
    setTrack,
    removeTrack,
    reorderTracks,
    importTrackLines,
    clearTrackLines,
    addAllMatchingLines,
    addLinesToTimeline,
    toggleTimelineTrack,
  };
}
