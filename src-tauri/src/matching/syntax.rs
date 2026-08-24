//! What a JavaScript regex means — the single place that knows.
//!
//! The frontend's filters are JS `RegExp`s without the `u` flag, and everything here
//! exists to scan them with a different engine and get the same answer. Two things had
//! to be centralised for that to be maintainable:
//!
//! 1. **The semantics table.** `\d`, `\w`, `\s` and `.` all mean something different in
//!    Rust than in JS, and those facts used to live in five places across two languages.
//!    Every silent wrong-highlight bug found in this subsystem was a fact that had been
//!    written down once and not in the others — the clearest case being `.` and U+2028,
//!    which was found and fixed on one path while the identical hazard sat unfixed on
//!    another, because nothing connected them.
//! 2. **The tokenizer.** "Walk a pattern, skipping escapes and character classes" was
//!    hand-written five times, each with its own idea of what an escape is and where a
//!    class ends. A `[\w-a]` that quietly became a range, and a `.*?` sliced as if it
//!    were `.*`, were each one copy knowing something the others did not.
//!
//! Nothing here compiles or matches anything. It answers what the pattern SAYS.

/// JS `\s` without the `u` flag, spelled out: WhiteSpace ∪ LineTerminator.
///
/// NEITHER Rust built-in is this set — `(?-u:\s)` is ASCII-only, and Unicode `\s` is
/// `\p{White_Space}`, which does not contain U+FEFF. Writing it out is what makes a
/// translated pattern exactly JS rather than approximately: `\s+err` scanned in ASCII
/// mode silently missed every line separated by a non-breaking or ideographic space.
pub const JS_SPACE: &str = concat!(
  r"\t\n\x0B\f\r \x{a0}\x{1680}\x{2000}-\x{200a}",
  r"\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}"
);

/// JS `\w` without the `u` flag is ASCII-only whatever the subject text is.
pub const JS_WORD: &str = "0-9A-Za-z_";

/// JS `\d` without the `u` flag is ASCII-only, so a full-width "３" must not match.
pub const JS_DIGIT: &str = "0-9";

/// JS `.` without the `s` flag: any code unit except a LineTerminator — and JS counts
/// four of those, where Rust's `.` excludes only `\n`. `split_lines` strips CR and LF,
/// so U+2028/U+2029 are the two that can still sit inside a line; an unrewritten dot
/// crosses one and claims a line the filter does not match.
pub const JS_DOT: &str = r"[^\n\r\x{2028}\x{2029}]";

/// The line terminators JS `.` refuses to cross, as characters. Callers that need to
/// know whether a corpus can even exhibit the hazard check for these.
pub const JS_LINE_SEPARATORS: [char; 2] = ['\u{2028}', '\u{2029}'];

/// Whether `text` contains a line separator that survived line splitting.
///
/// Some rewrites are exact only on a corpus without one — the lookahead-conjunction
/// decomposition, in particular, relies on `.*` from position 0 reaching the whole
/// line. Cheap to rule out, and it is essentially always false for a log.
pub fn has_line_separator(text: &str) -> bool {
  text.contains(JS_LINE_SEPARATORS)
}

/// What a token is, as far as anything here needs to care.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
  /// An ordinary character, including `.` — check `ch` for that.
  Char,
  /// A backslash escape; `ch` is the escaped character, not the backslash.
  Escape,
  /// `[` or `[^` opening a character class.
  ClassOpen,
  /// The `]` that closes one.
  ClassClose,
  /// `(`, `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<name>` …
  GroupOpen,
  /// The `)` that closes one.
  GroupClose,
  /// `|`. Check `depth` for whether it is top-level.
  Alt,
}

#[derive(Debug, Clone, Copy)]
pub struct Token {
  pub kind: Kind,
  /// The significant character: the escaped one for `Escape`, otherwise the char
  /// itself. Meaningless for `ClassOpen`/`GroupOpen`, which carry more in `text`.
  pub ch: char,
  /// Byte range of the whole token in the source, so a caller can slice around it.
  pub start: usize,
  pub end: usize,
  /// Inside a character class — where `[`, `.`, `|`, `(` and `)` are all literals and
  /// only `]` and `\` still mean anything.
  pub in_class: bool,
  /// Group nesting depth BEFORE this token. A `|` at depth 0 is a top-level
  /// alternation, which several rewrites have to refuse.
  pub depth: u32,
  /// This token is the first member of a class, where JS reads `]` as a literal.
  pub at_class_start: bool,
}

impl Token {
  /// The token's own text, for callers that pass parts of a pattern through unchanged.
  pub fn text<'a>(&self, src: &'a str) -> &'a str {
    &src[self.start..self.end]
  }
}

/// Walk a JS pattern's tokens. Returns None if the pattern is malformed in a way that
/// makes the walk meaningless (a trailing backslash, an unclosed class) — every caller
/// treats that as "hand it back to JS", which is always a safe answer.
pub fn tokenize(src: &str) -> Option<Vec<Token>> {
  let b = src.as_bytes();
  let mut out = Vec::with_capacity(src.len());
  let mut i = 0usize;
  let mut in_class = false;
  let mut depth = 0u32;
  // Set right after `[` or `[^`.
  let mut at_class_start = false;
  while i < b.len() {
    let start = i;
    let c = src[i..].chars().next()?;
    let clen = c.len_utf8();
    let was_class_start = at_class_start;
    at_class_start = false;
    // Nesting BEFORE this token: a top-level `(` reports 0, and the `)` that closes it
    // reports 1. Recorded up front because both arms below mutate `depth`.
    let depth_before = depth;
    let (kind, ch, end) = match c {
      '\\' => {
        // The escaped character, whatever it is — a trailing backslash is not a valid
        // regex on either side.
        let e = src[i + 1..].chars().next()?;
        (Kind::Escape, e, i + 1 + e.len_utf8())
      }
      '[' if !in_class => {
        in_class = true;
        at_class_start = true;
        // `[^` is taken whole, so the negation rides along in the token's text.
        let neg = b.get(i + 1) == Some(&b'^');
        (Kind::ClassOpen, '[', i + clen + usize::from(neg))
      }
      ']' if in_class && !was_class_start => {
        in_class = false;
        (Kind::ClassClose, ']', i + clen)
      }
      '(' if !in_class => {
        depth += 1;
        // Take the whole group prefix so a caller can tell `(?=` from `(?:` without
        // re-parsing: up to and including the `>` of a named group, else the `?X`.
        let rest = &src[i..];
        let take = if rest.starts_with("(?<") && !rest.starts_with("(?<=") && !rest.starts_with("(?<!") {
          rest.find('>').map(|p| p + 1).unwrap_or(clen)
        } else if rest.starts_with("(?<=") || rest.starts_with("(?<!") {
          4
        } else if rest.starts_with("(?") {
          3.min(rest.len())
        } else {
          clen
        };
        (Kind::GroupOpen, '(', i + take)
      }
      ')' if !in_class => {
        depth = depth.saturating_sub(1);
        (Kind::GroupClose, ')', i + clen)
      }
      '|' if !in_class => (Kind::Alt, '|', i + clen),
      _ => (Kind::Char, c, i + clen),
    };
    out.push(Token {
      kind,
      ch,
      start,
      end,
      // A ClassOpen reports itself as outside the class it opens; a ClassClose as
      // inside the one it closes. That is what makes "am I in a class" readable from
      // any single token without looking at its neighbours.
      in_class: match kind {
        Kind::ClassOpen => false,
        Kind::ClassClose => true,
        _ => in_class,
      },
      depth: depth_before,
      at_class_start: was_class_start,
    });
    i = end;
  }
  // An unclosed class means the rest of the pattern was mis-read; refuse rather than
  // hand back a walk that is quietly wrong.
  (!in_class).then_some(out)
}

/// Whether `src` has a `|` outside every group and class.
///
/// The guard several rewrites rest on. `(?=.*B)` means "B occurs somewhere" only
/// because the `.*` covers ALL of B, and a top-level `|` splits it so the `.*` reaches
/// only the first alternative: `/(?=.*a|b)(?=.*c|d)/` does not match "cb", while the
/// AND of `/a|b/` and `/c|d/` does.
pub fn has_top_level_alternation(src: &str) -> bool {
  match tokenize(src) {
    Some(toks) => toks
      .iter()
      .any(|t| t.kind == Kind::Alt && t.depth == 0 && !t.in_class),
    // Unparseable: say yes, so the caller refuses rather than guesses.
    None => true,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn kinds(src: &str) -> Vec<Kind> {
    tokenize(src).unwrap().iter().map(|t| t.kind).collect()
  }

  #[test]
  fn escapes_swallow_their_char() {
    let t = tokenize(r"a\.b").unwrap();
    assert_eq!(kinds(r"a\.b"), [Kind::Char, Kind::Escape, Kind::Char]);
    assert_eq!(t[1].ch, '.');
    assert_eq!(t[1].text(r"a\.b"), r"\.");
    // An escaped backslash must not make the NEXT char look escaped.
    assert_eq!(kinds(r"a\\d"), [Kind::Char, Kind::Escape, Kind::Char]);
    assert_eq!(tokenize(r"a\\d").unwrap()[1].ch, '\\');
    assert!(tokenize(r"trailing\").is_none());
  }

  #[test]
  fn class_contents_are_literal() {
    // Inside a class, `(`, `)`, `|`, `.` and `[` are all ordinary characters — the
    // thing every hand-written walker had to remember separately.
    let src = r"[(|.[]x";
    let toks = tokenize(src).unwrap();
    assert_eq!(toks[0].kind, Kind::ClassOpen);
    assert!(toks[1..5].iter().all(|t| t.kind == Kind::Char && t.in_class));
    assert_eq!(toks[5].kind, Kind::ClassClose);
    assert_eq!(toks[6].kind, Kind::Char);
    assert!(!toks[6].in_class);
    assert!(tokenize("[unclosed").is_none());
  }

  #[test]
  fn a_leading_bracket_in_a_class_is_a_member() {
    // JS reads `[]]` as a class containing `]`; a walker that closes on the first `]`
    // reads the rest of the pattern in the wrong mode from there on.
    let toks = tokenize("[]]a").unwrap();
    assert_eq!(toks[0].kind, Kind::ClassOpen);
    assert_eq!(toks[1].kind, Kind::Char);
    assert!(toks[1].at_class_start);
    assert_eq!(toks[2].kind, Kind::ClassClose);
    assert_eq!(toks[3].ch, 'a');
  }

  #[test]
  fn a_negation_rides_with_the_class_open() {
    // `[^` is one token, so a caller passing tokens through unchanged reproduces the
    // negation without having to know about it.
    assert_eq!(tokenize("[^ab]").unwrap()[0].text("[^ab]"), "[^");
    assert_eq!(tokenize("[ab]").unwrap()[0].text("[ab]"), "[");
  }

  #[test]
  fn depth_makes_top_level_alternation_decidable() {
    assert!(has_top_level_alternation("a|b"));
    assert!(!has_top_level_alternation("(a|b)"));
    assert!(!has_top_level_alternation("(?:a|b)c"));
    assert!(!has_top_level_alternation("[a|b]"));
    assert!(!has_top_level_alternation(r"a\|b")); // escaped: a literal pipe
    assert!(has_top_level_alternation("(a)|b"));
    assert!(has_top_level_alternation("[unclosed")); // unparseable refuses
  }

  #[test]
  fn group_prefixes_are_taken_whole() {
    let src = "(?=x)(?!y)(?:z)(w)(?<n>v)(?<=u)";
    let toks = tokenize(src).unwrap();
    let opens: Vec<&str> = toks
      .iter()
      .filter(|t| t.kind == Kind::GroupOpen)
      .map(|t| t.text(src))
      .collect();
    assert_eq!(opens, ["(?=", "(?!", "(?:", "(", "(?<n>", "(?<="]);
  }

  #[test]
  fn the_semantics_table_says_what_js_means() {
    // Pinned as values, because these are the facts the whole translation rests on and
    // `crosscheck.ts` verifies the same strings against a real JS RegExp.
    assert_eq!(JS_DIGIT, "0-9");
    assert_eq!(JS_WORD, "0-9A-Za-z_");
    assert!(JS_SPACE.contains(r"\x{feff}"), "JS \\s includes U+FEFF");
    assert!(JS_SPACE.contains(r"\x{a0}"), "JS \\s includes NBSP");
    assert!(JS_DOT.contains(r"\x{2028}"), "JS . refuses U+2028");
    assert!(has_line_separator("a\u{2028}b"));
    assert!(has_line_separator("a\u{2029}b"));
    assert!(!has_line_separator("a b\nc"));
  }
}
