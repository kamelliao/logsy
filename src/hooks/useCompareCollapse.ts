import { useCallback, useMemo, useState } from "react";

/** Per-table collapse state for the Compare panel, kept here (not inside
 *  CompareTable) so the dock-head's collapse-all toggle and each table's chevron
 *  share one source of truth — the panel can live in either dock, so the state
 *  can't sit in the component. Keyed by group id (the source filter's id, or ""
 *  for ungrouped). Ephemeral UI state, not persisted. */
export function useCompareCollapse(rows: readonly { fieldsFromId?: string }[]) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // The group ids currently present (one table per source filter).
  const groupIds = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) s.add(r.fieldsFromId ?? "");
    return s;
  }, [rows]);

  const allCollapsed =
    groupIds.size > 0 && [...groupIds].every((id) => collapsed.has(id));

  const toggle = useCallback((id: string) => {
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  // Collapse-all when any table is open, expand-all once everything is collapsed.
  const toggleAll = useCallback(() => {
    setCollapsed(allCollapsed ? new Set() : new Set(groupIds));
  }, [allCollapsed, groupIds]);

  return {
    collapsed,
    toggle,
    toggleAll,
    allCollapsed,
    hasGroups: groupIds.size > 0,
  };
}
