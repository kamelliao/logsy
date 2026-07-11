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
 * The filter set `gid` from the app-level pool. Set ids are globally unique, so
 * the file id is no longer needed to resolve one; `fid` is kept for call-site
 * symmetry (and to document which file the caller is acting on).
 */
export function withSet(s: AppState, _fid: string, gid: string): FilterSet {
  return s.filterSets[gid]!;
}

/**
 * The active filter set of the active file (mirrors the render-time `set`
 * derivation) — for store actions that must resolve set/file from a fresh
 * snapshot instead of closing over render-time values. Falls back to the file's
 * first referenced set when `activeSetId` doesn't resolve.
 */
export function activeSet(s: AppState): FilterSet | null {
  const f = activeFile(s);
  if (!f) return null;
  return (
    (f.activeSetId ? s.filterSets[f.activeSetId] : undefined) ??
    s.filterSets[f.setRefs[0] ?? ""] ??
    null
  );
}

/** The ordered filter sets a file shows (its tab strip), resolved from the pool.
 *  Skips ids that no longer resolve (defensive; normalizeState prunes them). */
export function fileSets(s: AppState, file: LogFile): FilterSet[] {
  return file.setRefs
    .map((id) => s.filterSets[id])
    .filter((g): g is FilterSet => !!g);
}

/** How many open files reference set `setId` (>1 means it's shared). */
export function setUseCount(s: AppState, setId: string): number {
  return s.files.reduce((n, f) => n + (f.setRefs.includes(setId) ? 1 : 0), 0);
}
