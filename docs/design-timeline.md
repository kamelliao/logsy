# Design: Event timeline from parsed timestamp fields

Status: **v2 implemented 2026-06-14** (branch `feat/event-timeline`, not committed). Tests green.

### v2.1 refinements (2026-06-14)
- **Add a track from the filter list**: a filter row's right-click / ⋮ menu now
  offers *Add to timeline track* (one item per numeric field when the filter has
  several). Wired `FilterPanel.onAddTimelineTrack` → App `addTrack`, which now
  **de-dupes by `(filterId, timeField)`**.
- **Track row title**: renamed inline by **double-clicking** the title (Enter/blur
  commit, Esc cancel); the separate rename `<input>` was removed from the expanded
  body.
- **Color + shape picker**: a swatch button left of the title (right of the
  collapse chevron) opens a popover to choose the track color and a **point shape**
  (`circle | square | triangle | diamond`). New `EventShape` type; `shape` lives on
  `TimelineSource` + `EventMark`, round-trips through `filterFile.ts`, and is drawn
  by `tracePoint()` in the canvas (spans stay bars). The body color `<input>` was
  removed.
- **Canvas — measure band is stored in TIME (ns), not screen px**, so zooming/panning
  keeps the swept Δ fixed; only the band's on-screen position/width changes. Band is
  clamped to the plot when drawn.
- **Canvas — resizable from the whole bottom edge**: replaced CSS `resize: vertical`
  (corner-only grip) with a full-width `.tlc-resize` strip + pointer-drag handlers;
  height is now controlled state (`wrapH`), clamped `[120, 0.7·innerHeight]`,
  persisted to `localStorage`.

### v2.2 refinements (2026-06-14)
- **Any field can back a track** — not just `time`/numeric-typed ones. Named groups
  default to `string` (`guessType`), so requiring numeric blocked most filters.
  `numericFieldsOf` → **`trackFieldsOf` returns all of a filter's fields**; the
  track's unit + `coerceTime` handle parsing. Used by the Add-track composer, the
  per-row field picker, and the filter context menu.
- **Track row flattened** — the collapse chevron / expandable body are gone; every
  control (color+shape, lane, filter chip, field, kind, end, unit, hide, delete)
  sits on one wrapping row.
- **Filter shown as `#N · description`** (`N` = its 1-based order in the set;
  falls back to `pattern` when no description). The chip is a button that **opens
  that filter's Edit modal** (`TimelinePanel.onEditFilter` → App `openEditFilter`),
  so the full filter is one click away. The per-row filter-rebind `<select>` was
  dropped (rebind = delete + re-add).
- **Color/shape picker** now tints the **shape icon** with the track color (neutral
  button background) and shows a pointer cursor.
- **Canvas time domain fixed to `[0, maxT]`** — `clampView` caps zoom-out at
  "whole domain fills the plot" and keeps the window inside `[0, domMax]`; wheel +
  pan both clamp. Auto-fit is keyed on the **data range only** (not `plotW`), with a
  separate idempotent clamp effect on width change — so a **resize no longer resets
  zoom/pan**.

### v2.3 refinements (2026-06-14)
- **Hover card no longer clipped**: `.tlc-wrap` is `overflow:hidden` (rounded corners
  + resize strip), so a tall absolutely-positioned tooltip got cut off. Now the card
  is **portaled to `document.body`** (`position:fixed`, z 1000) using viewport client
  coords stored on hover (`cx`/`cy`), and **flips up/left** near the bottom/right edge.
- **Default track name** is `"<filter#>:<field>"` (e.g. `3:ts`), matching the row's
  filter serial — set in App `addTrack` from `g.filters.findIndex`.
- **Panel layout**: canvas is **sticky at the top** (fixed flex region); only the
  **track rows scroll** (`flex-1 min-h-0 overflow-y-auto`, panel is `overflow-hidden`).
- **Empty canvas always renders** (not replaced by a hint): `TimelineCanvas` takes a
  `placeholder` string drawn centered (`.tlc-empty`) when `marks.length === 0`, so the
  area is visible before any track/line exists; a longer guidance line sits below.
- **Per-row selects** (field/kind/end/unit) shrunk to a new `size="xs"` SelectTrigger
  (~22px), right-aligned (`ml-auto`, left of hide/delete), each with a `SelectLabel`
  group heading (new `SelectGroup`/`SelectLabel` exports in `ui/select`).

Goal: plot log events on a numeric time axis, where each event's time comes from
a **regex-parsed numeric field** rather than the raw log order. A single log line
may carry several timestamps, so one line can emit several events. Primary use:
**measure deltas** between events and **correlate across categories** (lanes).

The corpus and field-extraction machinery already exist (filters with named
capture groups → `FieldDef` → `coerceValue`). This feature adds a viewer plus a
small track schema on top.

## Model (locked 2026-06-14, v2)

- **A track = `filter + timestamp field`.** Its identity key is
  `filterId + ":" + timeField`. One filter may define several numeric fields, so
  it can back several tracks (one per chosen field).
- **Tracks are a user-owned, ordered list** stored on `FilterSet.sources`. This
  list is the single source of truth. **No auto-derivation** — adding a track is a
  deliberate action (`+ Add track` → pick filter → pick field). New filters/fields
  never spawn tracks on their own; nothing is "missed" because the user decides
  what to plot.
- **Events come from a global set of added log lines** (ephemeral
  `timelineLines: Set<number>`, reset on file switch; right-click → *Add to
  timeline*, like the compare panel).
- **Extraction is first-match-wins.** A line's parsed fields come from the first
  structural filter that matched it (`row.fieldsFromId` / `view.fieldsFor(n)`). The
  line feeds every track whose `filterId === row.fieldsFromId` **and** whose
  `timeField` the line exposes. So one line can feed several tracks, but only
  tracks bound to that one (first-matched) filter. This is intentional — the user
  chose first-match over union, because the multi-timestamp case is "one filter
  with several ts fields", which first-match already covers.
- **Any numeric field can be a timestamp**, not just `time`-typed ones
  (`int | hex | float | time`). `time`+`hms` parses clocks; plain numbers need a
  declared unit. All times normalize to **nanoseconds**.
- **Spans pair within one line and one filter.** A `span` track reads a start
  field and an end field, both from the same filter on the same line.
- **View is a tab** in the main dock (alongside Filters / Compare / Bookmarks).

### Decision history (so the shape isn't re-litigated)
- v0 (abandoned): one track = one whole filter; plot all its matches. Too coarse;
  no field choice.
- v1 (built, this branch): tracks auto-derived one-per-`time`-field, **keyed by
  field name, no filterId**; line-driven; first-match extraction. Got the canvas
  + a compact config list working.
- v2 (this doc): tracks become a **user-owned list keyed by `(filterId, field)`**,
  configurable per row (DnD reorder, collapse, rename, point/span, field, unit),
  any numeric field, plus Perfetto-style canvas interactions. The `filterId` is
  back because the user's unit of meaning is `filter + field`, not a bare field
  name (two filters can reuse a field name; one filter can host many ts fields).

## Time units — the one real parsing risk

`time`/numeric field text comes in a few shapes:

| Shape | Example | Unit |
|---|---|---|
| Clock, self-describing | `12:30:01.442`, `01:05.7` | known (→ ms) via `parseTime` |
| Plain number | `12345` | **ambiguous: s / ms / µs / ns** |

Plain numbers carry no unit, so the user **must declare it**. The unit lives on
the **`TimelineSource`** (independent of the filter's field defs — the same field
can mean different things to different timelines):

```ts
type TimeUnit = "hms" | "s" | "ms" | "us" | "ns";   // "hms" = parse as clock
```

- Default guessed from the field name (`guessUnit`): suffix `*_ns` / `*_us` /
  `*_ms` / `*_s` → that unit; otherwise `"hms"`. Editable per track.
- `coerceValue(raw, "time", unit)` (and internal `coerceTime`) is unit-aware.
  `"hms"` keeps today's `parseTime`; plain numbers multiply by the unit's factor.
  No unit = legacy ms-ish (compare-table path, unchanged).

### Canonical base
All event times normalize to **nanoseconds (integer `Number`)**:
`hms`/`parseTime` yields ms → ×1e6; `s` ×1e9; `ms` ×1e6; `us` ×1e3; `ns` ×1.
float64 holds integers exactly to ~9×10¹⁵ ns ≈ **104 days** — ample for firmware
debug windows. Axis ticks and Δ readouts are **display-adaptive** (`s/ms/µs/ns`
from the current zoom range); the user never declares a display unit.

## Data model

```ts
interface TimelineSource {        // one track = one (filter, field)
  id: string;
  filterId: string;              // the filter this track binds to
  timeField: string;             // a numeric field of that filter (point time / span start)
  lane: string;                  // display label (default = timeField)
  kind: "point" | "span";
  endField?: string;             // span: the end field (same filter, same line)
  unit: TimeUnit;                // normalized to ns
  color?: string;                // default = per-track palette
  collapsed?: boolean;           // row collapsed in the config list
  hidden?: boolean;              // hidden from the canvas without deleting config
}

interface FilterSet { /* …existing… */ sources?: TimelineSource[] }  // ordered, user-owned
```

`FilterSet.sources` is the ordered track list (array order = DnD order). Track
edits go through `patchState` (undoable). The added **line set** is separate
ephemeral React state (not persisted, not undoable). Track config travels with
saved filter files; `filterFile.ts` de-dupes/validates by `filterId:timeField`.

## Extraction (logic.ts)

```
buildTimeline(view, lineNumbers, tracks): EventMark[]
  visible = tracks where !hidden
  for n in sorted(lineNumbers):
    row    = view.rows[n-1];          fid = row.fieldsFromId    // first-match filter
    if !fid: continue
    fields = view.fieldsFor(n)        // that filter's parsed fields (lazy)
    for tr in visible where tr.filterId === fid:
      sv = fields[tr.timeField]; if !sv: continue
      t  = coerceTime(sv.raw, tr.unit)                 // → ns
      end = (tr.kind==="span" && tr.endField)
              ? coerceTime(fields[tr.endField]?.raw, tr.unit) : —
      push { lane: tr.lane, t, end, lineN: n, label: text, color: tr.color, fields }
```

- `numericFieldsOf(filter)` returns the filter's `int|hex|float|time` fields — it
  feeds the *Add track* / per-row field & end-field pickers.
- `EventMark.fields` carries the source line's parsed fields for the hover card.

## UI — Timeline tab

```
┌─ Timeline ─────────────────────────────────[ fit ]┐
│ canvas: lanes stacked; points = ticks, spans = bars │
│   • hover → full-height vertical guide line + tip   │
│   • drag across body → measure band, shows Δ        │
│   • click a mark → jump to that log line            │
│─────────────────────────────────────────────────────│
│ Tracks            [ + Add track ]                    │
│ ⠿ ▸ [lane name] [filter▾] [field▾] point/span unit 👁⌫│
│ ⠿ ▸ … (dnd-reorderable, each row collapsible)        │
└──────────────────────────────────────────────────────┘
```

- **Track list**: user-owned, dnd-kit reorderable; each row is collapsible and
  carries: drag handle, collapse toggle, rename input, filter picker, field
  picker (`numericFieldsOf`), point/span (+ end-field picker for span), unit, hide,
  delete. `+ Add track` appends a default track (point, name=field, unit=guess).
- **Canvas** (same approach as the minimap): lanes top-down; points as marks,
  spans as bars; wheel-zoom (cursor-anchored), top axis. Interactions:
  - **hover** → full-height vertical guide line across all lanes + tooltip
    (label, formatted time, line number, parsed fields).
  - **drag across the body** → measure band; readout shows the swept duration
    (display-adaptive). Pan moves to **shift-drag / axis-strip drag** so plain
    drag is free for measuring (final pan affordance TBD during build).
  - **click a mark** → scroll the log view to that line.

## TODO — implementation  (done 2026-06-14)

Built in order: types → logic + tests green → App → panel → canvas → persistence.

- [x] **types.ts** — `TimelineSource` gained `filterId: string` and `collapsed?: boolean`.
- [x] **logic.ts** — `buildTimeline` now matches tracks by
      `tr.filterId === row.fieldsFromId` (first-match kept); added
      `numericFieldsOf(filter)` and `laneColor(i)`; removed the dead
      `timelineTracks` derive and `timeFieldNames`. `coerceTime`/`guessUnit` unchanged.
- [x] **__tests__/timeline.test.ts** — covers filterId matching, first-match
      precedence, one filter with several ts fields → several tracks, span within
      one filter, non-`time` numeric field + unit, hidden track skipped,
      `numericFieldsOf`.
- [x] **App.tsx** — `tracks = set?.sources ?? []` (derive dropped);
      `addTrack` / `removeTrack` / `reorderTracks` + `setTrack` (keyed by id), all
      via `patchState`; passes the set's filters to the panel for the pickers.
- [x] **TimelinePanel.tsx** — `+ Add track` composer (filter → field); dnd-kit
      reorderable rows; per-row collapse + filter/field/kind/end/unit/color/hide/
      delete controls; collapsed summary row.
- [x] **TimelineCanvas.tsx** — full-height hover vertical guide line;
      drag-to-measure band with adaptive Δ readout (+ "clear Δ"); pan moved to
      shift-drag / axis-strip drag. Wheel-zoom, fit, click-to-jump, hover card kept.
- [x] **filterFile.ts** — `importSources` carries `filterId`/`collapsed`, requires
      a `filterId`, de-dupes by `filterId:timeField`; round-trip test updated in
      `filterFile.test.ts`.
- [x] **styles/logsy.css** — `.tlc-clear` button (measure clear). Track rows use
      Tailwind utilities; guide line + measure band are canvas-drawn.

## Files

| File | Change |
|---|---|
| `src/types.ts` | `TimelineSource.filterId`, `TimelineSource.collapsed` |
| `src/logic.ts` | `buildTimeline` (filterId match), `numericFieldsOf`, drop derive |
| `src/components/TimelinePanel.tsx` | user-owned DnD/collapsible track rows + Add track |
| `src/components/TimelineCanvas.tsx` | hover guide line, drag-to-measure, pan rebind |
| `src/App.tsx` | add/remove/reorder track wiring, pickers, click-to-jump |
| `src/styles/logsy.css` | track row / handle / collapse / measure band / guide line |
| `src/__tests__/timeline.test.ts` | filterId match, first-match, multi-ts, span, numeric unit |
| `src/__tests__/filterFile.test.ts` | sources round-trip with filterId |
