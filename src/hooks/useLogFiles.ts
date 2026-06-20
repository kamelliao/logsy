import {
  useState,
  useMemo,
  useEffect,
  useCallback,
  useRef,
  useTransition,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import type { AppState, LogFile, FilterSet } from "@/types";
import { uid } from "@/lib/defaults";
import { baseName } from "@/lib/path";
import type { ConfirmOptions } from "@/components/ConfirmDialog";

// In-memory log contents, keyed by file id. Log bodies are *not* persisted to
// localStorage (they can be huge) — on restart we reload them from `file.path`.
const linesStore: Record<string, string[]> = {};
const EMPTY_LINES: string[] = [];

function splitLines(text: string): string[] {
  const arr = text.split(/\r\n|\n|\r/);
  if (arr.length > 0 && arr[arr.length - 1] === "") arr.pop();
  return arr;
}

// Yield a paint so a just-set loading overlay actually renders before a heavy
// synchronous step (splitting a large file into lines) blocks the main thread.
function nextPaint(): Promise<void> {
  return new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r())),
  );
}

interface Deps {
  patchState: (
    fn: (s: AppState) => void,
    opts?: { undoable?: boolean; coalesce?: string },
  ) => void;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  stateRef: React.RefObject<AppState>;
  pushRecent: (key: "recentFiles" | "recentFilterFiles", path: string) => void;
  appConfirm: (opts: ConfirmOptions) => Promise<boolean>;
  /** The active log file resolved at render time (drives the reload-on-restart effect). */
  file: LogFile | null;
}

export interface LogFilesApi {
  /** Lines of the active file (empty array when none / not yet loaded). */
  lines: string[];
  /** Set while a log file is being read from disk — drives the loading overlay. */
  busy: { name: string } | null;
  /** True while React computes the view for a just-switched (large) file. */
  isSwitchingFile: boolean;
  /** True while a genuine file drag is over the window. */
  dragOver: boolean;
  /** When true, show the blank "open a file" drop screen instead of the workspace. */
  openScreen: boolean;
  setOpenScreen: React.Dispatch<React.SetStateAction<boolean>>;
  selectFile: (fid: string) => void;
  deleteFile: (fid: string) => Promise<void>;
  openFiles: () => Promise<void>;
  loadPaths: (paths: string[], inheritFilters?: boolean) => Promise<void>;
}

/**
 * Owns log-file IO: reading files from disk (open dialog, OS drag-and-drop,
 * reload-on-restart), the in-memory line cache, and the loading/drag overlays.
 * Mutations funnel through the passed `patchState` / `setState` so file actions
 * sit on the same state + undo model as the rest of the app.
 */
export function useLogFiles({
  patchState,
  setState,
  stateRef,
  pushRecent,
  appConfirm,
  file,
}: Deps): LogFilesApi {
  // Bumped whenever a file's lines land in `linesStore`, to re-derive `lines`.
  const [linesVersion, setLinesVersion] = useState(0);
  // When set, a log file is being read from disk — drives the loading overlay.
  const [busy, setBusy] = useState<{ name: string } | null>(null);
  // Marks a non-urgent file switch so React can show an overlay while computing
  // the new view rather than silently freezing for large files.
  const [isSwitchingFile, startFileSwitchTransition] = useTransition();
  const [dragOver, setDragOver] = useState(false);
  // When set, the center shows a blank "open a file" drop screen instead of the
  // active workspace (triggered by the sidebar's Open File button).
  const [openScreen, setOpenScreen] = useState(false);
  const openScreenRef = useRef(false);
  openScreenRef.current = openScreen;
  // Latest appConfirm, for the once-mounted drag-drop listener (which can't close
  // over a fresh handler each render).
  const appConfirmRef = useRef(appConfirm);
  appConfirmRef.current = appConfirm;

  const lines = useMemo(
    () => (file ? (linesStore[file.id] ?? EMPTY_LINES) : EMPTY_LINES),
    [file?.id, linesVersion],
  );

  const selectFile = (fid: string) => {
    setOpenScreen(false);
    startFileSwitchTransition(() =>
      setState((s) => ({ ...s, activeFileId: fid })),
    );
  };

  // Closing a log discards its workspace (filters, sets) — confirm first.
  const deleteFile = async (fid: string) => {
    const f = stateRef.current.files.find((x) => x.id === fid);
    const ok = await appConfirm({
      title: "Close log?",
      message: `Close "${f?.name ?? "this log"}"? Its filters in this workspace will be discarded.`,
      okLabel: "Close",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;
    patchState(
      (s) => {
        s.files = s.files.filter((x) => x.id !== fid);
        if (s.activeFileId === fid) s.activeFileId = s.files[0]?.id ?? null;
        delete linesStore[fid];
      },
      { undoable: false },
    );
  };

  // Read each path from disk and add it as a log file. The same path may be
  // opened more than once — each open is a separate entry (duplicates get a
  // "(n)" suffix so the sidebar stays readable). When `inheritFilters` is set
  // (e.g. for drag-and-drop) the new file starts with a copy of the current
  // set's filters instead of an empty one.
  const loadPaths = useCallback(
    async (paths: string[], inheritFilters = false) => {
      let lastErr = "";
      // Snapshot the active set's filters once, up front, so every dropped file
      // inherits the same starting point.
      const inherited = (() => {
        if (!inheritFilters) return null;
        const cur = stateRef.current;
        const cf =
          cur.files.find((f) => f.id === cur.activeFileId) ??
          cur.files[0] ??
          null;
        const cg = cf
          ? (cf.sets.find((g) => g.id === cf.activeSetId) ?? cf.sets[0])
          : null;
        return cg ?? null;
      })();
      const makeSets = (): FilterSet[] =>
        inherited
          ? [
              {
                ...(JSON.parse(JSON.stringify(inherited)) as FilterSet),
                id: uid("g"),
              },
            ]
          : [
              {
                id: uid("g"),
                name: "Filters",
                filters: [],
                groups: [],
                order: [],
              },
            ];
      try {
        for (const path of paths) {
          let text: string;
          let encoding: string;
          setBusy({ name: baseName(path) });
          await nextPaint(); // let the overlay paint before the read/split blocks
          try {
            const res = await invoke<{ text: string; encoding: string }>(
              "read_text_file",
              { path },
            );
            text = res.text;
            encoding = res.encoding;
          } catch (e) {
            lastErr = `${baseName(path)} — ${String(e)}`;
            continue;
          }
          pushRecent("recentFiles", path);
          await nextPaint(); // yield again so the overlay stays visible before the synchronous line-split
          const lns = splitLines(text);
          const id = uid("file");
          linesStore[id] = lns;
          patchState(
            (s) => {
              // Disambiguate repeated opens of the same path: "log" → "log (2)" → …
              const dupes = s.files.filter((f) => f.path === path).length;
              const f: LogFile = {
                id,
                name:
                  dupes > 0
                    ? `${baseName(path)} (${dupes + 1})`
                    : baseName(path),
                path,
                lineCount: lns.length,
                encoding,
                sets: makeSets(),
                activeSetId: null,
              };
              f.activeSetId = f.sets[0].id;
              s.files.push(f);
              s.activeFileId = f.id;
            },
            { undoable: false },
          );
        }
      } finally {
        setBusy(null);
      }
      setLinesVersion((v) => v + 1);
      if (lastErr) toast.error("Could not open file: " + lastErr);
    },
    [patchState, pushRecent, stateRef],
  );

  const openFiles = useCallback(async () => {
    const sel = await open({ multiple: true });
    if (sel == null) return;
    await loadPaths(Array.isArray(sel) ? sel : [sel]);
    setOpenScreen(false); // a file is now active — leave the open screen
  }, [loadPaths]);

  // Replace the active file's contents in place (same workspace slot, keeping its
  // filters/groups) with a file from disk — used by drag-and-drop so a dropped
  // log loads into the current workspace instead of spawning a new file entry.
  const replaceActiveFile = useCallback(
    async (path: string) => {
      const cur = stateRef.current;
      const active =
        cur.files.find((f) => f.id === cur.activeFileId) ??
        cur.files[0] ??
        null;
      if (!active) {
        await loadPaths([path]);
        return;
      }
      let text: string;
      let encoding: string;
      setBusy({ name: baseName(path) });
      await nextPaint(); // let the overlay paint before the read/split blocks
      try {
        const res = await invoke<{ text: string; encoding: string }>(
          "read_text_file",
          { path },
        );
        text = res.text;
        encoding = res.encoding;
      } catch (e) {
        setBusy(null);
        toast.error(
          "Could not open file: " + baseName(path) + " — " + String(e),
        );
        return;
      }
      const lns = splitLines(text);
      linesStore[active.id] = lns;
      patchState(
        (s) => {
          const f = s.files.find((x) => x.id === active.id);
          if (!f) return;
          f.path = path;
          f.name = baseName(path);
          f.lineCount = lns.length;
          f.encoding = encoding;
          s.activeFileId = f.id;
        },
        { undoable: false },
      );
      pushRecent("recentFiles", path);
      // The slot keeps its file id but gets new contents, so its old line numbers
      // are stale — drop this file's compare lines (timeline does the same on reload).
      setState((s) => ({
        ...s,
        compareLinesByFile: {
          ...(s.compareLinesByFile ?? {}),
          [active.id]: [],
        },
      }));
      setLinesVersion((v) => v + 1);
      setBusy(null);
    },
    [loadPaths, patchState, pushRecent, setState, stateRef],
  );

  // On restart the persisted file list has paths but no cached lines; reload the
  // active file's contents from disk when they're missing.
  useEffect(() => {
    if (!file || !file.path || linesStore[file.id]) return;
    const { id, path, name } = file;
    let cancelled = false;
    // Show the loading overlay: the read can be slow (a large file, or one on a
    // network share), and without feedback the blank workspace looks stuck.
    setBusy({ name });
    (async () => {
      try {
        const res = await invoke<{ text: string; encoding: string }>(
          "read_text_file",
          { path },
        );
        if (cancelled) return;
        linesStore[id] = splitLines(res.text);
        patchState(
          (s) => {
            const f = s.files.find((x) => x.id === id);
            if (f) f.encoding = res.encoding;
          },
          { undoable: false },
        );
        setLinesVersion((v) => v + 1);
      } catch (e) {
        if (!cancelled) toast.error(`Could not reload ${name}: ${String(e)}`);
      } finally {
        if (!cancelled) setBusy(null);
      }
    })();
    return () => {
      cancelled = true;
      setBusy(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          const hasFiles =
            "paths" in p && Array.isArray(p.paths) && p.paths.length > 0;
          if (p.type === "enter" || p.type === "over") {
            if (hasFiles) setDragOver(true);
          } else if (p.type === "drop") {
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
                const ok = await appConfirmRef.current({
                  title: "Replace current log?",
                  message: `A log is already open. Replace it with the dropped file${paths.length > 1 ? "s" : ""}?`,
                  okLabel: "Replace",
                  cancelLabel: "Cancel",
                  danger: true,
                });
                if (!ok) return;
                await replaceActiveFileRef.current(paths[0]);
                // Any extra dropped files open as additional entries.
                if (paths.length > 1)
                  await loadPathsRef.current(paths.slice(1), true);
              } else {
                await loadPathsRef.current(paths);
              }
            })();
          } else {
            setDragOver(false);
          }
        })
        .then((un) => {
          if (disposed) un();
          else unlisten = un;
        })
        .catch(() => {
          /* not running under Tauri */
        });
    } catch {
      /* not running under Tauri */
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    lines,
    busy,
    isSwitchingFile,
    dragOver,
    openScreen,
    setOpenScreen,
    selectFile,
    deleteFile,
    openFiles,
    loadPaths,
  };
}
