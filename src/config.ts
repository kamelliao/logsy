// Central app configuration — identity, persistence, and global tunables.
// Only genuinely app-global values live here; component-local layout constants
// (panel sizes, track colors, regex patterns, dialog file-filters, dock sizes…)
// deliberately stay co-located with their use.

// --- App identity ---------------------------------------------------------
export const APP_NAME = "Logsy";
export const APP_AUTHOR = "Kamel Liao";
export const DOCS_URL = "https://github.com/kamelliao/logsy#readme";
// Shown until Tauri's getVersion() resolves the real bundle version at runtime.
export const APP_VERSION_FALLBACK = "0.2.1";

// --- Persistence ----------------------------------------------------------
// Bump STATE_VERSION when the persisted shape changes; STATE_KEY derives from it
// so the version number lives in exactly ONE place.
export const STATE_VERSION = 6;
export const STATE_KEY = `logsy.state.v${STATE_VERSION}`;

// Safe mode (app launched with `--safe`): the Rust side injects
// `window.__LOGSY_SAFE_MODE__` before the bundle runs. We then neither read nor
// write persisted state this session, so a state that freezes/crashes the app on
// load can be escaped without losing it — the bad state stays on disk and the
// next normal launch resumes it (use this to export/repair, then restart).
export const SAFE_MODE =
  typeof window !== "undefined" &&
  Boolean(
    (window as unknown as { __LOGSY_SAFE_MODE__?: boolean })
      .__LOGSY_SAFE_MODE__,
  );

// --- Undo history ---------------------------------------------------------
export const HISTORY_CAP = 50;

// --- Log-view font (zoom: Ctrl +/−/0 and Ctrl+wheel; persisted, not undoable) ---
export const FONT_DEFAULT = 12; // fallback + zoom-reset target
export const FONT_INITIAL = 12.5; // fresh-workspace persisted default (NOTE: differs from FONT_DEFAULT)
export const FONT_STEP = 1;
export const FONT_MIN = 8;
export const FONT_MAX = 24;
export const clampFont = (n: number) =>
  Math.max(FONT_MIN, Math.min(FONT_MAX, n));

// --- Default filter colors ------------------------------------------------
export const DEFAULT_TEXT_COLOR = "#1c1f23";
export const DEFAULT_BG_COLOR = "#ffffff";
