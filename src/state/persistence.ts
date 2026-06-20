import type { AppState } from "@/types";
import { initialState, normalizeState } from "@/lib/defaults";

export const STATE_KEY = "logsy.state.v6";

// Safe mode (app launched with `--safe`): the Rust side injects
// `window.__LOGSY_SAFE_MODE__` before the bundle runs. We then neither read nor
// write persisted state this session, so a state that freezes/crashes the app on
// load can be escaped without losing it — the bad state stays on disk and the
// next normal launch resumes it (use this to export/repair, then restart).
export const SAFE_MODE = typeof window !== "undefined"
  && Boolean((window as unknown as { __LOGSY_SAFE_MODE__?: boolean }).__LOGSY_SAFE_MODE__);

export function loadState(): AppState {
  if (SAFE_MODE) return normalizeState(initialState());
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) return normalizeState(JSON.parse(raw) as AppState);
  } catch { /* ignore */ }
  return normalizeState(initialState());
}
