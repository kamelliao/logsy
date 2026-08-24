import { useMemo } from "react";
import { toast } from "sonner";
import type {
  LogFile,
  FilterSet,
  ViewResult,
  TimelineSource,
  TimeMarker,
} from "@/types";
import { coerceTime, guessUnit, isTimeLike, isValidFormat } from "@/lib/fields";
import { buildTimeline, laneColor, timelineExcludeKey } from "@/lib/timeline";
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
  const addTimelineExcluded = useStore((s) => s.addTimelineExcluded);
  const removeTimelineExcluded = useStore((s) => s.removeTimelineExcluded);
  // Timeline tracks: a user-owned, ordered list (no auto-derivation).
  const tracks = useMemo(() => set?.sources ?? [], [set?.sources]);
  // Vertical reference lines the user dropped at arbitrary times (independent of
  // events). Persisted per-set, edited through undoable document patches.
  const timeMarkers = useMemo(() => set?.timeMarkers ?? [], [set?.timeMarkers]);
  // Lines the user added to the timeline. Persisted per file (survives reload),
  // keyed by file id so a file switch naturally shows that file's own set.
  const timelineLinesByFile = useStore((s) => s.doc.timelineLinesByFile);
  const timelineLines = useMemo(
    () => new Set(file ? (timelineLinesByFile?.[file.id] ?? []) : []),
    [timelineLinesByFile, file],
  );
  // Per-lane opt-outs: a line stays on the timeline (and on its OTHER lanes) but is
  // removed from one (filter, field) lane. Keyed by file; entries are
  // `timelineExcludeKey(line, filterId, timeField)`.
  const timelineExcludedByFile = useStore((s) => s.doc.timelineExcludedByFile);
  const exclusions = useMemo(
    () => new Set(file ? (timelineExcludedByFile?.[file.id] ?? []) : []),
    [timelineExcludedByFile, file],
  );
  // Events come from the lines the user added to the timeline (like compare), minus
  // the per-lane opt-outs. `badEndTracks` flags span tracks whose end field resolved
  // BEFORE the start (illegal, backwards span) — those ends are dropped; we warn.
  const { marks, badEndTracks } = useMemo(() => {
    const bad = new Set<string>();
    const m = buildTimeline(view, timelineLines, tracks, bad, exclusions);
    return { marks: m, badEndTracks: bad };
  }, [view, timelineLines, tracks, exclusions]);
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
  // Drop a vertical reference line at absolute time `t` (ns). Undoable, like a
  // track edit; persisted on the set.
  const addTimeMarker = (t: number) =>
    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      const marker: TimeMarker = {
        id:
          "tlm_" +
          Date.now().toString(36) +
          Math.random().toString(36).slice(2, 8),
        t,
        icon: "star",
      };
      g.timeMarkers = [...(g.timeMarkers ?? []), marker];
    });
  const removeTimeMarker = (id: string) =>
    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      g.timeMarkers = (g.timeMarkers ?? []).filter((m) => m.id !== id);
    });
  // Update a marker in place (label / color / icon edits), keyed by id.
  const setTimeMarker = (tm: TimeMarker) =>
    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      g.timeMarkers = (g.timeMarkers ?? []).map((m) =>
        m.id === tm.id ? tm : m,
      );
    });
  const clearTimeMarkers = () =>
    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      g.timeMarkers = [];
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
  // timeline, plotted on THIS lane only (per-track — like picking this field in the
  // row menu, so the lines don't also spill onto the filter's other lanes).
  const importTrackLines = (tr: TimelineSource) => {
    const lines = winnerLines(tr.filterId, tr.timeField);
    if (lines.length) {
      addLinesToTimeline(lines, tr.timeField);
    } else {
      toast(`No matching lines`, {
        description: `Nothing matches "${tr.lane}" yet.`,
      });
    }
  };
  // Track row "clear lines": take this track's matching lines off THIS lane only
  // (opting them out), leaving their other lanes — the inverse of import above.
  const clearTrackLines = (tr: TimelineSource) => {
    const lines = winnerLines(tr.filterId, tr.timeField);
    if (lines.length) removeTimelineField(lines, tr.timeField);
  };
  // Per-track stats for the row import/clear buttons and the per-row count badge:
  // how many lines the track matches, and how many of those are on the timeline.
  // `inTl` is per-LANE: a line on the timeline but opted out of THIS field (see
  // `exclusions`) does not count here, so the badge and the import/clear enablement
  // track exactly what the lane plots — not the line's global membership.
  const trackLineStats = useMemo(() => {
    const m = new Map<string, { matching: number; inTl: number }>();
    for (const tr of tracks) {
      const lines = winnerLines(tr.filterId, tr.timeField);
      let inTl = 0;
      for (const n of lines)
        if (
          timelineLines.has(n) &&
          !exclusions.has(timelineExcludeKey(n, tr.filterId, tr.timeField))
        )
          inTl++;
      m.set(tr.id, { matching: lines.length, inTl });
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, view, timelineLines, exclusions]);
  // Custom-format tracks whose `format` can't plot the field: empty / un-parseable
  // pattern, OR a syntactically valid pattern that fails on the field's actual
  // value (a sampled matched line). Drives the amber warning next to the format
  // box — the analogue of `badEndTracks` for the `custom` unit.
  const badFormatTracks = useMemo(() => {
    const bad = new Set<string>();
    for (const tr of tracks) {
      if (tr.unit !== "custom") continue;
      if (!isValidFormat(tr.format ?? "")) {
        bad.add(tr.id);
        continue;
      }
      const lines = winnerLines(tr.filterId, tr.timeField);
      const sample = lines.length
        ? view.fieldsFor(lines[0])?.[tr.timeField]?.raw
        : undefined;
      if (
        sample !== undefined &&
        typeof coerceTime(sample, "custom", tr.format) !== "number"
      )
        bad.add(tr.id);
    }
    return bad;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, view]);
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
  //
  // `timeField` lets the row menu pick WHICH time field backs the track, so the same
  // filter can be plotted on several tracks (one per field). Without it (a plain
  // click) the auto path picks the filter's first candidate field and, keeping the
  // old "one auto-track per filter" rule, skips a filter that already has any track.
  const addLinesToTimeline = (ns: number[], timeField?: string) => {
    addToTimeline(ns);
    if (!file || !set) return;
    // Re-plotting a line un-hides it from any lane it was opted out of, so clear the
    // matching opt-outs. An explicit field clears just that lane; the auto path (a
    // whole-line add) clears every opt-out on those lines.
    //
    // Adding a FRESH line to ONE field must also NOT spill it onto the filter's OTHER
    // lanes (a line is globally on the timeline, so it would otherwise plot on every
    // existing lane of its filter). Opt it out of every OTHER candidate field up front
    // — this covers lanes that exist now and any created later. A line already on the
    // timeline keeps whatever lanes it has; we only add the picked one.
    const unhide: string[] = [];
    const hide: string[] = [];
    for (const n of ns) {
      const fid = view.rows[n - 1]?.fieldsFromId;
      if (!fid) continue;
      if (timeField !== undefined) {
        const k = timelineExcludeKey(n, fid, timeField);
        if (exclusions.has(k)) unhide.push(k);
        if (!timelineLines.has(n)) {
          const allow = timeFieldsByFilter.get(fid);
          if (allow)
            for (const f of allow)
              if (f !== timeField) hide.push(timelineExcludeKey(n, fid, f));
        }
      } else {
        for (const k of exclusions)
          if (Number(k.slice(0, k.indexOf(" "))) === n) unhide.push(k);
      }
    }
    if (hide.length) addTimelineExcluded(hide);
    if (unhide.length) removeTimelineExcluded(unhide);
    // Explicit pick: a track is a (filter, field) pair, so only that exact pair blocks
    // a new one. Auto: one track per filter, so any existing track for the filter does.
    const pairs = new Set(
      (set.sources ?? []).map((x) => x.filterId + " " + x.timeField),
    );
    const filtersWithTrack = new Set(
      (set.sources ?? []).map((x) => x.filterId),
    );
    const specs: { fid: string; fld: string }[] = [];
    const seen = new Set<string>();
    for (const n of ns) {
      const fid = view.rows[n - 1]?.fieldsFromId;
      if (!fid) continue;
      const f = set.filters.find((x) => x.id === fid);
      const allow = timeFieldsByFilter.get(fid);
      // Explicit field: only if this filter can actually back it. Auto: first
      // candidate field, and only when the filter has no track yet.
      const fld =
        timeField !== undefined
          ? allow?.has(timeField)
            ? timeField
            : undefined
          : filtersWithTrack.has(fid)
            ? undefined
            : f?.fields?.find((d) => allow?.has(d.name))?.name;
      if (!f || !fld) continue;
      const key = fid + " " + fld;
      if (pairs.has(key) || seen.has(key)) continue; // track already exists / dup
      seen.add(key);
      specs.push({ fid, fld });
    }
    // An explicit pick reveals the timeline even when its track already existed (the
    // lines were still added) — otherwise the add would look like it did nothing.
    if (specs.length === 0) {
      if (timeField !== undefined && ns.length) selectPanelTab("timeline");
      return;
    }
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
  // The time-field lanes the row menu offers for a line selection — ONE entry per
  // (filter, field), NOT merged by name, so a selection spanning two filters keeps
  // their fields apart (even like-named ones). Entries are ordered by filter (then
  // field), each tagged with its `filterLabel` (`#N description`) so the menu can
  // group them into per-filter sections. Across the selection: `applicable` = selected
  // lines OF THIS FILTER that could plot the field; `plotted` = how many currently do;
  // `on` (fully ticked) = every applicable line is plotted (a mixed batch shows the
  // plotted/applicable count instead). `filterId` lets the caller scope the toggle to
  // just this filter's lines.
  const timelineFieldsForLines = (
    ns: number[],
  ): {
    filterId: string;
    filterLabel: string;
    name: string;
    on: boolean;
    plotted: number;
    applicable: number;
  }[] => {
    const pairs = new Set(tracks.map((t) => t.filterId + " " + t.timeField));
    const serialOf = new Map((set?.filters ?? []).map((f, i) => [f.id, i]));
    const filterById = new Map((set?.filters ?? []).map((f) => [f.id, f]));
    // Distinct filters present in the selection, in filter order.
    const filters: string[] = [];
    const seenF = new Set<string>();
    for (const n of ns) {
      const fid = view.rows[n - 1]?.fieldsFromId;
      if (fid && !seenF.has(fid)) {
        seenF.add(fid);
        filters.push(fid);
      }
    }
    filters.sort((a, b) => (serialOf.get(a) ?? 0) - (serialOf.get(b) ?? 0));
    const out: {
      filterId: string;
      filterLabel: string;
      name: string;
      on: boolean;
      plotted: number;
      applicable: number;
    }[] = [];
    for (const fid of filters) {
      const allow = timeFieldsByFilter.get(fid);
      if (!allow) continue;
      const f = filterById.get(fid);
      const serial = (serialOf.get(fid) ?? 0) + 1;
      const desc = (f?.description?.trim() || f?.pattern || "").slice(0, 40);
      const filterLabel = `#${serial}${desc ? " " + desc : ""}`;
      for (const name of allow) {
        let applicable = 0;
        let plotted = 0;
        for (const n of ns) {
          if (view.rows[n - 1]?.fieldsFromId !== fid) continue;
          applicable++;
          if (
            pairs.has(fid + " " + name) &&
            timelineLines.has(n) &&
            !exclusions.has(timelineExcludeKey(n, fid, name))
          )
            plotted++;
        }
        if (!applicable) continue;
        out.push({
          filterId: fid,
          filterLabel,
          name,
          on: plotted === applicable,
          plotted,
          applicable,
        });
      }
    }
    return out;
  };
  // Row-menu counterpart of picking a field to add: un-plot a selection from ONE lane.
  // Timeline membership is per-line (a line plots on every lane of its filter), so we
  // record a per-lane OPT-OUT rather than removing the line (which would wipe its other
  // fields) or the track (which would wipe the lane's other lines). A line left with no
  // lane at all is then taken off the timeline so it isn't a stray orphan.
  const removeTimelineField = (ns: number[], timeField: string) => {
    if (!file || !set) return;
    const keys: string[] = [];
    for (const n of ns) {
      const fid = view.rows[n - 1]?.fieldsFromId;
      if (!fid || !timeFieldsByFilter.get(fid)?.has(timeField)) continue;
      keys.push(timelineExcludeKey(n, fid, timeField));
    }
    if (!keys.length) return;
    addTimelineExcluded(keys);
    // With this opt-out applied, is a line now plotting on NO lane? (A hidden lane
    // still counts as its home — hiding is temporary, so don't evict for it.) If so,
    // drop it from the timeline entirely; that also prunes its opt-outs.
    const post = new Set(exclusions);
    keys.forEach((k) => post.add(k));
    const homeless = ns.filter((n) => {
      const fid = view.rows[n - 1]?.fieldsFromId;
      if (!fid) return false;
      const fl = view.fieldsFor(n);
      if (!fl) return false;
      return !tracks.some(
        (t) =>
          t.filterId === fid &&
          fl[t.timeField] &&
          !post.has(timelineExcludeKey(n, fid, t.timeField)),
      );
    });
    if (homeless.length) removeFromTimeline(homeless);
  };
  // "Add all matching lines" (timeline panel, when tracks exist but no lines yet):
  // pull every visible track's matching lines onto the timeline in one go. This is
  // the deliberate "plot everything" action, so it also clears any per-lane opt-outs
  // for the (line, lane) pairs it covers — a line matching several lanes lands on all.
  const addAllMatchingLines = () => {
    if (!set) return;
    const all = new Set<number>();
    const unhide: string[] = [];
    for (const tr of set.sources ?? []) {
      if (tr.hidden) continue;
      for (const n of winnerLines(tr.filterId, tr.timeField)) {
        all.add(n);
        unhide.push(timelineExcludeKey(n, tr.filterId, tr.timeField));
      }
    }
    if (all.size) {
      addToTimeline([...all]);
      removeTimelineExcluded(unhide);
    }
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

  // Bulk header actions ("… all"): the per-row toggles applied to every track in
  // ONE undoable patch. A `Partial<TimelineSource>` is merged onto each source, so
  // `{ expanded: undefined }` clears the flag and `{ expanded: true }` sets it.
  const setAllTracks = (patch: Partial<TimelineSource>) =>
    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      g.sources = (g.sources ?? []).map((x) => ({ ...x, ...patch }));
    });
  const deleteAllTracks = () =>
    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      g.sources = [];
    });
  // "Remove all lines": the inverse of import-all — drop every track's matching
  // lines from the timeline (not the whole file timeline, so unrelated added
  // lines stay put).
  const clearAllLines = () => {
    if (!set) return;
    const all = new Set<number>();
    for (const tr of set.sources ?? [])
      for (const n of winnerLines(tr.filterId, tr.timeField)) all.add(n);
    if (all.size) removeFromTimeline([...all]);
  };

  return {
    tracks,
    timeMarkers,
    addTimeMarker,
    removeTimeMarker,
    setTimeMarker,
    clearTimeMarkers,
    timelineLines,
    marks,
    badEndTracks,
    badFormatTracks,
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
    setAllTracks,
    deleteAllTracks,
    clearAllLines,
    addLinesToTimeline,
    timelineFieldsForLines,
    removeTimelineField,
    toggleTimelineTrack,
  };
}
