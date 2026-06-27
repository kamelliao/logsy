import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import type { Filter, FilterSet, FilterLayout } from "@/types";
import { uid, makeFilter, normalizeState } from "@/lib/defaults";
import { tokenize, buildPattern } from "@/lib/generalize";
import {
  buildGroupFromImport,
  exportPayload,
  projectSelection,
  remapImportIds,
  appendImportToSet,
  parseTatFilters,
} from "@/lib/filterFile";
import { activeFile, activeSet } from "@/state/selectors";
import type { Store } from "@/store";

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

export interface FilterActions {
  switchSet: (gid: string) => void;
  addSet: () => void;
  renameSet: (gid: string, name: string) => void;
  deleteSet: (gid: string) => Promise<void>;
  reorderSets: (from: number, to: number) => void;
  duplicateSet: (gid: string) => void;
  /** Copy a select-mode subset into another set — an existing one (by id) or a
   *  brand-new one (`targetSetId === null`). Copy semantics: the source keeps its
   *  filters; switches to the destination and flashes the new rows. */
  copyFiltersToSet: (ids: string[], targetSetId: string | null) => void;
  addGroup: () => void;
  renameGroup: (gid: string, name: string) => void;
  toggleGroup: (gid: string) => void;
  deleteGroup: (gid: string) => void;
  applyLayout: (model: FilterLayout) => void;
  setGroupEnabled: (gid: string, enabled: boolean) => void;
  updateFilter: (fid: string, patch: Partial<Filter>) => void;
  deleteFilter: (fid: string) => void;
  deleteFilters: (ids: string[]) => Promise<boolean>;
  setFiltersEnabled: (ids: string[], enabled: boolean) => void;
  duplicateFilter: (fid: string) => void;
  openNewFilter: (groupId?: string | null) => void;
  openFilterFromPattern: (text: string, mode?: "exact" | "pattern") => void;
  openEditFilter: (fid: string) => void;
  saveFilter: (draft: Filter) => void;
  saveFiltersAs: () => Promise<void>;
  saveFilters: () => Promise<void>;
  loadFilterFromPath: (
    path: string,
    mode?: "replace" | "append",
  ) => Promise<void>;
  importFilters: () => Promise<void>;
  appendFilters: () => Promise<void>;
  bulk: (action: string) => void;
}

/**
 * All mutations of the filter workspace: filter sets, groups, individual filters,
 * the drag-and-drop layout, bulk actions, and reading/writing filter files (Logsy
 * JSON + TextAnalysisTool.NET import). Ported 1:1 from the old useFilterActions
 * hook; file/set are resolved from the live document instead of render-time props,
 * and the UI collaborators (confirm dialog, edit modal, solo filter) come from the
 * store (`confirm` is bound at runtime by App; `setEditing`/`soloFilterId`/
 * `setSoloFilterId` live in the ui slice).
 */
export function createFilterActions(
  _set: unknown,
  get: () => Store,
): FilterActions {
  const patch = (
    fn: Parameters<Store["patchState"]>[0],
    opts?: Parameters<Store["patchState"]>[1],
  ) => get().patchState(fn, opts);

  return {
    // ---------- sets ----------
    // The heavy re-render this triggers is deferred in render via the dock's
    // deferred set id (useDockLayout / App), not here — see that note.
    switchSet: (gid) =>
      patch(
        (s) => {
          const f = activeFile(s);
          if (f) f.activeSetId = gid;
        },
        { undoable: false },
      ),
    addSet: () =>
      patch((s) => {
        const f = activeFile(s);
        if (!f) return;
        const g: FilterSet = {
          id: uid("g"),
          name: "New set",
          filters: [],
          groups: [],
          order: [],
        };
        f.sets.push(g);
        f.activeSetId = g.id;
      }),
    renameSet: (gid, name) =>
      patch((s) => {
        const g = activeFile(s)?.sets.find((x) => x.id === gid);
        if (g) g.name = name;
      }),
    deleteSet: async (gid) => {
      const f = activeFile(get().doc);
      if (!f) return;
      const g = f.sets.find((x) => x.id === gid);
      // Confirm only when the set actually holds filters (empty sets delete freely).
      if (g && g.filters.length > 0) {
        const ok = await get().confirm({
          title: "Delete filter set?",
          message: `Delete the "${g.name}" filter set and its ${g.filters.length} filter${g.filters.length > 1 ? "s" : ""}?`,
          okLabel: "Delete",
          cancelLabel: "Cancel",
          danger: true,
        });
        if (!ok) return;
      }
      patch((s) => {
        const ff = activeFile(s);
        if (!ff) return;
        ff.sets = ff.sets.filter((x) => x.id !== gid);
        if (ff.activeSetId === gid) ff.activeSetId = ff.sets[0]?.id ?? null;
      });
    },
    reorderSets: (from, to) =>
      patch((s) => {
        const f = activeFile(s);
        if (!f) return;
        const [m] = f.sets.splice(from, 1);
        f.sets.splice(to, 0, m);
      }),
    // Duplicate a whole filter set: deep-copy its groups/filters with fresh ids,
    // remap groupId references and the top-level order, drop the save link, and
    // insert the copy right after the original (then activate it).
    duplicateSet: (gid) =>
      patch((s) => {
        const f = activeFile(s);
        if (!f) return;
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
      }),
    // Copy the selected filters into another set, reusing the same projection →
    // remap → append plumbing packs use (so the destination gets independent
    // copies with fresh ids; the source is untouched). A new set is created when
    // targetSetId is null. Activates the destination and flashes the new rows so
    // the copy is visible; the panel's set-switch effect drops select mode.
    copyFiltersToSet: (ids, targetSetId) => {
      const src = activeSet(get().doc);
      if (!src) return;
      const proj = projectSelection(src, ids);
      if (proj.filters.length === 0) return;
      const add = remapImportIds({
        filters: proj.filters,
        groups: proj.groups,
        order: proj.order,
        sources: [],
      });
      let destName = "";
      patch((s) => {
        const f = activeFile(s);
        if (!f) return;
        let dest: FilterSet | undefined;
        if (targetSetId === null) {
          dest = {
            id: uid("g"),
            name: "New set",
            filters: [],
            groups: [],
            order: [],
          };
          f.sets.push(dest);
        } else {
          dest = f.sets.find((x) => x.id === targetSetId);
        }
        if (!dest) return;
        appendImportToSet(dest, add);
        f.activeSetId = dest.id;
        destName = dest.name;
        normalizeState(s);
      });
      get().flashFilters(add.filters.map((x) => x.id));
      const n = add.filters.length;
      toast.success(`Copied ${n} filter${n === 1 ? "" : "s"} to "${destName}"`);
    },

    // ---------- groups ----------
    addGroup: () =>
      patch((s) => {
        const g = activeSet(s);
        if (!g) return;
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
      }),
    renameGroup: (gid, name) =>
      patch((s) => {
        const grp = activeSet(s)?.groups.find((x) => x.id === gid);
        if (grp) grp.name = name;
      }),
    toggleGroup: (gid) =>
      patch(
        (s) => {
          const grp = activeSet(s)?.groups.find((x) => x.id === gid);
          if (grp) grp.collapsed = !grp.collapsed;
        },
        { undoable: false },
      ),
    deleteGroup: (gid) =>
      patch((s) => {
        const g = activeSet(s);
        if (!g) return;
        g.groups = g.groups.filter((x) => x.id !== gid);
        // Keep the filters — move them back to the ungrouped bucket, taking the
        // group's old top-level slot (so they don't jump elsewhere).
        const freed = g.filters
          .filter((f) => f.groupId === gid)
          .map((f) => f.id);
        g.filters.forEach((f) => {
          if (f.groupId === gid) f.groupId = null;
        });
        const at = g.order.indexOf(gid);
        if (at >= 0) g.order.splice(at, 1, ...freed);
        else g.order.push(...freed);
      }),
    // Commit a whole-set drag-and-drop arrangement (built live in FilterPanel) in
    // one undoable step. Rebuild `filters` in visual order — loose rows and each
    // group's rows interleaved per `model.top` — and set every filter's groupId;
    // `order` becomes the new interleaved top-level order.
    applyLayout: (model) =>
      patch((s) => {
        const g = activeSet(s);
        if (!g) return;
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
      }),
    setGroupEnabled: (gid, enabled) =>
      patch((s) => {
        activeSet(s)?.filters.forEach((f) => {
          if (f.groupId === gid) f.enabled = enabled;
        });
      }),

    // ---------- filters ----------
    updateFilter: (fid, patchObj) =>
      patch((s) => {
        const g = activeSet(s);
        if (!g) return;
        Object.assign(g.filters.find((x) => x.id === fid)!, patchObj);
      }),
    deleteFilter: (fid) => {
      patch((s) => {
        const g = activeSet(s);
        if (!g) return;
        g.filters = g.filters.filter((x) => x.id !== fid);
        const oi = g.order.indexOf(fid);
        if (oi >= 0) g.order.splice(oi, 1);
      });
      if (get().soloFilterId === fid) get().setSoloFilterId(null);
      get().setEditing(null);
    },
    // Batch delete from the filter panel's selection mode. One undoable step (a
    // single Ctrl+Z brings them all back), and unlike single-row delete it also
    // drops timeline tracks bound to the removed filters so none are left orphaned.
    // Always confirms; returns whether it went through so the panel only clears
    // its selection on success.
    deleteFilters: async (ids) => {
      const g = activeSet(get().doc);
      if (!g || ids.length === 0) return false;
      const ok = await get().confirm({
        title: "Delete filters?",
        message: `Delete ${ids.length} selected filter${ids.length > 1 ? "s" : ""}? This can be undone with Ctrl+Z.`,
        okLabel: "Delete",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (!ok) return false;
      const del = new Set(ids);
      patch((s) => {
        const gg = activeSet(s);
        if (!gg) return;
        gg.filters = gg.filters.filter((x) => !del.has(x.id));
        gg.order = gg.order.filter((id) => !del.has(id));
        gg.sources = (gg.sources ?? []).filter((x) => !del.has(x.filterId));
      });
      const solo = get().soloFilterId;
      if (solo && del.has(solo)) get().setSoloFilterId(null);
      get().setEditing(null);
      return true;
    },
    setFiltersEnabled: (ids, enabled) => {
      if (ids.length === 0) return;
      const sel = new Set(ids);
      patch((s) => {
        activeSet(s)?.filters.forEach((f) => {
          if (sel.has(f.id)) f.enabled = enabled;
        });
      });
    },
    duplicateFilter: (fid) =>
      patch((s) => {
        const g = activeSet(s);
        if (!g) return;
        const idx = g.filters.findIndex((x) => x.id === fid);
        if (idx < 0) return;
        const copy = { ...g.filters[idx], id: uid("f") };
        g.filters.splice(idx + 1, 0, copy);
        if (copy.groupId === null) {
          const oi = g.order.indexOf(fid);
          if (oi >= 0) g.order.splice(oi + 1, 0, copy.id);
          else g.order.push(copy.id);
        }
      }),
    // New filters default to the neutral white-bg / black-text style; the user
    // picks a highlight colour in the editor when they want one.
    openNewFilter: (groupId = null) => {
      if (!activeSet(get().doc)) return;
      get().setEditing({ isNew: true, filter: makeFilter("", { groupId }) });
    },
    openFilterFromPattern: (text, mode = "exact") => {
      if (!activeSet(get().doc)) return;
      if (mode === "pattern") {
        // Filters match single lines; a multi-line selection seeds from its
        // first non-empty line. genSeed drives the chips UI in EditModal.
        const seed =
          text
            .split(/\r?\n/)
            .find((l) => l.trim())
            ?.trim() ?? text;
        get().setEditing({
          isNew: true,
          filter: makeFilter(buildPattern(tokenize(seed)), { regex: true }),
          genSeed: seed,
        });
      } else {
        get().setEditing({ isNew: true, filter: makeFilter(text) });
      }
    },
    openEditFilter: (fid) => {
      const g = activeSet(get().doc);
      if (!g) return;
      const fl = g.filters.find((x) => x.id === fid)!;
      get().setEditing({ isNew: false, filter: { ...fl } });
    },
    saveFilter: (draft) => {
      patch((s) => {
        const g = activeSet(s);
        if (!g) return;
        const idx = g.filters.findIndex((x) => x.id === draft.id);
        if (idx >= 0) g.filters[idx] = draft;
        else g.filters.push(draft);
        // Reconcile top-level order with the (possibly changed) set.
        const oi = g.order.indexOf(draft.id);
        if (draft.groupId === null && oi < 0) g.order.push(draft.id);
        else if (draft.groupId !== null && oi >= 0) g.order.splice(oi, 1);
      });
      get().setEditing(null);
    },

    // ---------- save / import ----------
    saveFiltersAs: async () => {
      const set = activeSet(get().doc);
      if (!set) return;
      const path = await save({
        defaultPath: set.name.replace(/\s+/g, "_") + "_filters.json",
        filters: SAVE_DIALOG_FILTERS,
      });
      if (typeof path === "string") await writeFiltersTo(get, path);
    },
    // "Save filters": update the file it was last saved to; if never saved, behave as Save As.
    saveFilters: async () => {
      const set = activeSet(get().doc);
      if (!set) return;
      if (set.filePath) await writeFiltersTo(get, set.filePath);
      else await get().saveFiltersAs();
    },
    // Load a filter file from a known path into the current set. `mode` is either
    // "replace" (swap the whole set, the default) or "append" (merge the import in
    // as additional filters/groups beside the existing ones). Replace confirms
    // first when the set isn't empty; append is additive and undoable, so it
    // doesn't. Used by the "Load Filters"/"Append Filters" dialogs and the Recent
    // Filter Files menu.
    loadFilterFromPath: async (path, mode = "replace") => {
      const set = activeSet(get().doc);
      if (!set) return;
      if (mode === "replace" && set.filters.length > 0) {
        const ok = await get().confirm({
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
        patch((s) => {
          const g = activeSet(s);
          if (!g) return;
          appendImportToSet(g, add);
          normalizeState(s);
        });
        if (!foreign) get().pushRecent("recentFilterFiles", path);
        toast.success("Filters appended");
        return;
      }

      patch((s) => {
        const g = activeSet(s);
        if (!g || !built) return;
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
      if (!foreign) get().pushRecent("recentFilterFiles", path);
      toast.success(foreign ? "Filters imported" : "Filters loaded");
    },
    // "Load filters": pick a file, then load it into the current set.
    importFilters: async () => {
      if (!activeSet(get().doc)) return;
      const path = await open({
        multiple: false,
        filters: OPEN_DIALOG_FILTERS,
      });
      if (typeof path !== "string") return;
      await get().loadFilterFromPath(path);
    },
    // "Append filters": pick a file, then merge it into the current set without
    // replacing what's already there.
    appendFilters: async () => {
      if (!activeSet(get().doc)) return;
      const path = await open({
        multiple: false,
        filters: OPEN_DIALOG_FILTERS,
      });
      if (typeof path !== "string") return;
      await get().loadFilterFromPath(path, "append");
    },

    // ---------- bulk ----------
    bulk: (action) => {
      if (action === "enableAll")
        patch((s) => {
          activeSet(s)?.filters.forEach((f) => (f.enabled = true));
        });
      else if (action === "disableAll")
        patch((s) => {
          activeSet(s)?.filters.forEach((f) => (f.enabled = false));
        });
      else if (action === "clear")
        patch((s) => {
          const g = activeSet(s);
          if (!g) return;
          g.filters = [];
          g.order = g.order.filter((id) =>
            g.groups.some((grp) => grp.id === id),
          );
        });
      else if (action === "save") void get().saveFilters();
      else if (action === "saveAs") void get().saveFiltersAs();
      else if (action === "import") void get().importFilters();
      else if (action === "append") void get().appendFilters();
    },
  };
}

// Write the active set's filters to `path` and mark it the clean save baseline.
async function writeFiltersTo(get: () => Store, path: string) {
  const set = activeSet(get().doc);
  if (!set) return;
  try {
    await invoke("write_text_file", { path, contents: exportPayload(set) });
    get().patchState(
      (s) => {
        const g = activeSet(s);
        if (!g) return;
        g.filePath = path;
        // Mark this as the clean baseline so "Save Filter" disables until the
        // next edit.
        g.savedSnapshot = exportPayload(g);
      },
      { undoable: false },
    );
    get().pushRecent("recentFilterFiles", path);
    toast.success("Filters saved");
  } catch (e) {
    toast.error("Could not save filters: " + String(e));
  }
}
