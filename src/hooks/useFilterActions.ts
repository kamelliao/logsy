import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import type {
  AppState,
  Filter,
  FilterSet,
  FilterLayout,
  LogFile,
} from "@/types";
import { uid, makeFilter, normalizeState } from "@/lib/defaults";
import { tokenize, buildPattern } from "@/lib/generalize";
import {
  buildGroupFromImport,
  exportPayload,
  remapImportIds,
  parseTatFilters,
} from "@/lib/filterFile";
import { withFile, withSet } from "@/state/selectors";
import type { ConfirmOptions } from "@/components/ConfirmDialog";

// Open accepts native Logsy JSON plus TextAnalysisTool.NET (.tat/.xml) for import;
// Save always writes Logsy JSON, so it only offers .json.
const OPEN_DIALOG_FILTERS = [
  { name: "Filter files", extensions: ["json", "tat", "xml"] },
  { name: "Logsy filters", extensions: ["json"] },
  { name: "TextAnalysisTool.NET", extensions: ["tat", "xml"] },
];
const SAVE_DIALOG_FILTERS = [{ name: "Logsy filters", extensions: ["json"] }];

/** The draft being edited in the filter editor modal (null when closed). */
export interface EditingState {
  isNew: boolean;
  filter: Filter;
  genSeed?: string;
}

interface Deps {
  file: LogFile | null;
  set: FilterSet | null;
  patchState: (
    fn: (s: AppState) => void,
    opts?: { undoable?: boolean; coalesce?: string },
  ) => void;
  pushRecent: (key: "recentFiles" | "recentFilterFiles", path: string) => void;
  appConfirm: (opts: ConfirmOptions) => Promise<boolean>;
  startPanelTransition: React.TransitionStartFunction;
  setEditing: React.Dispatch<React.SetStateAction<EditingState | null>>;
  soloFilterId: string | null;
  setSoloFilterId: React.Dispatch<React.SetStateAction<string | null>>;
}

/**
 * All mutations of the filter workspace: filter sets, groups, individual
 * filters, the drag-and-drop layout, bulk actions, and reading/writing filter
 * files (Logsy JSON + TextAnalysisTool.NET import). Every edit funnels through
 * the passed `patchState`, so it sits on the shared undo model.
 */
export function useFilterActions({
  file,
  set,
  patchState,
  pushRecent,
  appConfirm,
  startPanelTransition,
  setEditing,
  soloFilterId,
  setSoloFilterId,
}: Deps) {
  // ---------- sets ----------
  const switchSet = (gid: string) =>
    startPanelTransition(() =>
      patchState(
        (s) => {
          if (!file) return;
          withFile(s, file.id).activeSetId = gid;
        },
        { undoable: false },
      ),
    );
  const addSet = () =>
    patchState((s) => {
      if (!file) return;
      const f = withFile(s, file.id);
      const g: FilterSet = {
        id: uid("g"),
        name: "New set",
        filters: [],
        groups: [],
        order: [],
      };
      f.sets.push(g);
      f.activeSetId = g.id;
    });
  const renameSet = (gid: string, name: string) =>
    patchState((s) => {
      if (!file) return;
      withSet(s, file.id, gid).name = name;
    });
  const deleteSet = async (gid: string) => {
    if (!file) return;
    const g = file.sets.find((x) => x.id === gid);
    // Confirm only when the set actually holds filters (empty sets delete freely).
    if (g && g.filters.length > 0) {
      const ok = await appConfirm({
        title: "Delete filter set?",
        message: `Delete the "${g.name}" filter set and its ${g.filters.length} filter${g.filters.length > 1 ? "s" : ""}?`,
        okLabel: "Delete",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (!ok) return;
    }
    patchState((s) => {
      const f = withFile(s, file.id);
      f.sets = f.sets.filter((x) => x.id !== gid);
      if (f.activeSetId === gid) f.activeSetId = f.sets[0]?.id ?? null;
    });
  };
  const reorderSets = (from: number, to: number) =>
    patchState((s) => {
      if (!file) return;
      const f = withFile(s, file.id);
      const [m] = f.sets.splice(from, 1);
      f.sets.splice(to, 0, m);
    });
  // Duplicate a whole filter set: deep-copy its groups/filters with fresh ids,
  // remap groupId references and the top-level order, drop the save link, and
  // insert the copy right after the original (then activate it).
  const duplicateSet = (gid: string) =>
    patchState((s) => {
      if (!file) return;
      const f = withFile(s, file.id);
      const idx = f.sets.findIndex((x) => x.id === gid);
      if (idx < 0) return;
      const src = f.sets[idx];
      const groupMap = new Map(
        src.groups.map((grp) => [grp.id, uid("grp")] as const),
      );
      const filMap = new Map(
        src.filters.map((fl) => [fl.id, uid("f")] as const),
      );
      const copy: FilterSet = {
        id: uid("g"),
        name: src.name + " copy",
        groups: src.groups.map((grp) => ({
          ...grp,
          id: groupMap.get(grp.id)!,
        })),
        filters: src.filters.map((fl) => ({
          ...fl,
          id: filMap.get(fl.id)!,
          groupId: fl.groupId ? (groupMap.get(fl.groupId) ?? null) : null,
          fields: fl.fields ? fl.fields.map((x) => ({ ...x })) : undefined,
        })),
        order: src.order
          .map((id) => groupMap.get(id) ?? filMap.get(id))
          .filter((x): x is string => !!x),
      };
      f.sets.splice(idx + 1, 0, copy);
      f.activeSetId = copy.id;
    });

  // ---------- groups ----------
  const addGroup = () =>
    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      const names = new Set(g.groups.map((x) => x.name));
      let name = "New group";
      if (names.has(name)) {
        let n = 1;
        while (names.has(`New group ${n}`)) n++;
        name = `New group ${n}`;
      }
      const grp = { id: uid("grp"), name, collapsed: false };
      g.groups.push(grp);
      g.order.push(grp.id);
    });
  const renameGroup = (gid: string, name: string) =>
    patchState((s) => {
      if (!file || !set) return;
      const grp = withSet(s, file.id, set.id).groups.find((x) => x.id === gid);
      if (grp) grp.name = name;
    });
  const toggleGroup = (gid: string) =>
    patchState(
      (s) => {
        if (!file || !set) return;
        const grp = withSet(s, file.id, set.id).groups.find(
          (x) => x.id === gid,
        );
        if (grp) grp.collapsed = !grp.collapsed;
      },
      { undoable: false },
    );
  const deleteGroup = (gid: string) =>
    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      g.groups = g.groups.filter((x) => x.id !== gid);
      // Keep the filters — move them back to the ungrouped bucket, taking the
      // group's old top-level slot (so they don't jump elsewhere).
      const freed = g.filters.filter((f) => f.groupId === gid).map((f) => f.id);
      g.filters.forEach((f) => {
        if (f.groupId === gid) f.groupId = null;
      });
      const at = g.order.indexOf(gid);
      if (at >= 0) g.order.splice(at, 1, ...freed);
      else g.order.push(...freed);
    });
  // Commit a whole-set drag-and-drop arrangement (built live in FilterPanel) in
  // one undoable step. Rebuild `filters` in visual order — loose rows and each
  // group's rows interleaved per `model.top` — and set every filter's groupId;
  // `order` becomes the new interleaved top-level order.
  const applyLayout = (model: FilterLayout) =>
    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      const byId = new Map(g.filters.map((f) => [f.id, f] as const));
      const next: Filter[] = [];
      for (const entry of model.top) {
        if (entry.kind === "filter") {
          const f = byId.get(entry.id);
          if (f) {
            f.groupId = null;
            next.push(f);
            byId.delete(entry.id);
          }
        } else {
          for (const fid of model.inGroup[entry.id] ?? []) {
            const f = byId.get(fid);
            if (f) {
              f.groupId = entry.id;
              next.push(f);
              byId.delete(fid);
            }
          }
        }
      }
      for (const f of byId.values()) next.push(f); // safety: never drop a filter
      g.filters = next;
      g.order = model.top.map((e) => e.id);
    });
  const setGroupEnabled = (gid: string, enabled: boolean) =>
    patchState((s) => {
      if (!file || !set) return;
      withSet(s, file.id, set.id).filters.forEach((f) => {
        if (f.groupId === gid) f.enabled = enabled;
      });
    });

  // ---------- filters ----------
  const updateFilter = (fid: string, patch: Partial<Filter>) =>
    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      Object.assign(g.filters.find((x) => x.id === fid)!, patch);
    });
  const deleteFilter = (fid: string) => {
    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      g.filters = g.filters.filter((x) => x.id !== fid);
      const oi = g.order.indexOf(fid);
      if (oi >= 0) g.order.splice(oi, 1);
    });
    if (soloFilterId === fid) setSoloFilterId(null);
    setEditing(null);
  };
  // Batch delete from the filter panel's selection mode. One undoable step (a
  // single Ctrl+Z brings them all back), and unlike single-row delete it also
  // drops timeline tracks bound to the removed filters so none are left orphaned.
  // Always confirms; returns whether it went through so the panel only clears
  // its selection on success.
  const deleteFilters = async (ids: string[]): Promise<boolean> => {
    if (!file || !set || ids.length === 0) return false;
    const ok = await appConfirm({
      title: "Delete filters?",
      message: `Delete ${ids.length} selected filter${ids.length > 1 ? "s" : ""}? This can be undone with Ctrl+Z.`,
      okLabel: "Delete",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return false;
    const del = new Set(ids);
    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      g.filters = g.filters.filter((x) => !del.has(x.id));
      g.order = g.order.filter((id) => !del.has(id));
      g.sources = (g.sources ?? []).filter((x) => !del.has(x.filterId));
    });
    if (soloFilterId && del.has(soloFilterId)) setSoloFilterId(null);
    setEditing(null);
    return true;
  };
  const setFiltersEnabled = (ids: string[], enabled: boolean) => {
    if (!file || !set || ids.length === 0) return;
    const sel = new Set(ids);
    patchState((s) => {
      if (!file || !set) return;
      withSet(s, file.id, set.id).filters.forEach((f) => {
        if (sel.has(f.id)) f.enabled = enabled;
      });
    });
  };
  const duplicateFilter = (fid: string) =>
    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      const idx = g.filters.findIndex((x) => x.id === fid);
      if (idx < 0) return;
      const copy = { ...g.filters[idx], id: uid("f") };
      g.filters.splice(idx + 1, 0, copy);
      if (copy.groupId === null) {
        const oi = g.order.indexOf(fid);
        if (oi >= 0) g.order.splice(oi + 1, 0, copy.id);
        else g.order.push(copy.id);
      }
    });
  // New filters default to the neutral white-bg / black-text style; the user
  // picks a highlight colour in the editor when they want one.
  const openNewFilter = (groupId: string | null = null) => {
    if (!set) return;
    setEditing({ isNew: true, filter: makeFilter("", { groupId }) });
  };
  const openFilterFromPattern = (
    text: string,
    mode: "exact" | "pattern" = "exact",
  ) => {
    if (!set) return;
    if (mode === "pattern") {
      // Filters match single lines; a multi-line selection seeds from its
      // first non-empty line. genSeed drives the chips UI in EditModal.
      const seed =
        text
          .split(/\r?\n/)
          .find((l) => l.trim())
          ?.trim() ?? text;
      setEditing({
        isNew: true,
        filter: makeFilter(buildPattern(tokenize(seed)), { regex: true }),
        genSeed: seed,
      });
    } else {
      setEditing({ isNew: true, filter: makeFilter(text) });
    }
  };
  const openEditFilter = (fid: string) => {
    if (!set) return;
    const fl = set.filters.find((x) => x.id === fid)!;
    setEditing({ isNew: false, filter: { ...fl } });
  };
  const saveFilter = (draft: Filter) => {
    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      const idx = g.filters.findIndex((x) => x.id === draft.id);
      if (idx >= 0) g.filters[idx] = draft;
      else g.filters.push(draft);
      // Reconcile top-level order with the (possibly changed) set.
      const oi = g.order.indexOf(draft.id);
      if (draft.groupId === null && oi < 0) g.order.push(draft.id);
      else if (draft.groupId !== null && oi >= 0) g.order.splice(oi, 1);
    });
    setEditing(null);
  };

  // ---------- save / import ----------
  const writeFiltersTo = async (path: string) => {
    if (!file || !set) return;
    try {
      await invoke("write_text_file", { path, contents: exportPayload(set) });
      patchState(
        (s) => {
          if (!file || !set) return;
          const g = withSet(s, file.id, set.id);
          g.filePath = path;
          // Mark this as the clean baseline so "Save Filter" disables until the
          // next edit.
          g.savedSnapshot = exportPayload(g);
        },
        { undoable: false },
      );
      pushRecent("recentFilterFiles", path);
      toast.success("Filters saved");
    } catch (e) {
      toast.error("Could not save filters: " + String(e));
    }
  };

  const saveFiltersAs = async () => {
    if (!set) return;
    const path = await save({
      defaultPath: set.name.replace(/\s+/g, "_") + "_filters.json",
      filters: SAVE_DIALOG_FILTERS,
    });
    if (typeof path === "string") await writeFiltersTo(path);
  };

  // "Save filters": update the file it was last saved to; if never saved, behave as Save As.
  const saveFilters = async () => {
    if (!set) return;
    if (set.filePath) await writeFiltersTo(set.filePath);
    else await saveFiltersAs();
  };

  // Load a filter file from a known path into the current set. `mode` is either
  // "replace" (swap the whole set, the default) or "append" (merge the import in
  // as additional filters/groups beside the existing ones). Replace confirms
  // first when the set isn't empty; append is additive and undoable, so it
  // doesn't. Used by the "Load Filters"/"Append Filters" dialogs and the Recent
  // Filter Files menu.
  const loadFilterFromPath = async (
    path: string,
    mode: "replace" | "append" = "replace",
  ) => {
    if (!file || !set) return;
    if (mode === "replace" && set.filters.length > 0) {
      const ok = await appConfirm({
        title: "Replace current filters?",
        message:
          "Loading will replace every filter and group in the current set. This can't be undone.",
        okLabel: "Replace",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (!ok) return;
    }
    let text: string;
    // read_text_file returns { text, encoding } — pull the text out (passing the
    // whole object to JSON.parse below would silently fail the load).
    try {
      text = (
        await invoke<{ text: string; encoding: string }>("read_text_file", {
          path,
        })
      ).text;
    } catch (e) {
      toast.error("Could not read file: " + String(e));
      return;
    }
    let built: ReturnType<typeof buildGroupFromImport> = null;
    let foreign = false; // a TAT import isn't a Logsy file, so don't make it the save target
    try {
      built = buildGroupFromImport(JSON.parse(text));
    } catch {
      /* not JSON — try TAT below */
    }
    if (!built) {
      built = parseTatFilters(text);
      foreign = !!built;
    } // TextAnalysisTool.NET (.tat)
    if (!built) {
      toast.error("That file isn't Logsy or TextAnalysisTool.NET filters.");
      return;
    }

    if (mode === "append") {
      // Fresh ids so the merged-in filters/groups/tracks never collide with what
      // the set already holds. Leave filePath/savedSnapshot untouched: appending
      // dirties the set (Save Filter re-enables) without retargeting the save.
      const add = remapImportIds(built);
      patchState((s) => {
        if (!file || !set) return;
        const g = withSet(s, file.id, set.id);
        g.filters.push(...add.filters);
        g.groups.push(...add.groups);
        g.order.push(...add.order);
        g.sources = [...(g.sources ?? []), ...add.sources];
        normalizeState(s);
      });
      if (!foreign) pushRecent("recentFilterFiles", path);
      toast.success("Filters appended");
      return;
    }

    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      g.filters = built.filters;
      g.groups = built.groups;
      g.order = built.order;
      g.sources = built.sources;
      if (foreign) {
        // Imported from a foreign format: the filters now live as Logsy filters,
        // not tied to the source file. "Save Filter" stays enabled and opens
        // Save As rather than writing back to the .tat.
        g.filePath = undefined;
        g.savedSnapshot = undefined;
        normalizeState(s);
      } else {
        // A native Logsy file becomes the save target and the clean baseline.
        g.filePath = path;
        normalizeState(s);
        g.savedSnapshot = exportPayload(g);
      }
    });
    if (!foreign) pushRecent("recentFilterFiles", path);
    toast.success(foreign ? "Filters imported" : "Filters loaded");
  };

  // "Load filters": pick a file, then load it into the current set.
  const importFilters = async () => {
    if (!file || !set) return;
    const path = await open({ multiple: false, filters: OPEN_DIALOG_FILTERS });
    if (typeof path !== "string") return;
    await loadFilterFromPath(path);
  };

  // "Append filters": pick a file, then merge it into the current set without
  // replacing what's already there.
  const appendFilters = async () => {
    if (!file || !set) return;
    const path = await open({ multiple: false, filters: OPEN_DIALOG_FILTERS });
    if (typeof path !== "string") return;
    await loadFilterFromPath(path, "append");
  };

  // ---------- bulk ----------
  const bulk = (action: string) => {
    if (action === "enableAll")
      patchState((s) => {
        if (file && set)
          withSet(s, file.id, set.id).filters.forEach(
            (f) => (f.enabled = true),
          );
      });
    else if (action === "disableAll")
      patchState((s) => {
        if (file && set)
          withSet(s, file.id, set.id).filters.forEach(
            (f) => (f.enabled = false),
          );
      });
    else if (action === "clear")
      patchState((s) => {
        if (!file || !set) return;
        const g = withSet(s, file.id, set.id);
        g.filters = [];
        g.order = g.order.filter((id) => g.groups.some((grp) => grp.id === id));
      });
    else if (action === "save") void saveFilters();
    else if (action === "saveAs") void saveFiltersAs();
    else if (action === "import") void importFilters();
    else if (action === "append") void appendFilters();
  };

  return {
    switchSet,
    addSet,
    renameSet,
    deleteSet,
    reorderSets,
    duplicateSet,
    addGroup,
    renameGroup,
    toggleGroup,
    deleteGroup,
    applyLayout,
    setGroupEnabled,
    updateFilter,
    deleteFilter,
    deleteFilters,
    setFiltersEnabled,
    duplicateFilter,
    openNewFilter,
    openFilterFromPattern,
    openEditFilter,
    saveFilter,
    saveFiltersAs,
    saveFilters,
    loadFilterFromPath,
    importFilters,
    appendFilters,
    bulk,
  };
}
