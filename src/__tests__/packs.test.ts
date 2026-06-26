import { test, expect } from "bun:test";
import {
  projectSelection,
  remapImportIds,
  appendImportToSet,
  buildGroupFromImport,
  rebuildOrder,
} from "@/lib/filterFile";
import { makeFilter, normalizeState } from "@/lib/defaults";
import type {
  AppState,
  Filter,
  FilterGroup,
  FilterPack,
  FilterSet,
} from "@/types";

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

// A pack is projectSelection's output (sans sources) plus id/name/createdAt.
function packFromSelection(
  set: FilterSet,
  ids: string[],
  name: string,
): FilterPack {
  const proj = projectSelection(set, ids);
  return {
    id: "pack1",
    name,
    createdAt: 0,
    filters: structuredClone(proj.filters),
    groups: structuredClone(proj.groups),
    order: [...proj.order],
  };
}

test("a saved pack is independent of later edits to its source set", () => {
  const f1 = makeFilter("alpha", { groupId: null } as Partial<Filter>);
  const set = makeSet({ filters: [f1], order: [f1.id] });
  const pack = packFromSelection(set, [f1.id], "Greek");
  // Mutate the live set's filter; the pack's clone must not change.
  f1.pattern = "MUTATED";
  expect(pack.filters[0].pattern).toBe("alpha");
});

test("inserting a pack remaps ids and appends into a set", () => {
  const groups: FilterGroup[] = [{ id: "g1", name: "Boot", collapsed: false }];
  const f1 = makeFilter("mount", { groupId: "g1" } as Partial<Filter>);
  const f2 = makeFilter("loose", { groupId: null } as Partial<Filter>);
  const src = makeSet({ groups, filters: [f1, f2], order: [f2.id, "g1"] });
  const pack = packFromSelection(src, [f1.id, f2.id], "Boot pack");

  // A different target set that already holds one filter.
  const existing = makeFilter("keep", { groupId: null } as Partial<Filter>);
  const target = makeSet({ filters: [existing], order: [existing.id] });

  const add = remapImportIds({
    filters: pack.filters,
    groups: pack.groups,
    order: pack.order,
    sources: [],
  });
  appendImportToSet(target, add);

  // Original kept, two appended with fresh ids.
  expect(target.filters.map((f) => f.pattern)).toEqual([
    "keep",
    "mount",
    "loose",
  ]);
  const oldIds = new Set([f1.id, f2.id, "g1"]);
  for (const f of add.filters) expect(oldIds.has(f.id)).toBe(false);
  expect(add.groups[0].id).not.toBe("g1");
  // groupId rewired to the remapped group.
  const mount = target.filters.find((f) => f.pattern === "mount")!;
  expect(mount.groupId).toBe(add.groups[0].id);
});

test("inserting the same pack twice never collides", () => {
  const f1 = makeFilter("x", { groupId: null } as Partial<Filter>);
  const src = makeSet({ filters: [f1], order: [f1.id] });
  const pack = packFromSelection(src, [f1.id], "p");
  const target = makeSet();
  for (let i = 0; i < 2; i++) {
    const add = remapImportIds({
      filters: pack.filters,
      groups: pack.groups,
      order: pack.order,
      sources: [],
    });
    appendImportToSet(target, add);
  }
  const ids = target.filters.map((f) => f.id);
  expect(new Set(ids).size).toBe(ids.length); // all unique
  expect(target.filters).toHaveLength(2);
});

test("a pack round-trips through the filter-file format", () => {
  const f = makeFilter("(?<a>\\d+)", { regex: true } as Partial<Filter>);
  const src = makeSet({ filters: [f], order: [f.id] });
  const pack = packFromSelection(src, [f.id], "p");
  const contents = JSON.stringify({
    version: 1,
    name: pack.name,
    groups: pack.groups,
    order: pack.order,
    filters: pack.filters,
    sources: [],
  });
  const built = buildGroupFromImport(JSON.parse(contents));
  expect(built!.filters.map((f) => f.pattern)).toEqual(["(?<a>\\d+)"]);
});

test("rebuildOrder mirrors the flat filter sequence for loose filters", () => {
  const a = makeFilter("a", { groupId: null } as Partial<Filter>);
  const b = makeFilter("b", { groupId: null } as Partial<Filter>);
  const c = makeFilter("c", { groupId: null } as Partial<Filter>);
  // A reorder swaps the array; order must follow it 1:1.
  expect(rebuildOrder([c, a, b], [])).toEqual([c.id, a.id, b.id]);
});

test("rebuildOrder emits a group once, at its first member's position", () => {
  const groups: FilterGroup[] = [{ id: "g1", name: "G", collapsed: false }];
  const loose = makeFilter("loose", { groupId: null } as Partial<Filter>);
  const m1 = makeFilter("m1", { groupId: "g1" } as Partial<Filter>);
  const m2 = makeFilter("m2", { groupId: "g1" } as Partial<Filter>);
  // loose first, then the two group members → [loose, g1] (g1 collapses its run).
  expect(rebuildOrder([loose, m1, m2], groups)).toEqual([loose.id, "g1"]);
  // group member first → group leads.
  expect(rebuildOrder([m1, loose, m2], groups)).toEqual(["g1", loose.id]);
});

test("rebuildOrder appends a group left without any member", () => {
  const groups: FilterGroup[] = [{ id: "g1", name: "G", collapsed: false }];
  const loose = makeFilter("x", { groupId: null } as Partial<Filter>);
  // g1 has no member among the filters — it's kept, appended at the end.
  expect(rebuildOrder([loose], groups)).toEqual([loose.id, "g1"]);
});

function makeAppState(over: Partial<AppState> = {}): AppState {
  return {
    files: [],
    activeFileId: null,
    recentFiles: [],
    recentFilterFiles: [],
    sidebarCollapsed: true,
    splitRatio: 0.5,
    panelPos: "right",
    mapColorMode: "bg",
    mapWidth: 16,
    fontSize: 13,
    fontWeight: 400,
    showLineNumbers: true,
    comparePos: "right",
    filterCollapsed: false,
    activePanelTab: "filters",
    comparePopped: false,
    panelSizes: {},
    ...over,
  };
}

test("normalizeState drops malformed packs and clears an empty library", () => {
  const good: FilterPack = {
    id: "p1",
    name: "ok",
    createdAt: 1,
    filters: [],
    groups: [],
    order: [],
  };
  const state = makeAppState({
    filterPacks: [
      good,
      { id: "p2" } as unknown as FilterPack, // missing arrays → dropped
      null as unknown as FilterPack,
    ],
  });
  normalizeState(state);
  expect(state.filterPacks).toEqual([good]);

  const emptied = makeAppState({ filterPacks: [] });
  normalizeState(emptied);
  expect(emptied.filterPacks).toBeUndefined();
});

test("normalizeState sanitizes pack tags (trim, drop blanks/non-strings, clear empty)", () => {
  const withTags: FilterPack = {
    id: "p1",
    name: "ok",
    createdAt: 1,
    filters: [],
    groups: [],
    order: [],
    tags: ["  net  ", "", 5 as unknown as string, "boot"],
  };
  const emptyTags: FilterPack = {
    id: "p2",
    name: "ok2",
    createdAt: 1,
    filters: [],
    groups: [],
    order: [],
    tags: ["   "],
  };
  const state = makeAppState({ filterPacks: [withTags, emptyTags] });
  normalizeState(state);
  expect(state.filterPacks![0].tags).toEqual(["net", "boot"]);
  // A tag list that's all blanks collapses to no `tags` field at all.
  expect(state.filterPacks![1].tags).toBeUndefined();
});

test("normalizeState keeps a valid packsSort and drops an invalid one", () => {
  const ok = makeAppState({ packsSort: "name" });
  normalizeState(ok);
  expect(ok.packsSort).toBe("name");

  const bad = makeAppState({
    packsSort: "bogus" as unknown as AppState["packsSort"],
  });
  normalizeState(bad);
  expect(bad.packsSort).toBeUndefined();
});
