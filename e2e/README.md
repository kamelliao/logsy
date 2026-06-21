# End-to-end tests

Playwright drives the Logsy **frontend** in a real browser with the Tauri IPC
layer mocked. Logsy is a Tauri desktop app, but the official WebDriver bridge
(`tauri-driver`) has no macOS support, so true end-to-end (driving the packaged
app) only runs on Linux/Windows CI. Almost all product logic lives in React; the
thin Rust side (file read/encoding, write, window controls) is covered by Rust
unit tests in `src-tauri`.

## Running

```bash
bun run test:e2e          # headless run
bun run test:e2e:ui       # interactive UI mode
bunx playwright test e2e/filters.spec.ts   # a single file
```

The Playwright config (`playwright.config.ts`) starts the Vite dev server
(`bun run dev`) on port 1420 and reuses an already-running one locally.

## How the Tauri mock works

`support/tauri-mock.ts` installs a stand-in for `window.__TAURI_INTERNALS__`
before any app code runs, so `invoke`, `@tauri-apps/plugin-dialog`, and the event
system behind webview drag-drop all resolve against it. Tests drive it via the
`tauri` fixture:

```ts
import { test, expect, openLog, addFilter } from "./support/fixtures";

test("…", async ({ page, tauri }) => {
  await tauri.setFile("/logs/x.log", "line a\nline b\n"); // read_text_file source
  await tauri.setDialogOpen("/logs/x.log"); // next open dialog result
  // …drive the UI…
  await tauri.drop(["/logs/x.log"]); // simulate an OS file drop
  const calls = await tauri.calls(); // assert write_text_file payloads, etc.
});
```

`openLog` and `addFilter` (in `support/fixtures.ts`) are helpers for the two most
common setup steps.

### Note on dev-mode events

In dev, React StrictMode mounts effects twice, leaving a duplicate drag-drop
listener. The mock delivers each event only to the most-recently-registered
listener, which matches production (one listener) and avoids double-loading
dropped files. See the comment in `tauri-mock.ts`.

## What's covered (P0)

**Convention: one spec file per panel / area** (not one per suite), with nested
`test.describe` blocks inside. This keeps the top-level dir readable as more
panels are covered; Playwright still parallelizes individual tests across workers.

Pure logic (parsing, matching, regex/case, counts) is covered far faster by the
unit tests in `src/__tests__/*` — e2e deliberately does **not** re-test it, and
only asserts that filters drive the rendered `.matched`/`.dim` wiring.

- `open-file.spec.ts` — open via dialog, multi-file tabs, drag-drop, drag-drop
  replace-confirm (keeps filters), reload-on-restart.
- `filter-panel.spec.ts` — the FilterPanel, grouped by area:
  - rows (flags, edit, row menu, delete)
  - enable toggle; matching behaviour (highlight / exclude wiring only)
  - filter sets (tabs): add / switch / rename / delete / duplicate
  - groups: add / collapse / rename / enable-all / delete-keep-filters
  - select mode: range select, batch enable/disable/delete
  - search; import / export (round-trip + non-empty replace confirm)
  - solo "view this filter only"; undo / redo (incl. the in-input guard)
  - reorder (drag & drop): filters, into/out of groups, groups, sets
- `log-view.spec.ts` — the LogView:
  - find in view (Ctrl+F): hit count, next/wrap, no-match, case & regex options
  - matches-only (Ctrl+H) toggle + toolbar button + disabled-without-highlights
  - match map presence; export filtered view (payload via `tauri.calls()`)
  - go to line (Ctrl+G); zoom in/out/reset (Ctrl +/-/0)
- `bookmarks.spec.ts` — the Bookmarks panel:
  - add from the gutter marker + editor popover (icon, note)
  - panel listing, note preview, jump-to-line, remove, clear all, icon filter

### Driving dnd-kit drags

Use the `dragTo(page, source, target)` helper. dnd-kit's PointerSensor needs the
press to move past a 5px activation distance and then several intermediate moves
for collision detection, which the helper does (it also waits a frame before
releasing so a busy machine commits the right drop target). Read resulting order
from inside `.filter-list` — the drag overlay and hover cards render in `<body>`
portals and would otherwise show up as duplicate `.fr-pattern` nodes. These are
the most load-sensitive tests in the suite; if one flakes in CI it's almost
always the drop-target timing.

## Planned next (not yet implemented)

- `timeline.spec.ts`, `compare.spec.ts`.
- Menu bar + remaining keyboard shortcuts; CSV export.
