import type { AppState, LogFile, FilterSet } from "@/types";

/** The log file with id `fid` (throws via `!` if absent — callers hold a live id). */
export function withFile(s: AppState, fid: string): LogFile {
  return s.files.find((f) => f.id === fid)!;
}

/**
 * The active file resolved from a state snapshot (mirrors the render-time
 * `file` derivation) — for patches that must not close over a stale `file`.
 */
export function activeFile(s: AppState): LogFile | null {
  return s.files.find((f) => f.id === s.activeFileId) ?? s.files[0] ?? null;
}

/** The filter set `gid` within file `fid`. */
export function withSet(s: AppState, fid: string, gid: string): FilterSet {
  return withFile(s, fid).sets.find((g) => g.id === gid)!;
}

/**
 * The active filter set of the active file (mirrors the render-time `set`
 * derivation) — for store actions that must resolve set/file from a fresh
 * snapshot instead of closing over render-time values.
 */
export function activeSet(s: AppState): FilterSet | null {
  const f = activeFile(s);
  if (!f) return null;
  return f.sets.find((g) => g.id === f.activeSetId) ?? f.sets[0] ?? null;
}
