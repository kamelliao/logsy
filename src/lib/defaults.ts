import type {
  AppState,
  Filter,
  FilterSet,
  Notebook,
  Pane,
  SplitView,
} from "@/types";
import { PANEL_TABS } from "@/types";
import { DEFAULT_TEXT_COLOR, DEFAULT_BG_COLOR, FONT_DEFAULT } from "@/config";

/** A TipTap doc counts as "written in" once it holds more than a lone empty
 *  paragraph — used to skip migrating untouched per-file notebooks. */
function docHasContent(doc: unknown): boolean {
  const c = (doc as { content?: unknown[] } | null)?.content;
  if (!Array.isArray(c) || c.length === 0) return false;
  if (c.length === 1) {
    const only = c[0] as { type?: string; content?: unknown };
    if (only?.type === "paragraph" && only.content === undefined) return false;
  }
  return true;
}

let _uid = 1;
export function uid(prefix: string): string {
  return `${prefix}_${(_uid++).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function makeFilter(
  pattern: string,
  opts: Partial<Filter> = {},
): Filter {
  return {
    id: uid("f"),
    pattern,
    description: opts.description ?? "",
    enabled: opts.enabled !== false,
    caseSensitive: !!opts.caseSensitive,
    regex: !!opts.regex,
    exclude: !!opts.exclude,
    textColor: opts.textColor ?? DEFAULT_TEXT_COLOR,
    bgColor: opts.bgColor ?? DEFAULT_BG_COLOR,
    groupId: opts.groupId ?? null,
    fields: opts.fields,
  };
}

// ---------------------------------------------------------------------------
// TextAnalysisTool.NET (.tat) import — lets users migrate their filter sets.
// These helpers are the pure mapping layer; the DOM parsing lives in filterFile.
// ---------------------------------------------------------------------------

/** Map a TextAnalysisTool.NET hex colour ("808000", or 8-digit ARGB) to #rrggbb. */
export function tatColor(
  raw: string | null | undefined,
  fallback: string,
): string {
  let h = (raw ?? "").trim().replace(/^#/, "");
  if (h.length === 8) h = h.slice(2); // drop the leading ARGB alpha byte
  return /^[0-9a-fA-F]{6}$/.test(h) ? `#${h.toLowerCase()}` : fallback;
}

/** Build one of our filters from a TextAnalysisTool.NET <filter> element's attrs. */
export function filterFromTatAttrs(
  a: Record<string, string | null | undefined>,
): Filter {
  const yes = (v: string | null | undefined) =>
    (v ?? "").trim().toLowerCase() === "y";
  return makeFilter(a.text ?? "", {
    description: a.description ?? "",
    enabled: yes(a.enabled),
    exclude: yes(a.excluding),
    caseSensitive: yes(a.case_sensitive),
    regex: yes(a.regex),
    textColor: tatColor(a.foreColor, DEFAULT_TEXT_COLOR),
    bgColor: tatColor(a.backColor, DEFAULT_BG_COLOR),
  });
}

/** A fresh, single-pane split view (i.e. the split is off) holding no tabs. */
function initialSplitView(): SplitView {
  const pane: Pane = { id: uid("pane"), tabs: [], active: null };
  return { dir: "h", panes: [pane], activePaneId: pane.id };
}

/** A fresh, empty workspace. Files are added by the user loading logs from disk. */
export function initialState(): AppState {
  return {
    files: [],
    activeFileId: null,
    recentFiles: [],
    recentFilterFiles: [],
    sidebarCollapsed: true,
    splitView: initialSplitView(),
    panelPos: "right",
    mapColorMode: "bg",
    mapWidth: 16,
    fontSize: FONT_DEFAULT,
    fontWeight: 400,
    showLineNumbers: true,
    filterCollapsed: false,
    activePanelTab: "filters",
    poppedCollapsed: false,
    panelSizes: {},
    filterSets: [],
  };
}

export function normalizeState(state: AppState): AppState {
  // Migrate the old app-level viewMode onto each file once (per-document now).
  const legacyViewMode = (
    state as Partial<Record<"viewMode", "all" | "matches">>
  ).viewMode;
  for (const f of state.files) {
    if (f.viewMode === undefined && legacyViewMode) f.viewMode = legacyViewMode;
  }
  // Filter sets are GLOBAL now — one ordered list (`state.filterSets`) shared by
  // every file. The active SELECTION stays per-document (`LogFile.activeSetId`,
  // resolved below). Migrate the two older shapes into the global list:
  //   - app-level pool `Record<id,FilterSet>` + per-file `setRefs` (previous model)
  //   - per-file `sets: FilterSet[]` (original model)
  // Malformed entries (no id / no filters array) are dropped here; the survivors
  // are deep-normalized by the loop below.
  {
    const byId = new Map<string, FilterSet>();
    const order: string[] = [];
    const pushSet = (g: unknown) => {
      if (!g || typeof g !== "object") return;
      const set = g as FilterSet;
      if (typeof set.id !== "string" || !Array.isArray(set.filters)) return;
      if (!byId.has(set.id)) {
        byId.set(set.id, set);
        order.push(set.id);
      }
    };
    // 1. Already-migrated global list.
    if (Array.isArray(state.filterSets)) state.filterSets.forEach(pushSet);
    // 2. Previous app-level pool (Record), ordered by how files referenced it —
    //    the (old) active file's tab order first, then the rest.
    const pool =
      !Array.isArray(state.filterSets) &&
      state.filterSets &&
      typeof state.filterSets === "object"
        ? (state.filterSets as unknown as Record<string, FilterSet>)
        : null;
    const files = Array.isArray(state.files) ? state.files : [];
    const orderedFiles = [
      ...files.filter((f) => f.id === state.activeFileId),
      ...files.filter((f) => f.id !== state.activeFileId),
    ];
    for (const f of orderedFiles) {
      const legacySets = (f as Partial<Record<"sets", FilterSet[]>>).sets;
      const refs = (f as Partial<Record<"setRefs", string[]>>).setRefs;
      if (Array.isArray(legacySets)) legacySets.forEach(pushSet); // original model
      if (pool && Array.isArray(refs)) for (const id of refs) pushSet(pool[id]);
    }
    // 3. Any pool set no file referenced (defensive).
    if (pool) for (const g of Object.values(pool)) pushSet(g);
    // Strip the retired per-file collection fields (setRefs / sets); the per-file
    // `activeSetId` SELECTION is kept and validated in the per-file loop below.
    for (const f of files) {
      delete (f as Partial<Record<"sets", unknown>>).sets;
      delete (f as Partial<Record<"setRefs", unknown>>).setRefs;
    }
    // Drop a stale global `activeSetId` from the interim global-selection model.
    delete (state as Partial<Record<"activeSetId", unknown>>).activeSetId;
    state.filterSets = order.map((id) => byId.get(id)!);
  }
  // Guarantee at least one set so the filter panel always has one to show.
  if (state.filterSets.length === 0) {
    state.filterSets.push({
      id: uid("g"),
      name: "Filters",
      filters: [],
      groups: [],
      order: [],
    });
  }
  for (const g of state.filterSets) {
    {
      if (!Array.isArray(g.groups)) g.groups = [];
      const validIds = new Set(g.groups.map((s) => s.id));
      for (const flt of g.filters) {
        // Drop references to deleted groups; backfill a missing groupId.
        if (
          flt.groupId === undefined ||
          (flt.groupId !== null && !validIds.has(flt.groupId))
        ) {
          flt.groupId = null;
        }
      }
      // Build / validate the top-level layout order (groups + ungrouped filters).
      if (!Array.isArray(g.order)) g.order = [];
      const groupIds = g.groups.map((s) => s.id);
      const ungroupedIds = g.filters
        .filter((f) => f.groupId === null)
        .map((f) => f.id);
      const valid = new Set<string>([...groupIds, ...ungroupedIds]);
      g.order = g.order.filter((id) => valid.has(id));
      const present = new Set(g.order);
      // Append anything missing. On first migration this preserves the old
      // layout: loose filter rows first (on top), then groups.
      for (const id of [...ungroupedIds, ...groupIds]) {
        if (!present.has(id)) g.order.push(id);
      }
      // Timeline track config: a track = (filter, field), so de-dupe by the
      // `filterId:timeField` pair — NOT by field name alone (which collapsed
      // every track sharing a field like `ts`/`time` down to one on reload).
      // Keep undefined when there are none.
      if (Array.isArray(g.sources)) {
        const seen = new Set<string>();
        g.sources = g.sources
          .filter((s) => {
            if (
              !s ||
              typeof s.filterId !== "string" ||
              typeof s.timeField !== "string"
            )
              return false;
            if (s.kind !== "point" && s.kind !== "span") return false;
            const key = s.filterId + ":" + s.timeField;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .map((s) => ({
            ...s,
            lane: typeof s.lane === "string" ? s.lane : s.timeField,
            unit: ["hms", "s", "ms", "us", "ns", "date", "custom"].includes(
              s.unit,
            )
              ? s.unit
              : "hms",
            format: typeof s.format === "string" ? s.format : undefined,
          }));
        if (g.sources.length === 0) delete g.sources;
      } else if (g.sources !== undefined) {
        delete g.sources;
      }
    }
  }
  // Per-file: normalize bookmarks + per-document view state (filter sets are
  // global now, so there's nothing per-file to reconcile against them).
  for (const f of state.files) {
    // Bookmarks: keep only well-formed entries (a numeric line + a string note).
    f.markers = Array.isArray(f.markers)
      ? f.markers
          .filter(
            (m) => m && typeof m.n === "number" && typeof m.icon === "string",
          )
          .map((m) => ({
            n: m.n,
            icon: m.icon,
            note: typeof m.note === "string" ? m.note : "",
          }))
      : [];
    // Per-document log-view header state (migrated from the old app-level viewMode).
    if (f.viewMode !== "matches") f.viewMode = "all";
    if (typeof f.findOpen !== "boolean") f.findOpen = false;
    // Resolve this document's active-set selection against the global list; an
    // invalid / missing id falls back to the first set.
    if (!f.activeSetId || !state.filterSets.some((g) => g.id === f.activeSetId))
      f.activeSetId = state.filterSets[0]?.id ?? null;
  }
  if (
    !state.activeFileId ||
    !state.files.find((f) => f.id === state.activeFileId)
  ) {
    state.activeFileId = state.files[0]?.id ?? null;
  }
  // Split view: N panes in one row/column. Prune tabs whose file is gone (a log
  // closed in a previous session), drop panes left with none, and guarantee the
  // invariants App relies on — at least one pane, a focused pane that exists, and
  // an active tab that is one of the pane's tabs. States saved before the split
  // view was persisted have no `splitView` at all and land on the seeded default.
  {
    const fileIds = new Set(state.files.map((f) => f.id));
    const raw = state.splitView as Partial<SplitView> | undefined;
    const panes: Pane[] = [];
    const seenPane = new Set<string>();
    for (const p of Array.isArray(raw?.panes) ? raw.panes : []) {
      if (!p || typeof p.id !== "string" || seenPane.has(p.id)) continue;
      const tabs = (Array.isArray(p.tabs) ? p.tabs : []).filter(
        (id, i, a) =>
          typeof id === "string" && fileIds.has(id) && a.indexOf(id) === i,
      );
      if (!tabs.length) continue; // every log this pane showed is closed → drop it
      seenPane.add(p.id);
      panes.push({
        id: p.id,
        tabs,
        active:
          typeof p.active === "string" && tabs.includes(p.active)
            ? p.active
            : tabs[tabs.length - 1],
      });
    }
    // Keep one pane no matter what: a fresh workspace, or one whose every log is
    // gone, still needs the main group. Seed it from the active file.
    if (!panes.length) {
      panes.push({
        id: uid("pane"),
        tabs: state.activeFileId ? [state.activeFileId] : [],
        active: state.activeFileId,
      });
    }
    const activePaneId =
      raw?.activePaneId && seenPane.has(raw.activePaneId)
        ? raw.activePaneId
        : panes[0].id;
    // The focused pane's active tab IS the app's active file. On a restore the
    // layout wins (the dock panels follow the focused pane), so re-point a stale
    // `activeFileId` at whatever that pane is actually showing.
    const focused = panes.find((p) => p.id === activePaneId)!.active;
    if (focused) state.activeFileId = focused;
    // Sizes only for panes that survived; an absent pane gets an even share.
    const sizes: Record<string, number> = {};
    for (const p of panes) {
      const v = raw?.sizes?.[p.id];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) sizes[p.id] = v;
    }
    state.splitView = {
      dir: raw?.dir === "v" ? "v" : "h",
      panes,
      activePaneId,
      ...(Object.keys(sizes).length ? { sizes } : {}),
    };
  }
  // File groups: keep only well-formed entries; drop a file's groupId when it
  // points at a group that no longer exists (mirrors the filter-group backfill
  // above). Older states have neither field → every file is ungrouped, i.e.
  // identical to before the feature.
  if (Array.isArray(state.fileGroups)) {
    state.fileGroups = state.fileGroups.filter(
      (g) =>
        g &&
        typeof g.id === "string" &&
        typeof g.name === "string" &&
        typeof g.collapsed === "boolean",
    );
    const groupIds = new Set(state.fileGroups.map((g) => g.id));
    for (const f of state.files) {
      if (
        f.groupId !== undefined &&
        f.groupId !== null &&
        !groupIds.has(f.groupId)
      )
        f.groupId = null;
    }
    if (state.fileGroups.length === 0) delete state.fileGroups;
  } else {
    if (state.fileGroups !== undefined) delete state.fileGroups;
    for (const f of state.files) if (f.groupId != null) f.groupId = null;
  }
  if (!Array.isArray(state.recentFiles)) state.recentFiles = [];
  if (!Array.isArray(state.recentFilterFiles)) state.recentFilterFiles = [];
  if (!state.mapColorMode) state.mapColorMode = "bg";
  if (!state.mapWidth) state.mapWidth = 16;
  if (!state.fontSize) state.fontSize = FONT_DEFAULT;
  if (!state.fontWeight) state.fontWeight = 400;
  if (state.showLineNumbers === undefined) state.showLineNumbers = true;
  if (state.filterCollapsed === undefined) state.filterCollapsed = false;
  // The popped-out side dock. ANY panel can be popped out now; older states said so
  // with two booleans (Compare/Timeline only), so migrate those into the list. The
  // main dock must keep at least one tab, so the list can never hold every panel —
  // and both active-tab pointers must name a panel that's actually on their dock.
  {
    const legacy = state as Partial<
      Record<"comparePopped" | "timelinePopped", boolean>
    >;
    const raw: unknown[] = Array.isArray(state.poppedPanels)
      ? state.poppedPanels
      : [
          ...(legacy.comparePopped ? ["compare"] : []),
          ...(legacy.timelinePopped ? ["timeline"] : []),
        ];
    delete legacy.comparePopped;
    delete legacy.timelinePopped;
    // Canonical order (not the order they were popped), so the popped tab strip
    // reads the same as the main one.
    let popped = PANEL_TABS.filter((t) => raw.includes(t));
    if (popped.length >= PANEL_TABS.length) popped = popped.slice(0, -1);
    const main = PANEL_TABS.filter((t) => !popped.includes(t));

    if (popped.length) state.poppedPanels = popped;
    else delete state.poppedPanels;
    if (!main.includes(state.activePanelTab)) state.activePanelTab = main[0];
    if (!state.poppedActiveTab || !popped.includes(state.poppedActiveTab)) {
      if (popped.length) state.poppedActiveTab = popped[0];
      else delete state.poppedActiveTab;
    }
  }
  if (typeof state.poppedCollapsed !== "boolean") state.poppedCollapsed = false;
  // The popped dock sits opposite the main one (derived from `panelPos`); the old
  // standalone compare-dock position was never read.
  delete (state as Partial<Record<"comparePos", unknown>>).comparePos;
  // Migrate the pre-shared-dock collapse flag onto the shared popped dock.
  const legacyCmpCollapsed = (
    state as Partial<Record<"compareCollapsed", boolean>>
  ).compareCollapsed;
  if (legacyCmpCollapsed && !state.poppedCollapsed)
    state.poppedCollapsed = true;
  delete (state as Partial<Record<"compareCollapsed", unknown>>)
    .compareCollapsed;
  // panelSizes is bucketed (group → id → percent); drop any old flat/invalid shape.
  if (
    !state.panelSizes ||
    typeof state.panelSizes !== "object" ||
    Object.values(state.panelSizes).some(
      (v) => typeof v !== "object" || v === null,
    )
  ) {
    state.panelSizes = {};
  }
  // Drop the short-lived app-level parse-profile fields; parsing now lives on
  // individual regex filters (Filter.fields).
  delete (
    state as Partial<
      Record<"profiles" | "activeProfileId" | "structuredView", unknown>
    >
  ).profiles;
  delete (
    state as Partial<
      Record<"profiles" | "activeProfileId" | "structuredView", unknown>
    >
  ).activeProfileId;
  delete (
    state as Partial<
      Record<"profiles" | "activeProfileId" | "structuredView", unknown>
    >
  ).structuredView;
  // viewMode moved onto each LogFile; drop the stale app-level field.
  delete (state as Partial<Record<"viewMode", unknown>>).viewMode;
  // The split view stores real pane sizes now (`splitView.sizes`); the old
  // single-number ratio was never read.
  delete (state as Partial<Record<"splitRatio", unknown>>).splitRatio;
  // Global filter-pack library: keep only well-formed packs. Don't deep-rewrite
  // a pack's internals — its `order` references filter/group ids, so coercing
  // them through makeFilter (fresh ids) would break the layout. Packs are
  // produced well-formed internally; imported packs are sanitized on import.
  if (Array.isArray(state.filterPacks)) {
    state.filterPacks = state.filterPacks.filter(
      (p) =>
        p &&
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        Array.isArray(p.filters) &&
        Array.isArray(p.groups) &&
        Array.isArray(p.order),
    );
    if (state.filterPacks.length === 0) delete state.filterPacks;
    // Tags are loose user labels — keep only trimmed, non-empty strings; drop the
    // field entirely when nothing survives so packs without tags stay clean.
    for (const p of state.filterPacks ?? []) {
      if (Array.isArray(p.tags)) {
        const t = p.tags
          .filter((x): x is string => typeof x === "string" && x.trim() !== "")
          .map((x) => x.trim());
        if (t.length) p.tags = t;
        else delete p.tags;
      } else if (p.tags !== undefined) {
        delete p.tags;
      }
    }
  } else if (state.filterPacks !== undefined) {
    delete state.filterPacks;
  }
  // Packs side-panel width: clamp to the same range the resize drag enforces.
  if (typeof state.packsDrawerW === "number") {
    state.packsDrawerW = Math.max(
      280,
      Math.min(680, Math.round(state.packsDrawerW)),
    );
  } else if (state.packsDrawerW !== undefined) {
    delete state.packsDrawerW;
  }
  // Packs list sort: one of the known modes, else drop back to manual (default).
  if (
    state.packsSort !== undefined &&
    !["manual", "name", "created", "count"].includes(state.packsSort)
  ) {
    delete state.packsSort;
  }
  // Notebooks are NOT doc state anymore (they live beside it in the store, with
  // their own persistence key) — but old blobs from this branch still carry them,
  // and pre-app-level files carry a per-file `notebookDoc`. `extractNotebooks`
  // (called by the storage adapter at hydration) lifts both shapes out; here we
  // only guarantee a normalized doc never keeps them.
  return state;
}

/**
 * Lift notebooks out of a just-parsed persisted blob (and strip them from the
 * doc). Handles both legacy shapes: per-file `notebookDoc` (pre-app-level) and
 * doc-level `notebooks`/`activeNotebookId` (early feat/notebook builds). The
 * caller passes what it read from the dedicated notebooks key, which wins when
 * present — the blob-derived value is only the migration fallback.
 */
export function extractNotebooks(
  state: AppState,
  fromOwnKey?: { notebooks?: unknown; activeNotebookId?: unknown } | null,
): { notebooks: Notebook[]; activeNotebookId: string | null } {
  const migrated: Notebook[] = [];
  if (!Array.isArray(state.notebooks)) {
    // Pre-app-level: lift each file's written-in doc into its own notebook.
    for (const f of state.files) {
      if (docHasContent(f.notebookDoc)) {
        const now = Date.now();
        migrated.push({
          id: uid("nb"),
          name: f.name.replace(/\.[^.]+$/, "") || "Untitled",
          doc: f.notebookDoc ?? null,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  } else {
    migrated.push(...state.notebooks);
  }
  const fromBlobActive = state.activeNotebookId;
  // A live doc never carries notebook fields — strip all legacy shapes.
  for (const f of state.files)
    delete (f as Partial<Record<"notebookDoc", unknown>>).notebookDoc;
  delete state.notebooks;
  delete state.activeNotebookId;

  const own = fromOwnKey?.notebooks;
  const raw: unknown[] = Array.isArray(own) ? own : migrated;
  const notebooks = raw.filter(
    (n): n is Notebook =>
      !!n &&
      typeof (n as Notebook).id === "string" &&
      typeof (n as Notebook).name === "string",
  );
  const wanted = Array.isArray(own)
    ? fromOwnKey?.activeNotebookId
    : fromBlobActive;
  // Active notebook must point at one that exists (else fall back to the first,
  // or null when there are none — the panel then shows its empty state).
  const activeNotebookId = notebooks.some((n) => n.id === wanted)
    ? (wanted as string)
    : (notebooks[0]?.id ?? null);
  return { notebooks, activeNotebookId };
}
