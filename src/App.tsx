import { useState, useMemo, useEffect, useCallback, useReducer, useRef, Fragment, CSSProperties, ReactNode } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FolderOpen, Minus, PanelBottom, PanelBottomClose, PanelRight, PanelRightOpen, Square, Upload, X } from "lucide-react";
import { tinykeys } from "tinykeys";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { save, open, confirm } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import type { AppState, LogFile, FilterGroup, FilterSection, Filter, FilterLayout } from "./types";
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
import { MenuPopup, type MenuItem } from "./components/MenuPopup";
import { AboutModal } from "./components/AboutModal";
import { Button } from "./components/ui/button";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./components/ui/resizable";

const STATE_KEY = "logsy.state.v6";
const DOCS_URL = "https://github.com/kamelliao/logsy#readme";
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
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appVersion, setAppVersion] = useState("0.2.1");
  // Go-to-line dialog + signals pushed to LogView for menu-driven actions.
  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoVal, setGotoVal] = useState("");
  const [selectAllNonce, setSelectAllNonce] = useState(0);
  const [gotoSignal, setGotoSignal] = useState<{ n: number; nonce: number } | null>(null);
  const gotoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { getVersion().then(setAppVersion).catch(() => { /* not under Tauri */ }); }, []);

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
    () => view.rows
      .filter((r) => !r.excluded && compareLines.has(r.n) && r.fieldsFromId !== undefined)
      .map((r) => ({ ...r, fields: view.fieldsFor(r.n) })),
    [view, compareLines],
  );

  // ---------- helpers ----------
  // Latest state, readable from async callbacks (file loading) and from
  // patchState / undo without stale closures.
  const stateRef = useRef(state);
  stateRef.current = state;

  // ---------- undo / redo ----------
  // Whole-AppState snapshots. Snapshots are immutable (patchState clones before
  // mutating), so stacking the prior reference is cheap. Memory-only (not
  // persisted); `bumpHistory` re-renders so menu enablement stays in sync.
  const past = useRef<AppState[]>([]);
  const future = useRef<AppState[]>([]);
  const coalesceKey = useRef<string | null>(null);
  const [, bumpHistory] = useReducer((x: number) => x + 1, 0);
  const HISTORY_CAP = 50;

  // Mutate state immutably. By default the edit is recorded for undo; pass
  // { undoable: false } for navigation / file / view-only changes, or
  // { coalesce } to fold a run of similar edits (typing, dragging) into one step.
  const patchState = useCallback(
    (fn: (s: AppState) => void, opts?: { undoable?: boolean; coalesce?: string }) => {
      if (opts?.undoable !== false) {
        const base = stateRef.current;
        const top = past.current[past.current.length - 1];
        const fold = !!opts?.coalesce && coalesceKey.current === opts.coalesce;
        // Skip when folding, or when an earlier edit this tick already pushed the
        // same base (so a single user action is one undo step).
        if (!fold && top !== base) {
          past.current.push(base);
          if (past.current.length > HISTORY_CAP) past.current.shift();
        }
        future.current = [];
        coalesceKey.current = opts?.coalesce ?? null;
        bumpHistory();
      }
      setState((s) => {
        const n = structuredClone(s);
        fn(n);
        return n;
      });
    },
    [],
  );

  const undo = useCallback(() => {
    if (past.current.length === 0) return;
    const prev = past.current.pop()!;
    future.current.push(stateRef.current);
    coalesceKey.current = null;
    bumpHistory();
    setState(prev);
  }, []);
  const redo = useCallback(() => {
    if (future.current.length === 0) return;
    const next = future.current.pop()!;
    past.current.push(stateRef.current);
    coalesceKey.current = null;
    bumpHistory();
    setState(next);
  }, []);
  const canUndo = past.current.length > 0;
  const canRedo = future.current.length > 0;

  // Push a path to the front of a recent-list (deduped, capped at 10).
  const pushRecent = useCallback((key: "recentFiles" | "recentFilterFiles", path: string) => {
    setState((s) => {
      const cur = (s[key] ?? []).filter((p) => p !== path);
      cur.unshift(path);
      return { ...s, [key]: cur.slice(0, 10) };
    });
  }, []);
  const clearRecent = useCallback((key: "recentFiles" | "recentFilterFiles") =>
    setState((s) => ({ ...s, [key]: [] })), []);

  function withFile(s: AppState, fid: string): LogFile {
    return s.files.find((f) => f.id === fid)!;
  }
  function withGroup(s: AppState, fid: string, gid: string): FilterGroup {
    return withFile(s, fid).groups.find((g) => g.id === gid)!;
  }

  // ---------- files ----------
  const selectFile = (fid: string) => setState((s) => ({ ...s, activeFileId: fid }));

  // Closing a log discards its workspace (filters, sets) — confirm first.
  const deleteFile = async (fid: string) => {
    const f = stateRef.current.files.find((x) => x.id === fid);
    const ok = await confirm(
      `Close "${f?.name ?? "this log"}"? Its filters in this workspace will be discarded.`,
      { title: "Close log?", kind: "warning", okLabel: "Close", cancelLabel: "Cancel" }
    );
    if (!ok) return;
    patchState((s) => {
      s.files = s.files.filter((x) => x.id !== fid);
      if (s.activeFileId === fid) s.activeFileId = s.files[0]?.id ?? null;
      delete linesStore[fid];
    }, { undoable: false });
  };

  // Read each path from disk and add it as a log file. The same path may be
  // opened more than once — each open is a separate entry (duplicates get a
  // "(n)" suffix so the sidebar stays readable). When `inheritFilters` is set
  // (e.g. for drag-and-drop) the new file starts with a copy of the current
  // set's filters instead of an empty one.
  const loadPaths = useCallback(async (paths: string[], inheritFilters = false) => {
    let lastErr = "";
    // Snapshot the active set's filters once, up front, so every dropped file
    // inherits the same starting point.
    const inherited = (() => {
      if (!inheritFilters) return null;
      const cur = stateRef.current;
      const cf = cur.files.find((f) => f.id === cur.activeFileId) ?? cur.files[0] ?? null;
      const cg = cf ? (cf.groups.find((g) => g.id === cf.activeGroupId) ?? cf.groups[0]) : null;
      return cg ?? null;
    })();
    const makeGroups = (): FilterGroup[] =>
      inherited
        ? [{ ...(JSON.parse(JSON.stringify(inherited)) as FilterGroup), id: uid("g") }]
        : [{ id: uid("g"), name: "Filters", filters: [], sections: [], order: [] }];
    for (const path of paths) {
      let text: string;
      try {
        text = await invoke<string>("read_text_file", { path });
      } catch (e) {
        lastErr = `${baseName(path)} — ${String(e)}`;
        continue;
      }
      pushRecent("recentFiles", path);
      const lns = splitLines(text);
      const id = uid("file");
      linesStore[id] = lns;
      patchState((s) => {
        // Disambiguate repeated opens of the same path: "log" → "log (2)" → …
        const dupes = s.files.filter((f) => f.path === path).length;
        const f: LogFile = {
          id,
          name: dupes > 0 ? `${baseName(path)} (${dupes + 1})` : baseName(path),
          path,
          lineCount: lns.length,
          groups: makeGroups(),
          activeGroupId: null,
        };
        f.activeGroupId = f.groups[0].id;
        s.files.push(f);
        s.activeFileId = f.id;
      }, { undoable: false });
    }
    setLinesVersion((v) => v + 1);
    if (lastErr) toast.error("Could not open file: " + lastErr);
  }, [patchState, pushRecent]);

  const openFiles = useCallback(async () => {
    const sel = await open({ multiple: true });
    if (sel == null) return;
    await loadPaths(Array.isArray(sel) ? sel : [sel]);
  }, [loadPaths]);

  // Replace the active file's contents in place (same workspace slot, keeping its
  // filters/groups) with a file from disk — used by drag-and-drop so a dropped
  // log loads into the current workspace instead of spawning a new file entry.
  const replaceActiveFile = useCallback(async (path: string) => {
    const cur = stateRef.current;
    const active = cur.files.find((f) => f.id === cur.activeFileId) ?? cur.files[0] ?? null;
    if (!active) { await loadPaths([path]); return; }
    let text: string;
    try { text = await invoke<string>("read_text_file", { path }); }
    catch (e) { toast.error("Could not open file: " + baseName(path) + " — " + String(e)); return; }
    const lns = splitLines(text);
    linesStore[active.id] = lns;
    patchState((s) => {
      const f = s.files.find((x) => x.id === active.id);
      if (!f) return;
      f.path = path;
      f.name = baseName(path);
      f.lineCount = lns.length;
      s.activeFileId = f.id;
    }, { undoable: false });
    pushRecent("recentFiles", path);
    setCompareLines(new Set());      // line numbers are file-specific
    setLinesVersion((v) => v + 1);
  }, [loadPaths, patchState, pushRecent]);

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
  const replaceActiveFileRef = useRef(replaceActiveFile);
  replaceActiveFileRef.current = replaceActiveFile;
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
            if (!p.paths.length) return;
            const paths = p.paths;
            void (async () => {
              // A log is already open: confirm, then load into the current
              // workspace (replace the active file in place, keeping its filters)
              // rather than spawning a new file entry.
              if (stateRef.current.files.length > 0) {
                const ok = await confirm(
                  `A log is already open. Replace it with the dropped file${paths.length > 1 ? "s" : ""}?`,
                  { title: "Replace current log?", kind: "warning", okLabel: "Replace", cancelLabel: "Cancel" }
                );
                if (!ok) return;
                await replaceActiveFileRef.current(paths[0]);
                // Any extra dropped files open as additional entries.
                if (paths.length > 1) await loadPathsRef.current(paths.slice(1), true);
              } else {
                await loadPathsRef.current(paths);
              }
            })();
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
  const switchGroup = (gid: string) => patchState((s) => { if (!file) return; withFile(s, file.id).activeGroupId = gid; }, { undoable: false });
  const addGroup = () => patchState((s) => {
    if (!file) return;
    const f = withFile(s, file.id);
    const g: FilterGroup = { id: uid("g"), name: "New set", filters: [], sections: [], order: [] };
    f.groups.push(g); f.activeGroupId = g.id;
  });
  const renameGroup = (gid: string, name: string) => patchState((s) => { if (!file) return; withGroup(s, file.id, gid).name = name; });
  const deleteGroup = async (gid: string) => {
    if (!file) return;
    const g = file.groups.find((x) => x.id === gid);
    // Confirm only when the set actually holds filters (empty sets delete freely).
    if (g && g.filters.length > 0) {
      const ok = await confirm(
        `Delete the "${g.name}" filter set and its ${g.filters.length} filter${g.filters.length > 1 ? "s" : ""}?`,
        { title: "Delete filter set?", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" }
      );
      if (!ok) return;
    }
    patchState((s) => {
      const f = withFile(s, file.id);
      f.groups = f.groups.filter((x) => x.id !== gid);
      if (f.activeGroupId === gid) f.activeGroupId = f.groups[0]?.id ?? null;
    });
  };
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
  }, { undoable: false });
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
  // Commit a whole-group drag-and-drop arrangement (built live in FilterPanel) in
  // one undoable step. Rebuild `filters` in visual order — loose rows and each
  // section's rows interleaved per `model.top` — and set every filter's sectionId;
  // `order` becomes the new interleaved top-level order.
  const applyLayout = (model: FilterLayout) => patchState((s) => {
    if (!file || !group) return;
    const g = withGroup(s, file.id, group.id);
    const byId = new Map(g.filters.map((f) => [f.id, f] as const));
    const next: Filter[] = [];
    for (const entry of model.top) {
      if (entry.kind === "filter") {
        const f = byId.get(entry.id);
        if (f) { f.sectionId = null; next.push(f); byId.delete(entry.id); }
      } else {
        for (const fid of model.inSection[entry.id] ?? []) {
          const f = byId.get(fid);
          if (f) { f.sectionId = entry.id; next.push(f); byId.delete(fid); }
        }
      }
    }
    for (const f of byId.values()) next.push(f); // safety: never drop a filter
    g.filters = next;
    g.order = model.top.map((e) => e.id);
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
      patchState((s) => {
        if (!file || !group) return;
        const g = withGroup(s, file.id, group.id);
        g.filePath = path;
        // Mark this as the clean baseline so "Save Filter" disables until the
        // next edit.
        g.savedSnapshot = exportPayload(g);
      }, { undoable: false });
      pushRecent("recentFilterFiles", path);
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

  // Load a filter file from a known path into the current group (replacing its
  // contents). Confirms first when the group isn't empty. Used by both the
  // "Load Filters" dialog and the Recent Filter Files menu.
  const loadFilterFromPath = async (path: string) => {
    if (!file || !group) return;
    if (group.filters.length > 0) {
      const ok = await confirm(
        "Loading will replace every filter and group in the current set. This can't be undone.",
        { title: "Replace current filters?", kind: "warning", okLabel: "Replace", cancelLabel: "Cancel" }
      );
      if (!ok) return;
    }
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
      // The loaded file becomes the save target and the clean baseline.
      g.filePath = path;
      normalizeState(s);
      g.savedSnapshot = exportPayload(g);
    });
    pushRecent("recentFilterFiles", path);
    toast.success("Filters loaded");
  };

  // "Load filters": pick a file, then load it into the current group.
  const importFilters = async () => {
    if (!file || !group) return;
    const path = await open({ multiple: false, filters: FILE_DIALOG_FILTERS });
    if (typeof path !== "string") return;
    await loadFilterFromPath(path);
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
  const addToCompare = (ns: number[]) => {
    setCompareLines((s) => { const x = new Set(s); ns.forEach((n) => x.add(n)); return x; });
    // Surface the comparison: focus its tab, or expand it if it's popped out.
    setState((s) => s.comparePopped
      ? { ...s, compareCollapsed: false }
      : { ...s, activePanelTab: "compare", filterCollapsed: false });
  };
  const removeFromCompare = (n: number) => setCompareLines((s) => { const x = new Set(s); x.delete(n); return x; });
  const clearCompare = () => setCompareLines(new Set());
  // Drop comparison lines when switching files (line numbers are file-specific).
  useEffect(() => { setCompareLines(new Set()); }, [state.activeFileId]);

  // Build CSV text for a single pattern-group's rows.
  const buildCsv = (rows: typeof compareRows) => {
    const esc = (s: string) => /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    const cols: string[] = []; const seen = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r.fields ?? {})) if (!seen.has(k)) { seen.add(k); cols.push(k); }
    const parts: string[] = [["line", ...cols].map(esc).join(",")];
    for (const r of rows) parts.push([String(r.n), ...cols.map((c) => r.fields?.[c]?.raw ?? "")].map(esc).join(","));
    return parts.join("\n") + "\n";
  };

  // Export one compared pattern's table as CSV via a native save dialog.
  const exportGroupCsv = useCallback(async (id: string | undefined, label: string) => {
    const rows = compareRows.filter((r) => (r.fieldsFromId ?? "") === (id ?? ""));
    if (!rows.length) return;
    // Default name is a timestamp (yyyymmdd_hhmmss.csv); `label` is unused here
    // now but kept in the signature for call sites / future use.
    void label;
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const path = await save({ defaultPath: stamp + ".csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (typeof path !== "string") return;
    try {
      await invoke("write_text_file", { path, contents: buildCsv(rows) });
      toast.success("CSV saved");
    } catch (e) {
      toast.error("Could not save CSV: " + String(e));
    }
  }, [compareRows]);

  // Export the filtered log view via a native save dialog. LogView builds the
  // text (it knows which rows are visible) and hands it here to write.
  const exportFilteredView = useCallback(async (defaultName: string, text: string) => {
    const path = await save({ defaultPath: defaultName, filters: [{ name: "Log", extensions: ["log", "txt"] }] });
    if (typeof path !== "string") return;
    try {
      await invoke("write_text_file", { path, contents: text });
      toast.success("Filtered view exported");
    } catch (e) {
      toast.error("Could not export view: " + String(e));
    }
  }, []);

  // ---------- dock layout ----------
  const setFilterPos = (pos: "bottom" | "right") => setState((s) => ({ ...s, panelPos: pos }));
  const toggleFilterCollapsed = () => setState((s) => ({ ...s, filterCollapsed: !s.filterCollapsed }));
  const toggleCompareCollapsed = () => setState((s) => ({ ...s, compareCollapsed: !s.compareCollapsed }));
  // Select a tab in the main panel (always expands it if it was collapsed).
  const selectPanelTab = (tab: "filters" | "compare") =>
    setState((s) => ({ ...s, activePanelTab: tab, filterCollapsed: false }));
  // Pop Compare out to its own dock (so it can sit beside Filters); Filters takes
  // over the main tab area.
  const popCompareOut = () => setState((s) => ({
    ...s, comparePopped: true, compareCollapsed: false,
    activePanelTab: s.activePanelTab === "compare" ? "filters" : s.activePanelTab,
  }));
  // Merge Compare back into the main panel as a tab, and focus it.
  const dockCompareBack = () => setState((s) => ({
    ...s, comparePopped: false, activePanelTab: "compare", filterCollapsed: false,
  }));

  const showCompare = compareRows.length > 0;
  // Compare is a tab in the main panel only when it has rows and isn't popped out.
  const compareTabAvailable = showCompare && !state.comparePopped;
  const activePanelTab: "filters" | "compare" =
    state.activePanelTab === "compare" && compareTabAvailable ? "compare" : "filters";

  // Default share (weight) for a panel that has no persisted size yet. Docks
  // open generously so they reveal a useful amount of content.
  const DEFAULT_WEIGHT: Record<string, number> = { lv: 100, center: 100, fp: 82, cmp: 120 };
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

  // Drive collapse/expand by resizing the panel directly (the library's own
  // collapse() records the pre-collapse size, which our maxSize pin corrupts).
  // Resize only on the actual collapse↔expand transition; the panel's
  // defaultSize handles fresh mounts. Expanded → a generous height.
  // Collapsed strip heights: the main panel keeps its tab bar visible (taller);
  // the popped compare dock rolls down to a thin header.
  const MAIN_COLLAPSED = "34px";
  const CMP_COLLAPSED = "26px";
  // Compare opens larger than the filter dock — its tables benefit from the room.
  const EXPAND_FP = "42%";
  const EXPAND_CMP = "55%";
  const prevFp = useRef(state.filterCollapsed);
  const prevCmp = useRef(state.compareCollapsed);
  useEffect(() => {
    const p = fpRef.current; if (!p) return;
    if (state.filterCollapsed) p.resize(MAIN_COLLAPSED);
    // Defer expand so the maxSize pin (strip → 100%) settles before resizing.
    else if (prevFp.current) requestAnimationFrame(() => p.resize(EXPAND_FP));
    prevFp.current = state.filterCollapsed;
  }, [state.filterCollapsed]);
  useEffect(() => {
    const p = cmpRef.current; if (!p) return;
    if (state.compareCollapsed) p.resize(CMP_COLLAPSED);
    else if (prevCmp.current) requestAnimationFrame(() => p.resize(EXPAND_CMP));
    prevCmp.current = state.compareCollapsed;
  }, [state.compareCollapsed]);

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

  // ---------- menu actions ----------
  const openDocs = () => { invoke("open_url", { url: DOCS_URL }).catch((e) => toast.error("Could not open documentation: " + String(e))); };
  const selectAllLines = () => setSelectAllNonce((n) => n + 1);
  const openGoto = () => { setGotoVal(""); setGotoOpen(true); };
  const submitGoto = () => {
    const n = parseInt(gotoVal, 10);
    if (Number.isFinite(n) && n > 0) setGotoSignal({ n, nonce: Date.now() });
    setGotoOpen(false);
  };
  // Focus the go-to input once the dialog opens.
  useEffect(() => { if (gotoOpen) requestAnimationFrame(() => gotoInputRef.current?.focus()); }, [gotoOpen]);

  // Ctrl+B (toggle filter panel), Ctrl+G (go to line) and Ctrl+R (reload) on a
  // plain keydown listener — robust regardless of focus or keymap quirks. Kept
  // off tinykeys so there's exactly one handler (no double-toggle).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      // Undo / redo — but let the browser's native undo handle editable fields
      // (filter editor, inline rename) so typing isn't clobbered.
      if (k === "z" || k === "y") {
        const t = e.target as HTMLElement | null;
        if (t && t.closest('input, textarea, [contenteditable="true"]')) return;
        e.preventDefault();
        if (k === "y" || e.shiftKey) redo(); else undo();
        return;
      }
      if (e.shiftKey) return;
      if (k === "b") { e.preventDefault(); toggleFilterCollapsed(); }
      else if (k === "g") { e.preventDefault(); openGoto(); }
      else if (k === "r") { e.preventDefault(); location.reload(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Suppress the native browser context menu app-wide, except inside editable
  // fields (so right-click copy/paste still works there). The app's own
  // right-click menus are React handlers and are unaffected.
  useEffect(() => {
    function onCtx(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (t && t.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
    }
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  // Save Filter is disabled when the current set was already saved/loaded and
  // hasn't changed since (nothing to write).
  const saveFilterDisabled = !group || (!!group.filePath && group.savedSnapshot === exportPayload(group));

  const recentFilesMenu: MenuItem[] = state.recentFiles.length
    ? [
        ...state.recentFiles.map((p, i) => ({ label: `${i + 1}   ${baseName(p)}`, action: () => void loadPaths([p]) })),
        { sep: true as const },
        { label: "Clear Recent Files", action: () => clearRecent("recentFiles") },
      ]
    : [{ label: "No recent files", disabled: true }];

  const recentFilterFilesMenu: MenuItem[] = state.recentFilterFiles.length
    ? [
        ...state.recentFilterFiles.map((p, i) => ({ label: `${i + 1}   ${baseName(p)}`, disabled: !group, action: () => void loadFilterFromPath(p) })),
        { sep: true as const },
        { label: "Clear Recent Filter Files", action: () => clearRecent("recentFilterFiles") },
      ]
    : [{ label: "No recent filter files", disabled: true }];

  const menuDefs: Record<string, MenuItem[]> = {
    File: [
      { label: "Open…", key: "Ctrl O", action: () => void openFiles() },
      { label: "Load Filters…", disabled: !group, action: () => void importFilters() },
      { label: "Save Filter", disabled: saveFilterDisabled, action: () => void saveFilters() },
      { label: "Save Filter As…", disabled: !group, action: () => void saveFiltersAs() },
      { sep: true },
      { label: "Recent Files", submenu: recentFilesMenu },
      { label: "Recent Filter Files", submenu: recentFilterFilesMenu },
      { sep: true },
      { label: "Reload", key: "Ctrl R", action: () => location.reload() },
      { label: "Exit", action: () => invoke("window_controls", { action: "close" }) },
    ],
    Edit: [
      { label: "Undo", key: "Ctrl Z", disabled: !canUndo, action: undo },
      { label: "Redo", key: "Ctrl Y", disabled: !canRedo, action: redo },
      { sep: true },
      { label: "Select All", key: "Ctrl A", disabled: !file, action: selectAllLines },
      { label: "Find…", key: "Ctrl F", disabled: !file, action: () => setFindOpen(true) },
      { label: "Go to…", key: "Ctrl G", disabled: !file, action: openGoto },
    ],
    View: [
      { label: "Show filter panel", checked: !state.filterCollapsed, key: "Ctrl B", disabled: !file, action: toggleFilterCollapsed },
      { sep: true },
      { label: "Show only filtered lines", checked: state.viewMode === "matches", key: "Ctrl H",
        action: () => setViewMode(state.viewMode === "matches" ? "all" : "matches") },
      { label: "Show line numbers", checked: showLineNumbers, action: toggleLineNumbers },
      { sep: true },
      { label: "Zoom In", key: "Ctrl +", action: zoomIn },
      { label: "Zoom Out", key: "Ctrl −", action: zoomOut },
      { label: `Reset Zoom  (${fontSize}px)`, key: "Ctrl 0", action: zoomReset },
    ],
    Filters: [
      { label: "Add new filter…", disabled: !group, action: () => openNewFilter() },
      { sep: true },
      { label: "Enable all filters", disabled: !group, action: () => bulk("enableAll") },
      { label: "Disable all filters", disabled: !group, action: () => bulk("disableAll") },
      { label: "Remove all filters", disabled: !group, action: () => bulk("clear") },
    ],
    Help: [
      { label: "Documentation", action: openDocs },
      { label: "About", action: () => setAboutOpen(true) },
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
        selectAllNonce={selectAllNonce}
        gotoSignal={gotoSignal}
        onExportView={exportFilteredView}
      />
    );

    const filterBody = (
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
        onSetSectionEnabled={setSectionEnabled}
        onUpdateFilter={updateFilter}
        onAddFilter={openNewFilter}
        onDeleteFilter={deleteFilter}
        onDuplicateFilter={duplicateFilter}
        onEditFilter={openEditFilter}
        onApplyLayout={applyLayout}
        onBulk={bulk}
      />
    );
    const compareBody = (
      <CompareTable
        rows={compareRows}
        onRemove={removeFromCompare}
        onExport={exportGroupCsv}
        labelFor={(id) => {
          const f = group!.filters.find((x) => x.id === id);
          return (f?.description?.trim() || f?.pattern) ?? "Fields";
        }}
        colorFor={(id) => group!.filters.find((x) => x.id === id)?.textColor ?? "#c2c7cd"}
      />
    );

    const foldChevron = (pos: "bottom" | "right", collapsed: boolean) =>
      pos === "bottom"
        ? (collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />)
        : (collapsed ? <ChevronLeft size={15} /> : <ChevronRight size={15} />);

    // The main panel: a tab bar switching between Filters and (when present and
    // not popped out) Compare. Collapses to its tab strip.
    const mainDockNode = (): ReactNode => {
      const collapsed = state.filterCollapsed;
      const pos = state.panelPos;
      const chevron = foldChevron(pos, collapsed);

      // Right-docked + collapsed: a thin vertical strip labelled with the active tab.
      if (collapsed && pos === "right") {
        return (
          <div className="dock dock-right collapsed panel-dock">
            <div className="dock-head" onClick={toggleFilterCollapsed} title="Expand  (Ctrl+B)">
              <span className="dock-chevron">{chevron}</span>
              <span className="dock-title">{activePanelTab === "compare" ? `Compare · ${compareRows.length}` : "Filters"}</span>
            </div>
          </div>
        );
      }

      return (
        <div className={"dock dock-" + pos + (collapsed ? " collapsed" : "") + " panel-dock"}>
          <div className="dock-head tabbed">
            <div className="panel-tabs">
              <button className={"ptab" + (activePanelTab === "filters" ? " active" : "")} onClick={() => selectPanelTab("filters")}>
                Filters
              </button>
              {compareTabAvailable && (
                <button className={"ptab" + (activePanelTab === "compare" ? " active" : "")} onClick={() => selectPanelTab("compare")}>
                  Compare<span className="ptab-badge">{compareRows.length}</span>
                </button>
              )}
            </div>
            <div className="dock-spacer" />
            {activePanelTab === "compare" && (
              <>
                <button className="dock-btn" title="Clear comparison" onClick={clearCompare}><X size={14} /></button>
                <button className="dock-btn" title="Pop out beside Filters" onClick={popCompareOut}><PanelRightOpen size={14} /></button>
              </>
            )}
            <button className="dock-btn" title={pos === "bottom" ? "Dock right" : "Dock bottom"} onClick={() => setFilterPos(pos === "bottom" ? "right" : "bottom")}>
              {pos === "bottom" ? <PanelRight size={14} /> : <PanelBottom size={14} />}
            </button>
            <button className="dock-btn" title={(collapsed ? "Expand" : "Collapse") + "  (Ctrl+B)"} onClick={toggleFilterCollapsed}>{chevron}</button>
          </div>
          {!collapsed && (
            <div className="dock-body">{activePanelTab === "filters" ? filterBody : compareBody}</div>
          )}
        </div>
      );
    };

    // The popped-out Compare dock (its own resizable pane beside the main panel).
    // Popped Compare always docks on the side opposite the main panel, so the
    // two never sit on the same edge.
    const comparePoppedPos: "bottom" | "right" = state.panelPos === "bottom" ? "right" : "bottom";
    const compareDockNode = (): ReactNode => {
      const collapsed = state.compareCollapsed;
      const pos = comparePoppedPos;
      const chevron = foldChevron(pos, collapsed);
      return (
        <div className={"dock dock-" + pos + (collapsed ? " collapsed" : "")}>
          <div className="dock-head" onClick={toggleCompareCollapsed} title={collapsed ? "Expand" : "Collapse"}>
            <span className="dock-chevron">{chevron}</span>
            <span className="dock-title">{`Compare · ${compareRows.length}`}</span>
            <div className="dock-spacer" />
            {!collapsed && (
              <>
                <button className="dock-btn" title="Clear comparison" onClick={(e) => { e.stopPropagation(); clearCompare(); }}><X size={14} /></button>
                <button className="dock-btn" title="Dock back into panel" onClick={(e) => { e.stopPropagation(); dockCompareBack(); }}><PanelBottomClose size={14} /></button>
              </>
            )}
          </div>
          {!collapsed && <div className="dock-body">{compareBody}</div>}
        </div>
      );
    };

    type PanelDesc = { id: string; node: ReactNode; collapsible?: boolean; collapsed?: boolean; collapsedSize?: string; ref?: React.RefObject<PanelImperativeHandle | null> };
    const buildGroup = (orientation: "vertical" | "horizontal", gid: string, panels: PanelDesc[]): ReactNode => {
      const ids = panels.map((p) => p.id);
      // Remount the group when its panel set changes — the library can't have a
      // Panel inserted into / removed from a live group ("constraints not found").
      const groupKey = gid + ":" + ids.join(",");
      const dl = layoutFor(groupKey, ids);
      return (
        <ResizablePanelGroup key={groupKey} orientation={orientation} className="main" id={groupKey} defaultLayout={dl} onLayoutChanged={onLayoutFor(groupKey)}>
          {panels.map((p, i) => {
            const cs = p.collapsedSize ?? "26px";
            return (
              <Fragment key={p.id}>
                <ResizablePanel
                  id={p.id}
                  defaultSize={p.collapsed ? cs : `${dl[p.id]}%`}
                  // A collapsed dock is pinned to the strip height (min == max) so
                  // neither dragging nor a sibling's collapse can grow it back.
                  minSize={p.collapsed ? cs : (p.collapsible ? "8%" : "15%")}
                  maxSize={p.collapsed ? cs : "100%"}
                  panelRef={p.ref}
                >
                  {p.node}
                </ResizablePanel>
                {i < panels.length - 1 && <ResizableHandle withHandle />}
              </Fragment>
            );
          })}
        </ResizablePanelGroup>
      );
    };

    // The main panel is always present; Compare gets its own dock only when popped.
    const docks = [
      { id: "fp", pos: state.panelPos, ref: fpRef },
      ...(showCompare && state.comparePopped ? [{ id: "cmp", pos: comparePoppedPos, ref: cmpRef }] : []),
    ];
    // Keep array order (main panel before the popped compare dock).
    const side = (s: "bottom" | "right") => docks.filter((d) => d.pos === s);
    const bottomDocks = side("bottom");
    const rightDocks = side("right");
    const dockPanel = (d: { id: string; ref: React.RefObject<PanelImperativeHandle | null> }): PanelDesc =>
      ({
        id: d.id, node: d.id === "fp" ? mainDockNode() : compareDockNode(), collapsible: true, ref: d.ref,
        collapsed: d.id === "fp" ? state.filterCollapsed : state.compareCollapsed,
        collapsedSize: d.id === "fp" ? MAIN_COLLAPSED : CMP_COLLAPSED,
      });

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
            {(["File", "Edit", "View", "Filters", "Help"] as const).map((m) => (
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
          <MenuPopup
            items={menuDefs[openMenu.name]}
            x={openMenu.x}
            y={openMenu.y + 2}
            onClose={() => setOpenMenu(null)}
          />
        )}

        {/* go-to-line dialog */}
        {gotoOpen && (
          <div className="goto-overlay" onMouseDown={() => setGotoOpen(false)}>
            <div className="goto-box" onMouseDown={(e) => e.stopPropagation()}>
              <div className="goto-title">Go to line</div>
              <input
                ref={gotoInputRef}
                className="goto-input"
                type="number"
                min={1}
                placeholder="Line number…"
                value={gotoVal}
                onChange={(e) => setGotoVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); submitGoto(); }
                  if (e.key === "Escape") setGotoOpen(false);
                }}
              />
              <div className="goto-actions">
                <Button variant="ghost" onClick={() => setGotoOpen(false)}>Cancel</Button>
                <Button onClick={submitGoto}>Go</Button>
              </div>
            </div>
          </div>
        )}

        {/* about dialog */}
        {aboutOpen && <AboutModal version={appVersion} onClose={() => setAboutOpen(false)} />}

        <Toaster />
      </div>
    </TooltipProvider>
  );
}
