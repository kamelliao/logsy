# State migration spec — hand-rolled store → Zustand

Status: **implemented** (phases 1–7 + cleanup done) · Target: `src/App.tsx` +
`src/hooks/*` + `src/state/*`

> All phases landed as static-verified commits (tsc / eslint / 79 tests / vite build
> green throughout; 8 pre-existing dnd-kit×React19 tsc errors are unrelated). The
> running Tauri GUI has **not** been smoke-tested by the author — do that before
> shipping (open/edit/delete filters, drag layout, save/load filter files, undo/redo,
> "view this filter only", switch sets, bookmarks, compare/timeline, file open/drop).

## Why

`useUndoableState` is a hand-rolled single store (one `useState<AppState>` +
`structuredClone` writes + undo stack + localStorage persistence). The action
hooks (`useFilterActions`, `useTimeline`, …) are not state — they are **action
modules** wrapped around the central `patchState`. The pattern is sound; it costs
us two things only:

1. **Prop threading.** `App.tsx` destructures ~100 functions/values out of hooks
   and re-passes them into components. `useMenuDefs` takes ~30 params; `FilterPanel`
   ~25 callbacks. Every new action touches 3 sites.
2. **Re-render / clone granularity.** One `useState<AppState>` → any edit re-renders
   the App subtree; `patchState` clones the whole state per edit. No selector
   subscription.

Goal of this migration: **selector subscriptions** (kills 1 and 2) while keeping
the ergonomics we already like (`patchState(s => { s.x = y })`, 50-step undo,
localStorage persist, safe mode).

## Target stack

```
zustand@5
zustand/middleware        → persist
zustand/middleware/immer  → immer-style set (replaces structuredClone)
src/store/undo.ts         → our own temporal middleware (see "tricky mapping #1")
```

**No zundo.** It's been effectively unmaintained for a while, and we already own a
working undo engine (`useUndoableState.ts:89-143`: past/future ref-stacks, coalesce,
undoable opt-out, 50-cap). Porting _our_ logic into a small zustand middleware is
lower-risk than bending it to fit a third-party temporal API — and it's one fewer
dependency. The undo engine is ~50 lines; we keep its exact semantics.

No Context, no Redux. Rationale and rejected options: see the survey that preceded
this spec (Context/useReducer doesn't fix re-render; Jotai's undo+persist story is
DIY and atomic is wrong for a document-with-undo; RTK is heavier for a single-window
Tauri app).

## What moves vs. what stays

**Decision rule: persisted/undoable state → store. Transient UI signal → local
`useState`. Runtime-derived (depends on `lines`) → memo/selector, never persisted.**

### → Store (the persisted `AppState` document)

Everything currently in `AppState` (`src/types.ts:102`). Split into slices by concern:

| Slice           | Owns (AppState keys)                                                                                                                                                                   | Replaces hook                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `documentSlice` | `files`, `activeFileId`, `recentFiles`, `recentFilterFiles`                                                                                                                            | `useUndoableState` recents + parts of `useLogFiles` |
| `filterSlice`   | mutations over `files[].sets` (filters/groups/sets/layout/bulk) + filter-file IO                                                                                                       | `useFilterActions` (579 LOC, 1:1)                   |
| `layoutSlice`   | `panelPos`, `splitRatio`, `sidebarCollapsed`, `filterCollapsed`, `activePanelTab`, `comparePos`, `comparePopped`, `timelinePopped`, `poppedActiveTab`, `poppedCollapsed`, `panelSizes` | `useDockLayout`                                     |
| `prefsSlice`    | `fontSize`, `fontWeight`, `showLineNumbers`, `mapColorMode`, `mapWidth`, `customPalette`, `timelineSheetH`, `timelineIconSize`                                                         | `useFontZoom` (value only)                          |
| `compareSlice`  | `compareLinesByFile`                                                                                                                                                                   | `useCompare` (persist part)                         |
| `timelineSlice` | `timelineLinesByFile`                                                                                                                                                                  | `useTimeline` (persist part)                        |
| `bookmarkSlice` | `files[].markers`                                                                                                                                                                      | `useBookmarks` (1:1)                                |

Slices compose via the standard Zustand slice pattern (`StateCreator` per slice,
merged in `createStore`). Each slice's actions take `set`/`get` instead of
`patchState`/`stateRef` — **the action bodies are copy-paste**; only the wrapper
changes (see "patchState → set mapping" below).

### Stays a hook (runtime, not store state)

- **`useLogFiles`** — keep. The in-memory `linesStore` (line bodies, deliberately
  NOT persisted — `useLogFiles.ts:18`), `busy`, `dragOver`, `useTransition`, the
  `requestAnimationFrame` paint yield, and the Tauri drag-drop listeners are runtime
  concerns. After migration it _reads/writes_ the store (add/remove file, push
  recent) but still owns IO + transient IO state.
- **`useFontZoom`** — keep the ctrl+wheel listener; the `fontSize` _value_ lives in
  `prefsSlice`. Hook becomes a thin listener calling `zoomIn/out/reset` store actions.
- **`useKeyboardShortcuts`** — keep. Pure side-effect; switch from props to reading
  store actions via the latest-ref it already uses.
- **`useMenuDefs`** — keep as a hook but **stop taking 30 params**: read state +
  actions from the store directly. This is the single biggest prop-threading win.

### Stays local `useState` (transient UI — do NOT centralize)

`editing`, `filterFlash`, `openMenu`, `aboutOpen`, `shortcutsOpen`, `gotoOpen`,
`gotoSignal`, `markerJump`, `selectAllNonce`, `focusSearchNonce`, `paletteModalOpen`,
`appVersion`. These never persist and never undo. Putting them in a global store is
the classic over-centralization mistake.

**Borderline: `soloFilterId`.** Read in 4+ places (LogView, FilterPanel,
useFilterActions, derived `soloView`) but ephemeral (not persisted, not undoable).
Recommendation: put it in a **non-persisted `uiSlice`** so consumers subscribe
directly instead of threading `setSoloFilterId`. Keep `partialize` excluding it.

### Stays a memo (runtime-derived, depends on `lines`)

`compiled`, `view`, `soloView`, `soloFilter`, `compareRows`, timeline `tracks`/
`marks`/`orphanLines`. These derive from the in-memory `lines` + store slices; they
can't live in the persisted store. Keep in a small `useDerivedView` hook (or
`zustand` computed via selector + `useMemo` at call site). `useCompare`/`useTimeline`
shrink to: persisted lines (store) + derived rows (memo over `view`).

## The three tricky mappings

### 1. `patchState` semantics → our own `undo` middleware

We keep the current engine almost verbatim, repackaged as a zustand middleware so
every slice's `set` flows through it. `patchState(fn, opts)` does three jobs today
(a) immer mutate, (b) push undo unless `undoable:false`, (c) coalesce via
`opts.coalesce` — all three carry over unchanged.

**Shape:** `undo(immer(slices))` exposes, alongside the normal store, a `patchState`
on the store API that mirrors today's signature so slice actions read identically:

```ts
// src/store/undo.ts — sketch, ~50 lines, ported from useUndoableState.ts:89-143
type PatchOpts = { undoable?: boolean; coalesce?: string };
interface UndoApi {
  patchState: (fn: (s: AppState) => void, opts?: PatchOpts) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean; // kept in store state so selectors re-render menus
}
```

- **(a) mutate** → delegate to the `immer` middleware's `set(fn)`. Drop the manual
  `structuredClone` in `patchState` (line 118).
- **(b) undoable opt-out** → keep the exact `past`/`future` arrays. On a tracked
  patch, push the prior state before applying; `{undoable:false}` skips the push
  (view mode, find bar, file icon, bookmarks, recents — same call sites as today).
  Snapshots stay cheap: immer gives a new frozen reference, so stacking the prior
  ref costs nothing (same property the current code relies on at line 92-94).
- **(c) coalesce** → keep the `coalesceKey` ref and the "same base already pushed
  this tick" dedupe verbatim (`useUndoableState.ts:104-114`). Nothing about zustand
  changes this logic.
- **limit 50** → keep `HISTORY_CAP` + `shift()`.
- **`canUndo`/`canRedo`** → today they're derived from ref lengths + `bumpHistory`
  re-render. In the middleware, store them as real store fields updated on every
  push/undo/redo, so menu enablement re-renders via a normal selector (no manual
  bump needed).

**Undo scope = whole workspace**, exactly as now. There is no separate "temporal
partialize" to get wrong — the engine snapshots the same `AppState` the current
code does. The only audit needed: confirm the set of actions calling
`{undoable:false}` is unchanged after the port (they are 1:1 copy from the hooks).

> Note: `past`/`future` hold whole-`AppState` snapshots and are **memory-only** (not
> persisted) — same as today. They live in the middleware closure, not in the
> persisted partition.

### 2. Persistence + SAFE_MODE → persist middleware

- `persist` with `name: STATE_KEY`, `version`, and a `partialize` that mirrors what
  we serialize today (whole `AppState`; line bodies already aren't in state).
- **Debounce:** current code debounces writes 300ms (`useUndoableState.ts:55`) +
  flushes on `beforeunload`/`pagehide`. persist writes synchronously by default —
  wrap `createJSONStorage` in a **debounced storage adapter** to preserve the
  large-state write optimization. Keep the `pagehide` flush as a manual
  `store.persist.rehydrate`-independent flush, or set debounce trailing + a flush on
  `pagehide`.
- **SAFE_MODE** (`--safe`): today = skip load + skip save (`persistence.ts`). Map to
  `skipHydration: true` when `SAFE_MODE` and a storage whose `setItem` is a no-op in
  safe mode. Keep the existing safe-mode toast.
- `loadState`/`normalizeState` migration logic → persist `migrate`/`merge`.

### 3. Derived state that hooks currently return

`useCompare`/`useTimeline` return BOTH persisted lines and derived rows. Split:
persisted half → slice; derived half (`compareRows`, `tracks`, `marks`) → `useMemo`
over `view` + the slice's lines, colocated where consumed.

## File layout after migration

```
src/store/
  index.ts           # createStore: persist( undo( immer( ...slices ) ) ), exports useStore + selectors
  undo.ts            # our temporal middleware (ported from useUndoableState undo engine)
  slices/
    document.ts      # files, activeFileId, recents
    filter.ts        # ex-useFilterActions
    layout.ts        # ex-useDockLayout
    prefs.ts         # font/map/palette/timeline prefs
    compare.ts       # compareLinesByFile + actions
    timeline.ts      # timelineLinesByFile + actions
    bookmark.ts      # markers
    ui.ts            # non-persisted: soloFilterId (+ maybe openMenu later)
  persist.ts         # debounced storage adapter + SAFE_MODE handling + migrate
  selectors.ts       # withFile/activeFile/withSet (moved from state/, now store-aware)
src/hooks/           # SHRINK: useLogFiles (IO only), useFontZoom (listener),
                     #         useKeyboardShortcuts, useMenuDefs, useDerivedView
```

## Phased rollout (each phase ships green; tests pass between phases)

1. **[DONE] Scaffold store, no behavior change.** `src/store/index.ts`: zustand +
   `persist` + immer `produce` + the ported undo engine (past/future module refs,
   coalesce, `{undoable:false}`, 50-cap). `useUndoableState` is now a thin adapter
   over the store, so `App.tsx` is untouched. On-disk format kept byte-compatible
   (bare `AppState` JSON under `STATE_KEY`) via a custom debounced raw-storage
   adapter; `--safe` honored via `skipHydration` + no-op writes. `setAutoFreeze(false)`
   to match the old non-frozen snapshot profile.
2. **[DONE] Move one leaf slice end-to-end: `bookmarkSlice`.** Store gained
   `setMarker`/`removeMarker`/`clearMarkers`; `useBookmarks()` is now arg-less and
   store-backed (still feeds `LogView` + marker counts from App); `BookmarksPanel`
   subscribes via `selectActiveMarkers` + action selectors and lost 4 props (now
   takes only `lineText` + `onJump`). PoC for the prop-elimination + selector
   pattern. Verified: tsc clean on changed files, 79/79 tests pass, vite build green.
3. **[DONE] `prefsSlice` + `layoutSlice`.** Font zoom → store (`zoomIn`/`zoomOut`/
   `zoomReset`); `useFontZoom()` is now arg-less (keeps only the Ctrl+wheel listener).
   `useDockLayout()` is arg-less too — it reads `doc`/`setDoc` from the store
   internally and uses `useStore.getState().doc` in place of the old `stateRef`;
   the dock write logic and the `useTransition`/refs/resize effects are unchanged
   (they must stay in the hook, not the store). **Both hooks lost their `interface
Deps`** — the injection of `patchState`/`setState`/`stateRef` is gone, which was
   the real smell behind `Deps`, not the named-param-object itself.
   _Tail (deferred):_ the inline prefs setters still in App/Sidebar
   (`onSetPanelPos`, `onSetMapColorMode`, `onSetMapWidth`, `onSetFontWeight`,
   `toggleSidebar`, `toggleLineNumbers`, `applyPalette`, timeline icon/sheet) already
   route through the store via the adapter's `setDoc`; promoting them to named slice
   actions is cosmetic and can ride along with later phases.

   > **On `interface Deps` generally:** a named param-object type is fine; the
   > anti-pattern is _what_ gets injected. Every hook whose `Deps` carries
   > `patchState`/`setState`/`stateRef` loses that `Deps` entirely as it migrates
   > (bookmarks, font, dock done). `useFilterActions`/`useLogFiles`/`useCompare`/
   > `useTimeline` keep theirs only until their phase lands — do **not** rename
   > `Deps` cosmetically in the meantime; the fix is removal, not renaming.

4. **[DONE — logic; FilterPanel de-prop deferred to 4b] `filterSlice` (the big one).**
   `useFilterActions` (579 LOC) ported 1:1 into `src/store/filterSlice.ts`
   (`createFilterActions(set, get)`, spread into the store) and **deleted**. file/set
   are resolved from the live document (`activeFile`/`activeSet` selectors) instead
   of render-time props. The mixed `interface Deps` is gone; its contents split by
   kind:
   - document/recents (`patchState`/`pushRecent`) → store internals.
   - **UI state** `editing` + `soloFilterId` → a non-persisted **ui slice** in the
     store (`setEditing`/`setSoloFilterId`); App now reads them via selectors, its
     render logic otherwise unchanged.
   - **React/UI primitives** that can't be store state — the confirm dialog
     (`appConfirm`) and the panel `useTransition` — are **bound into the store once**
     via `setRuntime({ confirm, runTransition })` in an App effect, with safe
     fallbacks (`window.confirm` / run-sync) until bound. This is the deliberate
     line: injecting the _document_ was the smell; injecting genuine UI collaborators
     is normal, and we localize it to one binding point.

   App sources the 27 filter actions from the store via a `useShallow` block and
   still threads them to `FilterPanel`/`EditModal`/`useMenuDefs`/`useKeyboardShortcuts`
   (unchanged call sites). Verified: 8 pre-existing tsc errors unchanged, eslint
   clean, 79/79 tests, vite build green.

   **[DONE] 4b — FilterPanel de-prop.** `FilterPanel` now reads the 21 filter
   actions from the store via `useStore` selectors (same local `on*` names → the
   2000-line body is untouched); its props interface dropped from ~30 to 9
   (file/set/counts/style + `onToggleTimelineTrack` [phase 5] + flash×3 +
   focusSearchNonce). App's `<FilterPanel>` call lost 21 props, and App's filter-action
   `useShallow` block shrank from 27 to the 11 it still wires into menus / keyboard /
   EditModal / LogView / focusFilter. Verified: tsc unchanged (8 pre-existing), eslint
   clean, 79/79 tests, vite build green.
   _Optional tail:_ `EditModal` could likewise self-subscribe `saveFilter`/
   `deleteFilter`/`setEditing` (minor; App keeps those 2 actions for it for now).

5. **[DONE] `compareSlice` + `timelineSlice`** with the derived-rows split. Only the
   **persisted-line** mutations moved to the store — compare: `addToCompare`
   (+ surfaces the tab) / `removeFromCompare` / `clearCompare`; timeline:
   `addToTimeline` / `removeFromTimeline` / `clearTimeline` — sharing a `mutateLines`
   helper that edits `{compare,timeline}LinesByFile[activeFileId]` (non-undoable).
   `useCompare` Deps `{view,file,state,setState}` → `{view,file}` (reads
   `compareLinesByFile` + mutations from the store; keeps `compareRows`/CSV/group
   helpers — all view-derived). `useTimeline` Deps
   `{view,file,set,state,setState,patchState,selectPanelTab}` →
   `{view,file,set,selectPanelTab}`: plotted lines + their mutations come from the
   store, and `patchState` (for undoable **track** edits) is read from the store
   internally rather than injected. The heavily view-coupled track logic (tracks,
   marks, timeFieldsByFilter, toggle/import/winnerLines, stats, orphans) stays in the
   hook. `selectPanelTab` stays a Dep — a genuine UI collaborator, not the document
   smell. Verified: tsc unchanged (8 pre-existing), 79/79 tests, vite build green
   (one pre-existing `buildCsv` exhaustive-deps warning left as-is).
6. **[DONE] `documentSlice` + retire `useUndoableState`.** `files`/`activeFileId`/
   recents already live in the store's `doc`, so there was no new slice to write —
   this phase retired the phase-1 adapter. App now reads `state`/`setState`/
   `patchState`/`undo`/`redo`/`canUndo`/`canRedo`/`clearRecent` from the store via
   selectors (reactive `state`/`canUndo`/`canRedo`; a `useShallow` block for the
   stable actions); the SAFE_MODE toast moved to an App effect. `useLogFiles` Deps
   `{patchState,setState,stateRef,pushRecent,appConfirm,file}` → `{file}`: it pulls
   `patchState`/`setDoc`/`pushRecent` from the store, a module-level `getDoc()`
   (`useStore.getState().doc`) replaces `stateRef.current`, and the confirm dialog
   comes from the bound store runtime — so the IO + transient state (linesStore,
   busy, dragOver, transitions, drag-drop listener) is all that's left in the hook.
   `useUndoableState.ts` deleted. **Every document-injection `Deps` is now gone**;
   the only Deps left carry genuine runtime inputs (`file`/`view`/`set`/
   `selectPanelTab`). Verified: tsc unchanged (8 pre-existing), 79/79 tests, vite
   build green (one pre-existing `lines` exhaustive-deps warning left as-is —
   adding `file` would wrongly recompute on every edit).
7. **[DONE] `useMenuDefs` + `useKeyboardShortcuts` de-prop.** Both read the
   store-resident state + actions from the store directly: `useMenuDefs` derives
   `state`/`file`/`set`/`fileViewMode`/`showLineNumbers`/`fontSize` from the doc and
   pulls undo/redo/canUndo/canRedo/clearRecent/zoom×3/openNewFilter/bulk/import/
   append/save×2/loadFilterFromPath from the store — Deps **~30 → 11**;
   `useKeyboardShortcuts` reads undo/redo/zoom×3/openNewFilter + `editing` from the
   store — Deps **~26 → 18**. The Deps that remain are genuine non-store wiring (log
   IO `openFiles`/`loadPaths`, App-local UI signals `openMenu`/dialog toggles/
   `selectAllLines`/`openGoto`/`focusFilterSearch`, dock `toggleFilterCollapsed`, and
   the thin view toggles `setViewMode`/`setFindOpen`/`toggleLineNumbers`) — these are
   **wiring hooks**, and a moderate Deps of real collaborators is correct, not a smell.
   App also shed the now-dead destructures (undo/redo/canUndo/canRedo/clearRecent/
   zoom×3 and 7 filter actions only the two hooks used).
8. **[DONE] Cleanup.** `loadState` deleted from `state/persistence.ts` (the store's
   own `createRawStorage` reads `STATE_KEY` directly); `STATE_KEY`/`SAFE_MODE` stay.
   Architecture memo updated.

## Possible future tidy (not blocking)

- Promote the thin view/layout doc-mutations (`setViewMode`, `setFindOpen`,
  `toggleLineNumbers`, `toggleFilterCollapsed`) into the store so menus/keyboard/App
  stop threading them; deferred because they're widely used and low-value/higher-risk.
- `EditModal` self-subscribe `saveFilter`/`deleteFilter`/`setEditing` (App keeps them
  for it today).
- Extract the inline bookmark/prefs/compare/timeline slices from `store/index.ts`
  into `store/slices/*` files (filterSlice already is one) if the file grows further.

## Risks / watch-items

- **Undo scope drift.** Easiest place to break behavior. The engine is ported 1:1,
  so the guard is simply: confirm every `{undoable:false}` call site survives the
  port unchanged (grep both before and after). The whole-`AppState` snapshot scope
  is identical to today, so there's no new partition to mis-specify.
- **Coalesce fidelity.** Typing/drag currently fold into one undo step. Verify after
  phase 3–4 that a burst still = one step.
- **Persist payload compatibility.** Keep `STATE_KEY` and the same JSON shape so
  existing users' saved workspaces survive the upgrade (add a `migrate` if shape
  shifts). Test a load of a pre-migration localStorage blob.
- **React 19.** zustand v5 supports React 19. (Orthogonal option: React Compiler
  would auto-memo and ease re-render pressure, but does NOT fix prop threading —
  selectors still needed.)
- **Custom middleware correctness.** The one thing we now own that a library would
  have given us: the undo middleware. Mitigated by porting it verbatim and landing
  it behind the phase-1 adapter (old `useUndoableState` API delegates to it) so undo
  is exercised by the existing app before any slice moves.
- **Over-pull selectors.** Subscribing to `s => s.files` re-renders on any file
  edit. Use `useShallow` for multi-field selects and narrow selectors per component.

## Definition of done

- `App.tsx` no longer threads action props into `FilterPanel`/`BookmarksPanel`/
  `TimelinePanel`/`CompareTable`/menus; they subscribe to the store.
- `useUndoableState`, `state/persistence.ts` undo/persist code deleted.
- Undo (50-step, coalesced), localStorage persist, and `--safe` mode behave
  identically (manual parity check + existing tests green).
- Components re-render only on their own slice (spot-check with React DevTools).
