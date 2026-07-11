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

/**
 * The filter set `gid` from the global list. Set ids are globally unique, so the
 * file id is no longer needed to resolve one; `fid` is kept for call-site symmetry
 * (and to document which file the caller is acting on).
 */
export function withSet(s: AppState, _fid: string, gid: string): FilterSet {
  return s.filterSets.find((g) => g.id === gid)!;
}

/**
 * The active filter set (mirrors the render-time `set` derivation) — for store
 * actions that must resolve the set from a fresh snapshot instead of closing over
 * render-time values. The set LIST is global, but the SELECTION is per-document:
 * this reads the active file's `activeSetId`, falling back to the first set.
 */
export function activeSet(s: AppState): FilterSet | null {
  const fid = activeFile(s)?.activeSetId;
  return (
    (fid ? s.filterSets.find((g) => g.id === fid) : undefined) ??
    s.filterSets[0] ??
    null
  );
}
