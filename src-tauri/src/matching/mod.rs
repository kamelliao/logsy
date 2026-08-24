//! The match pipeline's Phase A: pattern × lines → match bit set.
//!
//! See docs/design-match.md. The boundary with the frontend is the bit set and
//! nothing else: what the filters mean, which engine can run them, and how they are
//! scanned all live here, and JS receives only the packed bits.
//!
//! (`match` is a keyword, hence `matching`.)
pub mod scan;
pub mod syntax;
pub mod translate;
