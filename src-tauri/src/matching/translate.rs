//! Turn a JS pattern into something this engine can run — or say why it cannot.
//!
//! There is no third answer and no routing decision anywhere else: a pattern is either
//! `Runnable` or it is `Unsupported`, and the frontend scans the second kind itself.
//! `Conjunction` is a form of the FIRST — `(?=.*A)(?=.*B)` is a translation into two
//! patterns and an intersection, no more a separate path than `\d` becoming `[0-9]`.
use super::syntax::{
  has_line_separator, has_top_level_alternation, tokenize, Kind, Token, JS_DIGIT, JS_DOT,
  JS_SPACE, JS_WORD,
};

/// The JS `RegExp.source` verbatim, plus whether it carries the `i` flag.
#[derive(serde::Deserialize, Clone)]
pub struct ScanSpec {
  /// Already regex-escaped for literal filters, so both sides key the match cache off
  /// the exact same string.
  pub source: String,
  pub ci: bool,
}

#[derive(Debug)]
pub enum Runnable {
  /// One regex, matched directly.
  Direct(regex::Regex),
  /// A conjunction of lookaheads: the line matches iff EVERY part does.
  ///
  /// `(?=.*B₁)…(?=.*Bₙ)` is exactly this for a yes/no test — it matches iff there is
  /// some start position where every `.*Bᵢ` matches, and position 0 is the weakest
  /// such position, so it matches iff every Bᵢ occurs anywhere in the line. Worth the
  /// trouble because the alternative is a backtracking engine: one such filter over
  /// 92k × 180-char lines costs 1.8 s there and nothing measurable here.
  Conjunction(Vec<regex::Regex>),
}

/// Why a pattern could not be translated. Reaches the user as the tooltip on the
/// filter's badge, so it names the construct rather than the internal reason.
pub type Unsupported = &'static str;

/// Translate `spec`, given the corpus it will be scanned against.
///
/// `text` is needed because one rewrite's exactness depends on the subject: a line
/// separator that survived line splitting breaks the conjunction decomposition, since
/// `.*` from position 0 then cannot reach the whole line.
pub fn translate(spec: &ScanSpec, text: &str) -> Result<Runnable, Unsupported> {
  let ci = if spec.ci { "i" } else { "" };

  // A conjunction first: its branches are ordinary patterns, translated the same way.
  if let Some(bodies) = decompose_and(&spec.source) {
    if has_line_separator(text) {
      return Err("a line separator in this file");
    }
    let mut parts = Vec::with_capacity(bodies.len());
    for body in &bodies {
      match compile_one(body, ci) {
        Some(re) => parts.push(re),
        None => return Err("an unsupported part of a lookahead"),
      }
    }
    return Ok(Runnable::Conjunction(parts));
  }

  compile_one(&spec.source, ci)
    .map(Runnable::Direct)
    .ok_or_else(|| unsupported_reason(&spec.source))
}

/// Name the construct that stopped us, for the badge. Best-effort: the translation
/// already failed, and this only has to be more useful than "unsupported".
fn unsupported_reason(src: &str) -> Unsupported {
  if src.contains("(?=") || src.contains("(?!") {
    "a lookahead"
  } else if src.contains("(?<=") || src.contains("(?<!") {
    "a lookbehind"
  } else if src.contains(r"\b") || src.contains(r"\B") {
    "a word boundary next to a wildcard"
  } else if (1..=9).any(|d| src.contains(&format!("\\{d}"))) {
    "a backreference"
  } else {
    "syntax this scanner cannot take"
  }
}

/// Compile one JS pattern body, trying the two forms in order.
///
///   1. `(?i-u:…)` — ASCII semantics, which is what JS gives without the `u` flag.
///      Exact for `\d`/`\w`/`\b`, but `.` and negated classes go byte-wise there,
///      which Rust rejects on `&str` (a match could split a multi-byte char).
///   2. `(?i:…)` over the rewritten source — Unicode semantics, with every escape whose
///      meaning would drift spelled out. This is what lets `\d+.*ms` be scanned at all.
///
/// A case-insensitive pattern with non-ASCII text skips form 1: JS folds case per
/// Unicode even without `u`, which ASCII folding would not reproduce.
///
/// KNOWN GAP: form 2 folds case per Unicode, so `(?i:k)` also matches U+212A where JS —
/// which never folds an ASCII char to a non-ASCII one — does not. Only `k` and `s` have
/// such partners. The frontend spot-checks every pattern it is handed, so the cost of
/// hitting it is a downgrade to the JS scanner, not a wrong highlight.
fn compile_one(src: &str, ci: &str) -> Option<regex::Regex> {
  if (ci.is_empty() || src.is_ascii()) && !uses_js_space(src) {
    if let Ok(re) = regex::Regex::new(&format!("(?{ci}-u:{src})")) {
      return Some(re);
    }
  }
  regex::Regex::new(&format!("(?{ci}:{})", rewrite(src)?)).ok()
}

/// Whether a pattern uses `\s`/`\S`, the one escape the ASCII form gets WRONG.
///
/// `\d`, `\w` and `\b` really are ASCII-only in a JS regex without the `u` flag, so
/// `(?-u:…)` reproduces them exactly. `\s` is the exception — see `syntax::JS_SPACE`.
fn uses_js_space(src: &str) -> bool {
  match tokenize(src) {
    Some(toks) => toks
      .iter()
      .any(|t| t.kind == Kind::Escape && matches!(t.ch, 's' | 'S')),
    None => false, // unparseable: let the compile attempt refuse it
  }
}

/// Rewrite the escapes whose meaning differs from Rust's Unicode default into explicit
/// classes, so a pattern can be scanned in Unicode mode — where `.` and `[^…]` work —
/// without `\d`/`\w`/`\s`/`.` drifting.
///
/// Returns None for anything it cannot translate EXACTLY. That is not a failure path:
/// the caller reports it and the frontend scans it, which is where it ran anyway.
fn rewrite(src: &str) -> Option<String> {
  let toks = tokenize(src)?;
  let mut out = String::with_capacity(src.len() + 64);
  // An expansion writes several members where JS had one token, so a `-` on either side
  // of it binds to a different character than the user wrote: `[\w-a]` is a literal `-`
  // in JS, but `[0-9A-Za-z_-a]` makes Rust read `_`..`a`, quietly adding a backtick.
  let mut prev_was_expansion = false;
  for (i, t) in toks.iter().enumerate() {
    let next = toks.get(i + 1);
    let mut expansion = false;
    match t.kind {
      Kind::Escape => match (t.ch, t.in_class) {
        // Inside a class the replacement has to be bare members, so a NEGATED class
        // cannot be one; and it must not become a range endpoint.
        ('D' | 'W' | 'S', true) => return None,
        ('d' | 'w' | 's', true) => {
          if opens_range(&toks, i) {
            return None;
          }
          out.push_str(match t.ch {
            'd' => JS_DIGIT,
            'w' => JS_WORD,
            _ => JS_SPACE,
          });
          expansion = true;
        }
        ('d', false) => out.push_str("[0-9]"),
        ('D', false) => out.push_str("[^0-9]"),
        ('w', false) => out.push_str(&format!("[{JS_WORD}]")),
        ('W', false) => out.push_str(&format!("[^{JS_WORD}]")),
        ('s', false) => out.push_str(&format!("[{JS_SPACE}]")),
        ('S', false) => out.push_str(&format!("[^{JS_SPACE}]")),
        // Inside a class JS reads `\b` as U+0008. Outside it is a word boundary, and
        // an ASCII-only one, which Unicode mode has no spelling for — cheap to hand
        // back: `\bfoo\b.*` costs 4 ms in the JS engine.
        ('b', true) => out.push_str(r"\x08"),
        ('b' | 'B', false) => return None,
        // JS without `u` reads `\p` as a literal `p`; Rust reads a Unicode class.
        ('p' | 'P', _) => return None,
        // `￿` is JS spelling (Rust wants `\x{FFFF}`) and carries surrogate-pair
        // semantics we would have to reproduce.
        ('u', _) => return None,
        _ => out.push_str(t.text(src)),
      },
      // The construct whose two definitions disagree. Inside a class it is a literal
      // on both sides.
      Kind::Char if !t.in_class && t.ch == '.' => out.push_str(JS_DOT),
      Kind::Char if t.in_class => match t.ch {
        // JS reads a `[` inside a class as a literal; Rust opens a nested class.
        '[' => return None,
        // Rust's class operators — intersection, difference, symmetric difference —
        // are all plain literals to JS.
        '&' | '~' if next.map(|n| n.ch) == Some(t.ch) && next.map(|n| n.in_class) == Some(true) => {
          return None
        }
        '-' => {
          let closes = next.map(|n| n.kind) == Some(Kind::ClassClose);
          // A `-` right after an expansion would take that expansion's LAST member as
          // its lower bound. A trailing `-` (`[\w-]`) is a literal on both sides.
          if prev_was_expansion && !closes {
            return None;
          }
          if !closes && next.map(|n| n.ch) == Some('-') {
            return None; // `--` is Rust's difference operator
          }
          out.push('-');
        }
        // JS reads a leading `]` as a member of the class; Rust needs it escaped.
        ']' if t.at_class_start => out.push_str(r"\]"),
        _ => out.push_str(t.text(src)),
      },
      _ => out.push_str(t.text(src)),
    }
    prev_was_expansion = expansion;
  }
  Some(out)
}

/// Whether the token at `i` sits immediately after a `-` that is acting as a range's
/// lower bound — in which case an expansion there would silently change the range.
fn opens_range(toks: &[Token], i: usize) -> bool {
  match i.checked_sub(1).and_then(|p| toks.get(p)) {
    Some(p) => {
      p.in_class && p.kind == Kind::Char && p.ch == '-' && !p.at_class_start
    }
    None => false,
  }
}

/// Split `(?=.*A)(?=.*B)…` into its branch bodies, or None when the pattern is not
/// exactly that shape.
///
/// Deliberately narrow: anything accepted has to be EXACTLY equivalent as a yes/no
/// test, and a rejection costs only what the pattern costs today. Two or more
/// `(?=.*…)` groups, an optional bare `.*` tail, and nothing else — no leading anchor
/// (which would break the "take position 0" argument), no backreference (which cannot
/// span a split), no `^` inside a body, and no top-level `|` in one (which would leave
/// the `.*` covering only the first alternative).
pub fn decompose_and(src: &str) -> Option<Vec<String>> {
  let toks = tokenize(src)?;
  let mut bodies: Vec<String> = Vec::new();
  let mut i = 0usize;
  while let Some(t) = toks.get(i) {
    if t.kind != Kind::GroupOpen || t.text(src) != "(?=" {
      break;
    }
    let close = matching_close(&toks, i)?;
    // The body must start with `.*`, optionally lazy. Anything else after the dot —
    // `.**`, `.*+`, `.*{2}` — is a different pattern, so refuse rather than guess.
    let after = &src[t.end..];
    let mut skip = if after.starts_with(".*") { 2 } else { return None };
    match after.as_bytes().get(skip) {
      Some(b'?') => skip += 1,
      Some(b'*' | b'+' | b'{') => return None,
      _ => {}
    }
    let body = &src[t.end + skip..toks[close].start];
    if body.is_empty()
      || body.contains('^')
      || (1..=9).any(|d| body.contains(&format!("\\{d}")))
      || has_top_level_alternation(body)
    {
      return None;
    }
    bodies.push(body.to_string());
    i = close + 1;
  }
  if bodies.len() < 2 {
    return None; // not the AND idiom
  }
  let tail = &src[toks.get(i).map_or(src.len(), |t| t.start)..];
  if !tail.is_empty() && tail != ".*" {
    return None;
  }
  Some(bodies)
}

/// Index of the `)` closing the `GroupOpen` at `open`.
fn matching_close(toks: &[Token], open: usize) -> Option<usize> {
  let base = toks[open].depth;
  toks[open + 1..]
    .iter()
    .position(|t| t.kind == Kind::GroupClose && t.depth == base + 1)
    .map(|p| open + 1 + p)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn rw(src: &str) -> Option<String> {
    rewrite(src)
  }

  #[test]
  fn expansions_are_exactly_js() {
    assert_eq!(rw(r"\d").unwrap(), "[0-9]");
    assert_eq!(rw(r"[\d]").unwrap(), "[0-9]");
    assert_eq!(rw(r"[^\w]").unwrap(), "[^0-9A-Za-z_]");
    assert_eq!(rw(r"[\b]").unwrap(), r"[\x08]"); // backspace inside a class
    assert_eq!(rw(r"a\.b").unwrap(), r"a\.b");
    assert_eq!(rw(r"a\\d").unwrap(), r"a\\d"); // escaped backslash, then a literal d
    assert_eq!(rw("a.b").unwrap(), format!("a{JS_DOT}b"));
    assert_eq!(rw("[a.b]").unwrap(), "[a.b]"); // a dot in a class is a literal
    assert_eq!(rw(r"\b"), None);
    assert_eq!(rw(r"\p{L}"), None);
    assert_eq!(rw("[a"), None);
  }

  #[test]
  fn expansions_never_form_a_range() {
    assert_eq!(rw(r"[\w-a]"), None);
    assert_eq!(rw(r"[a-\w]"), None);
    assert_eq!(rw(r"[\d-\w]"), None);
    assert_eq!(rw(r"[\w-]").unwrap(), format!("[{JS_WORD}-]"));
    assert_eq!(rw(r"[-\d]").unwrap(), format!("[-{JS_DIGIT}]"));
    assert_eq!(rw(r"[^-\d]").unwrap(), format!("[^-{JS_DIGIT}]"));
    assert_eq!(rw(r"[a-z\d]").unwrap(), format!("[a-z{JS_DIGIT}]"));
  }

  #[test]
  fn a_leading_bracket_member_is_escaped_not_refused() {
    // JS reads `[]a]` as a class holding `]` and `a`. Rust needs the `]` escaped —
    // which is expressible, so this is translated rather than handed back.
    assert_eq!(rw("[]a]").unwrap(), r"[\]a]");
    assert!(regex::Regex::new(&rw("[]a]").unwrap()).is_ok());
  }

  #[test]
  fn class_operators_are_refused() {
    assert_eq!(rw("[a&&b]"), None);
    assert_eq!(rw("[a--b]"), None);
    assert_eq!(rw("[a[b]"), None);
  }

  #[test]
  fn decompose_takes_only_what_is_exact() {
    assert_eq!(decompose_and("(?=.*a)(?=.*b)").unwrap(), ["a", "b"]);
    assert_eq!(decompose_and("(?=.*a)(?=.*b)(?=.*c)").unwrap(), ["a", "b", "c"]);
    assert_eq!(decompose_and("(?=.*a)(?=.*b).*").unwrap(), ["a", "b"]);
    assert_eq!(decompose_and("(?=.*(a|b))(?=.*c)").unwrap(), ["(a|b)", "c"]);
    assert_eq!(decompose_and("(?=.*[)])(?=.*b)").unwrap(), ["[)]", "b"]);
    assert_eq!(decompose_and("(?=.*?a)(?=.*b)").unwrap(), ["a", "b"]);

    assert_eq!(decompose_and("(?=.*a)"), None); // one branch is not a conjunction
    assert_eq!(decompose_and("^(?=.*a)(?=.*b)"), None); // anchored
    assert_eq!(decompose_and("(?=.*a)(?=.*b)tail"), None); // a consuming tail
    assert_eq!(decompose_and("(?=.*a|b)(?=.*c|d)"), None); // top-level alternation
    assert_eq!(decompose_and(r"(?=.*(a))(?=.*\1)"), None); // backreference
    assert_eq!(decompose_and("(?=.*^a)(?=.*b)"), None); // re-anchored in a branch
    assert_eq!(decompose_and("(?=.**a)(?=.*b)"), None);
    assert_eq!(decompose_and("(?=.*a)(?=.*b"), None); // unbalanced
    assert_eq!(decompose_and("plain"), None);
  }

  #[test]
  fn a_conjunction_is_runnable_unless_the_corpus_forbids_it() {
    let spec = ScanSpec { source: "(?=.*a)(?=.*b)".into(), ci: true };
    assert!(matches!(translate(&spec, "a b\n"), Ok(Runnable::Conjunction(p)) if p.len() == 2));
    // `.` cannot cross a line separator, so "a occurs somewhere" stops being what the
    // lookahead means and the whole rewrite is off.
    assert!(translate(&spec, "a\u{2028}b\n").is_err());
  }

  #[test]
  fn unsupported_patterns_name_themselves() {
    let t = |s: &str| translate(&ScanSpec { source: s.into(), ci: false }, "x\n").unwrap_err();
    assert_eq!(t(r"(?!.*a).*b"), "a lookahead");
    assert_eq!(t(r"(?<=a)b"), "a lookbehind");
    assert_eq!(t(r"\bfoo\b.*"), "a word boundary next to a wildcard");
    assert_eq!(t(r"(a).*\1"), "a backreference");
  }
}
