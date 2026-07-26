//! Cross-check helper: emits `scan_text`'s blob for a given text + patterns so the
//! frontend can compare Rust's match bit sets against real JS `RegExp` results.
//!
//! It exists because the two engines must agree bit for bit — a disagreement shows
//! up as silently wrong highlight colours, never as an error. The comparison itself
//! lives in `scripts/crosscheck.ts`, which owns the cases and does the diffing; this
//! binary is only the Rust half of the pipe.
//!
//! An *example*, not a `[[bin]]`, and deliberately so: the Tauri bundler enumerates
//! every bin target in the manifest and ignores `required-features`, so a dev-only
//! bin gets written into the installer's file list and then fails to bundle (or, if
//! it happens to be lying around in `target/`, silently ships to users). Examples
//! are invisible to the bundler and are still skipped by a plain `cargo build`:
//!
//! ```text
//! cargo build --release --example crosscheck
//! ```
//!
//! stdin:  {"text": "...", "patterns": [{"source": "...", "ci": true}, ...]}
//! stdout: the raw blob, exactly as `scan_lines` would return it over IPC.
//!
//! Includes the app's own `scan.rs` via `#[path]` rather than duplicating it — the
//! whole point is to test the code that actually ships. (That's also why `scan.rs`
//! is a standalone module with no tauri dependency.)
#[path = "../src/scan.rs"]
mod scan;

use std::io::{Read, Write};

#[derive(serde::Deserialize)]
struct Input {
    text: String,
    patterns: Vec<scan::ScanSpec>,
}

fn main() {
    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .expect("read stdin");
    let input: Input = serde_json::from_str(&buf).expect("parse stdin JSON");
    // read_us is only telemetry; the comparison ignores it.
    let blob = scan::scan_text(&input.text, &input.patterns, 0);
    std::io::stdout().write_all(&blob).expect("write stdout");
}
