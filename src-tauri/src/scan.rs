// --- match scanning for the filter engine ------------------------------------
// The frontend's `computeView` cold path runs every filter's RegExp over every
// line — O(lines × filters) on the main thread, which is what makes opening a big
// log with a big filter set freeze the window (measured ~1.3 s for 200k lines ×
// 100 filters). Here the same work is one RegexSet pass per line (a single
// aho-corasick/Teddy prefilter over all patterns at once, instead of one automaton
// per filter) spread across rayon workers: 21 ms for the same workload. We hand
// back the packed match bit sets so the JS match cache is already warm the first
// time `computeView` runs, and it never does the cold scan at all.
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

/// Whether a pattern uses a class whose meaning differs between Rust's Unicode
/// mode and the JS semantics we're standing in for. The frontend's regexes never
/// carry the `u` flag, so there `\d`/`\w`/`\b` are ASCII-only while Rust's default
/// is Unicode-aware (`\d` would also match "３"). Escaped backslashes are skipped
/// so a literal `\\d` isn't mistaken for the class.
fn uses_ascii_sensitive_class(src: &str) -> bool {
  let b = src.as_bytes();
  let mut i = 0;
  while i + 1 < b.len() {
    if b[i] != b'\\' {
      i += 1;
      continue;
    }
    if matches!(b[i + 1], b'd' | b'D' | b'w' | b'W' | b's' | b'S' | b'b' | b'B') {
      return true;
    }
    i += 2; // an escaped char (incl. `\\`) can't start a class of its own
  }
  false
}

/// Rewrite a JS pattern into one Rust's engine matches identically, or None when it
/// can't be trusted to and JS must scan it.
///
/// Two forms, tried in order:
///   1. `(?i-u:…)` — ASCII semantics, which is what JS gives without the `u` flag.
///      Correct for `\d`/`\w`/`\b`, but it also makes `.` and negated classes
///      byte-wise, which Rust rejects on `&str` input (a match could split a
///      multi-byte char).
///   2. `(?i:…)` — Unicode semantics, for the patterns form 1 won't take (`.`,
///      `[^…]`). Only allowed when the pattern uses none of the classes whose
///      meaning would then drift, so `.*` gets scanned here while `\w.*` falls back.
///
/// A case-insensitive pattern with non-ASCII text also skips form 1: JS folds case
/// per Unicode even without `u`, which ASCII folding wouldn't reproduce.
fn rust_source(spec: &ScanSpec) -> Option<String> {
  let ci = if spec.ci { "i" } else { "" };
  if !spec.ci || spec.source.is_ascii() {
    let ascii = format!("(?{ci}-u:{})", spec.source);
    if regex::Regex::new(&ascii).is_ok() {
      return Some(ascii);
    }
  }
  if uses_ascii_sensitive_class(&spec.source) {
    return None;
  }
  let uni = format!("(?{ci}:{})", spec.source);
  regex::Regex::new(&uni).is_ok().then_some(uni)
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
  let mut sources: Vec<String> = Vec::new();
  let mut fallback: Vec<u32> = Vec::new();
  for (k, spec) in specs.iter().enumerate() {
    match rust_source(spec) {
      Some(src) => {
        ok_idx.push(k);
        sources.push(src);
      }
      None => fallback.push(k as u32),
    }
  }

  // Building the combined set can still fail (combined size limit) even when every
  // pattern compiled alone — then everything falls back and JS scans as before.
  // Flags ride inside each source, so the set itself takes the defaults.
  let set = if sources.is_empty() {
    None
  } else {
    regex::RegexSetBuilder::new(&sources).build().ok()
  };
  if set.is_none() {
    fallback.extend(ok_idx.iter().map(|&k| k as u32));
    fallback.sort_unstable();
    ok_idx.clear();
  }
  let n_ok = ok_idx.len();

  let mut bits = vec![0u8; n_bytes * n_pat];
  let mut counts = vec![0u32; n_pat];
  if let Some(set) = set.filter(|_| n_ok > 0) {
    // Each worker fills a chunk-local bit set (indexed by the set's own pattern
    // order), so no two threads touch the same byte.
    let per_chunk: Vec<(usize, Vec<u8>, Vec<u32>)> = lines
      .par_chunks(SCAN_CHUNK)
      .enumerate()
      .map(|(ci, slab)| {
        let lb = slab.len().div_ceil(8);
        let mut local = vec![0u8; lb * n_ok];
        let mut local_counts = vec![0u32; n_ok];
        for (i, line) in slab.iter().enumerate() {
          for k in set.matches(line).iter() {
            local[k * lb + (i >> 3)] |= 1 << (i & 7);
            local_counts[k] += 1;
          }
        }
        (ci, local, local_counts)
      })
      .collect();

    for (ci, local, local_counts) in per_chunk {
      let off = ci * (SCAN_CHUNK / 8); // chunk start in bytes — exact, chunk is 8-aligned
      let lb = local.len() / n_ok;
      for (u, &k) in ok_idx.iter().enumerate() {
        let take = lb.min(n_bytes - off);
        bits[k * n_bytes + off..k * n_bytes + off + take]
          .copy_from_slice(&local[u * lb..u * lb + take]);
        counts[k] += local_counts[u];
      }
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
  use super::{scan_text, split_lines, ScanSpec, SCAN_CHUNK};

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
  fn ascii_class_mixed_with_dot_falls_back() {
    // `\w` needs the ASCII form and `.` can't be expressed there — rather than
    // silently scanning it with Unicode `\w` (which would also match 名), report it.
    let specs = vec![spec("\\w.*", false), spec("\\bfoo\\b.*", false), spec("\\w+", false)];
    let (_, fb, _, _) = parse_blob(&scan_text("foo bar\n", &specs, 0));
    assert_eq!(fb, vec![0, 1]);
    // …but a `\w` with no dot is fine on its own.
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
