import type { Filter, FilterGroup, FilterSet, TimelineSource, TimeUnit, EventShape } from "./types";
import { makeFilter, uid } from "./data";
import { guessUnit } from "./logic";

const TIME_UNITS: TimeUnit[] = ["hms", "s", "ms", "us", "ns"];
const SHAPES: EventShape[] = ["circle", "square", "triangle", "diamond"];

/** The filters/groups/layout extracted from an imported filter file. */
export interface ImportedFilters {
  filters: Filter[];
  groups: FilterGroup[];
  order: string[];
  sources: TimelineSource[];
}

/**
 * Serialize a filter set to the on-disk export format (Logsy filters JSON).
 * Keeps the full structure — filters, groups, top-level order and timeline
 * sources — so a load round-trips back to the same arrangement.
 */
export function exportPayload(g: Pick<FilterSet, "name" | "groups" | "order" | "filters" | "sources">): string {
  return JSON.stringify(
    { version: 1, name: g.name, groups: g.groups, order: g.order, filters: g.filters, sources: g.sources ?? [] },
    null,
    2
  );
}

/** Parse timeline tracks (one per filter+field) from an imported document. */
function importSources(raw: unknown): TimelineSource[] {
  if (!Array.isArray(raw)) return [];
  const out: TimelineSource[] = [];
  const seen = new Set<string>();
  for (const s of raw as any[]) {
    // A track needs both a filter binding and a field; de-dupe by the pair.
    if (!s || typeof s.filterId !== "string" || typeof s.timeField !== "string") continue;
    const key = s.filterId + ":" + s.timeField;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = s.kind === "span" ? "span" : "point";
    out.push({
      id: typeof s.id === "string" ? s.id : uid("tlt"),
      filterId: s.filterId,
      timeField: s.timeField,
      lane: typeof s.lane === "string" ? s.lane : s.timeField,
      kind,
      endField: kind === "span" && typeof s.endField === "string" ? s.endField : undefined,
      unit: TIME_UNITS.includes(s.unit) ? s.unit : guessUnit(s.timeField),
      color: typeof s.color === "string" ? s.color : undefined,
      shape: SHAPES.includes(s.shape) ? s.shape : undefined,
      collapsed: s.collapsed === true ? true : undefined,
      hidden: s.hidden === true ? true : undefined,
    });
  }
  return out;
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
    const sources = importSources(d.sources);
    return { filters, groups, order, sources };
  }
  // Legacy: a flat array of filters.
  if (Array.isArray(data)) {
    const filters = data.map((x: any) => {
      const f = makeFilter(typeof x?.pattern === "string" ? x.pattern : "", x ?? {});
      if (typeof x?.id === "string") f.id = x.id;
      return f;
    });
    return { filters, groups: [], order: filters.map((f) => f.id), sources: [] };
  }
  return null;
}
