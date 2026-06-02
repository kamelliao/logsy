import { useState, useMemo, useEffect, useCallback, useRef, Fragment, CSSProperties, ReactNode } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FolderOpen, Minus, PanelBottom, PanelRight, Square, Upload, X } from "lucide-react";
import { tinykeys } from "tinykeys";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { save, open, confirm } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import type { AppState, LogFile, FilterGroup, FilterSection, Filter } from "./types";
import {
  uid, makeFilter, initialState, normalizeState, PALETTE,
} from "./data";

const FILE_DIALOG_FILTERS = [{ name: "Logsy filters", extensions: ["json"] }];

/** Parse an imported filters file into a group's filters/sections/order. */
function buildGroupFromImport(
  data: unknown
): { filters: Filter[]; sections: FilterSection[]; order: string[] } | null {
  // Full structure: { filters, sections?, order? }
  if (data && typeof data === "object" && !Array.isArray(data) && Array.isArray((data as any).filters)) {
    const d = data as any;
    const sections: FilterSection[] = Array.isArray(d.sections)
      ? d.sections
          .filter((s: any) => s && typeof s.id === "string")
          .map((s: any) => ({ id: s.id, name: typeof s.name === "string" ? s.name : "Group", collapsed: !!s.collapsed }))
      : [];
    const validSec = new Set(sections.map((s) => s.id));
    const filters: Filter[] = d.filters.map((x: any) => {
      const f = makeFilter(typeof x?.pattern === "string" ? x.pattern : "", x ?? {});
      if (typeof x?.id === "string") f.id = x.id;
      f.sectionId = typeof x?.sectionId === "string" && validSec.has(x.sectionId) ? x.sectionId : null;
      return f;
    });
    const order: string[] = Array.isArray(d.order) ? d.order.filter((id: any) => typeof id === "string") : [];
    return { filters, sections, order };
  }
  // Legacy: a flat array of filters.
  if (Array.isArray(data)) {
    const filters = data.map((x: any) => {
      const f = makeFilter(typeof x?.pattern === "string" ? x.pattern : "", x ?? {});
      if (typeof x?.id === "string") f.id = x.id;
      return f;
    });
    return { filters, sections: [], order: filters.map((f) => f.id) };
  }
  return null;
}
import { compileAll, computeView } from "./logic";
import { Sidebar } from "./components/Sidebar";
import { LogView } from "./components/LogView";
import { FilterPanel } from "./components/FilterPanel";
import { EditModal } from "./components/EditModal";
import { CompareTable } from "./components/CompareTable";
import { Button } from "./components/ui/button";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./components/ui/resizable";

const STATE_KEY = "logsy.state.v6";
const FONT_DEFAULT = 12.5;
const FONT_STEP = 1;
const FONT_MIN = 8;
const FONT_MAX = 24;

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) return normalizeState(JSON.parse(raw) as AppState);
  } catch { /* ignore */ }
  return normalizeState(initialState());
}

// In-memory log contents, keyed by file id. Log bodies are *not* persisted to
// localStorage (they can be huge) — on restart we reload them from `file.path`.
const linesStore: Record<string, string[]> = {};
const EMPTY_LINES: string[] = [];

function splitLines(text: string): string[] {
  const arr = text.split(/\r\n|\n|\r/);
  if (arr.length > 0 && arr[arr.length - 1] === "") arr.pop();
  return arr;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function App() {
  const [state, setState] = useState<AppState>(loadState);
  const [editing, setEditing] = useState<{ isNew: boolean; filter: Filter } | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  // Lines explicitly added to the comparison panel (kept separate from selection).
  const [compareLines, setCompareLines] = useState<Set<number>>(() => new Set());
  const fpRef = useRef<PanelImperativeHandle | null>(null);
  const cmpRef = useRef<PanelImperativeHandle | null>(null);
  const [openMenu, setOpenMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  // Bumped whenever a file's lines land in `linesStore`, to re-derive `lines`.
  const [linesVersion, setLinesVersion] = useState(0);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  }, [state]);

  const file = state.files.find((f) => f.id === state.activeFileId) ?? state.files[0] ?? null;
  const group = file ? (file.groups.find((g) => g.id === file.activeGroupId) ?? file.groups[0]) : null;

  const lines = useMemo(
    () => (file ? linesStore[file.id] ?? EMPTY_LINES : EMPTY_LINES),
    [file?.id, linesVersion]
  );
  const compiled = useMemo(() => compileAll(group?.filters ?? []), [group?.filters]);
  const view = useMemo(() => computeView(lines, compiled), [lines, compiled]);
  // Rows shown in the comparison panel: explicitly-added, still-visible, parsed lines.
  const compareRows = useMemo(
    () => view.rows.filter((r) => !r.excluded && compareLines.has(r.n) && r.fields),
    [view, compareLines],
  );

  // ---------- helpers ----------
  const patchState = useCallback((fn: (s: AppState) => void) => {
    setState((s) => {
      const n = JSON.parse(JSON.stringify(s)) as AppState;
      fn(n);
      return n;
    });
  }, []);

  // Latest state, readable from async callbacks (file loading) without stale closures.
  const stateRef = useRef(state);
  stateRef.current = state;

  function withFile(s: AppState, fid: string): LogFile {
    return s.files.find((f) => f.id === fid)!;
  }
  function withGroup(s: AppState, fid: string, gid: string): FilterGroup {
    return withFile(s, fid).groups.find((g) => g.id === gid)!;
  }

  // ---------- files ----------
  const selectFile = (fid: string) => setState((s) => ({ ...s, activeFileId: fid }));

  const deleteFile = (fid: string) => patchState((s) => {
    s.files = s.files.filter((f) => f.id !== fid);
    if (s.activeFileId === fid) s.activeFileId = s.files[0]?.id ?? null;
    delete linesStore[fid];
  });

  // Read each path from disk and add it as a log file. An already-open path is
  // re-activated rather than opened twice.
  const loadPaths = useCallback(async (paths: string[]) => {
    const seen = new Set<string>();
    let lastErr = "";
    for (const path of paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      const existing = stateRef.current.files.find((f) => f.path === path);
      if (existing) { setState((s) => ({ ...s, activeFileId: existing.id })); continue; }
      let text: string;
      try {
        text = await invoke<string>("read_text_file", { path });
      } catch (e) {
        lastErr = `${baseName(path)} — ${String(e)}`;
        continue;
      }
      const lns = splitLines(text);
      const id = uid("file");
      linesStore[id] = lns;
      patchState((s) => {
        const f: LogFile = {
          id,
          name: baseName(path),
          path,
          lineCount: lns.length,
          groups: [{ id: uid("g"), name: "Filters", filters: [], sections: [], order: [] }],
          activeGroupId: null,
        };
        f.activeGroupId = f.groups[0].id;
        s.files.push(f);
        s.activeFileId = f.id;
      });
    }
    setLinesVersion((v) => v + 1);
    if (lastErr) toast.error("Could not open file: " + lastErr);
  }, [patchState]);

  const openFiles = useCallback(async () => {
    const sel = await open({ multiple: true });
    if (sel == null) return;
    await loadPaths(Array.isArray(sel) ? sel : [sel]);
  }, [loadPaths]);

  // On restart the persisted file list has paths but no cached lines; reload the
  // active file's contents from disk when they're missing.
  useEffect(() => {
    if (!file || !file.path || linesStore[file.id]) return;
    const { id, path, name } = file;
    let cancelled = false;
    (async () => {
      try {
        const text = await invoke<string>("read_text_file", { path });
        if (cancelled) return;
        linesStore[id] = splitLines(text);
        setLinesVersion((v) => v + 1);
      } catch (e) {
        if (!cancelled) toast.error(`Could not reload ${name}: ${String(e)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [file?.id, file?.path]);

  // OS drag-and-drop of files onto the window (Tauri handles this natively).
  const loadPathsRef = useRef(loadPaths);
  loadPathsRef.current = loadPaths;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    try {
      getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") setDragOver(true);
          else if (p.type === "drop") {
            setDragOver(false);
            if (p.paths.length) void loadPathsRef.current(p.paths);
          } else {
            setDragOver(false);
          }
        })
        .then((un) => { if (disposed) un(); else unlisten = un; })
        .catch(() => { /* not running under Tauri */ });
    } catch { /* not running under Tauri */ }
    return () => { disposed = true; unlisten?.(); };
  }, []);

  // ---------- groups ----------
  const switchGroup = (gid: string) => patchState((s) => { if (!file) return; withFile(s, file.id).activeGroupId = gid; });
  const addGroup = () => patchState((s) => {
    if (!file) return;
    const f = withFile(s, file.id);
    const g: FilterGroup = { id: uid("g"), name: "New set", filters: [], sections: [], order: [] };
    f.groups.push(g); f.activeGroupId = g.id;
  });
  const renameGroup = (gid: string, name: string) => patchState((s) => { if (!file) return; withGroup(s, file.id, gid).name = name; });
  const deleteGroup = (gid: string) => patchState((s) => {
    if (!file) return;
    const f = withFile(s, file.id);
    f.groups = f.groups.filter((g) => g.id !== gid);
    if (f.activeGroupId === gid) f.activeGroupId = f.groups[0]?.id ?? null;
  });
  const reorderGroups = (from: number, to: number) => patchState((s) => {
    if (!file) return;
    const f = withFile(s, file.id);
    const [m] = f.groups.splice(from, 1);
    f.groups.splice(to, 0, m);
  });

  // ---------- sections ----------
  const addSection = () => patchState((s) => {
    if (!file || !group) return;
    const g = withGroup(s, file.id, group.id);
    const sec = { id: uid("sec"), name: "New group", collapsed: false };
    g.sections.push(sec);
    g.order.push(sec.id);
  });
  const renameSection = (sid: string, name: string) => patchState((s) => {
    if (!file || !group) return;
    const sec = withGroup(s, file.id, group.id).sections.find((x) => x.id === sid);
    if (sec) sec.name = name;
  });
  const toggleSection = (sid: string) => patchState((s) => {
    if (!file || !group) return;
    const sec = withGroup(s, file.id, group.id).sections.find((x) => x.id === sid);
    if (sec) sec.collapsed = !sec.collapsed;
  });
  const deleteSection = (sid: string) => patchState((s) => {
    if (!file || !group) return;
    const g = withGroup(s, file.id, group.id);
    g.sections = g.sections.filter((x) => x.id !== sid);
    // Keep the filters — move them back to the ungrouped bucket, taking the
    // section's old top-level slot (so they don't jump elsewhere).
    const freed = g.filters.filter((f) => f.sectionId === sid).map((f) => f.id);
    g.filters.forEach((f) => { if (f.sectionId === sid) f.sectionId = null; });
    const at = g.order.indexOf(sid);
    if (at >= 0) g.order.splice(at, 1, ...freed);
    else g.order.push(...freed);
  });
  // Reorder a top-level item (section or ungrouped filter) to `toId`'s slot;
  // toId === null moves it to the end.
  const reorderTop = (fromId: string, toId: string | null) => patchState((s) => {
    if (!file || !group) return;
    const order = withGroup(s, file.id, group.id).order;
    const from = order.indexOf(fromId);
    if (from < 0) return;
    const to = toId ? order.indexOf(toId) : -1;
    const [m] = order.splice(from, 1);
    if (to < 0) order.push(m);
    else order.splice(to, 0, m);
  });
  const setSectionEnabled = (sid: string, enabled: boolean) => patchState((s) => {
    if (!file || !group) return;
    withGroup(s, file.id, group.id).filters.forEach((f) => { if (f.sectionId === sid) f.enabled = enabled; });
  });

  // ---------- filters ----------
  const updateFilter = (fid: string, patch: Partial<Filter>) => patchState((s) => {
    if (!file || !group) return;
    const g = withGroup(s, file.id, group.id);
    Object.assign(g.filters.find((x) => x.id === fid)!, patch);
  });
  const deleteFilter = (fid: string) => {
    patchState((s) => {
      if (!file || !group) return;
      const g = withGroup(s, file.id, group.id);
      g.filters = g.filters.filter((x) => x.id !== fid);
      const oi = g.order.indexOf(fid);
      if (oi >= 0) g.order.splice(oi, 1);
    });
    setEditing(null);
  };
  // Move a filter to `overId`'s slot (arrayMove semantics), optionally into another section.
  // overId === null drops it at the end of `targetSectionId`'s bucket.
  const moveFilter = (activeId: string, overId: string | null, targetSectionId: string | null) =>
    patchState((s) => {
      if (!file || !group) return;
      const g = withGroup(s, file.id, group.id);
      const arr = g.filters;
      const from = arr.findIndex((x) => x.id === activeId);
      if (from < 0) return;
      // Capture the destination index BEFORE removing the dragged item so that
      // dragging downward lands the row *after* the drop target (matches dnd-kit's preview).
      const to = overId ? arr.findIndex((x) => x.id === overId) : -1;
      arr[from].sectionId = targetSectionId;
      const [m] = arr.splice(from, 1);
      if (to < 0) arr.push(m);
      else arr.splice(to, 0, m);
      // Maintain the top-level order: ungrouped filters appear in `order`,
      // grouped ones do not.
      const oi = g.order.indexOf(activeId);
      if (targetSectionId === null) {
        const oto = overId ? g.order.indexOf(overId) : -1;
        if (oi >= 0) g.order.splice(oi, 1);
        const at = oto >= 0 ? oto : -1;
        if (at < 0) g.order.push(activeId);
        else g.order.splice(at, 0, activeId);
      } else if (oi >= 0) {
        g.order.splice(oi, 1);
      }
    });
  const duplicateFilter = (fid: string) => patchState((s) => {
    if (!file || !group) return;
    const g = withGroup(s, file.id, group.id);
    const idx = g.filters.findIndex((x) => x.id === fid);
    if (idx < 0) return;
    const copy = { ...g.filters[idx], id: uid("f") };
    g.filters.splice(idx + 1, 0, copy);
    if (copy.sectionId === null) {
      const oi = g.order.indexOf(fid);
      if (oi >= 0) g.order.splice(oi + 1, 0, copy.id);
      else g.order.push(copy.id);
    }
  });
  const openNewFilter = (sectionId: string | null = null) => {
    if (!group) return;
    const pal = PALETTE[group.filters.length % PALETTE.length];
    setEditing({ isNew: true, filter: makeFilter("", { textColor: pal.text, bgColor: pal.bg, sectionId }) });
  };
  const openFilterFromPattern = (pattern: string) => {
    if (!group) return;
    const pal = PALETTE[group.filters.length % PALETTE.length];
    setEditing({ isNew: true, filter: makeFilter(pattern, { textColor: pal.text, bgColor: pal.bg }) });
  };
  const openEditFilter = (fid: string) => {
    if (!group) return;
    const fl = group.filters.find((x) => x.id === fid)!;
    setEditing({ isNew: false, filter: { ...fl } });
  };
  const saveFilter = (draft: Filter) => {
    patchState((s) => {
      if (!file || !group) return;
      const g = withGroup(s, file.id, group.id);
      const idx = g.filters.findIndex((x) => x.id === draft.id);
      if (idx >= 0) g.filters[idx] = draft; else g.filters.push(draft);
      // Reconcile top-level order with the (possibly changed) section.
      const oi = g.order.indexOf(draft.id);
      if (draft.sectionId === null && oi < 0) g.order.push(draft.id);
      else if (draft.sectionId !== null && oi >= 0) g.order.splice(oi, 1);
    });
    setEditing(null);
  };

  // ---------- save / import ----------
  // Exported file keeps the full structure: filters, sections and top-level order.
  const exportPayload = (g: FilterGroup) =>
    JSON.stringify({ version: 1, name: g.name, sections: g.sections, order: g.order, filters: g.filters }, null, 2);

  const writeFiltersTo = async (path: string) => {
    if (!file || !group) return;
    try {
      await invoke("write_text_file", { path, contents: exportPayload(group) });
      patchState((s) => { if (file && group) withGroup(s, file.id, group.id).filePath = path; });
      toast.success("Filters saved");
    } catch (e) {
      toast.error("Could not save filters: " + String(e));
    }
  };

  const saveFiltersAs = async () => {
    if (!group) return;
    const path = await save({
      defaultPath: group.name.replace(/\s+/g, "_") + "_filters.json",
      filters: FILE_DIALOG_FILTERS,
    });
    if (typeof path === "string") await writeFiltersTo(path);
  };

  // "Save filters": update the file it was last saved to; if never saved, behave as Save As.
  const saveFilters = async () => {
    if (!group) return;
    if (group.filePath) await writeFiltersTo(group.filePath);
    else await saveFiltersAs();
  };

  // "Import filters": replaces the current group's filters/sections entirely,
  // so confirm first when the group isn't empty.
  const importFilters = async () => {
    if (!file || !group) return;
    if (group.filters.length > 0) {
      const ok = await confirm(
        "Importing will replace every filter and group in the current set. This can't be undone.",
        { title: "Replace current filters?", kind: "warning", okLabel: "Replace", cancelLabel: "Cancel" }
      );
      if (!ok) return;
    }
    const path = await open({ multiple: false, filters: FILE_DIALOG_FILTERS });
    if (typeof path !== "string") return;
    let text: string;
    try { text = await invoke<string>("read_text_file", { path }); }
    catch (e) { toast.error("Could not read file: " + String(e)); return; }
    let data: unknown;
    try { data = JSON.parse(text); }
    catch { toast.error("That file isn't valid JSON."); return; }
    const built = buildGroupFromImport(data);
    if (!built) { toast.error("That file doesn't contain Logsy filters."); return; }
    patchState((s) => {
      if (!file || !group) return;
      const g = withGroup(s, file.id, group.id);
      g.filters = built.filters;
      g.sections = built.sections;
      g.order = built.order;
      normalizeState(s);
    });
    toast.success("Filters imported");
  };

  // ---------- bulk ----------
  const bulk = (action: string) => {
    if (action === "enableAll")   patchState((s) => { if (file && group) withGroup(s, file.id, group.id).filters.forEach((f) => (f.enabled = true)); });
    else if (action === "disableAll") patchState((s) => { if (file && group) withGroup(s, file.id, group.id).filters.forEach((f) => (f.enabled = false)); });
    else if (action === "clear")  patchState((s) => { if (!file || !group) return; const g = withGroup(s, file.id, group.id); g.filters = []; g.order = g.order.filter((id) => g.sections.some((sec) => sec.id === id)); });
    else if (action === "save")   void saveFilters();
    else if (action === "saveAs") void saveFiltersAs();
    else if (action === "import") void importFilters();
  };

  // ---------- compare panel ----------
  const addToCompare = (ns: number[]) => setCompareLines((s) => { const x = new Set(s); ns.forEach((n) => x.add(n)); return x; });
  const removeFromCompare = (n: number) => setCompareLines((s) => { const x = new Set(s); x.delete(n); return x; });
  const clearCompare = () => setCompareLines(new Set());
  // Drop comparison lines when switching files (line numbers are file-specific).
  useEffect(() => { setCompareLines(new Set()); }, [state.activeFileId]);

  // ---------- dock layout ----------
  const setComparePos = (pos: "bottom" | "right") => setState((s) => ({ ...s, comparePos: pos }));
  const setFilterPos = (pos: "bottom" | "right") => setState((s) => ({ ...s, panelPos: pos }));
  const toggleFilterCollapsed = () => setState((s) => ({ ...s, filterCollapsed: !s.filterCollapsed }));
  const toggleCompareCollapsed = () => setState((s) => ({ ...s, compareCollapsed: !s.compareCollapsed }));

  const showCompare = compareRows.length > 0;
  // Structure signature: panels remount when positions or compare-presence change.
  const layoutKey = `${state.panelPos}|${state.comparePos}|${showCompare}`;

  // Default share (weight) for a panel that has no persisted size yet. Docks
  // open generously so they reveal a useful amount of content.
  const DEFAULT_WEIGHT: Record<string, number> = { lv: 100, center: 100, fp: 82, cmp: 82 };
  // Build a group's initial layout from its persisted-size bucket, normalised to 100%.
  const layoutFor = (groupKey: string, ids: string[]): Record<string, number> => {
    const bucket = state.panelSizes?.[groupKey] ?? {};
    const out: Record<string, number> = {};
    let known = 0; const unknown: string[] = [];
    for (const id of ids) { const v = bucket[id]; if (typeof v === "number") { out[id] = v; known += v; } else unknown.push(id); }
    if (unknown.length) {
      const totalW = unknown.reduce((a, id) => a + (DEFAULT_WEIGHT[id] ?? 100), 0) || 1;
      const rem = Math.max(unknown.length * 10, 100 - known);
      for (const id of unknown) out[id] = rem * (DEFAULT_WEIGHT[id] ?? 100) / totalW;
    }
    const sum = ids.reduce((a, id) => a + out[id], 0) || 1;
    for (const id of ids) out[id] = (out[id] / sum) * 100;
    return out;
  };
  const onLayoutFor = (groupKey: string) => (layout: Record<string, number>) => setState((s) => {
    const bucket = { ...(s.panelSizes?.[groupKey] ?? {}) };
    for (const [id, v] of Object.entries(layout)) {
      if (id === "fp" && s.filterCollapsed) continue;   // don't persist a collapsed size
      if (id === "cmp" && s.compareCollapsed) continue;
      bucket[id] = v;
    }
    return { ...s, panelSizes: { ...(s.panelSizes ?? {}), [groupKey]: bucket } };
  });

  // Keep the panels' collapsed state in sync with persisted flags.
  useEffect(() => { const p = fpRef.current; if (p) state.filterCollapsed ? p.collapse() : p.expand(); }, [state.filterCollapsed, layoutKey]);
  useEffect(() => { const p = cmpRef.current; if (p && showCompare) state.compareCollapsed ? p.collapse() : p.expand(); }, [state.compareCollapsed, layoutKey, showCompare]);

  // ---------- layout ----------
  const setViewMode = (m: "all" | "matches") => setState((s) => ({ ...s, viewMode: m }));
  const toggleSidebar = () => setState((s) => ({ ...s, sidebarCollapsed: !s.sidebarCollapsed }));
  const toggleLineNumbers = () => setState((s) => ({ ...s, showLineNumbers: !(s.showLineNumbers ?? true) }));

  const zoomIn    = useCallback(() => setState((s) => ({ ...s, fontSize: Math.min(FONT_MAX, (s.fontSize ?? FONT_DEFAULT) + FONT_STEP) })), []);
  const zoomOut   = useCallback(() => setState((s) => ({ ...s, fontSize: Math.max(FONT_MIN, (s.fontSize ?? FONT_DEFAULT) - FONT_STEP) })), []);
  const zoomReset = useCallback(() => setState((s) => ({ ...s, fontSize: FONT_DEFAULT })), []);

  useEffect(() => {
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      setState((s) => ({
        ...s,
        fontSize: Math.max(FONT_MIN, Math.min(FONT_MAX, (s.fontSize ?? FONT_DEFAULT) + dir * FONT_STEP)),
      }));
    }
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);

  const fontSize = state.fontSize ?? FONT_DEFAULT;
  const showLineNumbers = state.showLineNumbers ?? true;
  const rowH = Math.round(fontSize * 1.5);
  const filterRowH = Math.round(fontSize * 1.58);

  // ---------- keyboard shortcuts ----------
  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [openMenu]);

  useEffect(() => {
    return tinykeys(window, {
      "$mod+o": (e) => { e.preventDefault(); void openFiles(); },
      "$mod+f": (e) => { e.preventDefault(); setFindOpen(true); },
      "$mod+F": (e) => { e.preventDefault(); setFindOpen(true); },
      "$mod+h": (e) => { e.preventDefault(); setViewMode(state.viewMode === "all" ? "matches" : "all"); },
      "$mod+H": (e) => { e.preventDefault(); setViewMode(state.viewMode === "all" ? "matches" : "all"); },
      "$mod+=": (e) => { e.preventDefault(); zoomIn(); },
      "$mod+shift+=": (e) => { e.preventDefault(); zoomIn(); },
      "$mod+-": (e) => { e.preventDefault(); zoomOut(); },
      "$mod+0": (e) => { e.preventDefault(); zoomReset(); },
      "Escape": () => { if (findOpen && !editing) setFindOpen(false); },
    });
  }, [findOpen, editing, state.viewMode, zoomIn, zoomOut, zoomReset]);

  type MenuItem = { label?: string; key?: string; action?: () => void; sep?: true };
  const menuDefs: Record<string, MenuItem[]> = {
    File: [
      { label: "Open File…", key: "Ctrl O", action: () => void openFiles() },
      { sep: true },
      { label: "Close Window", action: () => invoke("window_controls", { action: "close" }) },
    ],
    Edit: [
      { label: "Enable All Filters", action: () => bulk("enableAll") },
      { label: "Disable All Filters", action: () => bulk("disableAll") },
      { label: "Clear All Filters", action: () => bulk("clear") },
      { sep: true },
      { label: "Save Filters", action: () => bulk("save") },
      { label: "Save Filters As…", action: () => bulk("saveAs") },
      { label: "Import Filters…", action: () => bulk("import") },
    ],
    View: [
      { label: "Toggle Sidebar", action: toggleSidebar },
      { label: showLineNumbers ? "Hide Line Numbers" : "Show Line Numbers", action: toggleLineNumbers },
      { sep: true },
      { label: "All Lines", action: () => setViewMode("all") },
      { label: "Matches Only", key: "Ctrl H", action: () => setViewMode("matches") },
      { sep: true },
      { label: "Panel: Bottom", action: () => setState((s) => ({ ...s, panelPos: "bottom" })) },
      { label: "Panel: Right", action: () => setState((s) => ({ ...s, panelPos: "right" })) },
      { sep: true },
      { label: "Zoom In", key: "Ctrl +", action: zoomIn },
      { label: "Zoom Out", key: "Ctrl −", action: zoomOut },
      { label: `Reset Zoom  (${fontSize}px)`, key: "Ctrl 0", action: zoomReset },
    ],
    Help: [
      { label: "Find in View", key: "Ctrl F", action: () => setFindOpen(true) },
      { sep: true },
      { label: "Reset Workspace", action: () => { localStorage.removeItem(STATE_KEY); location.reload(); } },
    ],
  };

  // Build the resizable workspace: log view + filter/compare docks. Docks dock
  // bottom or right; on the same side compare sits before (above/left-of) filter.
  function renderWorkspace(): ReactNode {
    const logview = (
      <LogView
        file={file!}
        view={view}
        viewMode={state.viewMode}
        onToggleViewMode={setViewMode}
        onToggleFind={() => setFindOpen((v) => !v)}
        findOpen={findOpen}
        onCloseFind={() => setFindOpen(false)}
        onBuildFilter={openFilterFromPattern}
        mapColorMode={state.mapColorMode ?? "bg"}
        mapWidth={state.mapWidth ?? 14}
        fontSize={fontSize}
        showLineNumbers={showLineNumbers}
        compareLines={compareLines}
        onAddToCompare={addToCompare}
        onRemoveFromCompare={removeFromCompare}
      />
    );

    const dockNode = (kind: "fp" | "cmp"): ReactNode => {
      const collapsed = kind === "fp" ? state.filterCollapsed : state.compareCollapsed;
      const pos = kind === "fp" ? state.panelPos : state.comparePos;
      const setPos = kind === "fp" ? setFilterPos : setComparePos;
      const toggle = kind === "fp" ? toggleFilterCollapsed : toggleCompareCollapsed;
      const title = kind === "fp" ? "Filters" : `Compare · ${compareRows.length}`;
      // Chevron points the way the panel will fold (toward its docked edge).
      const chevron = pos === "bottom"
        ? (collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />)
        : (collapsed ? <ChevronLeft size={15} /> : <ChevronRight size={15} />);
      return (
        <div className={"dock dock-" + pos + (collapsed ? " collapsed" : "")}>
          {/* whole header toggles collapse; the action buttons stop propagation */}
          <div className="dock-head" onClick={toggle} title={collapsed ? "Expand" : "Collapse"}>
            <span className="dock-chevron">{chevron}</span>
            <span className="dock-title">{title}</span>
            <div className="dock-spacer" />
            {kind === "cmp" && !collapsed && (
              <button className="dock-btn" title="Clear comparison" onClick={(e) => { e.stopPropagation(); clearCompare(); }}><X size={14} /></button>
            )}
            <button className="dock-btn" title={pos === "bottom" ? "Dock right" : "Dock bottom"} onClick={(e) => { e.stopPropagation(); setPos(pos === "bottom" ? "right" : "bottom"); }}>
              {pos === "bottom" ? <PanelRight size={14} /> : <PanelBottom size={14} />}
            </button>
          </div>
          {!collapsed && (
            <div className="dock-body">
              {kind === "fp" ? (
                <FilterPanel
                  file={file!}
                  group={group!}
                  counts={view.counts}
                  onSwitchGroup={switchGroup}
                  onAddGroup={addGroup}
                  onRenameGroup={renameGroup}
                  onDeleteGroup={deleteGroup}
                  onReorderGroup={reorderGroups}
                  onAddSection={addSection}
                  onRenameSection={renameSection}
                  onToggleSection={toggleSection}
                  onDeleteSection={deleteSection}
                  onReorderTop={reorderTop}
                  onSetSectionEnabled={setSectionEnabled}
                  onUpdateFilter={updateFilter}
                  onAddFilter={openNewFilter}
                  onDeleteFilter={deleteFilter}
                  onDuplicateFilter={duplicateFilter}
                  onEditFilter={openEditFilter}
                  onMoveFilter={moveFilter}
                  onBulk={bulk}
                />
              ) : (
                <CompareTable rows={compareRows} onRemove={removeFromCompare} />
              )}
            </div>
          )}
        </div>
      );
    };

    type PanelDesc = { id: string; node: ReactNode; collapsible?: boolean; ref?: React.RefObject<PanelImperativeHandle | null> };
    const buildGroup = (orientation: "vertical" | "horizontal", gid: string, panels: PanelDesc[]): ReactNode => {
      const ids = panels.map((p) => p.id);
      // Remount the group when its panel set changes — the library can't have a
      // Panel inserted into / removed from a live group ("constraints not found").
      const groupKey = gid + ":" + ids.join(",");
      const dl = layoutFor(groupKey, ids);
      return (
        <ResizablePanelGroup key={groupKey} orientation={orientation} className="main" id={groupKey} defaultLayout={dl} onLayoutChanged={onLayoutFor(groupKey)}>
          {panels.map((p, i) => (
            <Fragment key={p.id}>
              <ResizablePanel
                id={p.id}
                defaultSize={`${dl[p.id]}%`}
                minSize={p.collapsible ? "8%" : "15%"}
                collapsible={p.collapsible}
                collapsedSize="26px"
                panelRef={p.ref}
              >
                {p.node}
              </ResizablePanel>
              {i < panels.length - 1 && <ResizableHandle withHandle />}
            </Fragment>
          ))}
        </ResizablePanelGroup>
      );
    };

    const docks = [
      { id: "fp", pos: state.panelPos, ref: fpRef },
      ...(showCompare ? [{ id: "cmp", pos: state.comparePos, ref: cmpRef }] : []),
    ];
    // Order each side so compare comes before filter (above when bottom, left when right).
    const side = (s: "bottom" | "right") =>
      docks.filter((d) => d.pos === s).sort((a, b) => (a.id === "cmp" ? -1 : 1) - (b.id === "cmp" ? -1 : 1));
    const bottomDocks = side("bottom");
    const rightDocks = side("right");
    const dockPanel = (d: { id: string; ref: React.RefObject<PanelImperativeHandle | null> }): PanelDesc =>
      ({ id: d.id, node: dockNode(d.id as "fp" | "cmp"), collapsible: true, ref: d.ref });

    let center: ReactNode = logview;
    if (bottomDocks.length) {
      center = buildGroup("vertical", "grp-v", [{ id: "lv", node: logview }, ...bottomDocks.map(dockPanel)]);
    }
    if (rightDocks.length) {
      return buildGroup("horizontal", "grp-h", [
        { id: bottomDocks.length ? "center" : "lv", node: center },
        ...rightDocks.map(dockPanel),
      ]);
    }
    return center;
  }

  return (
    <TooltipProvider delay={600}>
      <div className="app" style={{ "--log-font-size": `${fontSize}px`, "--log-row-h": `${rowH}px`, "--filter-row-h": `${filterRowH}px` } as CSSProperties}>
        {/* titlebar */}
        <div className="titlebar" data-tauri-drag-region>
          <div className="brand">
            <span className="logo" />
            logsy
          </div>
          <div className="menubar">
            {(["File", "Edit", "View", "Help"] as const).map((m) => (
              <div
                key={m}
                className={"menu" + (openMenu?.name === m ? " active" : "")}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setOpenMenu(openMenu?.name === m ? null : { name: m, x: rect.left, y: rect.bottom });
                }}
              >
                {m}
              </div>
            ))}
          </div>
          <div className="win-controls" onMouseDown={(e) => e.stopPropagation()}>
            <div className="wc" onClick={() => invoke("window_controls", { action: "minimize" })}>
              <Minus size={15} />
            </div>
            <div className="wc" onClick={() => invoke("window_controls", { action: "maximize" })}>
              <Square size={13} />
            </div>
            <div className="wc close" onClick={() => invoke("window_controls", { action: "close" })}>
              <X size={15} />
            </div>
          </div>
        </div>

        {/* body */}
        <div className="body">
          <Sidebar
            state={state}
            collapsed={state.sidebarCollapsed}
            onToggleCollapse={toggleSidebar}
            onSelectFile={selectFile}
            onOpenFile={() => void openFiles()}
            onDeleteFile={deleteFile}
            onSetPanelPos={(pos) => setState((s) => ({ ...s, panelPos: pos }))}
            onSetMapColorMode={(mode) => setState((s) => ({ ...s, mapColorMode: mode }))}
            onSetMapWidth={(w) => setState((s) => ({ ...s, mapWidth: w }))}
            onResetWorkspace={() => { localStorage.removeItem(STATE_KEY); location.reload(); }}
          />
          {file && group ? (
            renderWorkspace()
          ) : (
            <div className="empty-workspace">
              <div className="ew-card">
                <div className="ew-icon"><FolderOpen size={40} /></div>
                <div className="ew-title">No log open</div>
                <div className="ew-sub">Open a log file to start filtering, or drag &amp; drop one anywhere in this window.</div>
                <Button onClick={() => void openFiles()}>
                  <Upload data-icon="inline-start" />Open log file
                </Button>
                <div className="ew-hint">Ctrl O</div>
              </div>
            </div>
          )}
        </div>

        {/* modal */}
        {editing && group && (
          <EditModal
            filter={editing.filter}
            isNew={editing.isNew}
            lines={lines}
            sections={group.sections}
            onSave={saveFilter}
            onClose={() => setEditing(null)}
            onDelete={() => deleteFilter(editing.filter.id)}
          />
        )}

        {/* drag-and-drop overlay */}
        {dragOver && (
          <div className="drop-overlay">
            <div className="drop-overlay-inner">
              <Upload size={34} />
              <div className="do-title">Drop log files to open</div>
            </div>
          </div>
        )}

        {openMenu && (
          <div
            className="menu-pop"
            style={{ position: "fixed", left: openMenu.x, top: openMenu.y + 2, zIndex: 500 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {menuDefs[openMenu.name].map((item, i) =>
              item.sep ? (
                <div key={i} className="menu-sep" />
              ) : (
                <div
                  key={i}
                  className="menu-item"
                  onClick={() => { item.action?.(); setOpenMenu(null); }}
                >
                  <span>{item.label}</span>
                  {item.key && <span className="mi-key">{item.key}</span>}
                </div>
              )
            )}
          </div>
        )}

        <Toaster />
      </div>
    </TooltipProvider>
  );
}
