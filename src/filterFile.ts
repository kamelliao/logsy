import type { Filter, FilterGroup, FilterSet } from "./types";
import { makeFilter } from "./data";

/** The filters/groups/layout extracted from an imported filter file. */
export interface ImportedFilters {
  filters: Filter[];
  groups: FilterGroup[];
  order: string[];
}

/**
 * Serialize a filter set to the on-disk export format (Logsy filters JSON).
 * Keeps the full structure — filters, groups and top-level order — so a load
 * round-trips back to the same arrangement.
 */
export function exportPayload(g: Pick<FilterSet, "name" | "groups" | "order" | "filters">): string {
  return JSON.stringify(
    { version: 1, name: g.name, groups: g.groups, order: g.order, filters: g.filters },
    null,
    2
  );
}

/**
 * Parse an already-JSON-parsed filters file into a set's filters/groups/order.
 * Returns null when the data isn't a recognizable filter document.
 */
export function buildGroupFromImport(data: unknown): ImportedFilters | null {
  // Full structure: { filters, groups?, order? }.
  if (data && typeof data === "object" && !Array.isArray(data) && Array.isArray((data as any).filters)) {
    const d = data as any;
    const rawGroups = Array.isArray(d.groups) ? d.groups : [];
    const groups: FilterGroup[] = rawGroups
      .filter((s: any) => s && typeof s.id === "string")
      .map((s: any) => ({ id: s.id, name: typeof s.name === "string" ? s.name : "Group", collapsed: !!s.collapsed }));
    const validGroupIds = new Set(groups.map((s) => s.id));
    const filters: Filter[] = d.filters.map((x: any) => {
      const f = makeFilter(typeof x?.pattern === "string" ? x.pattern : "", x ?? {});
      if (typeof x?.id === "string") f.id = x.id;
      const gid = typeof x?.groupId === "string" ? x.groupId : null;
      f.groupId = gid && validGroupIds.has(gid) ? gid : null;
      return f;
    });
    const order: string[] = Array.isArray(d.order) ? d.order.filter((id: any) => typeof id === "string") : [];
    return { filters, groups, order };
  }
  // Legacy: a flat array of filters.
  if (Array.isArray(data)) {
    const filters = data.map((x: any) => {
      const f = makeFilter(typeof x?.pattern === "string" ? x.pattern : "", x ?? {});
      if (typeof x?.id === "string") f.id = x.id;
      return f;
    });
    return { filters, groups: [], order: filters.map((f) => f.id) };
  }
  return null;
}
