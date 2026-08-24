# Design: the match pipeline — two phases, one boundary

Status: **implemented 2026-08-24**, branch `perf/match-pipeline`. Steps 0–5 below are
done; what remains is listed at the end.

    time to visible    3547 ms -> 27 ms
    time to complete   3547 ms -> 290 ms

## Why

Three review rounds over that perf work produced **24 real findings**, and the rounds
were diverging, not converging: round 2 contained 1 finding introduced by round 1's
fixes, round 3 contained 7 introduced or widened by round 2's. That is not a code-quality
problem to be fixed by another round. Three structural causes, each with direct evidence:

- **No owner of "what a JS regex means."** The facts live in five places across two
  languages — `JS_WORD`/`JS_SPACE` in Rust, `escapeRegex` in `engine.ts`, "`.` cannot
  cross U+2028" in `scanPrime.ts`, "`i` folds per Unicode" in a `scan.rs` doc comment,
  "`\s` is not ASCII-only" in `uses_js_space`. Nearly every correctness finding was a
  semantics fact that existed in one place and not the others. The clearest case: the
  U+2028 hazard was found and fixed on the JS composition path in round 2, and round 3
  found the _same fact_ unfixed on the Rust path, because nothing connected them.
- **Five hand-rolled "walk a regex source" loops** across three files, each with its own
  notion of what an escape is and where a character class ends. Two findings
  (`[\w-a]` forming a range; the lazy `.*?` slice) were one walker knowing something the
  others did not.
- **The routing decision has no home.** "Who scans pattern P?" is answered by three files
  that must agree. Nothing enumerates the legs, which is why `primeSet` silently had no
  JS leg.

A fourth cause is the one this design is actually built around, and it is the reason the
other three were hard to see:

- **The two phases of the pipeline are interleaved.** `computeView` both _scans_ (fills
  missing bit sets) and _resolves_ (first-win, excludes, counts). The scan half is what
  freezes the window; the resolve half is 3 ms. Because they share a function, every
  mitigation for the scan half — slicing, yielding, cancellation, "which filters are
  slow" tracking — had to be threaded through code that only wanted to resolve.

## The model

```
Phase A — MATCH          pattern × lines → bit set
  Depends ONLY on (lines, pattern). Not on order, enabled, exclude, or colour.
  Expensive, parallel, content-addressable.                            → Rust owns it

  ─────────────────────────────  the boundary is the bit set  ─────────────────────────

Phase B — RESOLVE        bit sets + filter list → view
  first-win winner, excludes, counts, field provider.
  Depends ONLY on the things a filter operation changes.
  Cheap: 3 ms at 20k × 70, 106 ms at 1M × 100.                          → JS owns it
```

Nothing else crosses. Capture-group extraction (`extractFields`) stays in JS: it is lazy,
runs per visible row, and its output feeds JS-side time parsing and the timeline.

### The invariant

> **Phase B is pure and never scans.** A missing bit set is reported, never computed.

This is the whole design. It makes the freeze structurally impossible rather than
mitigated; it puts slicing and cancellation in exactly one place (the Phase A driver);
and it makes "which filters aren't ready" a property the view already knows, deleting the
`jsScanned` side table and its plumbing.

### The cache key is the boundary contract

Bit sets are keyed by `(lines array identity, pattern source + flags)`. Order, `enabled`,
`exclude` and colour are deliberately **not** in the key — that is precisely why
reordering and toggling are free, and it is what makes the operations table below true
rather than aspirational.

## Every filter operation, against this model

| Operation         | Work needed         | Today                                                                                         | After                       |
| ----------------- | ------------------- | --------------------------------------------------------------------------------------------- | --------------------------- |
| reorder           | B                   | ok                                                                                            | `resolve()`                 |
| enable / disable  | B                   | scans disabled filters anyway, for the badge count                                            | `resolve()`                 |
| remove            | B                   | ok                                                                                            | `resolve()`                 |
| add               | A (one pattern) + B | **no priming** — the render cold-scans it                                                     | `ensureMatched` + `resolve` |
| update pattern    | A (one pattern) + B | **no priming**; the edit modal also scans the whole file per keystroke (1.7 s on a 16 MB log) | same                        |
| switch filter set | A (missing) + B     | primed, but the JS leg was missed                                                             | same                        |
| open file         | A (all) + B         | ok                                                                                            | same                        |

Four of seven are wrong or incomplete today, each in a different file. After, every one of
them is a composition of two functions:

```ts
await ensureMatched(lines, patterns); // Phase A driver — the only entry point
const view = resolve(lines, filters); // Phase B — pure, sync, never scans
```

`primeSet` could lose a leg because nothing in the codebase defined what "Phase A is
complete" means. `ensureMatched` is that definition.

## Progressive rendering (the UX this enables)

Today the open path awaits the whole scan before the lines reach the store, because a
render with missing bit sets would cold-scan and freeze. With the invariant in place that
reason disappears, so:

1. **Lines enter the store as soon as they are split.** The log is on screen and
   scrollable immediately — plain text, no highlights.
2. **Phase A runs in the background** and the view re-resolves as bit sets land.
3. **Filters that have no bit set yet render as pending**, not as "zero matches".

Update granularity: the Rust scan returns every pattern in one blob, so it is a single
re-resolve. The JS fallback finishes one pattern at a time — throttle those into batches
rather than re-resolving 119 times.

### Three details this forces us to decide

- **Excludes must not render half-applied.** A highlight filter whose bits are pending
  costs the user a missing colour. An _exclude_ whose bits are pending shows lines that
  should be hidden — a wrong view, not an incomplete one. Excludes are few; Phase A
  should scan them first and the filtered view should wait for them specifically.
- **Counts and "N matched" must read as pending**, not as a settled number that then
  changes. Same for the minimap.
- **Cancel changes meaning**, and improves: it becomes "stop scanning" rather than "abort
  the open". The file stays open and usable; the pending filters simply stay pending with
  a way to resume. That removes the cancelled-restore-leaves-a-blank-file problem
  entirely rather than patching it.

Telemetry follows: `view_ms` stops being meaningful as one number and becomes
**time-to-visible** (read + split) and **time-to-complete** (Phase A done).

## Modules

```
src-tauri/src/matching/       Phase A, entirely (`match` is a keyword)
  syntax.rs      the JS regex semantics table + THE tokenizer (one, not five)
  translate.rs   js pattern -> Runnable | Unsupported(reason)
                   Runnable::Direct(Regex)
                   Runnable::Conjunction(Vec<Regex>)   ← (?=.*A)(?=.*B) is a TRANSLATION,
                                                          not a third route
  scan.rs        parallel scan + wire format

src/lib/match/
  cache.ts       bit set cache (and the bit set ops, in one place)
  ensure.ts      the Phase A driver: IPC, verify, sliced JS fallback, cancellation
  resolve.ts     Phase B: today's computeView with the scanning removed
```

`syntax.rs` is not hand-mirrored in TypeScript. `scripts/crosscheck.ts` compares the
table against real JS `RegExp` behaviour, entry by entry — two hand-written copies are
what let the `\s` bug live as long as it did.

Unrelated tenants of `engine.ts` (≈370 lines of field parsing and time coercion, ≈110 of
timeline) move out separately. Lowest priority: no defect evidence, pure readability.

## What this deletes

- `Composition`, `ScanPlan.compositions`, `branchOnly`, `decomposeAnd`,
  `hasTopLevelAlternation`, `hasLineSeparator`, `POPCOUNT`, `cachedMatchBits` — ≈200
  lines of JS, moved into Rust's translate layer where the decomposition belongs.
- `jsScanned` WeakMap and its plumbing — the view knows.
- `JsReason` as an enum — `Unsupported(reason)` carries a string for the badge tooltip,
  produced by the code that made the decision, so it cannot disagree with it.
- The `matchBitsFor` call inside `computeView` — the phase leak itself.

Roughly 14 of the 24 findings become unable to occur: they are all either "the same fact
maintained by hand in several places" or "a leg someone forgot to call".

## Two things this does NOT change

- **`fancy-regex` was evaluated and rejected.** It does take lookaround and
  backreferences, but it does 1.4–1.5× _more_ work than V8, not less (92k × 180: negative
  lookahead 4010 ms vs 2778 ms; AND idiom 2504 vs 1781). It wins only by being
  off-thread, and it has the identical `.`/U+2028 divergence, so it fixes nothing about
  semantics. The residual JS leg — negative lookahead, lookbehind, backreferences — stays
  in JS, sliced.
- **The semantics translation is needed whatever the engine.** It is the one part of
  every draft of this design that survived, and it is the part with the most defect
  evidence behind it.

## Migration order

Each step was verifiable on its own against the crosscheck harness and the 92k-line
fixture; none was a rewrite.

0. **The `.` translation** (`.` becomes `[^\n\r\x{2028}\x{2029}]`) — a live correctness bug
   producing silently wrong highlights, and also the first line of `syntax.rs`. The perf
   work was then committed as a checkpoint, so `git bisect` stays usable. DONE
1. **`resolve`** — the scanning lifted out of `computeView`. Verified against an
   independent oracle (walk the filters, first enabled non-exclude match wins) over
   every combination of order/enabled/exclude, rather than against the old
   implementation, so a shared misunderstanding could not pass. DONE
2. **`ensureMatched` + `useEnsureMatched`** — one Phase A driver, every operation
   through it. `primeSet`, its store hook and `switchSet`'s sequence guard deleted. DONE
3. **Progressive render** — lines first, pending filters, excludes scanned first. DONE
4. **`matching/syntax.rs`** — one tokenizer and one semantics table. DONE
5. **`matching/translate.rs`** — `decomposeAnd` moved to Rust; the JS composition code
   (`Composition`, `branchOnly`, `POPCOUNT`, `hasLineSeparator`, the AND pass) deleted. DONE

## Still open

- `engine.ts` still houses ~370 lines of field parsing / time coercion and ~110 of
  timeline, neither of which has anything to do with matching. Pure readability, no
  defect evidence — lowest priority, and deliberately not bundled with the above.
- `regexHighlight.ts` keeps its own walker. That one renders a pattern FOR THE USER
  rather than deciding what it means, so it is a different concern, not a fifth copy.
- The `(?i:)` case-folding gap (`k` also matching U+212A) is unchanged. The frontend's
  spot-check downgrades it to a JS scan rather than a wrong highlight.
- Of the last review round's findings, three were in code these steps deleted; the rest
  — `primeSet`'s staleness, the Retry-nonce binding, the slice budget resetting per
  pattern — went with the rewrite of the paths that had them.
