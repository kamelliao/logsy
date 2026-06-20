# Design: Live match preview + create-filter-from-selection

Status: in development on `feat/regex-builder` (2026-06-10)

Goal: cut the effort of writing filter regexes by exploiting the one thing
generic regex tools don't have — the corpus is already loaded. Two features:

1. **Live match preview** in EditModal: see matching lines (with per-named-group
   coloring) while typing the pattern.
2. **Create filter from selection**: select text in the log, generalize it into
   a regex (numbers → `\d+`, hex → `0x[0-9A-Fa-f]+`, …), tweak via token chips.

## Key design decisions

- **No grex / no Rust for phase A.** Single-example generalization is a small
  TS tokenizer (`src/lib/generalize.ts`). grex (Rust crate) is reserved for a
  possible phase B: multi-example convergence ("create filter from N selected
  lines") via a `suggest_regex` Tauri command.
- **Chips are one-way (chips → pattern).** Once the user edits the pattern text
  by hand, chips disable (with a Restore button). No regex→chips reverse
  parsing — that's where visual regex builders die.
- **Capture state ties into existing fields.** Cycling a chip to "capture"
  emits a named group, which the existing `deriveFields` machinery picks up as
  a parsed field automatically.
- Tokenizer recognizes: timestamps (`12:30:01.442`), `0x` hex, bare hex
  (≥4 chars, must contain a letter), floats, ints, whitespace runs.
  Deliberately **no MAC / IP rules** (out of scope per review).

## Feature 1 — live preview

- `logic.ts` gains `scanMatches(lines, re, limit)` — one pass returning total
  count + first 200 matching lines (replaces the EditModal's `countMatches`
  call so there's no double scan), and `groupSegments(text, re, groupOrder)` —
  like `segments` but tags named-group spans with their index so the preview
  can color each field. Requires the regex compiled with the `d` flag
  (indices; ES2022, fine in WebView2).
- EditModal: the "N lines match" line becomes a toggle header above a
  scrollable ~180 px pane listing sample matches; whole-match spans get a soft
  highlight, named-group spans use palette `--rxg-0…5`. The same palette tints
  named-group parens in `RegexInput` and dots in the Parsed-fields list, so
  pattern ↔ preview ↔ fields visually correspond.
- Scan is deferred via `useDeferredValue` so typing stays responsive on huge
  files. Pane open/closed state persists in `localStorage` (UI pref, not
  AppState).

## Feature 2 — from selection

- LogView's selection popup gains a second button: "Filter as pattern…"
  (existing button = exact text, unchanged). Multi-line selections seed from
  the first non-empty line.
- `App.openFilterFromPattern(text, mode)`: `"pattern"` mode tokenizes the
  selection, opens EditModal with `regex: true`, the built pattern, and
  `genSeed` (the raw selection).
- EditModal with `genSeed` shows a chips row above the pattern field. Each
  detected token cycles exact → generalized → capture (text tokens are
  exact-only; whitespace toggles exact ↔ generalized). Capture chips get an
  inline name input (default names: ts/hex/num/val, deduped). Every change
  rebuilds the pattern and the live preview refreshes — that's the feedback
  loop.

## Files

| File                                  | Change                                                    |
| ------------------------------------- | --------------------------------------------------------- |
| `src/logic.ts`                        | `scanMatches`, `groupSegments`                            |
| `src/lib/generalize.ts`               | new: tokenizer + `buildPattern` + name assignment         |
| `src/components/EditModal.tsx`        | preview pane, chips row, `genSeed` prop                   |
| `src/components/LogView.tsx`          | second sel-menu button, `onBuildFilter` mode arg          |
| `src/components/RegexInput.tsx`       | per-named-group tint classes `g0…g5`                      |
| `src/App.tsx`                         | `openFilterFromPattern` mode + `genSeed` in editing state |
| `src/styles/logsy.css`                | `--rxg-*` palette, `.mp-pane`, `.gen-chips`               |
| `src/__tests__/logic.preview.test.ts` | scanMatches / groupSegments                               |
| `src/__tests__/generalize.test.ts`    | tokenizer / buildPattern                                  |
