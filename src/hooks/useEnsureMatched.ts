import { useEffect, useRef, useState } from "react";
import { ensureMatched, type EnsureResult } from "@/lib/match/ensure";
import type { Filter } from "@/types";

/**
 * Run Phase A for one document, and report a version that changes whenever new match
 * bit sets land. See docs/design-match.md.
 *
 * Declarative on purpose. Every filter operation — add, update, remove, reorder,
 * enable, switch set — changes the `filters` array, and every file change changes
 * `lines`, so depending on those two covers all of them. The alternative, each
 * mutation calling a prime function itself, is what let a whole leg go missing without
 * anything failing: a set switch scanned, an add did not, and neither knew.
 *
 * The returned version exists because the bit sets live outside React (a module-level
 * cache keyed by the lines array). A component reading them through `resolve` has to
 * put this in its memo deps or it will render the first, empty answer forever.
 *
 * Already-cached patterns are skipped inside `ensureMatched`, so a reorder or a toggle
 * costs nothing and does no IPC at all.
 */
export function useEnsureMatched(
  path: string | null | undefined,
  encoding: string | null | undefined,
  lines: string[],
  filters: Filter[],
  onDone?: (result: EnsureResult) => void,
): number {
  const [version, setVersion] = useState(0);
  // Held in a ref so a caller passing an inline callback doesn't restart the scan on
  // every render.
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    if (!lines.length || !filters.length) return;
    let stale = false;
    void ensureMatched(path, encoding, lines, filters, {
      cancelled: () => stale,
      onProgress: () => {
        if (!stale) setVersion((v) => v + 1);
      },
    }).then((result) => {
      if (stale) return;
      // Before the version bump, so the render that first sees a complete view can
      // already act on the finished result.
      done.current?.(result);
      setVersion((v) => v + 1);
    });
    // A superseded run (another filter edited, the file switched) stops at its next
    // slice; whatever it already cached stays cached and stays valid.
    return () => {
      stale = true;
    };
  }, [path, encoding, lines, filters]);

  return version;
}
