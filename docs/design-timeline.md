# Design: Event timeline from parsed timestamp fields

Status: **v2 implemented 2026-06-14** (branch `feat/event-timeline`, not committed). Tests green.

### v2.8 refinements (2026-06-14)

- **Bug fix — only one track survived a reload.** `normalizeState` (the
  localStorage-load path) still de-duped `g.sources` by **`timeField` alone**
  (leftover v1 logic), so tracks sharing a field name (several filters each
  exposing `ts`/`time`) collapsed to one. Now de-dupes by the v2 key
  **`filterId:timeField`** and requires a `filterId` string, matching
  `filterFile.ts:importSources`. Regression test in `timeline.test.ts`.
- **Filter chip → hover card (no Edit modal).** A track row's filter chip no
  longer opens the Edit modal; it's a read-only `HoverCard` (`ui/hover-card`)
  showing serial + description, the pattern, the filter's time fields (active one
  marked), and flags. `TimelinePanel.onEditFilter` prop dropped (App's
  `openEditFilter` stays for the Filters tab).
- **Timeline can pop out — and SHARES one dock with Compare.** Compare and
  Timeline, when popped, live as **tabs in a single popped dock** on the side
  opposite the main panel (never two stacked docks). New
  `AppState.timelinePopped`, plus a shared `poppedActiveTab: "compare" |
"timeline"` and `poppedCollapsed` that **replace** the old per-panel
  `compareCollapsed`/`timelineCollapsed` (migrated in `normalizeState`). One `pop`
  dock entry (ref `popRef`), one `popDockNode` (collapsed → simple strip head;
  expanded → `panel-tabs` over the popped tabs + the active body), one resize
  effect. `popCompareOut`/`popTimelineOut` set `poppedActiveTab` + expand;
  dock-back returns that panel to the main tabbed dock and focuses the other in
  the popped dock. Pop-out button sits in the main tab-bar header when
  Compare/Timeline is the active tab.

### v2.10 — canvas: hover keyboard nav + scroll under the sheet (2026-06-15)

- **WASD works on hover, not click-to-focus.** The canvas keyboard nav was bound
  to `onKeyDown` (needed DOM focus → a click first). Replaced with a window
  `keydown` listener gated on a `hoverRef` (set on `onPointerEnter`, cleared on
  leave), so A/D pan + W/S zoom act whenever the cursor is over the canvas. Guarded
  to skip when an `INPUT`/`TEXTAREA`/contenteditable is focused, so it never
  hijacks typing. `tabIndex`/`onKeyDown` removed from the `<canvas>`.
- **Lanes behind the sheet are scrollable; canvas stays full height.**
  `.tl-sheet` is `position:absolute; bottom:0` (overlays the canvas). The canvas
  reserved only `HANDLE_H`, so a pulled-up sheet hid the lower lanes with no way to
  scroll them up. Fix keeps the canvas **full height** (no resize → no jump when
  the sheet drags) and instead extends its scroll range: the panel passes the
  covered height as `bottomInset = renderH − HANDLE_H`, and the canvas adds it to
  the scroll spacer (`spacerH = max(0, contentH − size.h + bottomInset)`) so the
  bottom lanes can be scrolled up from behind the sheet. (A first attempt shrank
  the canvas viewport to `paddingBottom: renderH` — rejected: it made the canvas
  jump on every sheet drag.) `MIN_PLOT_H` 90 → 120 so a usable strip (minimap +
  axis + a lane) always stays uncovered above the sheet.
- **Canvas goes full-width / frameless so its scrollbar aligns with the sheet's.**
  `.tlc-wrap` and `.tlc-mm` dropped their `border` + `border-radius`; the canvas
  container dropped its `px-2.5` inset. The plot now runs edge-to-edge (like the
  log view), so `.tlc-wrap`'s scrollbar sits at the panel's right edge, lined up
  with the bottom sheet's (`.tl-sheet-body`) — both full-width with `.scroll` +
  `scrollbar-gutter: stable`. Minimap keeps a `border-bottom` divider (suppressed
  via `.tlc-mm:empty` when there are no events).

### v2.9 — per-track line counts + gutter marker (2026-06-14)

The added-line set was near-invisible (only aggregate counts + canvas marks). This
surfaces it **without re-rendering log text** (that would duplicate the log view).

- **Per-track count badge** `inTl / matching` (e.g. `12/40` = on-timeline /
  matchable) on each track row, left of the import/clear buttons. App's
  `trackLineStats` stays `{matching, inTl}`.
- **`.intimeline` gutter marker** in the log view (mirrors `.incompare`): a teal
  inset bar (`--tl-accent`, #0d9488) on timeline lines; a line in both compare and
  timeline stacks blue 0–2px + teal 2–4px. So which lines are on the timeline is
  visible _in context_ while scrolling the log — this is the canonical "which
  lines" surface, alongside the canvas marks.
- **Orphan hint** — a bounded one-liner in the sheet hint area when there are
  lines on the timeline that **no track plots** ("added but nothing shows"): a
  count + **Jump** (to the first) + **Remove** (all). `orphanLines` = timeline
  lines absent from `marks`. This is the one thing not visible via the badge /
  gutter / canvas, so it's the only added-line detail the panel shows.

#### Rejected: a per-line "Lines" index (built, then removed)

A `Tracks ⇄ Lines` toggle with per-track chip lists (in-timeline + an expandable,
capped candidate list, dot=toggle / number=jump, "Not plotted" group) was built
and then **removed**: it duplicated what the badges + gutter marker + canvas
already convey, and one DOM node per added line doesn't scale (a filter matching
tens of thousands of lines, plus "add all"). The added-line set already scales the
canvas/marks, so listing it per-line added cost without unique value. Kept only the
cheap, bounded pieces (badge, gutter, orphan hint). Also rejected earlier: a
full-text line list (duplicates the log), a "timeline-only" log-view filter (can't
_add_ not-yet lines), and minimap ticks (deferred).

### v2.8 refinements (2026-06-17)

- **Filter-row timeline menu is now a checkbox toggle.** Each usable field shows a
  ✓ (`Check` icon) when it's already plotted as a track; clicking toggles it — adds
  when off, removes when on. Single-field rows flip the label between _Add to
  timeline track_ / _Remove from timeline track_; multi-field rows use a _Timeline
  tracks_ submenu with a ✓ per field (sub-trigger shows ✓ only when all are tracked).
  The old "Track already exists" toast is gone (re-clicking now removes). Wiring:
  `FilterPanel` derives a memoized `filterId → tracked field names` map from
  `set.sources` and threads a stable `trackedFields` array into each row's menu;
  App's `addTrack` became `toggleTimelineTrack` (`onAddTimelineTrack` →
  `onToggleTimelineTrack`).

### v2.7 refinements (2026-06-14)

- **`+ Add track` button removed.** It was the lowest-context of the three add
  paths — a mini filter picker rebuilding a selection the user already has in the
  Filters tab. Adding a track now happens where the context is: the **filter row's
  right-click → _Add to timeline track_** (one item per usable field), backed by the
  line→track auto-create (A2). The panel's `AddTrack` composer, `usableFilters`, and
  the `onAddTrack` prop were dropped (`addTrack` stays in App for the filter menu).
- **Empty Tracks state uses a shadcn `Empty` component** (new `ui/empty.tsx`):
  `ChartNoAxesGantt` icon + "No tracks yet" + guidance pointing at the right-click
  path. The old header empty-state hint (the `tracks.length === 0` branch that also
  mentioned `+ Add track`) was removed; the header hint now starts at the
  "lines" stage (`lineCount === 0`).

### v2.1 refinements (2026-06-14)

- **Add a track from the filter list**: a filter row's right-click / ⋮ menu now
  offers _Add to timeline track_ (one item per numeric field when the filter has
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

### v2.6 polish (2026-06-14)

- **Per-row import + clear, with disabled states.** Each track row now has a
  `ListMinus` _clear_ button left of the `ListPlus` _import_ button. App computes
  `trackLineStats: Map<trackId, {matching, inTl}>` (per track: matching lines via
  `winnerLines`, and how many are already on the timeline); import is disabled when
  all matches are already added (`inTl === matching`) or there are none, clear when
  none are on the timeline (`inTl === 0`). `onClearTrackLines` removes just that
  track's lines.
- **Track DnD locked to the vertical axis** via `restrictToVerticalAxis`
  (`@dnd-kit/modifiers`) on the `DndContext` — no sideways drift.
- **Field-picker labels** are terse + context-aware: the start select reads
  _"Time field"_ for a point, _"Start field"_ once an end exists; the end select
  reads _"End field"_.
- **Toast switched to a light theme** — `.logsy-toast` was an inverted dark chip
  (`background: var(--text)`, white text); now white bg, `var(--text)` text,
  `var(--border)` border, `var(--text-2)` icon.

### v2.5 refinements (2026-06-14)

- **Guidance moved above the canvas.** The empty-state hint (incl. the _add all
  matching lines_ button) now sits in the panel header, **left of the
  "N events · N lines" counts**, instead of below the canvas.
- **Added lines persist across reload, per file.** `timelineLines` is no longer
  ephemeral React state — it lives in `AppState.timelineLinesByFile` (a
  `Record<fileId, number[]>`), derived back into a `Set` per active file. Mutations
  go through plain `setState` (persisted, **not** undoable). The file-switch reset
  effect no longer clears it (each file reads its own set); only `compareLines`
  still resets there.
- **Time field restricted to numeric / time-like fields.** A field can back a time
  field only if its declared type is numeric (`int|hex|float|time`) **or** a sampled
  matched value passes `isTimeLike()` (int / hex / decimal / clock — judged on the
  VALUE, since a char-set test on the regex source is unreliable: quantifiers, char
  classes, hex). App computes `timeFieldsByFilter: Map<filterId, Set<field>>` in one
  O(rows) pass (sampling ≤20 winner lines per provider that has string-typed
  fields), threaded into the panel's pickers (`fieldsOf`) and used for A2's
  auto-track field choice. `trackFieldsOf` (returns all fields) is now filtered by
  this allow-set at the call sites.
- **Span UX — kind derived from the end field; field "pill".** The `Mark kind`
  select is gone. The start field and (for a span) the end field live together in
  **one bordered pill** (`inline-flex … rounded-md border`), with the inner
  `SelectTrigger`s stripped to borderless (`border-0 bg-transparent shadow-none`)
  so the pill reads as a single control. A point shows `[ field ] +`; the `+`
  reveals `[ field ] → [ end ] ✕` (the `MoveRight` arrow only ever sits _between
  the two field selects_, never next to the unit). Picking an end sets
  `kind:"span"`; the `✕` clears it back to `kind:"point"`. The **unit select stays
  OUTSIDE the pill** — the earlier inline `→`-before-unit adder read as a false
  "field → unit" span, which this fixes. (`TimelineSource.kind` is still written
  for `buildTimeline`; local `addEnd` reveals the end picker before a field is
  chosen; the `+` only shows when the filter has another field to pair.)

### v2.4 — affordance: auto-bridge the two-step setup (2026-06-14)

The timeline needs two inputs (a **track** = filter+field, and **lines**), declared
in two places with AND semantics — so either one alone yields an identical empty
canvas, and the user can't tell which step they're missing. The two directions are
asymmetric: **track→lines is deterministic** (the filter already knows its matching
lines) so it can be auto-filled; **line→track is ambiguous** (which field is the
timestamp?) so it's offered, not silent. Fixes (App.tsx only; model/persistence
untouched):

- **A1 — per-row "import matching lines" button.** Creating a track only _defines
  what to plot_; it does **not** auto-pull lines (that conflates "define a measure"
  with "load data" and could flood the canvas). Instead each track row has a
  `ListPlus` button → `importTrackLines(tr)`, which adds that track's
  `winnerLines(filterId, timeField)` (visible lines where this filter is the
  **first-match winner** and exposes the field — exactly the lines that produce a
  mark) with a `"N lines imported"` toast. Explicit, per-track, affordance next to
  the track.
- **A2 — adding lines with no matching track creates one.** The LogView _Add to
  timeline_ handler is now `addLinesToTimeline`: after adding, it finds the distinct
  first-match filters among the added lines that have **no track**, and **batches**
  one track each (`field = trackFieldsOf(f)[0]`) into a **single undoable patch** +
  one toast, then switches to the Timeline tab. Batching is the fix for a
  multi-filter selection spawning overlapping prompts. These tracks are created with
  **autofill:false** — the user already picked the lines, so don't flood the
  filter's other matches.
- **B — empty-state bridge button.** The "tracks exist, no lines" hint gained an
  inline **add all matching lines** button → `addAllMatchingLines` (every visible
  track's `winnerLines`). Backs up A1 after a _Clear lines_.
- `winnerLines` / `buildTrack` factored out and shared by all three paths;
  `TimelinePanel` gained `onAddMatchingLines`.

### v2.3 refinements (2026-06-14)

- **Hover card no longer clipped**: `.tlc-wrap` is `overflow:hidden` (rounded corners
  - resize strip), so a tall absolutely-positioned tooltip got cut off. Now the card
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
  `timelineLines: Set<number>`, reset on file switch; right-click → _Add to
  timeline_, like the compare panel).
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
  - a compact config list working.
- v2 (this doc): tracks become a **user-owned list keyed by `(filterId, field)`**,
  configurable per row (DnD reorder, collapse, rename, point/span, field, unit),
  any numeric field, plus Perfetto-style canvas interactions. The `filterId` is
  back because the user's unit of meaning is `filter + field`, not a bare field
  name (two filters can reuse a field name; one filter can host many ts fields).

## Time units — the one real parsing risk

`time`/numeric field text comes in a few shapes:

| Shape                  | Example                   | Unit                            |
| ---------------------- | ------------------------- | ------------------------------- |
| Clock, self-describing | `12:30:01.442`, `01:05.7` | known (→ ms) via `parseTime`    |
| Plain number           | `12345`                   | **ambiguous: s / ms / µs / ns** |

Plain numbers carry no unit, so the user **must declare it**. The unit lives on
the **`TimelineSource`** (independent of the filter's field defs — the same field
can mean different things to different timelines):

```ts
type TimeUnit = "hms" | "s" | "ms" | "us" | "ns"; // "hms" = parse as clock
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
interface TimelineSource {
  // one track = one (filter, field)
  id: string;
  filterId: string; // the filter this track binds to
  timeField: string; // a numeric field of that filter (point time / span start)
  lane: string; // display label (default = timeField)
  kind: "point" | "span";
  endField?: string; // span: the end field (same filter, same line)
  unit: TimeUnit; // normalized to ns
  color?: string; // default = per-track palette
  collapsed?: boolean; // row collapsed in the config list
  hidden?: boolean; // hidden from the canvas without deleting config
}

interface FilterSet {
  /* …existing… */ sources?: TimelineSource[];
} // ordered, user-owned
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
  feeds the _Add track_ / per-row field & end-field pickers.
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

## TODO — implementation (done 2026-06-14)

Built in order: types → logic + tests green → App → panel → canvas → persistence.

- [x] **types.ts** — `TimelineSource` gained `filterId: string` and `collapsed?: boolean`.
- [x] **logic.ts** — `buildTimeline` now matches tracks by
      `tr.filterId === row.fieldsFromId` (first-match kept); added
      `numericFieldsOf(filter)` and `laneColor(i)`; removed the dead
      `timelineTracks` derive and `timeFieldNames`. `coerceTime`/`guessUnit` unchanged.
- [x] \***\*tests**/timeline.test.ts\*\* — covers filterId matching, first-match
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

| File                                | Change                                                           |
| ----------------------------------- | ---------------------------------------------------------------- |
| `src/types.ts`                      | `TimelineSource.filterId`, `TimelineSource.collapsed`            |
| `src/logic.ts`                      | `buildTimeline` (filterId match), `numericFieldsOf`, drop derive |
| `src/components/TimelinePanel.tsx`  | user-owned DnD/collapsible track rows + Add track                |
| `src/components/TimelineCanvas.tsx` | hover guide line, drag-to-measure, pan rebind                    |
| `src/App.tsx`                       | add/remove/reorder track wiring, pickers, click-to-jump          |
| `src/styles/logsy.css`              | track row / handle / collapse / measure band / guide line        |
| `src/__tests__/timeline.test.ts`    | filterId match, first-match, multi-ts, span, numeric unit        |
| `src/__tests__/filterFile.test.ts`  | sources round-trip with filterId                                 |
