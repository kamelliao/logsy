// --- match scanning for the filter engine ------------------------------------
// The frontend's `computeView` cold path runs every filter's RegExp over every
// line — O(lines × filters) on the main thread, which is what makes opening a big
// log with a big filter set freeze the window (measured ~1.3 s for 200k lines ×
// 100 filters). Here the same work is one RegexSet pass per line (a single
// aho-corasick/Teddy prefilter over all patterns at once, instead of one automaton
// per filter) spread across rayon workers: 21 ms for the same workload. We hand
// back the packed match bit sets so the JS match cache is already warm the first
// time `computeView` runs, and it never does the cold scan at all.
//
// CORRECTION (measured): the RegexSet was the wrong shape. `RegexSet::matches` reports
// WHICH patterns matched, so it can never stop at a first hit and never gets the lazy
// DFA and prefilters a single `Regex::is_match` does. On a real filter set (92k lines x
// 180 chars, 118 patterns) that cost 2565 ms against 96 ms for one Regex per pattern,
// for identical results. Literal-only benchmarks hide it completely — every pattern
// looks the same until one carries a `.*` or a character class. `scan_text` now runs
// one Regex per pattern, parallel over (pattern x chunk).
use rayon::prelude::*;

#[derive(serde::Deserialize)]
pub struct ScanSpec {
  /// The JS `RegExp.source` verbatim — already regex-escaped for literal filters,
  /// so both sides key the match cache off the exact same string.
  pub source: String,
  /// Whether the JS regex carries the `i` flag.
  pub ci: bool,
}

// Lines per rayon task. A multiple of 8 so every chunk's bit set starts on a byte
// boundary and merges into the global one with a plain copy — no bit shifting.
pub const SCAN_CHUNK: usize = 8192;

/// Split exactly like the frontend's `splitLines`: `text.split(/\r\n|\n|\r/)` with a
/// single trailing empty element dropped. The bit sets are indexed by line number,
/// so any disagreement here would silently shift every highlight — the JS side also
/// re-checks the line count before trusting the result.
pub fn split_lines(text: &str) -> Vec<&str> {
  let b = text.as_bytes();
  let mut out: Vec<&str> = Vec::new();
  let mut start = 0usize;
  let mut i = 0usize;
  while i < b.len() {
    match b[i] {
      // CR, CRLF and LF all break a line (the JS alternation tries \r\n first).
      b'\r' => {
        out.push(&text[start..i]);
        i += if i + 1 < b.len() && b[i + 1] == b'\n' { 2 } else { 1 };
        start = i;
      }
      b'\n' => {
        out.push(&text[start..i]);
        i += 1;
        start = i;
      }
      _ => i += 1,
    }
  }
  out.push(&text[start..]);
  if out.last().is_some_and(|s| s.is_empty()) {
    out.pop();
  }
  out
}

// JS `\s` without the `u` flag, spelled out: WhiteSpace ∪ LineTerminator. NEITHER of
// Rust's built-ins is this set — `(?-u:\s)` is ASCII-only, and Unicode `\s` is
// `\p{White_Space}`, which does not contain U+FEFF. Writing it out is what makes a
// translated pattern exactly JS rather than approximately.
const JS_SPACE: &str = concat!(
  r"\t\n\x0B\f\r \x{a0}\x{1680}\x{2000}-\x{200a}",
  r"\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}"
);
// `\w` and `\d` without the `u` flag are ASCII-only whatever the subject text is, so
// a full-width "３" must not match `\d`.
const JS_WORD: &str = "0-9A-Za-z_";
const JS_DIGIT: &str = "0-9";
// JS `.` without the `s` flag is "any code unit except a LineTerminator" — and JS counts
// four of those. Rust's `.` excludes only `\n`, so an unrewritten dot silently crosses a
// U+2028, setting a bit for a line the filter does not match: `/err.*4/` is false on
// "err\u{2028}4" and Rust said true. `splitLines` strips `\n`/`\r`, so only the last two
// can actually occur inside a line — the first two are written out anyway, because the
// point of this table is to say what JS means, not what happens to be reachable.
const JS_DOT: &str = r"[^\n\r\x{2028}\x{2029}]";

/// Whether a pattern uses `\s`/`\S`, the one escape the ASCII form gets WRONG.
///
/// `\d`, `\w` and `\b` really are ASCII-only in a JS regex without the `u` flag, so
/// `(?-u:…)` reproduces them exactly. `\s` is the exception: it is
/// WhiteSpace ∪ LineTerminator, which includes U+00A0, U+3000 and U+FEFF whatever
/// the flags. Scanning `\s+err` in ASCII mode silently missed every line whose
/// separator was a non-breaking or ideographic space — a wrong bit set, not a slow
/// one. Such a pattern goes to form 2, which spells the set out.
///
/// Escaped backslashes are skipped so a literal `\\s` isn't mistaken for the class.
fn uses_js_space(src: &str) -> bool {
  let b = src.as_bytes();
  let mut i = 0;
  while i + 1 < b.len() {
    if b[i] != b'\\' {
      i += 1;
      continue;
    }
    if matches!(b[i + 1], b's' | b'S') {
      return true;
    }
    i += 2; // an escaped char (incl. `\\`) can't start a class of its own
  }
  false
}

/// Rewrite the JS escapes whose meaning differs from Rust's Unicode default into
/// explicit character classes, so a pattern can be scanned in Unicode mode — where
/// `.` and `[^…]` work — without `\d`/`\w`/`\s` drifting.
///
/// This is the whole point of the translation: the previous all-or-nothing wrap had
/// to pick ONE mode for the entire pattern and handed anything needing both back to
/// JS. That is precisely the shape a backtracking JS engine is slowest on — `\w+.*A`
/// over 92k × 180-char lines costs 14.1 s in V8 and nothing measurable here — so the
/// fallback set was selecting for the patterns it could least afford to give away.
///
/// Returns None for anything it cannot translate EXACTLY. That is not a failure path:
/// the caller reports a fallback and JS scans it, which is where it ran anyway.
fn rewrite_js_classes(src: &str) -> Option<String> {
  let mut out = String::with_capacity(src.len() + 64);
  let mut it = src.chars().peekable();
  let mut in_class = false;
  // Set right after `[` or `[^`, where JS reads a `]` as a literal member of the
  // class and Rust reads the class as closed.
  let mut at_class_start = false;
  // An expansion writes several members where JS had one token, so a `-` on either
  // side of it would bind to a different character than the user wrote: `[\w-a]` is
  // a literal `-` in JS, but `[0-9A-Za-z_-a]` makes Rust read `_`..`a`, quietly adding
  // a backtick. Both neighbours are tracked so either can refuse.
  let mut prev_was_expansion = false;
  let mut pending_range = false;
  while let Some(c) = it.next() {
    let was_class_start = at_class_start;
    let was_expansion = prev_was_expansion;
    let open_range = pending_range;
    at_class_start = false;
    prev_was_expansion = false;
    pending_range = false;
    match c {
      '\\' => {
        // A trailing backslash isn't a valid regex on either side.
        let e = it.next()?;
        match e {
          // Inside a class the replacement has to be bare members, not a class of
          // its own; a NEGATED class cannot be a member at all, so refuse those.
          // `open_range` means a `-` is waiting for its upper bound — an expansion
          // cannot be one.
          'd' | 'w' | 's' if in_class && open_range => return None,
          'd' if in_class => {
            out.push_str(JS_DIGIT);
            prev_was_expansion = true;
          }
          'w' if in_class => {
            out.push_str(JS_WORD);
            prev_was_expansion = true;
          }
          's' if in_class => {
            out.push_str(JS_SPACE);
            prev_was_expansion = true;
          }
          'D' | 'W' | 'S' if in_class => return None,
          'd' => out.push_str("[0-9]"),
          'D' => out.push_str("[^0-9]"),
          'w' => {
            out.push('[');
            out.push_str(JS_WORD);
            out.push(']');
          }
          'W' => {
            out.push_str("[^");
            out.push_str(JS_WORD);
            out.push(']');
          }
          's' => {
            out.push('[');
            out.push_str(JS_SPACE);
            out.push(']');
          }
          'S' => {
            out.push_str("[^");
            out.push_str(JS_SPACE);
            out.push(']');
          }
          // Inside a class JS reads `\b` as U+0008. Outside it is a word boundary,
          // and an ASCII-only one — Unicode mode has no spelling for that, so the
          // pattern goes to JS. It can afford to: `\bfoo\b.*` measures 4 ms there.
          'b' if in_class => out.push_str(r"\x08"),
          'b' | 'B' => return None,
          // JS without `u` reads `\p` as a literal `p`; Rust reads a Unicode class.
          'p' | 'P' => return None,
          // `\uFFFF` is JS spelling (Rust wants `\x{FFFF}`), and it carries
          // surrogate-pair semantics we would have to reproduce. Hand it back.
          'u' => return None,
          _ => {
            out.push('\\');
            out.push(e);
          }
        }
      }
      '[' => {
        // JS reads a `[` inside a class as a literal; Rust opens a nested class.
        if in_class {
          return None;
        }
        in_class = true;
        at_class_start = true;
        out.push('[');
        if it.peek() == Some(&'^') {
          out.push(it.next()?);
        }
      }
      ']' if in_class => {
        if was_class_start {
          return None; // JS: a literal `]`. Rust: an empty class.
        }
        in_class = false;
        out.push(']');
      }
      // Inside a class a `.` is a literal on both sides; outside, it is the construct
      // whose two definitions disagree.
      '.' if !in_class => out.push_str(JS_DOT),
      // Rust's class operators — intersection, difference, symmetric difference —
      // are all plain literals to JS.
      '&' | '-' | '~' if in_class && it.peek() == Some(&c) => return None,
      '-' if in_class => {
        // A `-` right after an expansion would take the expansion's LAST member as
        // its lower bound; one before an expansion is handled above. A trailing `-`
        // (`[\w-]`) is a literal on both sides and is fine.
        let closes = it.peek() == Some(&']');
        if was_expansion && !closes {
          return None;
        }
        pending_range = !closes && !was_class_start;
        out.push('-');
      }
      _ => out.push(c),
    }
  }
  (!in_class).then_some(out)
}

/// Rewrite a JS pattern into one Rust's engine matches identically, or None when it
/// can't be trusted to and JS must scan it.
///
/// Two forms, tried in order:
///   1. `(?i-u:…)` — ASCII semantics, which is what JS gives without the `u` flag.
///      Correct for `\d`/`\w`/`\b`, but it also makes `.` and negated classes
///      byte-wise, which Rust rejects on `&str` input (a match could split a
///      multi-byte char).
///   2. `(?i:…)` over `rewrite_js_classes` — Unicode semantics for the patterns form
///      1 won't take (`.`, `[^…]`), with the ASCII-only escapes written out so they
///      can't drift. This is what lets `\d+.*ms` and `\w+.*err` be scanned at all.
///
/// A case-insensitive pattern with non-ASCII text also skips form 1: JS folds case
/// per Unicode even without `u`, which ASCII folding wouldn't reproduce.
///
/// KNOWN GAP, unchanged by the rewrite but now reached by more patterns: form 2 folds
/// case per Unicode, so `(?i:k)` also matches U+212A (KELVIN SIGN) where JS — which
/// never folds an ASCII char to a non-ASCII one — does not. Only `k`/`s` have such a
/// partner. `verify()` on the JS side spot-checks every primed pattern, so the cost of
/// hitting it is a downgrade to the JS scan, not a wrong highlight.
fn rust_regex(spec: &ScanSpec) -> Option<regex::Regex> {
  let ci = if spec.ci { "i" } else { "" };
  if (!spec.ci || spec.source.is_ascii()) && !uses_js_space(&spec.source) {
    if let Ok(re) = regex::Regex::new(&format!("(?{ci}-u:{})", spec.source)) {
      return Some(re);
    }
  }
  // Returns the compiled Regex, not its source: the caller needs one anyway, and
  // building it here means a translation that somehow doesn't compile is a fallback
  // (which is the contract) rather than a second build that has to assume it does.
  regex::Regex::new(&format!("(?{ci}:{})", rewrite_js_classes(&spec.source)?)).ok()
}

/// Wire format (little-endian), mirrored by `scanAndPrime` in `src/lib/scanPrime.ts`.
/// The 28-byte header is fixed-size, so both sides must change together:
///
/// ```text
///   u32 nLines | u32 nPatterns | u32 bytesPerPattern | u32 nFallback
///   u32 readUs | u32 splitUs | u32 scanUs    timings, for the open-perf log line
///   u32 × nFallback   pattern indices Rust could not scan (JS must do them)
///   u32 × nPatterns   match count per pattern (0 for fallbacks)
///   u8  × nPatterns × bytesPerPattern   match bit sets (all-zero for fallbacks)
/// ```
///
/// Fallback slots still occupy their bit-set space so a pattern's offset is just
/// `index × bytesPerPattern`; the JS side skips them and lets `computeView` scan
/// those few itself.
///
/// `read_us` is how long the caller spent reading and decoding the file — it rides
/// along in the header so one log line can account for the whole Rust side.
pub fn scan_text(text: &str, specs: &[ScanSpec], read_us: u32) -> Vec<u8> {
  let t_split = std::time::Instant::now();
  let lines = split_lines(text);
  let split_us = t_split.elapsed().as_micros() as u32;
  let t_scan = std::time::Instant::now();
  let n = lines.len();
  let n_bytes = n.div_ceil(8);
  let n_pat = specs.len();

  // Translate each pattern on its own first: one Rust's engine can't take
  // (lookaround, backreferences, a size blowup) must fall back to JS rather than
  // sink the whole batch.
  let mut ok_idx: Vec<usize> = Vec::new();
  let mut res: Vec<regex::Regex> = Vec::new();
  let mut fallback: Vec<u32> = Vec::new();
  for (k, spec) in specs.iter().enumerate() {
    match rust_regex(spec) {
      Some(re) => {
        ok_idx.push(k);
        res.push(re);
      }
      None => fallback.push(k as u32),
    }
  }

  // ONE Regex PER PATTERN, not one RegexSet over all of them.
  //
  // `RegexSet::matches` has to report WHICH patterns matched, so it cannot stop at a
  // first hit and cannot use the lazy DFA and prefilters that `Regex::is_match` gets.
  // With literal-only patterns the difference hides; with the `.*`/class patterns real
  // filter sets are full of, it is the whole cost. Measured on 92k lines x 180 chars,
  // 118 patterns: RegexSet 2565ms vs per-Regex 96ms, identical hits. The slowest single
  // pattern is 21.8ms.
  //
  // It also removes a failure cliff: the combined-size limit that used to send EVERY
  // pattern to the JS scanner at once no longer exists, because nothing is combined.
  let n_ok = ok_idx.len();

  let mut bits = vec![0u8; n_bytes * n_pat];
  let mut counts = vec![0u32; n_pat];
  if n_ok > 0 && n > 0 {
    // Parallel over (pattern x line-chunk) rather than either alone: over patterns
    // only, a set smaller than the core count leaves cores idle; over chunks only, one
    // expensive pattern serialises every worker. The chunk is a multiple of 8 so each
    // bit set starts on a byte boundary and merges with a plain copy.
    let n_chunks = n.div_ceil(SCAN_CHUNK);
    let tasks: Vec<(usize, usize)> = (0..n_ok)
      .flat_map(|u| (0..n_chunks).map(move |ci| (u, ci)))
      .collect();
    let per: Vec<(usize, usize, Vec<u8>, u32)> = tasks
      .par_iter()
      .map(|&(u, ci)| {
        let start = ci * SCAN_CHUNK;
        let slab = &lines[start..(start + SCAN_CHUNK).min(n)];
        let re = &res[u];
        let mut local = vec![0u8; slab.len().div_ceil(8)];
        let mut count = 0u32;
        for (i, line) in slab.iter().enumerate() {
          if re.is_match(line) {
            local[i >> 3] |= 1 << (i & 7);
            count += 1;
          }
        }
        (u, ci, local, count)
      })
      .collect();

    for (u, ci, local, count) in per {
      let k = ok_idx[u];
      let off = ci * (SCAN_CHUNK / 8); // exact: the chunk is 8-aligned
      let take = local.len().min(n_bytes - off);
      bits[k * n_bytes + off..k * n_bytes + off + take].copy_from_slice(&local[..take]);
      counts[k] += count;
    }
  }

  let mut out = Vec::with_capacity(28 + fallback.len() * 4 + n_pat * 4 + bits.len());
  out.extend_from_slice(&(n as u32).to_le_bytes());
  out.extend_from_slice(&(n_pat as u32).to_le_bytes());
  out.extend_from_slice(&(n_bytes as u32).to_le_bytes());
  out.extend_from_slice(&(fallback.len() as u32).to_le_bytes());
  out.extend_from_slice(&read_us.to_le_bytes());
  out.extend_from_slice(&split_us.to_le_bytes());
  out.extend_from_slice(&(t_scan.elapsed().as_micros() as u32).to_le_bytes());
  for f in &fallback {
    out.extend_from_slice(&f.to_le_bytes());
  }
  for c in &counts {
    out.extend_from_slice(&c.to_le_bytes());
  }
  out.extend_from_slice(&bits);
  out
}

#[cfg(test)]
mod tests {
  use super::{rewrite_js_classes, scan_text, split_lines, ScanSpec, SCAN_CHUNK};

  // Mirrors the frontend's `splitLines`; these cases are the ones where a naive
  // implementation drifts (trailing newline, lone CR, empty input).
  #[test]
  fn split_lines_matches_js_semantics() {
    assert_eq!(split_lines("a\nb"), vec!["a", "b"]);
    assert_eq!(split_lines("a\nb\n"), vec!["a", "b"]); // one trailing empty dropped
    assert_eq!(split_lines("a\r\nb\r\n"), vec!["a", "b"]);
    assert_eq!(split_lines("a\rb"), vec!["a", "b"]); // lone CR splits too
    assert_eq!(split_lines("a\n\nb"), vec!["a", "", "b"]); // inner blank kept
    assert_eq!(split_lines("a\n\n"), vec!["a", ""]); // only ONE trailing empty goes
    assert_eq!(split_lines(""), Vec::<&str>::new());
    assert_eq!(split_lines("\n"), vec![""]);
    assert_eq!(split_lines("日本語\nlog"), vec!["日本語", "log"]); // multi-byte safe
  }

  fn spec(source: &str, ci: bool) -> ScanSpec {
    ScanSpec { source: source.into(), ci }
  }

  /// Decode the blob back into (nLines, fallbacks, counts, per-pattern bit sets).
  fn parse_blob(b: &[u8]) -> (usize, Vec<u32>, Vec<u32>, Vec<Vec<u8>>) {
    let u32_at = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    let (n, n_pat, n_bytes, n_fb) = (
      u32_at(0) as usize,
      u32_at(4) as usize,
      u32_at(8) as usize,
      u32_at(12) as usize,
    );
    let mut o = 28; // header now carries three timing fields
    let fb: Vec<u32> = (0..n_fb).map(|k| u32_at(o + k * 4)).collect();
    o += n_fb * 4;
    let counts: Vec<u32> = (0..n_pat).map(|k| u32_at(o + k * 4)).collect();
    o += n_pat * 4;
    let bits = (0..n_pat)
      .map(|k| b[o + k * n_bytes..o + (k + 1) * n_bytes].to_vec())
      .collect();
    (n, fb, counts, bits)
  }
  fn is_set(bits: &[u8], i: usize) -> bool {
    bits[i >> 3] & (1 << (i & 7)) != 0
  }

  #[test]
  fn scan_text_marks_matching_lines() {
    let text = "alpha ERROR one\nbeta warn two\nGAMMA error three\n";
    let specs = vec![spec("ERROR", false), spec("error", true), spec("^beta", false)];
    let (n, fb, counts, bits) = parse_blob(&scan_text(text, &specs, 0));
    assert_eq!(n, 3);
    assert!(fb.is_empty());
    // case-sensitive "ERROR": line 0 only
    assert_eq!(counts[0], 1);
    assert!(is_set(&bits[0], 0) && !is_set(&bits[0], 1) && !is_set(&bits[0], 2));
    // case-insensitive "error": lines 0 and 2
    assert_eq!(counts[1], 2);
    assert!(is_set(&bits[1], 0) && !is_set(&bits[1], 1) && is_set(&bits[1], 2));
    // anchored "^beta": line 1 only — the anchor must bind per line, not per file
    assert_eq!(counts[2], 1);
    assert!(!is_set(&bits[2], 0) && is_set(&bits[2], 1));
  }

  #[test]
  fn scan_text_reports_unsupported_patterns_as_fallback() {
    // Lookahead and backreferences are JS-only; they must be reported, not guessed
    // at, so the frontend scans exactly those itself.
    let specs = vec![
      spec("ok", false),
      spec("foo(?=bar)", false),
      spec("(a)\\1", false),
      spec("also_ok", false),
    ];
    let (_, fb, _, _) = parse_blob(&scan_text("ok line\n", &specs, 0));
    assert_eq!(fb, vec![1, 2]);
  }

  #[test]
  fn dot_and_negated_classes_are_still_scanned() {
    // `.` can't take the ASCII form (it would go byte-wise, which Rust rejects on
    // &str), so it goes through the Unicode form rather than falling back — `.`
    // is far too common in real filters to hand back to JS.
    let specs = vec![
      spec(".", false),
      spec(".*here", false),
      spec("[^a]", false),
      spec("^.{3}$", false),
    ];
    let (_, fb, counts, _) = parse_blob(&scan_text("abc\nlong here\n日本語\n", &specs, 0));
    assert!(fb.is_empty(), "dot patterns must not fall back");
    assert_eq!(counts[0], 3); // every line has at least one char
    assert_eq!(counts[1], 1); // only "long here"
    // "abc" and 日本語 both count as 3 — `.{3}` measures chars, not bytes, on both
    // sides ("long here" is 9). A byte-wise `.` would have missed 日本語 entirely.
    assert_eq!(counts[3], 2);
  }

  #[test]
  fn ascii_class_mixed_with_dot_is_scanned() {
    // `\w` needs ASCII semantics and `.` can't be expressed in the ASCII form, so
    // this pair used to fall back wholesale — and it is the most expensive shape
    // there is to hand to JS. `rewrite_js_classes` spells `\w` out instead, leaving
    // only `\b` (which Unicode mode cannot express) on the fallback list.
    let specs = vec![spec("\\w.*", false), spec("\\bfoo\\b.*", false), spec("\\w+", false)];
    let (_, fb, _, _) = parse_blob(&scan_text("foo bar\n", &specs, 0));
    assert_eq!(fb, vec![1]);
  }

  /// The shapes that used to fall back purely for mixing an ASCII class with a dot.
  /// Each is checked against what JS would match, line by line — the point is not
  /// that they are *scanned* but that they are scanned *correctly*.
  #[test]
  fn rewritten_classes_match_js_semantics() {
    // Every line here is one where a naive translation drifts: NBSP and U+FEFF are
    // JS `\s` but not Rust `\p{White_Space}` (FEFF) / not ASCII `\s` (both); the
    // full-width ３ is not JS `\d`; é is not JS `\w`.
    let text = "err 42ms\n\u{a0}err 1\n\u{feff}err 2\n\u{3000}err 3\n３ms\nérr err 5\n日本語 err 6\ntab\terr 0\n";
    let specs = vec![
      spec("\\d+ms", false),   // ３ms must NOT match
      spec(".*err.*\\d+", false),
      spec("\\w+.*err", false),
      spec("[\\w\\s]+err", false),
      spec("\\s+err", false),  // must match NBSP, FEFF and ideographic space
      spec("\\Dx", false),
      spec("\\W+.*err", false),
    ];
    let (n, fb, counts, _) = parse_blob(&scan_text(text, &specs, 0));
    assert_eq!(n, 8);
    assert!(fb.is_empty(), "none of these should fall back now");
    assert_eq!(counts[0], 1, "\\d+ms: '42ms' only — the full-width ３ is not \\d");
    assert_eq!(counts[4], 6, r"\s+err: NBSP, FEFF and ideographic space, plus the two plain spaces and the tab");
  }

  /// JS `.` stops at a LineTerminator; Rust's does not. `split_lines` removes CR and LF,
  /// so U+2028/U+2029 are the two that can still sit inside a line — and an unrewritten
  /// dot crossing one sets a bit for a line the filter does not match.
  #[test]
  fn dot_does_not_cross_a_line_separator() {
    let text = "err\u{2028}4\nerr 4\nerr\u{2029}4\nplain\n";
    let specs = vec![
      spec("err.*4", true),
      spec("\\w+.*4", true),
      spec("^err.{2}$", true),
      spec("[.]", true), // a dot INSIDE a class is a literal on both sides
    ];
    let (n, fb, counts, bits) = parse_blob(&scan_text(text, &specs, 0));
    assert_eq!(n, 4);
    assert!(fb.is_empty());
    // Only the line whose separator is an ordinary space matches — lines 0 and 2 hold a
    // separator the dot may not cross.
    assert_eq!(counts[0], 1, "err.*4");
    assert!(!is_set(&bits[0], 0) && is_set(&bits[0], 1) && !is_set(&bits[0], 2));
    assert_eq!(counts[1], 1, "\\w+.*4");
    assert_eq!(counts[2], 1, "anchored dot-count: a separator is one char, but not a dot");
    assert_eq!(counts[3], 0, "no literal dot anywhere in the corpus");
  }

  #[test]
  fn untranslatable_escapes_still_fall_back() {
    let specs = vec![
      spec("\\bfoo\\b.*", false),  // ASCII word boundary + dot: no Unicode spelling
      spec("\\p{L}.*", false),     // JS reads a literal `p`; Rust reads a class
      spec("\\u0041.*", false),    // JS spelling, and surrogate semantics
      spec("[a[b].*", false),      // JS: literal `[`. Rust: a nested class
      spec("[a&&b].*", false),     // JS: literal `&`. Rust: intersection
      spec("[]a].*", false),       // JS: a literal `]` member. Rust: an empty class
      spec("[\\Sx].*", false),     // a negated class can't be a member of a class
      spec("ok.*", false),         // …and something that must still get through
    ];
    let (_, fb, _, _) = parse_blob(&scan_text("ok line\n", &specs, 0));
    assert_eq!(fb, vec![0, 1, 2, 3, 4, 5, 6]);
  }

  /// An expanded class must never become a range endpoint: JS reads the `-` in
  /// `[\w-a]` as a literal, Rust would read `_`..`a` and quietly add a backtick.
  #[test]
  fn expanded_class_never_forms_a_range() {
    assert_eq!(rewrite_js_classes(r"[\w-a]"), None);
    assert_eq!(rewrite_js_classes(r"[a-\w]"), None);
    assert_eq!(rewrite_js_classes(r"[\d-\w]"), None);
    // A trailing `-` is a literal on both sides, and must still go through.
    assert_eq!(rewrite_js_classes(r"[\w-]").unwrap(), "[0-9A-Za-z_-]");
    // A `-` that isn't next to an expansion is an ordinary range.
    assert_eq!(rewrite_js_classes(r"[a-z\d]").unwrap(), "[a-z0-9]");
    // …and one at the very start of a class is a literal, not a range.
    assert_eq!(rewrite_js_classes(r"[-\d]").unwrap(), "[-0-9]");
  }

  #[test]
  fn rewrite_leaves_unrelated_escapes_alone() {
    assert_eq!(rewrite_js_classes(r"a\.b").unwrap(), r"a\.b");
    assert_eq!(rewrite_js_classes(r"a\\d").unwrap(), r"a\\d"); // escaped backslash, then a literal d
    assert_eq!(rewrite_js_classes(r"\d").unwrap(), "[0-9]");
    assert_eq!(rewrite_js_classes(r"[\d]").unwrap(), "[0-9]");
    assert_eq!(rewrite_js_classes(r"[^\w]").unwrap(), "[^0-9A-Za-z_]");
    assert_eq!(rewrite_js_classes(r"[\b]").unwrap(), r"[\x08]"); // backspace inside a class
    assert_eq!(rewrite_js_classes(r"\b"), None);
    assert_eq!(rewrite_js_classes(r"[a"), None); // unterminated class
  }

  #[test]
  fn case_insensitive_non_ascii_folds_like_js() {
    // JS folds case per Unicode even without the `u` flag, so a ci pattern with
    // non-ASCII text must not be matched with ASCII-only folding.
    let (_, fb, counts, _) =
      parse_blob(&scan_text("école\nÉCOLE\nEcole\n", &[spec("école", true)], 0));
    assert!(fb.is_empty());
    assert_eq!(counts[0], 2); // école + ÉCOLE, not Ecole
  }

  #[test]
  fn scan_text_ascii_digit_semantics() {
    // JS without the `u` flag treats \d as ASCII-only. A full-width digit must NOT
    // match, or Rust's bits would disagree with the JS regex they stand in for.
    let (_, fb, counts, _) = parse_blob(&scan_text("ID ３\nID 7\n", &[spec("\\d", false)], 0));
    assert!(fb.is_empty());
    assert_eq!(counts[0], 1);
  }

  #[test]
  fn scan_text_spans_many_chunks() {
    // More lines than SCAN_CHUNK, so the per-chunk bit sets have to merge at the
    // right byte offsets — an off-by-one here would shift highlights wholesale.
    let n = SCAN_CHUNK * 2 + 13;
    let mut text = String::new();
    for i in 0..n {
      text.push_str(if i % 7 == 0 { "hit\n" } else { "miss\n" });
    }
    let (got_n, _, counts, bits) = parse_blob(&scan_text(&text, &[spec("hit", false)], 0));
    assert_eq!(got_n, n);
    assert_eq!(counts[0] as usize, (n + 6) / 7);
    for i in 0..n {
      assert_eq!(is_set(&bits[0], i), i % 7 == 0, "line {i}");
    }
  }

  #[test]
  fn scan_text_handles_empty_inputs() {
    let (n, fb, _, _) = parse_blob(&scan_text("", &[spec("x", false)], 0));
    assert_eq!((n, fb.len()), (0, 0));
    let (n2, _, _, _) = parse_blob(&scan_text("a\nb\n", &[], 0));
    assert_eq!(n2, 2); // no patterns is a valid, empty scan
  }
}
