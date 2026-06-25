import type {
  Filter,
  FilterGroup,
  FilterSet,
  TimelineSource,
  TimeUnit,
  EventShape,
} from "@/types";
import { makeFilter, uid, filterFromTatAttrs } from "@/lib/defaults";
import { guessUnit } from "@/lib/engine";

/**
 * Parse a TextAnalysisTool.NET (.tat) filter file so users of that tool can
 * import their filters here. Returns null when the text isn't a TAT document.
 */
export function parseTatFilters(text: string): ImportedFilters | null {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) return null;
  if (doc.documentElement?.tagName !== "TextAnalysisTool.NET") return null;
  const attrs = [
    "text",
    "description",
    "enabled",
    "excluding",
    "case_sensitive",
    "regex",
    "foreColor",
    "backColor",
  ];
  const filters = Array.from(doc.getElementsByTagName("filter")).map((el) =>
    filterFromTatAttrs(
      Object.fromEntries(attrs.map((k) => [k, el.getAttribute(k)])),
    ),
  );
  return { filters, groups: [], order: filters.map((f) => f.id), sources: [] };
}

const TIME_UNITS: TimeUnit[] = ["hms", "s", "ms", "us", "ns", "date", "custom"];
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
export function exportPayload(
  g: Pick<FilterSet, "name" | "groups" | "order" | "filters" | "sources">,
): string {
  return JSON.stringify(
    {
      version: 1,
      name: g.name,
      groups: g.groups,
      order: g.order,
      filters: g.filters,
      sources: g.sources ?? [],
    },
    null,
    2,
  );
}

/**
 * Project a subset of a set's filters down to a standalone, exportable document
 * — the "filter pack" shape. Keeps a group only when at least one of its filters
 * is in the selection, and projects the top-level `order` to just the surviving
 * loose filters and kept groups. Timeline sources are intentionally dropped: they
 * bind a filter to one file's time semantics, which rarely travel with a reused
 * pack. The result round-trips through `exportPayload` / `buildGroupFromImport`
 * like any other filter file.
 */
export function projectSelection(
  set: Pick<FilterSet, "name" | "groups" | "order" | "filters">,
  ids: Iterable<string>,
): Pick<FilterSet, "name" | "groups" | "order" | "filters" | "sources"> {
  const sel = new Set(ids);
  const filters = set.filters.filter((f) => sel.has(f.id));
  // A group survives only if it still holds a selected filter.
  const keptGroups = new Set(
    filters.map((f) => f.groupId).filter((g): g is string => g != null),
  );
  const groups = set.groups.filter((g) => keptGroups.has(g.id));
  // `order` interleaves loose-filter ids and group ids; keep the ones still here.
  const order = set.order.filter((id) => sel.has(id) || keptGroups.has(id));
  return { name: set.name, groups, order, filters, sources: [] };
}

/** Parse timeline tracks (one per filter+field) from an imported document. */
function importSources(raw: unknown): TimelineSource[] {
  if (!Array.isArray(raw)) return [];
  const out: TimelineSource[] = [];
  const seen = new Set<string>();
  for (const s of raw as any[]) {
    // A track needs both a filter binding and a field; de-dupe by the pair.
    if (!s || typeof s.filterId !== "string" || typeof s.timeField !== "string")
      continue;
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
      endField:
        kind === "span" && typeof s.endField === "string"
          ? s.endField
          : undefined,
      unit: TIME_UNITS.includes(s.unit) ? s.unit : guessUnit(s.timeField),
      format: typeof s.format === "string" ? s.format : undefined,
      color: typeof s.color === "string" ? s.color : undefined,
      shape: SHAPES.includes(s.shape) ? s.shape : undefined,
      collapsed: s.collapsed === true ? true : undefined,
      hidden: s.hidden === true ? true : undefined,
    });
  }
  return out;
}

/**
 * Give every group and filter in an imported document a fresh id, rewiring
 * `groupId`, the top-level `order`, and timeline source bindings to match.
 * Required before *appending* an import into a set that may already contain the
 * original ids (loading the same file twice, or two files that share ids):
 * duplicate ids would corrupt group membership, source bindings and React keys.
 * Mirrors the id-remap used by `duplicateSet`, plus source bindings.
 */
export function remapImportIds(b: ImportedFilters): ImportedFilters {
  const groupMap = new Map(
    b.groups.map((grp) => [grp.id, uid("grp")] as const),
  );
  const filMap = new Map(b.filters.map((fl) => [fl.id, uid("f")] as const));
  return {
    groups: b.groups.map((grp) => ({ ...grp, id: groupMap.get(grp.id)! })),
    filters: b.filters.map((fl) => ({
      ...fl,
      id: filMap.get(fl.id)!,
      groupId: fl.groupId ? (groupMap.get(fl.groupId) ?? null) : null,
      fields: fl.fields ? fl.fields.map((x) => ({ ...x })) : undefined,
    })),
    order: b.order
      .map((id) => groupMap.get(id) ?? filMap.get(id))
      .filter((x): x is string => !!x),
    // A track binds to a filter by id; drop tracks whose filter didn't come
    // along, and give the rest fresh ids + remapped bindings.
    sources: b.sources
      .filter((s) => filMap.has(s.filterId))
      .map((s) => ({
        ...s,
        id: uid("tlt"),
        filterId: filMap.get(s.filterId)!,
      })),
  };
}

/**
 * Parse an already-JSON-parsed filters file into a set's filters/groups/order.
 * Returns null when the data isn't a recognizable filter document.
 */
export function buildGroupFromImport(data: unknown): ImportedFilters | null {
  // Full structure: { filters, groups?, order? }.
  if (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Array.isArray((data as any).filters)
  ) {
    const d = data as any;
    const rawGroups = Array.isArray(d.groups) ? d.groups : [];
    const groups: FilterGroup[] = rawGroups
      .filter((s: any) => s && typeof s.id === "string")
      .map((s: any) => ({
        id: s.id,
        name: typeof s.name === "string" ? s.name : "Group",
        collapsed: !!s.collapsed,
      }));
    const validGroupIds = new Set(groups.map((s) => s.id));
    const filters: Filter[] = d.filters.map((x: any) => {
      const f = makeFilter(
        typeof x?.pattern === "string" ? x.pattern : "",
        x ?? {},
      );
      if (typeof x?.id === "string") f.id = x.id;
      const gid = typeof x?.groupId === "string" ? x.groupId : null;
      f.groupId = gid && validGroupIds.has(gid) ? gid : null;
      return f;
    });
    const order: string[] = Array.isArray(d.order)
      ? d.order.filter((id: any) => typeof id === "string")
      : [];
    const sources = importSources(d.sources);
    return { filters, groups, order, sources };
  }
  // Legacy: a flat array of filters.
  if (Array.isArray(data)) {
    const filters = data.map((x: any) => {
      const f = makeFilter(
        typeof x?.pattern === "string" ? x.pattern : "",
        x ?? {},
      );
      if (typeof x?.id === "string") f.id = x.id;
      return f;
    });
    return {
      filters,
      groups: [],
      order: filters.map((f) => f.id),
      sources: [],
    };
  }
  return null;
}
