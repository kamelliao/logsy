import { test, expect } from "bun:test";
import {
  exportPayload,
  buildGroupFromImport,
  remapImportIds,
} from "@/lib/filterFile";
import type { ImportedFilters } from "@/lib/filterFile";
import { makeFilter } from "@/lib/defaults";
import type { Filter, FilterGroup, FilterSet } from "@/types";

// Simulate the full save → reload trip: serialize like the app does, then parse
// the resulting text back the way loadFilterFromPath does after reading a file.
function roundTrip(set: FilterSet) {
  return buildGroupFromImport(JSON.parse(exportPayload(set)));
}

function makeSet(over: Partial<FilterSet> = {}): FilterSet {
  return {
    id: "set1",
    name: "My Set",
    filters: [],
    groups: [],
    order: [],
    ...over,
  };
}

// --- the regression this guards against -------------------------------------

test("export → load round-trips filters, groups, and order intact", () => {
  const groups: FilterGroup[] = [
    { id: "g1", name: "Boot", collapsed: false },
    { id: "g2", name: "Errors", collapsed: true },
  ];
  const f1 = makeFilter("mount ok", {
    id: "f1",
    groupId: "g1",
    description: "boot ok",
    textColor: "#166534",
    bgColor: "#dcfce7",
  } as Partial<Filter>);
  const f2 = makeFilter("ERR", {
    id: "f2",
    groupId: "g2",
    exclude: true,
    caseSensitive: true,
    regex: true,
    enabled: false,
  } as Partial<Filter>);
  const f3 = makeFilter("loose", {
    id: "f3",
    groupId: null,
  } as Partial<Filter>);
  const set = makeSet({
    groups,
    filters: [f1, f2, f3],
    order: ["f3", "g1", "g2"],
  });

  const built = roundTrip(set);
  expect(built).not.toBeNull();
  expect(built!.groups).toEqual(groups);
  expect(built!.order).toEqual(["f3", "g1", "g2"]);
  // Every filter field survives the trip unchanged.
  expect(built!.filters).toEqual([f1, f2, f3]);
});

test("round-trip preserves structured-field definitions", () => {
  const f = makeFilter("(?<ts>\\d+) (?<lvl>\\w+)", {
    id: "f1",
    regex: true,
    fields: [
      { name: "ts", type: "time" },
      { name: "lvl", type: "string" },
    ],
  } as Partial<Filter>);
  const built = roundTrip(makeSet({ filters: [f], order: ["f1"] }));
  expect(built!.filters[0].fields).toEqual([
    { name: "ts", type: "time" },
    { name: "lvl", type: "string" },
  ]);
});

test("round-trip preserves every boolean/color attribute", () => {
  const f = makeFilter("x", {
    id: "f1",
    enabled: false,
    caseSensitive: true,
    regex: true,
    exclude: true,
    textColor: "#b42318",
    bgColor: "#fce4e4",
    description: "note",
    groupId: null,
  } as Partial<Filter>);
  const built = roundTrip(makeSet({ filters: [f], order: ["f1"] }));
  expect(built!.filters[0]).toEqual(f);
});

test("round-trip preserves timeline tracks and de-dupes by filterId:timeField", () => {
  const f = makeFilter("(?<a>\\d+) (?<b>\\d+)", {
    regex: true,
  } as Partial<Filter>);
  const set = makeSet({
    filters: [f],
    order: [f.id],
    sources: [
      {
        id: "tl1",
        filterId: f.id,
        timeField: "a",
        lane: "req",
        kind: "span",
        endField: "b",
        unit: "ms",
        color: "#abc",
      },
      {
        id: "tl2",
        filterId: f.id,
        timeField: "a",
        lane: "dup",
        kind: "point",
        unit: "hms",
      }, // same pair → dropped
      {
        id: "tl3",
        filterId: "other",
        timeField: "a",
        lane: "ok",
        kind: "point",
        unit: "ns",
      }, // diff filter → kept
    ],
  });
  const built = roundTrip(set);
  expect(built!.sources).toEqual([
    {
      id: "tl1",
      filterId: f.id,
      timeField: "a",
      lane: "req",
      kind: "span",
      endField: "b",
      unit: "ms",
      color: "#abc",
      collapsed: undefined,
      hidden: undefined,
    },
    {
      id: "tl3",
      filterId: "other",
      timeField: "a",
      lane: "ok",
      kind: "point",
      endField: undefined,
      unit: "ns",
      color: undefined,
      collapsed: undefined,
      hidden: undefined,
    },
  ]);
});

// --- append: id remap -------------------------------------------------------

test("remapImportIds gives fresh ids and rewires groupId, order, and sources", () => {
  const built = buildGroupFromImport({
    groups: [{ id: "g1", name: "Boot", collapsed: false }],
    filters: [
      { id: "f1", pattern: "mount", groupId: "g1" },
      { id: "f2", pattern: "loose", groupId: null },
    ],
    order: ["f2", "g1"],
    sources: [
      {
        id: "tl1",
        filterId: "f1",
        timeField: "a",
        lane: "req",
        kind: "point",
        unit: "ms",
      },
      {
        id: "tl-orphan",
        filterId: "gone",
        timeField: "a",
        lane: "x",
        kind: "point",
        unit: "ms",
      },
    ],
  })!;
  const out = remapImportIds(built);

  // Every id is regenerated — none of the originals survive.
  const oldIds = new Set(["g1", "f1", "f2", "tl1", "tl-orphan", "gone"]);
  expect(out.groups[0].id).not.toBe("g1");
  out.filters.forEach((f) => expect(oldIds.has(f.id)).toBe(false));
  out.sources.forEach((s) => expect(oldIds.has(s.id)).toBe(false));

  // groupId still points at the (now-renamed) group.
  const newG = out.groups[0].id;
  const grouped = out.filters.find((f) => f.pattern === "mount")!;
  const loose = out.filters.find((f) => f.pattern === "loose")!;
  expect(grouped.groupId).toBe(newG);
  expect(loose.groupId).toBeNull();

  // order references the remapped loose-filter id then the remapped group id.
  expect(out.order).toEqual([loose.id, newG]);

  // The track binding to f1 is remapped; the orphan (filter not imported) drops.
  expect(out.sources).toHaveLength(1);
  expect(out.sources[0].filterId).toBe(grouped.id);

  // Field definitions are deep-copied, not shared with the source.
  const src: ImportedFilters = built;
  expect(out.filters[0]).not.toBe(src.filters[0]);
});

// --- legacy format ----------------------------------------------------------

test("buildGroupFromImport reads a legacy flat array of filters", () => {
  const built = buildGroupFromImport([
    { id: "f1", pattern: "alpha" },
    { id: "f2", pattern: "beta" },
  ]);
  expect(built!.groups).toEqual([]);
  expect(built!.filters.map((f) => f.pattern)).toEqual(["alpha", "beta"]);
  expect(built!.order).toEqual(["f1", "f2"]);
});

// --- robustness against malformed input -------------------------------------

test("buildGroupFromImport drops filter references to non-existent groups", () => {
  const built = buildGroupFromImport({
    filters: [{ id: "f1", pattern: "p", groupId: "ghost" }],
    groups: [],
    order: [],
  });
  expect(built!.filters[0].groupId).toBeNull();
});

test("buildGroupFromImport returns null for non-filter data", () => {
  expect(buildGroupFromImport(null)).toBeNull();
  expect(buildGroupFromImport(42)).toBeNull();
  expect(buildGroupFromImport({ name: "no filters here" })).toBeNull();
  expect(buildGroupFromImport("just a string")).toBeNull();
});

test("buildGroupFromImport tolerates missing optional fields with sane defaults", () => {
  const built = buildGroupFromImport({ filters: [{ pattern: "p" }] });
  const f = built!.filters[0];
  expect(f.pattern).toBe("p");
  expect(f.enabled).toBe(true);
  expect(f.groupId).toBeNull();
  expect(typeof f.id).toBe("string");
  expect(f.id.length).toBeGreaterThan(0);
});
