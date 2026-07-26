# Opening large logs: cost model and the Rust pre-scan

Status: **implemented 2026-07-26**. Rust 20 tests + JS 133 tests green;
`bun run test:crosscheck` clean; e2e unaffected.

This documents why opening a big log used to freeze the window, what the cost
actually consists of, and how the Rust `scan_lines` pre-scan removes it. The
measurement traps at the end cost real time to rediscover — read them before
benchmarking anything in this area.

---

## 1. The cost model

Opening a log runs a fixed pipeline. Only one stage matters:

| Stage                          | Where                                             | Scales with         |
| ------------------------------ | ------------------------------------------------- | ------------------- |
| read + decode                  | `read_text_file_blocking`, `src-tauri/src/lib.rs` | file size           |
| IPC (text as JSON)             | Tauri command return                              | file size           |
| `splitLines`                   | `src/hooks/useLogFiles.ts`                        | file size           |
| **first `computeView`**        | `src/lib/engine.ts`                               | **lines × filters** |
| downstream O(rows) derivations | `LogView`, `useTimeline`, minimap                 | lines               |

`computeView` itself is two layers with wildly different costs:

- **Scanning** — run each filter's regex over every line, producing one match
  bitset per filter (`lines/8` bytes each). `O(lines × filters)`.
- **Composing** — from those bitsets, derive per-row winner (colour), exclusions,
  counts and the `ViewRow[]`. `O(lines)`.

At 200k lines × 100 filters on V8, scanning is **856 ms** and composing is
**24 ms**. Scanning is ~97% of the open, and it blocks the main thread.

**Every filter costs the same to scan**, roughly 6.5 ms per 200k lines,
regardless of what its pattern is — a literal that matches 80% of lines, a
literal that matches nothing, and a real regex are all within ~20% of each other.
There is no such thing as a cheap filter; cost is purely a function of count.

Cold `computeView` scaling (JSC, 200k lines, distinct patterns):

| filters | 10     | 30     | 100     | 200     |
| ------- | ------ | ------ | ------- | ------- |
| cold    | 142 ms | 398 ms | 1302 ms | 2676 ms |

Perfectly linear. **File size barely matters at this scale** — at 200k lines /
11.7 MB every non-scan stage combined is under 60 ms. (At a very different shape,
say 160 MB × 30 filters, the balance shifts and peak memory approaches 1 GB; the
model above is worth re-deriving per workload rather than assumed.)

## 2. The match cache, and why priming works

`matchBitsFor` in `src/lib/engine.ts` already cached bitsets before any of this:

```
key = (identity of the lines array) × (regex source + flags)
```

The key deliberately excludes enabled/exclude/colour/order — a bitset answers only
_which lines does this regex match_, which is independent of UI state. That is why
toggling filters, recolouring, and reordering are all fast: they only re-run the
compose layer. Only the **first** view of a file pays the scan, because a new file
means a new lines array, hence an empty cache.

Since a bitset is a pure function of `(lines, regex)`, it does not matter who
computes it. `primeMatchCache` writes bitsets computed elsewhere straight into the
cache, so the first `computeView` is already fully warm:

```
before:  computeView → cache miss → JS scans 856 ms → store → compose 24 ms
after:   Rust scans → prime → computeView → all hits → compose 24 ms
```

`computeView` is unchanged. It still asks the cache for bitsets; it just always
gets them.

## 3. Why the Rust side is fast — RegexSet, not Rust

The common assumption is that the win comes from being native. It does not.
Measured on identical input (200k lines × 100 distinct patterns):

| approach                              | time   |
| ------------------------------------- | ------ |
| JS, one regex per filter              | 856 ms |
| Rust, one regex per filter            | 600 ms |
| Rust, **single `RegexSet` pass**      | 77 ms  |
| Rust, `RegexSet` + rayon (12 threads) | 21 ms  |

Rewriting in Rust buys 1.4×. **`RegexSet` buys 8×**: it compiles all 100 patterns
into one automaton with an aho-corasick/Teddy prefilter, so the text is walked
_once_ for all patterns instead of 100 times. Parallelism then adds another 3.7×.

This is an architectural gap, not a language gap — JS has no equivalent, which is
also why a Web Worker approach tops out around 160 ms.

If rayon were ever undesirable, single-threaded `RegexSet` at 77 ms already
captures 94% of the benefit.

## 4. Architecture

```
useLogFiles.loadPaths
  ├─ invoke read_text_file            → text, encoding, size          (ipcMs)
  ├─ splitLines(text)                 → lines[]                       (jsSplitMs)
  ├─ await primeFor(...)                                              (primeMs)
  │    ├─ scanSpecs(compileAll(set.filters))  → dedup'd {source, ci}[]
  │    ├─ invoke scan_lines            → 2.5 MB blob (raw bytes)
  │    │    └─ Rust: re-read + decode (readMs) → split (splitMs) → RegexSet+rayon (scanMs)
  │    ├─ verify each pattern against the real JS RegExp (sampled)
  │    └─ primeMatchCache(lines, entries)
  ├─ linesStore[id] = lines           → now visible to React
  └─ patchState(...)                  → render → computeView (all cache hits)  (viewMs)
```

Key files:

- `src-tauri/src/scan.rs` — `split_lines`, `rust_source`, `scan_text`. Kept out of
  `lib.rs` so it compiles without tauri, which lets a cross-check tool include it
  via `#[path]` and compare against the real thing rather than a copy.
- `src-tauri/src/lib.rs` — the `scan_lines` command (wraps `scan_text` in
  `spawn_blocking`, times the read).
- `src/lib/engine.ts` — `cacheKey`, `matchBitsFor`, `primeMatchCache`, `hasMatchBits`.
- `src/lib/scanPrime.ts` — `scanSpecs`, blob parsing, `verify`, `scanAndPrime`.
- `src/hooks/useLogFiles.ts` — `primeFor`, called from all four read paths.

`scan_lines` **re-reads and re-decodes the file** rather than taking the text back
over IPC. The read is a few ms off a warm page cache; shipping 12 MB of text in
the other direction would cost more than the scan.

The blob is returned as raw bytes (`tauri::ipc::Response`), never JSON — JSON
would escape and re-parse all 2.5 MB. Tauri sets `application/octet-stream` for
`InvokeResponseBody::Raw` and its `ipc-protocol.js` routes anything that isn't
json/text through `response.arrayBuffer()`, so the JS side receives an
`ArrayBuffer`.

### Wire format

28-byte fixed header; both sides must change together (`scan.rs` ↔ `scanPrime.ts`):

```
u32 nLines | u32 nPatterns | u32 bytesPerPattern | u32 nFallback
u32 readUs | u32 splitUs | u32 scanUs
u32 × nFallback    pattern indices Rust could not scan
u32 × nPatterns    match count per pattern
u8  × nPatterns × bytesPerPattern    bitsets (all-zero for fallbacks)
```

Fallback slots still occupy their bitset space so a pattern's offset stays
`index × bytesPerPattern`.

## 5. Timing is the hard part, not speed

The cache must be filled **before `computeView` first runs**, and `computeView`
runs synchronously inside a React render. So `primeFor` is awaited _before the
lines enter the store_:

```
read → split → ★ await scan + prime ★ → lines into store → render → computeView
```

Priming from an effect instead is always one render too late: the first render has
already paid the 856 ms cold scan, and warming the cache afterwards only helps a
second render that was never slow. This is why the earlier spike needed
view-gating (render an empty view, then repaint colours); awaiting up front
removes that machinery entirely.

All four read paths are wired: `loadPaths` (open dialog / drop), the
restart-reload effect, the split-pane reload effect, and `setFileEncoding` (a
re-decode produces a fresh lines array, i.e. a fresh cache key).

**Switching filter sets** takes the same shape: `switchSet` awaits `primeSet`
before committing the new `activeSetId`, for exactly the same reason. The store
has no access to the lines cache, so App binds `primeSet` as a runtime
collaborator alongside `confirm`. Two things make it cheap:

- The cache is keyed per pattern, not per set, so only the patterns not already
  cached are sent — switching back to a set, or to one sharing patterns with the
  current one, hits throughout and does no IPC at all.
- A `switchSeq` guard means a slow scan landing after a later switch is dropped
  rather than yanking the selection back.

Ordering is pinned by `src/__tests__/switchSet.test.ts` — without it, dropping the
`await` would leave the view correct and merely slow again, which no other test
would notice.

## 6. Regex semantics: Rust must agree with JS exactly

A wrong bitset means wrong highlight colours — silent and hard to notice. Three
layers of defence:

**1. Pattern translation** (`rust_source` in `scan.rs`). The frontend's regexes
never carry the `u` flag, so `\d`/`\w`/`\b` are ASCII-only there while Rust
defaults to Unicode-aware (`\d` would also match `３`). Two forms are tried:

| form       | semantics         | used for      | rejected when                                                                  |
| ---------- | ----------------- | ------------- | ------------------------------------------------------------------------------ |
| `(?i-u:…)` | ASCII, matches JS | most patterns | contains `.` or a negated class (goes byte-wise, which Rust refuses on `&str`) |
| `(?i:…)`   | Unicode           | `.`, `[^…]`   | pattern also uses `\d\w\s\b` — meaning would drift                             |

So `.*` gets scanned, `\w.*` falls back. A case-insensitive pattern containing
non-ASCII text also skips form 1, because JS folds case per Unicode even without
`u`. Lookaround and backreferences are unsupported by Rust's engine and are
reported in the fallback list.

**2. Sampled verification** (`verify` in `scanPrime.ts`). Each primed pattern is
re-checked against the real JS `RegExp` on 48 evenly spread lines plus the first
16 lines Rust claims as hits (the spread alone would not catch an all-zero bitset
on a low-match pattern). Costs ~3 ms for 100 patterns. Any disagreement drops that
pattern, and `computeView` scans it itself.

**3. Cross-check harness** — `bun run test:crosscheck`. `scripts/crosscheck.ts`
generates randomised logs and patterns, runs them through the app's own `scan.rs`
(via `src-tauri/src/bin/crosscheck.rs`, which `#[path]`-includes it rather than
copying it), and compares every bit against real JS `RegExp` results. ~340k
(line × pattern) bits per run, plus pinned cases for CRLF/CR/LF mixes, blank
lines, multi-byte text, emoji, full-width digits, Unicode case folding, and chunk
boundaries — and an assertion that lookaround/backreference/`\w.*` are _refused_
rather than guessed at, so the protection is shown to fire rather than merely to
exist. Exits non-zero on any disagreement.

The helper binary sits behind the `crosscheck` cargo feature, so a normal build —
and therefore `tauri build` — never compiles it.

**Run this after touching `scan.rs`.** The runtime spot-check only downgrades
quietly on a user's machine; this is the only thing that fails loudly.

Every failure mode is a **downgrade, never an error**: no Tauri shell, line-count
mismatch, unsupported syntax, or a failed spot-check all just leave those patterns
for the JS scanner.

## 7. Capture groups and lazy field extraction

`RegexSet` does not report captures, so structured fields must still be extracted
in JS. This does not put the cost back, because the two have different orders:

- **Scanning** is `O(lines × filters)` — every line tried against every filter.
- **Extraction** is `O(requested lines × 1)` — `computeView` already recorded which
  filter owns each row's fields (`fieldsFromId`), so `fieldsFor(n)` runs exactly
  one `exec` on one line: ~0.4 µs.

And `computeView` never calls it — it hands out `fieldsFor` and callers pay only
for the rows they ask about. Measured with 70 of 100 filters carrying named groups
(200k lines, V8):

|                                               | literal filters | 70% with capture groups |
| --------------------------------------------- | --------------- | ----------------------- |
| `computeView` cold                            | 886 ms          | 856 ms                  |
| `computeView` primed                          | 24 ms           | **43 ms**               |
| `fieldsFor`, sampled (20 rows × 70 providers) | —               | **1 ms**                |
| `fieldsFor`, 1,000 rows                       | —               | 0 ms                    |
| `fieldsFor`, all 200k rows (worst case)       | —               | 79 ms                   |

Who actually calls it on open: the Compare panel's pinned lines (empty for a new
file), the timeline's lines (likewise), `useTimeline`'s `timeFieldsByFilter`
sampling (≤20 rows per provider filter → 1 ms), and the row hover card (one row).
The 79 ms figure is an upper bound reached only by importing a whole filter's
matches into Compare — a deliberate user action, and still an eighth of a cold scan.

The primed 24 → 43 ms difference is **compose-layer**, not extraction: with
providers present, `computeView` also maintains a per-row `fieldsIdx` and the
provider map. It cannot be precomputed (it depends on filter order and enabled
state) and is negligible against 856 ms.

Named groups themselves do not prevent priming — `(?<name>…)` compiles fine in
Rust. Of a representative 7-pattern set, 6 primed; the one fallback mixed `\s`/`\w`
with `.`, unrelated to captures.

## 8. Telemetry

Release builds have no devtools console, so a user hitting a slow open cannot
report a console log. `src/lib/openTiming.ts` writes one INFO record per open via
`@tauri-apps/plugin-log`, in [logfmt](https://brandur.org/logfmt):

```
event=open_file file=boot.log bytes=11700000 lines=200000 encoding=UTF-8 filters=100 (primed=100 fallback=0 rejected=0) read_ms=5 ipc_ms=33 js_split_ms=13 rust_split_ms=8 scan_ms=43 prime_ms=3 view_ms=24 total_ms=130
```

A slow open is then self-describing — this one is a network read plus a filter set
Rust mostly could not take:

```
event=open_file file="fw dump v2.log" bytes=480000000 lines=6100000 encoding=UTF-16LE filters=100 (primed=61 fallback=39 rejected=0) read_ms=2100 ipc_ms=4300 js_split_ms=420 rust_split_ms=190 scan_ms=980 prime_ms=3400 view_ms=2600 total_ms=12800
```

Format choices, both of which matter in practice:

- **One line per record.** The log file prefixes each _record_ with a timestamp,
  not each line, so a multi-line record leaves its continuation unprefixed and
  `grep` returns only half of it.
- **logfmt, not prose or JSON.** These records get read two ways — by eye when a
  user sends the file back, and by `grep event=open_file` (or a two-line script)
  when comparing many opens. logfmt serves both; prose defeats the second and JSON
  nested inside the plugin's own text format reads badly for the first. Values are
  quoted only when they contain whitespace, a quote or `=`, so a file name with a
  space in it cannot split the record.
- **One deliberate departure from strict logfmt:** the scan outcome is bracketed
  onto the count it breaks down — `filters=100 (primed=100 fallback=0 rejected=0)`
  — so the three numbers read as one fact. Field-level greps
  (`grep -o 'fallback=[0-9]*'`) still work; a generic logfmt parser would read the
  keys as `(primed` and the last value as `0)`, so strip the brackets first if you
  ever feed these records to one.

The whole pipeline is accounted for, so the record says _which_ stage was slow — a
stalled network read looks nothing like a filter set that fell back to JS. Records
the bare file name and pattern **counts only**, never a path or a pattern, so the
log is shareable.

Stages are measured in two places (IO in `useLogFiles`, `view` in App's memo), so a
record is opened when the file lands and emitted after the first `computeView`;
`finishOpenTiming` is a no-op for files with no pending record, so ordinary
re-renders cost nothing.

`tauri-plugin-log` now registers in release too (`src-tauri/src/lib.rs`). Its
defaults are 40 KB / keep-one — far too small, so a couple of slow opens would
rotate away the interesting ones; set to 2 MB / `KeepSome(3)`. Output goes to
`%LOCALAPPDATA%/dev.logsy.app/logs/`.

Use the **JS plugin API** (`@tauri-apps/plugin-log` plus the `log:default`
capability), not a hand-rolled Rust command. A struct nested inside a command
payload is plain serde — Tauri only bridges naming for a command's own parameters
— so it needs `#[serde(rename_all = "camelCase")]` or every payload silently fails
to deserialize. Since telemetry errors are swallowed by design, the symptom is an
empty log rather than an error. Keep the npm package and the Rust crate on the
same major/minor, or `tauri build` refuses to start.

## 9. Benchmarking traps

Each of these produced a wrong conclusion at least once.

- **The cache key uses a NUL separator** (`source + "\0" + flags`). Read and grep
  render NUL as a space, so a space-separated copy looks identical on screen and
  silently never hits. Now behind a single `cacheKey()` in `engine.ts` — never
  re-inline it.
- **A cache-hit test that passes the true match count proves nothing.** A missed
  cache just re-scans to the same number. Use a sentinel count
  (`src/__tests__/scanPrime.test.ts`).
- **`hasMatchBits` sharing the primer's key format will report phantom hits.**
  Verify through an effect only a real cache hit can produce.
- **The first `computeView` in a fresh JS process takes ~1 s regardless of cache
  state** — the bit loops start interpreted. Warm the JIT before timing or it
  swamps the measurement (this is what made priming first appear to save −31 ms).
- **`scripts/profile.ts` reuses one lines array across runs**, so it measures WARM
  `computeView`. Use a fresh `lines.slice()` per run for cold numbers.
- **Patterns must be distinct.** `matchBitsFor` keys on source+flags, so repeated
  patterns share one entry — 100 filters drawn from 40 distinct patterns measured
  like 47, not 100.
- **Measure Rust in release.** The scan is 43 ms release vs **432 ms debug**
  (10×), because `regex` is unoptimised in debug. Under `tauri dev` the whole
  benefit looks ~1.7× instead of ~6.7×.
- **JSC ≠ V8.** Bun measures ~1302 ms cold where Chromium measures ~856 ms. The
  app runs on WebView2 (V8); use Chromium via Playwright for frontend numbers.

## 10. Results

200k lines / 11.7 MB / 100 filters, release build, V8:

| stage                    | before      | after                                |
| ------------------------ | ----------- | ------------------------------------ |
| Rust read + decode       | 5 ms        | 5 ms                                 |
| IPC (text)               | ~33 ms      | ~33 ms                               |
| JS `splitLines`          | 13 ms       | 13 ms                                |
| Rust scan (`scan_lines`) | —           | 56 ms (read 5 + split 8 + scan 43)   |
| IPC (2.5 MB bitsets)     | —           | not measured directly; ~5–15 ms est. |
| JS verify + prime        | —           | 3 ms                                 |
| **JS `computeView`**     | **856 ms**  | **24 ms**                            |
| **main-thread freeze**   | **~870 ms** | **~40 ms**                           |
| total wait               | ~907 ms     | ~135 ms                              |

The Rust scan runs on a `spawn_blocking` worker, so it does not block the window
even in debug builds — the loading overlay stays responsive.

## 11. Reproducing the measurements

- `bun run scripts/profile.ts --lines=200000 --filters=100` — engine-level, but see
  the warm-cache trap above.
- Cold vs warm and filter scaling: call `computeView(lines.slice(), compiled)` per
  run to defeat the identity-keyed cache.
- Rust side: build a small bin that `#[path]`-includes `src-tauri/src/scan.rs`, and
  run it in `--release` against a real file.
- Frontend numbers: bundle an entry importing `engine.ts` and run it in Chromium
  through Playwright; warm the JIT with a smaller input first.
- Semantics: `bun run test:crosscheck` (see §6). `--seeds=40 --lines=20000` for a
  heavier run before a release.

## 12. Not done

- **Skipping disabled filters.** `computeView` scans them too, only to populate
  badge counts. A set with many disabled filters pays for them; deferring those
  counts to idle would cut the scan proportionally. Judged low value.
- **Bitset disk cache** keyed by path + mtime + pattern hash — would make reopening
  the same log with the same set nearly free, and stacks on top of the above.
- **FilterPanel render cost** with 100+ filter rows is unmeasured and is plausibly
  the second-largest cost on open now that scanning is gone. Needs React Profiler.
