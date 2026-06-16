import { useState, useMemo, useEffect, useCallback, useReducer, useRef, useTransition, Fragment, CSSProperties, ReactNode } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Eraser, FolderOpen, Minus, PanelBottom, PanelBottomClose, PanelRightClose, PanelLeftOpen, PanelRight, PanelTopOpen, Square, Upload, X } from "lucide-react";
import { tinykeys } from "tinykeys";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { save, open, confirm } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import type { AppState, LogFile, FilterSet, FilterGroup, Filter, FilterLayout, MarkerIcon, TimelineSource } from "./types";
import {
  uid, makeFilter, filterFromTatAttrs, initialState, normalizeState, DEFAULT_PALETTE,
} from "./data";
import type { PaletteEntry } from "./types";

// Open accepts native Logsy JSON plus TextAnalysisTool.NET (.tat/.xml) for import;
// Save always writes Logsy JSON, so it only offers .json.
const OPEN_DIALOG_FILTERS = [
  { name: "Filter files", extensions: ["json", "tat", "xml"] },
  { name: "Logsy filters", extensions: ["json"] },
  { name: "TextAnalysisTool.NET", extensions: ["tat", "xml"] },
];
const SAVE_DIALOG_FILTERS = [{ name: "Logsy filters", extensions: ["json"] }];

/**
 * Parse a TextAnalysisTool.NET (.tat) filter file so users of that tool can
 * import their filters here. Returns null when the text isn't a TAT document.
 */
function parseTatFilters(
  text: string
): { filters: Filter[]; groups: FilterGroup[]; order: string[]; sources: TimelineSource[] } | null {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) return null;
  if (doc.documentElement?.tagName !== "TextAnalysisTool.NET") return null;
  const attrs = ["text", "description", "enabled", "excluding", "case_sensitive", "regex", "foreColor", "backColor"];
  const filters = Array.from(doc.getElementsByTagName("filter")).map((el) =>
    filterFromTatAttrs(Object.fromEntries(attrs.map((k) => [k, el.getAttribute(k)])))
  );
  return { filters, groups: [], order: filters.map((f) => f.id), sources: [] };
}

import { buildGroupFromImport, exportPayload } from "./filterFile";
import { compileAll, computeView, buildTimeline, laneColor, guessUnit, isTimeLike } from "./logic";
import { tokenize, buildPattern } from "./lib/generalize";
import { Sidebar } from "./components/Sidebar";
import { LogView } from "./components/LogView";
import { FilterPanel } from "./components/FilterPanel";
import { EditModal } from "./components/EditModal";
import { PaletteModal } from "./components/PaletteModal";
import { CompareTable } from "./components/CompareTable";
import { BookmarksPanel } from "./components/BookmarksPanel";
import { TimelinePanel } from "./components/TimelinePanel";
import { MenuPopup, type MenuItem } from "./components/MenuPopup";
import { AboutModal } from "./components/AboutModal";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { Button } from "./components/ui/button";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./components/ui/resizable";

const STATE_KEY = "logsy.state.v6";
const MENUS = ["File", "Edit", "View", "Filters", "Help"] as const;
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

// Yield a paint so a just-set loading overlay actually renders before a heavy
// synchronous step (splitting a large file into lines) blocks the main thread.
function nextPaint(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

export function App() {
  const [state, setState] = useState<AppState>(loadState);
  const [editing, setEditing] = useState<{ isNew: boolean; filter: Filter; genSeed?: string } | null>(null);
  // A request to scroll+flash a filter row (e.g. clicking a Compare group header).
  // The bumping nonce re-triggers the flash even when the same id is re-requested.
  const [filterFlash, setFilterFlash] = useState<{ id: string; nonce: number } | null>(null);
  const fpRef = useRef<PanelImperativeHandle | null>(null);
  const popRef = useRef<PanelImperativeHandle | null>(null);
  const [openMenu, setOpenMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  // Bumped whenever a file's lines land in `linesStore`, to re-derive `lines`.
  const [linesVersion, setLinesVersion] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  // Marks a non-urgent file switch so React can show an overlay while computing
  // the new view rather than silently freezing for large files.
  const [isSwitchingFile, startFileSwitchTransition] = useTransition();
  // Same idea for switching the dock tab to Filters or switching filter sets:
  // mounting/rendering a large filter list is a long task that would block the
  // click's paint (high INP). Deferring it keeps the interaction responsive;
  // isPanelPending dims the panel body as feedback while it renders.
  const [isPanelPending, startPanelTransition] = useTransition();
  // When set, the center shows a blank "open a file" drop screen instead of the
  // active workspace (triggered by the sidebar's Open File button).
  const [openScreen, setOpenScreen] = useState(false);
  const openScreenRef = useRef(false);
  openScreenRef.current = openScreen;
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // When set, a log file is being read from disk — drives the loading overlay.
  const [busy, setBusy] = useState<{ name: string } | null>(null);
  const [appVersion, setAppVersion] = useState("0.2.1");
  // Go-to-line dialog + signals pushed to LogView for menu-driven actions.
  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoVal, setGotoVal] = useState("");
  const [selectAllNonce, setSelectAllNonce] = useState(0);
  const [gotoSignal, setGotoSignal] = useState<{ n: number; nonce: number } | null>(null);
  // Pushed to LogView to scroll/select a bookmarked line from the Bookmarks tab.
  const [markerJump, setMarkerJump] = useState<{ n: number; nonce: number } | null>(null);
  const gotoInputRef = useRef<HTMLInputElement>(null);
  // "View this filter only" — ephemeral focus on a single filter's matches.
  const [soloFilterId, setSoloFilterId] = useState<string | null>(null);

  useEffect(() => { getVersion().then(setAppVersion).catch(() => { /* not under Tauri */ }); }, []);

  // Persist on a short debounce — serializing the whole state synchronously on
  // every edit added a fixed cost to each action on large filter sets. The
  // unload flush (below, after stateRef) covers the trailing edits.
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
    }, 300);
    return () => clearTimeout(t);
  }, [state]);

  const file = state.files.find((f) => f.id === state.activeFileId) ?? state.files[0] ?? null;
  const set = file ? (file.sets.find((g) => g.id === file.activeSetId) ?? file.sets[0]) : null;
  // Log-view header state is per-document (stored on the active LogFile).
  const findOpen = file?.findOpen ?? false;
  const fileViewMode: "all" | "matches" = file?.viewMode ?? "all";

  // Switching filter sets (or files) exits "view this filter only".
  useEffect(() => { setSoloFilterId(null); }, [file?.activeSetId, file?.id]);

  const lines = useMemo(
    () => (file ? linesStore[file.id] ?? EMPTY_LINES : EMPTY_LINES),
    [file?.id, linesVersion]
  );
  const compiled = useMemo(() => compileAll(set?.filters ?? []), [set?.filters]);
  const view = useMemo(() => computeView(lines, compiled), [lines, compiled]);
  // Timeline tracks: a user-owned, ordered list (no auto-derivation).
  const tracks = useMemo(() => set?.sources ?? [], [set?.sources]);
  // Lines the user added to the timeline. Persisted per file (survives reload),
  // keyed by file id so a file switch naturally shows that file's own set.
  const timelineLines = useMemo(
    () => new Set(file ? state.timelineLinesByFile?.[file.id] ?? [] : []),
    [state.timelineLinesByFile, file],
  );
  // Lines explicitly added to the comparison panel. Persisted per file (survives
  // reload / document switch / filter switch), keyed by file id like the timeline.
  const compareLines = useMemo(
    () => new Set(file ? state.compareLinesByFile?.[file.id] ?? [] : []),
    [state.compareLinesByFile, file],
  );
  // Events come from the lines the user added to the timeline (like compare).
  const marks = useMemo(
    () => buildTimeline(view, timelineLines, tracks),
    [view, timelineLines, tracks],
  );
  // Field names per filter that may back a timeline TIME field. A field qualifies
  // if its declared type is numeric (int/hex/float/time) OR a sampled matched
  // value looks time-like (covers string-typed groups that actually hold numbers).
  // One O(rows) pass collects a few sample lines per provider filter that has any
  // string-typed field; recomputed when the view or filters change.
  const timeFieldsByFilter = useMemo(() => {
    const result = new Map<string, Set<string>>();
    const providers = (set?.filters ?? []).filter((f) => f.fields && f.fields.length);
    if (!providers.length) return result;
    const NUMERIC: Record<string, boolean> = { int: true, hex: true, float: true, time: true };
    const needsSample = new Set<string>();
    for (const f of providers) {
      result.set(f.id, new Set(f.fields!.filter((d) => NUMERIC[d.type]).map((d) => d.name)));
      if (f.fields!.some((d) => !NUMERIC[d.type])) needsSample.add(f.id);
    }
    if (needsSample.size) {
      const SAMPLE = 20;
      const sampleLines = new Map<string, number[]>();
      for (const fid of needsSample) sampleLines.set(fid, []);
      for (let n = 1; n <= view.rows.length; n++) {
        const fid = view.rows[n - 1]?.fieldsFromId;
        if (!fid || !needsSample.has(fid)) continue;
        const arr = sampleLines.get(fid)!;
        if (arr.length < SAMPLE) arr.push(n);
      }
      for (const fid of needsSample) {
        const have = result.get(fid)!;
        const strFields = providers.find((p) => p.id === fid)!.fields!.filter((d) => !NUMERIC[d.type]);
        for (const n of sampleLines.get(fid)!) {
          const fl = view.fieldsFor(n);
          if (!fl) continue;
          for (const d of strFields) {
            if (have.has(d.name)) continue;
            const v = fl[d.name]?.raw;
            if (v !== undefined && isTimeLike(v)) have.add(d.name);
          }
        }
      }
    }
    return result;
  }, [view, set]);
  // Soloing a filter ("View this filter only"): the log shows just that filter's
  // matches (forced enabled, never excluding), while the filter panel keeps its
  // badge counts from the full `view`. Ephemeral — not persisted, not undoable.
  const soloFilter = soloFilterId ? set?.filters.find((f) => f.id === soloFilterId) ?? null : null;
  const soloView = useMemo(() => {
    if (!soloFilterId) return null;
    const c = compiled.find((x) => x.f.id === soloFilterId);
    if (!c || !c.re || !c.ok) return null;
    return computeView(lines, [{ ...c, f: { ...c.f, enabled: true, exclude: false } }]);
  }, [soloFilterId, compiled, lines]);
  const logView = soloView ?? view;
  const effectiveViewMode: "all" | "matches" = soloView ? "matches" : fileViewMode;
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

  // Flush the debounced persist when the window goes away (reload / close), so
  // edits made within the debounce window aren't lost.
  useEffect(() => {
    const flush = () => {
      try { localStorage.setItem(STATE_KEY, JSON.stringify(stateRef.current)); } catch { /* ignore */ }
    };
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

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
  // The active file resolved from a state snapshot (mirrors the render-time
  // `file` derivation) — for patches that must not close over a stale `file`.
  function activeFile(s: AppState): LogFile | null {
    return s.files.find((f) => f.id === s.activeFileId) ?? s.files[0] ?? null;
  }
  function withSet(s: AppState, fid: string, gid: string): FilterSet {
    return withFile(s, fid).sets.find((g) => g.id === gid)!;
  }

  // ---------- files ----------
  const selectFile = (fid: string) => {
    setOpenScreen(false);
    startFileSwitchTransition(() => setState((s) => ({ ...s, activeFileId: fid })));
  };

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
      const cg = cf ? (cf.sets.find((g) => g.id === cf.activeSetId) ?? cf.sets[0]) : null;
      return cg ?? null;
    })();
    const makeSets = (): FilterSet[] =>
      inherited
        ? [{ ...(JSON.parse(JSON.stringify(inherited)) as FilterSet), id: uid("g") }]
        : [{ id: uid("g"), name: "Filters", filters: [], groups: [], order: [] }];
    try {
    for (const path of paths) {
      let text: string;
      let encoding: string;
      setBusy({ name: baseName(path) });
      await nextPaint();   // let the overlay paint before the read/split blocks
      try {
        const res = await invoke<{ text: string; encoding: string }>("read_text_file", { path });
        text = res.text;
        encoding = res.encoding;
      } catch (e) {
        lastErr = `${baseName(path)} — ${String(e)}`;
        continue;
      }
      pushRecent("recentFiles", path);
      await nextPaint();   // yield again so the overlay stays visible before the synchronous line-split
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
          encoding,
          sets: makeSets(),
          activeSetId: null,
        };
        f.activeSetId = f.sets[0].id;
        s.files.push(f);
        s.activeFileId = f.id;
      }, { undoable: false });
    }
    } finally {
      setBusy(null);
    }
    setLinesVersion((v) => v + 1);
    if (lastErr) toast.error("Could not open file: " + lastErr);
  }, [patchState, pushRecent]);

  const openFiles = useCallback(async () => {
    const sel = await open({ multiple: true });
    if (sel == null) return;
    await loadPaths(Array.isArray(sel) ? sel : [sel]);
    setOpenScreen(false); // a file is now active — leave the open screen
  }, [loadPaths]);

  // Replace the active file's contents in place (same workspace slot, keeping its
  // filters/groups) with a file from disk — used by drag-and-drop so a dropped
  // log loads into the current workspace instead of spawning a new file entry.
  const replaceActiveFile = useCallback(async (path: string) => {
    const cur = stateRef.current;
    const active = cur.files.find((f) => f.id === cur.activeFileId) ?? cur.files[0] ?? null;
    if (!active) { await loadPaths([path]); return; }
    let text: string;
    let encoding: string;
    setBusy({ name: baseName(path) });
    await nextPaint();   // let the overlay paint before the read/split blocks
    try {
      const res = await invoke<{ text: string; encoding: string }>("read_text_file", { path });
      text = res.text;
      encoding = res.encoding;
    }
    catch (e) { setBusy(null); toast.error("Could not open file: " + baseName(path) + " — " + String(e)); return; }
    const lns = splitLines(text);
    linesStore[active.id] = lns;
    patchState((s) => {
      const f = s.files.find((x) => x.id === active.id);
      if (!f) return;
      f.path = path;
      f.name = baseName(path);
      f.lineCount = lns.length;
      f.encoding = encoding;
      s.activeFileId = f.id;
    }, { undoable: false });
    pushRecent("recentFiles", path);
    // The slot keeps its file id but gets new contents, so its old line numbers
    // are stale — drop this file's compare lines (timeline does the same on reload).
    setState((s) => ({ ...s, compareLinesByFile: { ...(s.compareLinesByFile ?? {}), [active.id]: [] } }));
    setLinesVersion((v) => v + 1);
    setBusy(null);
  }, [loadPaths, patchState, pushRecent]);

  // On restart the persisted file list has paths but no cached lines; reload the
  // active file's contents from disk when they're missing.
  useEffect(() => {
    if (!file || !file.path || linesStore[file.id]) return;
    const { id, path, name } = file;
    let cancelled = false;
    (async () => {
      try {
        const res = await invoke<{ text: string; encoding: string }>("read_text_file", { path });
        if (cancelled) return;
        linesStore[id] = splitLines(res.text);
        patchState((s) => { const f = s.files.find((x) => x.id === id); if (f) f.encoding = res.encoding; }, { undoable: false });
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
          // Only show the drop overlay for genuine file drags (which carry
          // `paths`). In-webview drags — e.g. dragging to select log text — also
          // emit enter/over events but with no paths, and must be ignored.
          const hasFiles = "paths" in p && Array.isArray(p.paths) && p.paths.length > 0;
          if (p.type === "enter" || p.type === "over") { if (hasFiles) setDragOver(true); }
          else if (p.type === "drop") {
            setDragOver(false);
            if (!p.paths.length) return;
            const paths = p.paths;
            void (async () => {
              // Dropped onto the "open a file" screen: always open as new files.
              if (openScreenRef.current) {
                await loadPathsRef.current(paths);
                setOpenScreen(false);
                return;
              }
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
  const switchSet = (gid: string) => startPanelTransition(() => patchState((s) => { if (!file) return; withFile(s, file.id).activeSetId = gid; }, { undoable: false }));
  const addSet = () => patchState((s) => {
    if (!file) return;
    const f = withFile(s, file.id);
    const g: FilterSet = { id: uid("g"), name: "New set", filters: [], groups: [], order: [] };
    f.sets.push(g); f.activeSetId = g.id;
  });
  const renameSet = (gid: string, name: string) => patchState((s) => { if (!file) return; withSet(s, file.id, gid).name = name; });
  const deleteSet = async (gid: string) => {
    if (!file) return;
    const g = file.sets.find((x) => x.id === gid);
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
      f.sets = f.sets.filter((x) => x.id !== gid);
      if (f.activeSetId === gid) f.activeSetId = f.sets[0]?.id ?? null;
    });
  };
  const reorderSets = (from: number, to: number) => patchState((s) => {
    if (!file) return;
    const f = withFile(s, file.id);
    const [m] = f.sets.splice(from, 1);
    f.sets.splice(to, 0, m);
  });
  // Duplicate a whole filter set: deep-copy its groups/filters with fresh ids,
  // remap groupId references and the top-level order, drop the save link, and
  // insert the copy right after the original (then activate it).
  const duplicateSet = (gid: string) => patchState((s) => {
    if (!file) return;
    const f = withFile(s, file.id);
    const idx = f.sets.findIndex((x) => x.id === gid);
    if (idx < 0) return;
    const src = f.sets[idx];
    const groupMap = new Map(src.groups.map((grp) => [grp.id, uid("grp")] as const));
    const filMap = new Map(src.filters.map((fl) => [fl.id, uid("f")] as const));
    const copy: FilterSet = {
      id: uid("g"),
      name: src.name + " copy",
      groups: src.groups.map((grp) => ({ ...grp, id: groupMap.get(grp.id)! })),
      filters: src.filters.map((fl) => ({
        ...fl,
        id: filMap.get(fl.id)!,
        groupId: fl.groupId ? groupMap.get(fl.groupId) ?? null : null,
        fields: fl.fields ? fl.fields.map((x) => ({ ...x })) : undefined,
      })),
      order: src.order.map((id) => groupMap.get(id) ?? filMap.get(id)).filter((x): x is string => !!x),
    };
    f.sets.splice(idx + 1, 0, copy);
    f.activeSetId = copy.id;
  });

  // ---------- groups ----------
  const addGroup = () => patchState((s) => {
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
  const renameGroup = (gid: string, name: string) => patchState((s) => {
    if (!file || !set) return;
    const grp = withSet(s, file.id, set.id).groups.find((x) => x.id === gid);
    if (grp) grp.name = name;
  });
  const toggleGroup = (gid: string) => patchState((s) => {
    if (!file || !set) return;
    const grp = withSet(s, file.id, set.id).groups.find((x) => x.id === gid);
    if (grp) grp.collapsed = !grp.collapsed;
  }, { undoable: false });
  const deleteGroup = (gid: string) => patchState((s) => {
    if (!file || !set) return;
    const g = withSet(s, file.id, set.id);
    g.groups = g.groups.filter((x) => x.id !== gid);
    // Keep the filters — move them back to the ungrouped bucket, taking the
    // group's old top-level slot (so they don't jump elsewhere).
    const freed = g.filters.filter((f) => f.groupId === gid).map((f) => f.id);
    g.filters.forEach((f) => { if (f.groupId === gid) f.groupId = null; });
    const at = g.order.indexOf(gid);
    if (at >= 0) g.order.splice(at, 1, ...freed);
    else g.order.push(...freed);
  });
  // Commit a whole-set drag-and-drop arrangement (built live in FilterPanel) in
  // one undoable step. Rebuild `filters` in visual order — loose rows and each
  // group's rows interleaved per `model.top` — and set every filter's groupId;
  // `order` becomes the new interleaved top-level order.
  const applyLayout = (model: FilterLayout) => patchState((s) => {
    if (!file || !set) return;
    const g = withSet(s, file.id, set.id);
    const byId = new Map(g.filters.map((f) => [f.id, f] as const));
    const next: Filter[] = [];
    for (const entry of model.top) {
      if (entry.kind === "filter") {
        const f = byId.get(entry.id);
        if (f) { f.groupId = null; next.push(f); byId.delete(entry.id); }
      } else {
        for (const fid of model.inGroup[entry.id] ?? []) {
          const f = byId.get(fid);
          if (f) { f.groupId = entry.id; next.push(f); byId.delete(fid); }
        }
      }
    }
    for (const f of byId.values()) next.push(f); // safety: never drop a filter
    g.filters = next;
    g.order = model.top.map((e) => e.id);
  });
  const setGroupEnabled = (gid: string, enabled: boolean) => patchState((s) => {
    if (!file || !set) return;
    withSet(s, file.id, set.id).filters.forEach((f) => { if (f.groupId === gid) f.enabled = enabled; });
  });

  // ---------- palette ----------
  const effectivePalette: PaletteEntry[] = state.customPalette ?? DEFAULT_PALETTE;
  const [paletteModalOpen, setPaletteModalOpen] = useState(false);

  const applyPalette = (palette: PaletteEntry[]) =>
    setState((s) => ({ ...s, customPalette: palette }));

  // ---------- filters ----------
  const updateFilter = (fid: string, patch: Partial<Filter>) => patchState((s) => {
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
  const duplicateFilter = (fid: string) => patchState((s) => {
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
  const openFilterFromPattern = (text: string, mode: "exact" | "pattern" = "exact") => {
    if (!set) return;
    if (mode === "pattern") {
      // Filters match single lines; a multi-line selection seeds from its
      // first non-empty line. genSeed drives the chips UI in EditModal.
      const seed = text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? text;
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
      if (idx >= 0) g.filters[idx] = draft; else g.filters.push(draft);
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
      patchState((s) => {
        if (!file || !set) return;
        const g = withSet(s, file.id, set.id);
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

  // Load a filter file from a known path into the current set (replacing its
  // contents). Confirms first when the set isn't empty. Used by both the
  // "Load Filters" dialog and the Recent Filter Files menu.
  const loadFilterFromPath = async (path: string) => {
    if (!file || !set) return;
    if (set.filters.length > 0) {
      const ok = await confirm(
        "Loading will replace every filter and group in the current set. This can't be undone.",
        { title: "Replace current filters?", kind: "warning", okLabel: "Replace", cancelLabel: "Cancel" }
      );
      if (!ok) return;
    }
    let text: string;
    // read_text_file returns { text, encoding } — pull the text out (passing the
    // whole object to JSON.parse below would silently fail the load).
    try { text = (await invoke<{ text: string; encoding: string }>("read_text_file", { path })).text; }
    catch (e) { toast.error("Could not read file: " + String(e)); return; }
    let built: ReturnType<typeof buildGroupFromImport> = null;
    let foreign = false; // a TAT import isn't a Logsy file, so don't make it the save target
    try { built = buildGroupFromImport(JSON.parse(text)); } catch { /* not JSON — try TAT below */ }
    if (!built) { built = parseTatFilters(text); foreign = !!built; } // TextAnalysisTool.NET (.tat)
    if (!built) { toast.error("That file isn't Logsy or TextAnalysisTool.NET filters."); return; }
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

  // ---------- bulk ----------
  const bulk = (action: string) => {
    if (action === "enableAll")   patchState((s) => { if (file && set) withSet(s, file.id, set.id).filters.forEach((f) => (f.enabled = true)); });
    else if (action === "disableAll") patchState((s) => { if (file && set) withSet(s, file.id, set.id).filters.forEach((f) => (f.enabled = false)); });
    else if (action === "clear")  patchState((s) => { if (!file || !set) return; const g = withSet(s, file.id, set.id); g.filters = []; g.order = g.order.filter((id) => g.groups.some((grp) => grp.id === id)); });
    else if (action === "save")   void saveFilters();
    else if (action === "saveAs") void saveFiltersAs();
    else if (action === "import") void importFilters();
  };

  // ---------- compare panel ----------
  // Compare lines persist per file (survive reload / document switch / filter
  // switch) but are not on the undo stack, so they go through plain setState into
  // `compareLinesByFile[file.id]` — mirroring the timeline.
  const mutateCompare = (fn: (cur: Set<number>) => void) =>
    setState((s) => {
      const fid = (s.files.find((f) => f.id === s.activeFileId) ?? s.files[0])?.id;
      if (!fid) return s;
      const cur = new Set(s.compareLinesByFile?.[fid] ?? []);
      fn(cur);
      return { ...s, compareLinesByFile: { ...(s.compareLinesByFile ?? {}), [fid]: [...cur] } };
    });
  const addToCompare = (ns: number[]) => {
    mutateCompare((c) => ns.forEach((n) => c.add(n)));
    // Surface the comparison: focus its tab, or expand it if it's popped out.
    setState((s) => s.comparePopped
      ? { ...s, poppedCollapsed: false, poppedActiveTab: "compare" }
      : { ...s, activePanelTab: "compare", filterCollapsed: false });
  };
  const removeFromCompare = (ns: number[]) => mutateCompare((c) => ns.forEach((n) => c.delete(n)));
  const clearCompare = () => mutateCompare((c) => c.clear());
  // Clear just one pattern-table's lines (its Compare group header button).
  const clearCompareGroup = (id: string | undefined) => {
    const ns = compareRows.filter((r) => (r.fieldsFromId ?? "") === (id ?? "")).map((r) => r.n);
    if (ns.length) removeFromCompare(ns);
  };
  // Import every visible line this filter parses into the comparison (its group
  // header button) — the analogue of the timeline track's "import matching lines".
  const importCompareGroup = (id: string | undefined) => {
    const ns = view.rows
      .filter((r) => !r.excluded && r.fieldsFromId !== undefined && (r.fieldsFromId ?? "") === (id ?? ""))
      .map((r) => r.n);
    if (ns.length) addToCompare(ns);
  };
  // Jump from a Compare group header to the filter that produced it: reveal the
  // Filters tab, expand the filter's group if collapsed, then flash its row.
  // selectPanelTab no-ops (no dim transition) when Filters is already the visible
  // main tab — e.g. Compare popped out into its own dock — so clicking a header
  // row no longer flickers the filter panel's disable animation.
  const focusFilter = (id: string) => {
    selectPanelTab("filters");
    const f = set?.filters.find((x) => x.id === id);
    if (f?.groupId) {
      const grp = set?.groups.find((g) => g.id === f.groupId);
      if (grp?.collapsed) toggleGroup(grp.id);
    }
    setFilterFlash({ id, nonce: Date.now() });
  };

  // ---------- bookmarks ----------
  const markers = file?.markers ?? [];
  // Upsert a bookmark on a line (persisted with the file; not on the undo stack).
  const setMarker = (n: number, icon: MarkerIcon, note: string) => patchState((s) => {
    if (!file) return;
    const f = withFile(s, file.id);
    if (!Array.isArray(f.markers)) f.markers = [];
    const m = f.markers.find((x) => x.n === n);
    if (m) { m.icon = icon; m.note = note; }
    else f.markers.push({ n, icon, note });
    f.markers.sort((a, b) => a.n - b.n);
  }, { undoable: false });
  const removeMarker = (n: number) => patchState((s) => {
    if (!file) return;
    const f = withFile(s, file.id);
    if (Array.isArray(f.markers)) f.markers = f.markers.filter((m) => m.n !== n);
  }, { undoable: false });
  const clearMarkers = () => patchState((s) => {
    if (!file) return;
    withFile(s, file.id).markers = [];
  }, { undoable: false });
  // Jump to a bookmark from the Bookmarks tab. Bookmarks only render in "Show
  // all"; if the target line is hidden *because* of matches-only mode (not
  // excluded, just unmatched), switch to all first so the jump lands on it.
  const jumpToMarker = (n: number) => {
    const row = view.rows.find((r) => r.n === n);
    if (fileViewMode === "matches" && view.hasHighlights && row && !row.excluded && !row.winner) {
      setViewMode("all");
    }
    setMarkerJump({ n, nonce: Date.now() });
  };

  // ---------- timeline ----------
  // Added lines persist per file (survive reload) but are not on the undo stack,
  // so they go through plain setState into `timelineLinesByFile[file.id]`.
  const mutateTimeline = (fn: (cur: Set<number>) => void) =>
    setState((s) => {
      const fid = (s.files.find((f) => f.id === s.activeFileId) ?? s.files[0])?.id;
      if (!fid) return s;
      const cur = new Set(s.timelineLinesByFile?.[fid] ?? []);
      fn(cur);
      return { ...s, timelineLinesByFile: { ...(s.timelineLinesByFile ?? {}), [fid]: [...cur] } };
    });
  const addToTimeline = (ns: number[]) => mutateTimeline((c) => ns.forEach((n) => c.add(n)));
  const removeFromTimeline = (ns: number[]) => mutateTimeline((c) => ns.forEach((n) => c.delete(n)));
  // Global clear: drop every line from the timeline (tracks stay). Mirrors
  // `clearCompare` — the panel's dock-head "Clear" action.
  const clearTimeline = () => mutateTimeline((c) => c.clear());
  // Tracks are a document edit → undoable; persisted on the set, keyed by id.
  const setTrack = (tr: TimelineSource) => patchState((s) => {
    if (!file || !set) return;
    const g = withSet(s, file.id, set.id);
    const list = [...(g.sources ?? [])];
    const i = list.findIndex((x) => x.id === tr.id);
    if (i >= 0) list[i] = tr; else list.push(tr);
    g.sources = list;
  });
  // All visible lines for which `filterId` is the first-match winner AND that
  // expose `timeField` — exactly the lines that will produce a mark on this track.
  const winnerLines = (filterId: string, timeField: string): number[] => {
    const out: number[] = [];
    for (let n = 1; n <= view.rows.length; n++) {
      if (view.rows[n - 1]?.fieldsFromId !== filterId) continue;
      if (view.fieldsFor(n)?.[timeField]) out.push(n);
    }
    return out;
  };
  // A fresh TimelineSource for (filter, field). `order` = the filter's serial
  // (lane label, e.g. "#3:ts"); `colorIdx` = position in the track list (palette).
  // `sample` lets the default unit be inferred from a real value's shape.
  const buildTrack = (filterId: string, timeField: string, order: number, colorIdx: number, sample?: string): TimelineSource => ({
    id: "tlt_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    filterId, timeField, lane: `#${order + 1}:${timeField}`,
    kind: "point", unit: guessUnit(timeField, sample), color: laneColor(colorIdx),
  });
  // Append a new track bound to a (filter, field). Creating a track only defines
  // *what* to plot; it does NOT pull lines in (that would conflate "define a
  // measure" with "load data" and could flood the canvas). The track row carries
  // an explicit "import matching lines" button instead (onImportTrackLines).
  const addTrack = (filterId: string, timeField: string) => {
    if (!file || !set) return;
    // A track's identity is (filter, time field); adding the same pair again is a
    // no-op, so tell the user why nothing happened instead of failing silently.
    if ((set.sources ?? []).some((x) => x.filterId === filterId && x.timeField === timeField)) {
      const idx = set.filters.findIndex((f) => f.id === filterId);
      toast(`Track already exists`, {
        description: `Filter ${idx >= 0 ? `#${idx + 1}` : ""} already plots "${timeField}".`,
        position: "bottom-right",
      });
      return;
    }
    // Sample the field's first matched value so the default unit can be inferred
    // from its shape (a plain number ⇒ seconds), not just the field name.
    const lines = winnerLines(filterId, timeField);
    const sample = lines.length ? view.fieldsFor(lines[0])?.[timeField]?.raw : undefined;
    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      const list = [...(g.sources ?? [])];
      // Track identity is (filterId, timeField); don't add a duplicate.
      if (list.some((x) => x.filterId === filterId && x.timeField === timeField)) return;
      const idx = g.filters.findIndex((f) => f.id === filterId);
      list.push(buildTrack(filterId, timeField, idx, list.length, sample));
      g.sources = list;
    });
  };
  // Track row "import matching lines": pull just this track's winner lines onto the
  // timeline (explicit, per-track — the affordance lives next to the track).
  const importTrackLines = (tr: TimelineSource) => {
    const lines = winnerLines(tr.filterId, tr.timeField);
    if (lines.length) {
      addToTimeline(lines);
      // toast.success(`${lines.length} line${lines.length === 1 ? "" : "s"} imported`, {
      //   description: `For track "${tr.lane}".`, position: "bottom-right",
      // });
    } else {
      toast(`No matching lines`, { description: `Nothing matches "${tr.lane}" yet.`, position: "bottom-right" });
    }
  };
  // Track row "clear lines": remove just this track's matching lines.
  const clearTrackLines = (tr: TimelineSource) => {
    const lines = winnerLines(tr.filterId, tr.timeField);
    if (lines.length) removeFromTimeline(lines);
  };
  // Per-track stats for the row import/clear buttons and the per-row count badge:
  // how many lines the track matches, and how many of those are on the timeline.
  const trackLineStats = useMemo(() => {
    const m = new Map<string, { matching: number; inTl: number }>();
    for (const tr of tracks) {
      const lines = winnerLines(tr.filterId, tr.timeField);
      let inTl = 0;
      for (const n of lines) if (timelineLines.has(n)) inTl++;
      m.set(tr.id, { matching: lines.length, inTl });
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, view, timelineLines]);
  // Orphan lines: on the timeline but producing no mark (their first-match filter
  // has no track, or the track's field is absent) — the "added but nothing shows"
  // case. Surfaced as a bounded hint in the timeline panel.
  const orphanLines = useMemo(() => {
    const plotted = new Set(marks.map((mk) => mk.lineN));
    return [...timelineLines].filter((n) => !plotted.has(n)).sort((a, b) => a - b);
  }, [marks, timelineLines]);
  // LogView "Add to timeline": add the lines, then bridge the common dead-end —
  // if any added line's first-match filter has no track yet, create one so the
  // events actually show. Line-first, so no autofill. A multi-filter selection is
  // batched into ONE undoable patch + one toast so it never spawns overlapping
  // prompts (one per filter, deduped).
  const addLinesToTimeline = (ns: number[]) => {
    addToTimeline(ns);
    if (!file || !set) return;
    const existing = new Set((set.sources ?? []).map((x) => x.filterId));
    const specs: { fid: string; fld: string }[] = [];
    const seen = new Set<string>();
    for (const n of ns) {
      const fid = view.rows[n - 1]?.fieldsFromId;
      if (!fid || existing.has(fid) || seen.has(fid)) continue;
      seen.add(fid);
      const f = set.filters.find((x) => x.id === fid);
      const allow = timeFieldsByFilter.get(fid);
      // First numeric/time-like field, in filter order.
      const fld = f?.fields?.find((d) => allow?.has(d.name))?.name;
      if (f && fld) specs.push({ fid, fld });
    }
    if (specs.length === 0) return;
    patchState((s) => {
      if (!file || !set) return;
      const g = withSet(s, file.id, set.id);
      const list = [...(g.sources ?? [])];
      for (const { fid, fld } of specs) {
        if (list.some((x) => x.filterId === fid && x.timeField === fld)) continue;
        const idx = g.filters.findIndex((f) => f.id === fid);
        list.push(buildTrack(fid, fld, idx, list.length));
      }
      g.sources = list;
    });
    selectPanelTab("timeline");
    const serials = specs.map((x) => `#${set.filters.findIndex((f) => f.id === x.fid) + 1}`).join(", ");
    toast.success(specs.length > 1 ? `${specs.length} tracks added` : `Track added`, {
      description: `For filter${specs.length > 1 ? "s" : ""} ${serials}.`,
      position: "bottom-right",
    });
  };
  // "Add all matching lines" (timeline panel, when tracks exist but no lines yet):
  // pull every visible track's matching lines onto the timeline in one go.
  const addAllMatchingLines = () => {
    if (!set) return;
    const all = new Set<number>();
    for (const tr of set.sources ?? []) {
      if (tr.hidden) continue;
      for (const n of winnerLines(tr.filterId, tr.timeField)) all.add(n);
    }
    if (all.size) addToTimeline([...all]);
  };
  const removeTrack = (id: string) => patchState((s) => {
    if (!file || !set) return;
    const g = withSet(s, file.id, set.id);
    g.sources = (g.sources ?? []).filter((x) => x.id !== id);
  });
  const reorderTracks = (ids: string[]) => patchState((s) => {
    if (!file || !set) return;
    const g = withSet(s, file.id, set.id);
    const by = new Map((g.sources ?? []).map((x) => [x.id, x]));
    g.sources = ids.map((id) => by.get(id)!).filter(Boolean);
  });

  // Build CSV text for a single pattern-set's rows.
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
  const togglePoppedCollapsed = () => setState((s) => ({ ...s, poppedCollapsed: !s.poppedCollapsed }));
  // Which tab the main dock actually shows, resolved the same way the render does
  // (a popped-out Compare/Timeline falls back to Filters). Used to skip a no-op
  // tab switch so we don't start a panel transition (the dim animation) when the
  // target tab is already the visible one.
  const resolveActiveTab = (s: AppState): "filters" | "compare" | "bookmarks" | "timeline" =>
    s.activePanelTab === "bookmarks" ? "bookmarks"
      : s.activePanelTab === "timeline" && !s.timelinePopped ? "timeline"
      : s.activePanelTab === "compare" && !s.comparePopped ? "compare"
      : "filters";
  // Select a tab in the main panel (always expands it if it was collapsed). When
  // that tab is already shown expanded, do nothing — re-running the transition
  // would needlessly dim the panel body even though no content re-renders.
  const selectPanelTab = (tab: "filters" | "compare" | "bookmarks" | "timeline") => {
    const s = stateRef.current;
    if (resolveActiveTab(s) === tab && !s.filterCollapsed) return;
    startPanelTransition(() => setState((st) => ({ ...st, activePanelTab: tab, filterCollapsed: false })));
  };
  // Compare and Timeline, when popped, share ONE dock beside Filters. Popping a
  // panel out focuses it as the active tab in that shared dock and expands it;
  // Filters takes over the main tab area if the popped panel was active there.
  const popCompareOut = () => setState((s) => ({
    ...s, comparePopped: true, poppedCollapsed: false, poppedActiveTab: "compare",
    activePanelTab: s.activePanelTab === "compare" ? "filters" : s.activePanelTab,
  }));
  // Merge Compare back into the main panel as a tab, and focus it.
  const dockCompareBack = () => setState((s) => ({
    ...s, comparePopped: false, activePanelTab: "compare", filterCollapsed: false,
    poppedActiveTab: "timeline",
  }));
  const popTimelineOut = () => setState((s) => ({
    ...s, timelinePopped: true, poppedCollapsed: false, poppedActiveTab: "timeline",
    activePanelTab: s.activePanelTab === "timeline" ? "filters" : s.activePanelTab,
  }));
  // Merge Timeline back into the main panel as a tab, and focus it.
  const dockTimelineBack = () => setState((s) => ({
    ...s, timelinePopped: false, activePanelTab: "timeline", filterCollapsed: false,
    poppedActiveTab: "compare",
  }));

  const showCompare = compareRows.length > 0;
  // Compare is a permanent tab (shows an empty-state when it has no rows); it's a
  // main-panel tab unless popped out into the shared dock.
  const compareTabAvailable = !state.comparePopped;
  // Timeline is a tab unless it's popped out into the shared popped dock.
  const timelineTabAvailable = !state.timelinePopped;
  // Compare and Timeline share ONE popped dock. Its tab set is whichever are
  // popped; the active tab is resolved against that set.
  const poppedTabs: ("compare" | "timeline")[] = [
    ...(state.comparePopped ? ["compare" as const] : []),
    ...(state.timelinePopped ? ["timeline" as const] : []),
  ];
  const popOpen = poppedTabs.length > 0;
  const poppedActiveTab: "compare" | "timeline" =
    poppedTabs.includes(state.poppedActiveTab ?? "compare")
      ? (state.poppedActiveTab ?? "compare")
      : (poppedTabs[0] ?? "compare");
  // Bookmarks is always a tab. Compare/Timeline fall back to Filters when unavailable.
  const activePanelTab: "filters" | "compare" | "bookmarks" | "timeline" =
    state.activePanelTab === "bookmarks" ? "bookmarks"
      : state.activePanelTab === "timeline" && timelineTabAvailable ? "timeline"
      : state.activePanelTab === "compare" && compareTabAvailable ? "compare"
      : "filters";

  // Default share (weight) for a panel that has no persisted size yet. Docks
  // open generously so they reveal a useful amount of content.
  const DEFAULT_WEIGHT: Record<string, number> = { lv: 100, center: 100, fp: 82, pop: 120 };
  // Build a set's initial layout from its persisted-size bucket, normalised to 100%.
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
      if (id === "pop" && s.poppedCollapsed) continue;
      bucket[id] = v;
    }
    return { ...s, panelSizes: { ...(s.panelSizes ?? {}), [groupKey]: bucket } };
  });

  // Drive collapse/expand by resizing the panel directly (the library's own
  // collapse() records the pre-collapse size, which our maxSize pin corrupts).
  // Resize only on the actual collapse↔expand transition; the panel's
  // defaultSize handles fresh mounts. Expanded → a generous height.
  // Collapsed strip size — shared by both docks so the popped Compare/Timeline
  // dock collapses to the same tab-bar strip as the Filters/Bookmarks dock.
  const MAIN_COLLAPSED = "34px";
  const POP_COLLAPSED = MAIN_COLLAPSED;
  // The popped dock opens larger than the filter dock — its tables/canvas benefit.
  const EXPAND_FP = "30%";
  const EXPAND_POP = "30%";
  const prevFp = useRef(state.filterCollapsed);
  const prevPop = useRef(state.poppedCollapsed);
  useEffect(() => {
    const p = fpRef.current; if (!p) return;
    if (state.filterCollapsed) p.resize(MAIN_COLLAPSED);
    // Defer expand so the maxSize pin (strip → 100%) settles before resizing.
    else if (prevFp.current) requestAnimationFrame(() => p.resize(EXPAND_FP));
    prevFp.current = state.filterCollapsed;
  }, [state.filterCollapsed]);
  useEffect(() => {
    const p = popRef.current; if (!p) return;
    if (state.poppedCollapsed) p.resize(POP_COLLAPSED);
    else if (prevPop.current) requestAnimationFrame(() => p.resize(EXPAND_POP));
    prevPop.current = state.poppedCollapsed;
  }, [state.poppedCollapsed]);

  // ---------- layout ----------
  // Any explicit view-mode toggle also exits "view this filter only". Both the
  // view mode and the find bar are stored per-document on the active LogFile.
  const setViewMode = (m: "all" | "matches") => {
    setSoloFilterId(null);
    patchState((s) => { const f = activeFile(s); if (f) f.viewMode = m; }, { undoable: false });
  };
  const setFindOpen = (v: boolean | ((prev: boolean) => boolean)) =>
    patchState((s) => {
      const f = activeFile(s);
      if (!f) return;
      f.findOpen = typeof v === "function" ? v(f.findOpen ?? false) : v;
    }, { undoable: false });
  const toggleSidebar = () => setState((s) => ({ ...s, sidebarCollapsed: !s.sidebarCollapsed }));
  const toggleLineNumbers = () => setState((s) => ({ ...s, showLineNumbers: !(s.showLineNumbers ?? true) }));

  const zoomIn    = useCallback(() => setState((s) => ({ ...s, fontSize: Math.min(FONT_MAX, (s.fontSize ?? FONT_DEFAULT) + FONT_STEP) })), []);
  const zoomOut   = useCallback(() => setState((s) => ({ ...s, fontSize: Math.max(FONT_MIN, (s.fontSize ?? FONT_DEFAULT) - FONT_STEP) })), []);
  const zoomReset = useCallback(() => setState((s) => ({ ...s, fontSize: FONT_DEFAULT })), []);

  useEffect(() => {
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      // The timeline owns ctrl+wheel over its own area (axis zoom); don't also
      // font-zoom the log view when the cursor is there.
      if ((e.target as Element | null)?.closest?.(".tlc-outer")) return;
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
  const fontWeight = state.fontWeight ?? 400;
  const showLineNumbers = state.showLineNumbers ?? true;
  const rowH = Math.round(fontSize * 1.5);
  const filterRowH = Math.round(fontSize * 1.58);

  // ---------- keyboard shortcuts ----------
  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    // While a menu is open, Left/Right move to the adjacent top-level menu and
    // Esc closes it (matches native menubar keyboard navigation).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpenMenu(null); return; }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const i = MENUS.indexOf(openMenu.name as typeof MENUS[number]);
      if (i < 0) return;
      const ni = (i + (e.key === "ArrowRight" ? 1 : -1) + MENUS.length) % MENUS.length;
      const el = document.querySelector(`[data-menu="${MENUS[ni]}"]`);
      if (el) { const r = el.getBoundingClientRect(); setOpenMenu({ name: MENUS[ni], x: r.left, y: r.bottom }); }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", onKey); };
  }, [openMenu]);

  useEffect(() => {
    return tinykeys(window, {
      "$mod+o": (e) => { e.preventDefault(); void openFiles(); },
      "$mod+f": (e) => { e.preventDefault(); setFindOpen(true); },
      "$mod+F": (e) => { e.preventDefault(); setFindOpen(true); },
      "$mod+h": (e) => { e.preventDefault(); setViewMode(fileViewMode === "all" ? "matches" : "all"); },
      "$mod+H": (e) => { e.preventDefault(); setViewMode(fileViewMode === "all" ? "matches" : "all"); },
      "$mod+=": (e) => { e.preventDefault(); zoomIn(); },
      "$mod+shift+=": (e) => { e.preventDefault(); zoomIn(); },
      "$mod+-": (e) => { e.preventDefault(); zoomOut(); },
      "$mod+0": (e) => { e.preventDefault(); zoomReset(); },
      "Escape": () => {
        if (shortcutsOpen) setShortcutsOpen(false);
        else if (aboutOpen) setAboutOpen(false);
        else if (findOpen && !editing) setFindOpen(false);
        // Leave the open screen (back to the active file) if there's one to show.
        else if (openScreen && state.files.length > 0) setOpenScreen(false);
      },
    });
  }, [findOpen, editing, openScreen, state.files.length, fileViewMode, zoomIn, zoomOut, zoomReset, shortcutsOpen, aboutOpen]);

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
  const saveFilterDisabled = !set || (!!set.filePath && set.savedSnapshot === exportPayload(set));

  const recentFilesMenu: MenuItem[] = state.recentFiles.length
    ? [
        ...state.recentFiles.map((p, i) => ({ label: `${i + 1}   ${baseName(p)}`, action: () => void loadPaths([p]) })),
        { sep: true as const },
        { label: "Clear Recent Files", action: () => clearRecent("recentFiles") },
      ]
    : [{ label: "No recent files", disabled: true }];

  const recentFilterFilesMenu: MenuItem[] = state.recentFilterFiles.length
    ? [
        ...state.recentFilterFiles.map((p, i) => ({ label: `${i + 1}   ${baseName(p)}`, disabled: !set, action: () => void loadFilterFromPath(p) })),
        { sep: true as const },
        { label: "Clear Recent Filter Files", action: () => clearRecent("recentFilterFiles") },
      ]
    : [{ label: "No recent filter files", disabled: true }];

  const menuDefs: Record<string, MenuItem[]> = {
    File: [
      { label: "Open…", key: "Ctrl O", action: () => void openFiles() },
      { label: "Load Filters…", disabled: !set, action: () => void importFilters() },
      { label: "Save Filter", disabled: saveFilterDisabled, action: () => void saveFilters() },
      { label: "Save Filter As…", disabled: !set, action: () => void saveFiltersAs() },
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
      { label: "Show only filtered lines", checked: fileViewMode === "matches", key: "Ctrl H",
        action: () => setViewMode(fileViewMode === "matches" ? "all" : "matches") },
      { label: "Show line numbers", checked: showLineNumbers, action: toggleLineNumbers },
      { sep: true },
      { label: "Zoom In", key: "Ctrl +", action: zoomIn },
      { label: "Zoom Out", key: "Ctrl −", action: zoomOut },
      { label: `Reset Zoom  (${fontSize}px)`, key: "Ctrl 0", action: zoomReset },
    ],
    Filters: [
      { label: "Add new filter…", disabled: !set, action: () => openNewFilter() },
      { sep: true },
      { label: "Enable all filters", disabled: !set, action: () => bulk("enableAll") },
      { label: "Disable all filters", disabled: !set, action: () => bulk("disableAll") },
      { label: "Remove all filters", disabled: !set, action: () => bulk("clear") },
    ],
    Help: [
      { label: "Keyboard shortcuts", action: () => setShortcutsOpen(true) },
      { label: "Documentation", action: openDocs },
      { label: "About", action: () => setAboutOpen(true) },
    ],
  };

  // Build the resizable workspace: log view + filter/compare docks. Docks dock
  // bottom or right; on the same side compare sits before (above/left-of) filter.
  function renderWorkspace(): ReactNode {
    const logview = (
      <LogView
        key={file!.id}
        file={file!}
        view={logView}
        lines={lines}
        filters={set!.filters}
        viewMode={effectiveViewMode}
        soloPattern={soloView && soloFilter ? (soloFilter.pattern || "untitled filter") : null}
        onExitSolo={() => setSoloFilterId(null)}
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
        timelineLines={timelineLines}
        onAddToTimeline={addLinesToTimeline}
        onRemoveFromTimeline={removeFromTimeline}
        selectAllNonce={selectAllNonce}
        gotoSignal={gotoSignal}
        onExportView={exportFilteredView}
        markers={markers}
        markerJump={markerJump}
        onSetMarker={setMarker}
        onRemoveMarker={removeMarker}
      />
    );

    const filterBody = (
      <FilterPanel
        file={file!}
        set={set!}
        counts={view.counts}
        onSwitchSet={switchSet}
        onAddSet={addSet}
        onRenameSet={renameSet}
        onDeleteSet={deleteSet}
        onDuplicateSet={duplicateSet}
        onReorderSet={reorderSets}
        onAddGroup={addGroup}
        onRenameGroup={renameGroup}
        onToggleGroup={toggleGroup}
        onDeleteGroup={deleteGroup}
        onSetGroupEnabled={setGroupEnabled}
        onUpdateFilter={updateFilter}
        onAddFilter={openNewFilter}
        onDeleteFilter={deleteFilter}
        onDuplicateFilter={duplicateFilter}
        onViewFilterOnly={setSoloFilterId}
        onEditFilter={openEditFilter}
        onAddTimelineTrack={addTrack}
        onApplyLayout={applyLayout}
        onBulk={bulk}
        flashFilterId={filterFlash?.id ?? null}
        flashNonce={filterFlash?.nonce ?? 0}
        onFlashConsumed={() => setFilterFlash(null)}
      />
    );
    const compareBody = (
      <CompareTable
        rows={compareRows}
        rowH={rowH}
        onRemove={(n) => removeFromCompare([n])}
        onExport={exportGroupCsv}
        onClearGroup={clearCompareGroup}
        onImportMatching={importCompareGroup}
        onJump={jumpToMarker}
        onFocusFilter={focusFilter}
        labelFor={(id) => {
          const f = set!.filters.find((x) => x.id === id);
          return (f?.description?.trim() || f?.pattern) ?? "Fields";
        }}
        colorFor={(id) => set!.filters.find((x) => x.id === id)?.textColor ?? "#c2c7cd"}
        indexFor={(id) => set!.filters.findIndex((x) => x.id === id)}
      />
    );
    const bookmarksBody = (
      <BookmarksPanel
        markers={markers}
        lineText={(n) => view.rows[n - 1]?.text ?? ""}
        onJump={jumpToMarker}
        onSetNote={(n, note) => { const m = markers.find((x) => x.n === n); setMarker(n, m?.icon ?? "bookmark", note); }}
        onRemove={removeMarker}
        onClearAll={clearMarkers}
      />
    );

    const timelineBody = (
      <TimelinePanel
        tracks={tracks}
        filters={set?.filters ?? []}
        timeFields={timeFieldsByFilter}
        marks={marks}
        lineCount={timelineLines.size}
        onSetTrack={setTrack}
        onRemoveTrack={removeTrack}
        onReorderTracks={reorderTracks}
        onAddMatchingLines={addAllMatchingLines}
        onImportTrackLines={importTrackLines}
        onClearTrackLines={clearTrackLines}
        trackLineStats={trackLineStats}
        orphanLines={orphanLines}
        onRemoveLines={removeFromTimeline}
        onJump={jumpToMarker}
        onFocusFilter={focusFilter}
        sheetH={state.timelineSheetH ?? 200}
        onSetSheetH={(h) => setState((s) => ({ ...s, timelineSheetH: h }))}
        iconSize={state.timelineIconSize ?? "M"}
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
              <span className="dock-title">{activePanelTab === "compare" ? `Compare · ${compareRows.length}` : activePanelTab === "bookmarks" ? `Bookmarks · ${markers.length}` : activePanelTab === "timeline" ? `Timeline · ${marks.length}` : "Filters"}</span>
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
              <button className={"ptab" + (activePanelTab === "bookmarks" ? " active" : "")} onClick={() => selectPanelTab("bookmarks")}>
                Bookmarks{markers.length > 0 && <span className="ptab-badge">{markers.length}</span>}
              </button>
              {timelineTabAvailable && (
                <button className={"ptab" + (activePanelTab === "timeline" ? " active" : "")} onClick={() => selectPanelTab("timeline")}>
                  Timeline{marks.length > 0 && <span className="ptab-badge">{marks.length}</span>}
                </button>
              )}
              {compareTabAvailable && (
                <button className={"ptab" + (activePanelTab === "compare" ? " active" : "")} onClick={() => selectPanelTab("compare")}>
                  Compare{showCompare && <span className="ptab-badge">{compareRows.length}</span>}
                </button>
              )}
            </div>
            <div className="dock-spacer" />
            {activePanelTab === "compare" && (
              <>
                <button className="dock-btn" title="Clear comparison" onClick={clearCompare}><Eraser size={14} /></button>
                <button className="dock-btn" title="Pop out beside Filters" onClick={popCompareOut}>
                  {pos === "bottom" ? <PanelLeftOpen size={14} /> : <PanelTopOpen size={14} />}
                </button>
              </>
            )}
            {activePanelTab === "timeline" && (
              <>
                <button className="dock-btn" title="Clear timeline" onClick={clearTimeline}><Eraser size={14} /></button>
                <button className="dock-btn" title="Pop out beside Filters" onClick={popTimelineOut}>
                  {pos === "bottom" ? <PanelLeftOpen size={14} /> : <PanelTopOpen size={14} />}
                </button>
              </>
            )}
            <button className="dock-btn" title={pos === "bottom" ? "Dock right" : "Dock bottom"} onClick={() => setFilterPos(pos === "bottom" ? "right" : "bottom")}>
              {pos === "bottom" ? <PanelRight size={14} /> : <PanelBottom size={14} />}
            </button>
            <button className="dock-btn" title={(collapsed ? "Expand" : "Collapse") + "  (Ctrl+B)"} onClick={toggleFilterCollapsed}>{chevron}</button>
          </div>
          {!collapsed && (
            <div className={"dock-body" + (isPanelPending ? " pending" : "")}>{activePanelTab === "filters" ? filterBody : activePanelTab === "compare" ? compareBody : activePanelTab === "timeline" ? timelineBody : bookmarksBody}</div>
          )}
        </div>
      );
    };

    // The shared popped dock: Compare and Timeline, when popped out, live here as
    // tabs (one or both). It docks on the side opposite the main panel so the two
    // never sit on the same edge. Collapsing mirrors the main dock exactly (same
    // shared tab-strip look): right → a thin vertical title strip, otherwise the
    // tab bar stays visible (just the body is dropped).
    const poppedPos: "bottom" | "right" = state.panelPos === "bottom" ? "right" : "bottom";
    const popDockNode = (): ReactNode => {
      const collapsed = !!state.poppedCollapsed;
      const pos = poppedPos;
      const chevron = foldChevron(pos, collapsed);
      const activeTitle = poppedActiveTab === "compare" ? `Compare · ${compareRows.length}` : `Timeline · ${marks.length}`;

      // Right-docked + collapsed: a thin vertical strip labelled with the active tab.
      if (collapsed && pos === "right") {
        return (
          <div className="dock dock-right collapsed panel-dock">
            <div className="dock-head" onClick={togglePoppedCollapsed} title="Expand">
              <span className="dock-chevron">{chevron}</span>
              <span className="dock-title">{activeTitle}</span>
            </div>
          </div>
        );
      }

      return (
        <div className={"dock dock-" + pos + (collapsed ? " collapsed" : "") + " panel-dock"}>
          <div className="dock-head tabbed">
            <div className="panel-tabs">
              {poppedTabs.map((t) => (
                <button
                  key={t}
                  className={"ptab" + (poppedActiveTab === t ? " active" : "")}
                  onClick={() => setState((s) => ({ ...s, poppedActiveTab: t, poppedCollapsed: false }))}
                >
                  {t === "compare"
                    ? <>Compare{showCompare && <span className="ptab-badge">{compareRows.length}</span>}</>
                    : <>Timeline{marks.length > 0 && <span className="ptab-badge">{marks.length}</span>}</>}
                </button>
              ))}
            </div>
            <div className="dock-spacer" />
            {poppedActiveTab === "compare" ? (
              <button className="dock-btn" title="Clear comparison" onClick={(e) => { e.stopPropagation(); clearCompare(); }}><Eraser size={14} /></button>
            ) : (
              <button className="dock-btn" title="Clear timeline" onClick={(e) => { e.stopPropagation(); clearTimeline(); }}><Eraser size={14} /></button>
            )}
            <button className="dock-btn" title="Dock back into panel" onClick={(e) => { e.stopPropagation(); poppedActiveTab === "compare" ? dockCompareBack() : dockTimelineBack(); }}>
              {pos === "bottom" ? <PanelRightClose size={14} /> : <PanelBottomClose size={14} />}
            </button>
            <button className="dock-btn" title={collapsed ? "Expand" : "Collapse"} onClick={togglePoppedCollapsed}>{chevron}</button>
          </div>
          {!collapsed && <div className="dock-body">{poppedActiveTab === "compare" ? compareBody : timelineBody}</div>}
        </div>
      );
    };

    type PanelDesc = { id: string; node: ReactNode; collapsible?: boolean; collapsed?: boolean; collapsedSize?: string; minSize?: string; ref?: React.RefObject<PanelImperativeHandle | null> };
    const buildGroup = (orientation: "vertical" | "horizontal", gid: string, panels: PanelDesc[]): ReactNode => {
      const ids = panels.map((p) => p.id);
      // Remount the set when its panel set changes — the library can't have a
      // Panel inserted into / removed from a live set ("constraints not found").
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
                  // A side dock carries a px floor (p.minSize) so it can't be
                  // dragged into an unusably narrow sliver.
                  minSize={p.collapsed ? cs : (p.minSize ?? (p.collapsible ? "8%" : "15%"))}
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

    // The main panel is always present; Compare and Timeline share the one popped
    // dock, present only when at least one of them is popped out.
    const docks = [
      { id: "fp", pos: state.panelPos, ref: fpRef },
      ...(popOpen ? [{ id: "pop", pos: poppedPos, ref: popRef }] : []),
    ];
    // Keep array order (main panel before the popped dock).
    const side = (s: "bottom" | "right") => docks.filter((d) => d.pos === s);
    const bottomDocks = side("bottom");
    const rightDocks = side("right");
    const dockPanel = (d: { id: string; ref: React.RefObject<PanelImperativeHandle | null> }): PanelDesc =>
      ({
        id: d.id,
        node: d.id === "fp" ? mainDockNode() : popDockNode(),
        collapsible: true, ref: d.ref,
        collapsed: d.id === "fp" ? state.filterCollapsed : !!state.poppedCollapsed,
        collapsedSize: d.id === "fp" ? MAIN_COLLAPSED : POP_COLLAPSED,
      });

    let center: ReactNode = logview;
    if (bottomDocks.length) {
      center = buildGroup("vertical", "grp-v", [{ id: "lv", node: logview }, ...bottomDocks.map(dockPanel)]);
    }
    if (rightDocks.length) {
      // Side docks get a px floor so a drag can't shrink them into an unusable
      // sliver (the content needs room for a pattern + hit count). When collapsed
      // they stay pinned to their strip width instead.
      const RIGHT_DOCK_MIN = "240px";
      return buildGroup("horizontal", "grp-h", [
        { id: bottomDocks.length ? "center" : "lv", node: center },
        ...rightDocks.map(dockPanel).map((p) => p.collapsed ? p : { ...p, minSize: RIGHT_DOCK_MIN }),
      ]);
    }
    return center;
  }

  return (
    <TooltipProvider delay={350}>
      <div className="app" style={{ "--log-font-size": `${fontSize}px`, "--log-font-weight": fontWeight, "--log-row-h": `${rowH}px`, "--filter-row-h": `${filterRowH}px` } as CSSProperties}>
        {/* titlebar */}
        <div className="titlebar" data-tauri-drag-region>
          <div className="brand">
            Logsy
          </div>
          <div className="menubar">
            {MENUS.map((m) => (
              <div
                key={m}
                data-menu={m}
                className={"menu" + (openMenu?.name === m ? " active" : "")}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setOpenMenu(openMenu?.name === m ? null : { name: m, x: rect.left, y: rect.bottom });
                }}
                // Once any menu is open, hovering a sibling switches to it
                // (standard menubar behaviour — no extra click needed).
                onMouseEnter={(e) => {
                  if (!openMenu || openMenu.name === m) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  setOpenMenu({ name: m, x: rect.left, y: rect.bottom });
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
            openScreen={openScreen}
            onToggleCollapse={toggleSidebar}
            onSelectFile={selectFile}
            onOpenFile={() => setOpenScreen(true)}
            onDeleteFile={deleteFile}
            onSetFileIcon={(id, icon) => patchState((s) => { const f = s.files.find((x) => x.id === id); if (f) f.icon = icon; }, { undoable: false })}
            onSetPanelPos={(pos) => setState((s) => ({ ...s, panelPos: pos }))}
            onSetMapColorMode={(mode) => setState((s) => ({ ...s, mapColorMode: mode }))}
            onSetMapWidth={(w) => setState((s) => ({ ...s, mapWidth: w }))}
            onSetFontWeight={(w) => setState((s) => ({ ...s, fontWeight: w }))}
            onSetTimelineIconSize={(sz) => setState((s) => ({ ...s, timelineIconSize: sz }))}
            onManagePalette={() => setPaletteModalOpen(true)}
          />
          {file && set && !openScreen ? (
            renderWorkspace()
          ) : (
            <div
              className={"empty-workspace" + (dragOver ? " dragover" : "")}
              onClick={() => void openFiles()}
              title="Click to open a log file, or drop one here"
            >
              <div className="ew-card">
                <div className="ew-icon"><FolderOpen size={40} /></div>
                <div className="ew-title">{state.files.length ? "Open another log" : "No log open"}</div>
                <div className="ew-sub">Click here to choose a log file, or drag &amp; drop one into this window.</div>
                <Button onClick={(e) => { e.stopPropagation(); void openFiles(); }}>
                  <Upload data-icon="inline-start" />Open log file
                </Button>
                <div className="ew-hint">Ctrl O</div>
              </div>
            </div>
          )}
        </div>

        {/* modal */}
        {editing && set && (
          <EditModal
            filter={editing.filter}
            isNew={editing.isNew}
            genSeed={editing.genSeed}
            lines={lines}
            groups={set.order
              .map((id) => set.groups.find((g) => g.id === id))
              .filter((g): g is FilterGroup => !!g)
              .concat(set.groups.filter((g) => !set.order.includes(g.id)))
            }
            palette={effectivePalette}
            onSave={saveFilter}
            onClose={() => setEditing(null)}
            onDelete={() => deleteFilter(editing.filter.id)}
          />
        )}

        {/* palette management modal */}
        {paletteModalOpen && (
          <PaletteModal
            palette={effectivePalette}
            onChange={applyPalette}
            onClose={() => setPaletteModalOpen(false)}
          />
        )}

        {/* loading overlay — shown while a log file is read from disk */}
        {busy && (
          <div className="busy-overlay">
            <div className="busy-card">
              <div className="busy-spinner" />
              <div className="busy-text">Opening {busy.name}…</div>
            </div>
          </div>
        )}

        {/* file-switch overlay — shown while React computes the view for a large file */}
        {isSwitchingFile && !busy && (
          <div className="busy-overlay">
            <div className="busy-card">
              <div className="busy-spinner" />
              <div className="busy-text">Loading…</div>
            </div>
          </div>
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
            key={openMenu.name}
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

        {/* keyboard shortcuts dialog */}
        {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}

        <Toaster />
      </div>
    </TooltipProvider>
  );
}
