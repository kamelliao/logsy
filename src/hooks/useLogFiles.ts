import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import type { LogFile } from "@/types";
import { uid } from "@/lib/defaults";
import { baseName } from "@/lib/path";
import { nextPaint } from "@/lib/paint";
import { useStore } from "@/store";

// In-memory log contents, keyed by file id. Log bodies are *not* persisted to
// localStorage (they can be huge) — on restart we reload them from `file.path`.
const linesStore: Record<string, string[]> = {};
const EMPTY_LINES: string[] = [];
// Reads in flight, by file id. A pane's read isn't visible in `linesStore` until it
// lands, so without this a re-render mid-read would fire a second read for the
// same file.
const readsInFlight = new Set<string>();

// The live document, read without a render dependency — the old `stateRef.current`.
// Module-level so it's a stable reference (safe to use inside useCallback bodies).
const getDoc = () => useStore.getState().doc;

function splitLines(text: string): string[] {
  const arr = text.split(/\r\n|\n|\r/);
  if (arr.length > 0 && arr[arr.length - 1] === "") arr.pop();
  return arr;
}

interface Deps {
  /** The active log file resolved at render time (drives the reload-on-restart effect). */
  file: LogFile | null;
  /** The document each split pane is showing. The split layout is persisted, so on
   *  restart a pane can show a log that was never the ACTIVE file — nothing else
   *  would ever read it, and the pane would render as an empty log. */
  paneFileIds: string[];
  /** Optional hook: an OS file drop at (x,y) physical px — return true to claim it
   *  (e.g. the split view routing it to the pane under the cursor), skipping the
   *  default "just open the files" behaviour. */
  osDropRef?: React.MutableRefObject<
    ((paths: string[], x: number, y: number) => boolean) | null
  >;
  /** Optional hook: a file is being dragged over the window at (x,y) physical px —
   *  lets the split view highlight the pane under the cursor. */
  osDragRef?: React.MutableRefObject<((x: number, y: number) => void) | null>;
}

export interface LogFilesApi {
  /** Lines of the active file (empty array when none / not yet loaded). */
  lines: string[];
  /** Lines of ANY loaded file by id (for the split view's second pane). Reads the
   *  same in-memory cache as `lines`; re-derives when `linesVersion` changes. */
  linesFor: (fileId: string | null | undefined) => string[];
  /** Set while a log file is being read from disk — drives the loading overlay. */
  busy: { name: string } | null;
  /** True while a genuine file drag is over the window. */
  dragOver: boolean;
  /** When true, show the blank "open a file" drop screen instead of the workspace. */
  openScreen: boolean;
  setOpenScreen: React.Dispatch<React.SetStateAction<boolean>>;
  selectFile: (fid: string) => void;
  deleteFile: (fid: string) => Promise<void>;
  /** Close several logs at once, behind a single confirm. */
  deleteFiles: (fids: string[]) => Promise<void>;
  openFiles: () => Promise<void>;
  loadPaths: (paths: string[], opts?: { activate?: boolean }) => Promise<void>;
  /** Re-decode a file with a forced encoding label (null = back to auto-detect). */
  setFileEncoding: (fid: string, label: string | null) => Promise<void>;
}

/**
 * Owns log-file IO: reading files from disk (open dialog, OS drag-and-drop,
 * reload-on-restart), the in-memory line cache, and the loading/drag overlays.
 * Document mutations and the confirm dialog come from the store; only the active
 * `file` (a render-time derivation) is passed in.
 */
export function useLogFiles({
  file,
  paneFileIds,
  osDropRef,
  osDragRef,
}: Deps): LogFilesApi {
  const patchState = useStore((s) => s.patchState);
  const setState = useStore((s) => s.setDoc);
  const pushRecent = useStore((s) => s.pushRecent);
  // Bumped whenever a file's lines land in `linesStore`, to re-derive `lines`.
  const [linesVersion, setLinesVersion] = useState(0);
  // When set, a log file is being read from disk — drives the loading overlay.
  const [busy, setBusy] = useState<{ name: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // When set, the center shows a blank "open a file" drop screen instead of the
  // active workspace (triggered by the sidebar's Open File button).
  const [openScreen, setOpenScreen] = useState(false);

  const lines = useMemo(
    () => (file ? (linesStore[file.id] ?? EMPTY_LINES) : EMPTY_LINES),
    [file?.id, linesVersion],
  );
  // Any file's cached lines by id — used by the split view's non-active pane. A
  // stable identity is fine: it reads the live module-level cache each call, and
  // App re-renders when `linesVersion` bumps (this hook lives in App), so a
  // later-loaded file's lines are picked up on the next render.
  const linesFor = useCallback(
    (fileId: string | null | undefined) =>
      fileId ? (linesStore[fileId] ?? EMPTY_LINES) : EMPTY_LINES,
    [],
  );

  // Bumped on every explicit sidebar file selection. Reads (which the passive
  // busy overlay no longer blocks) snapshot it before their await: if it moved
  // by the time the file lands, the user navigated mid-read — comparing
  // activeFileId alone can't see a re-click of the already-active file.
  const selectNonceRef = useRef(0);

  const selectFile = (fid: string) => {
    setOpenScreen(false);
    selectNonceRef.current++;
    useStore.getState().touchFileMru(fid);
    // The heavy re-render this triggers (computeView over the switched-to file)
    // is deferred in render via App's deferred active-file id (isSwitchingFile),
    // not here — a transition can't defer this Zustand (useSyncExternalStore)
    // update.
    setState((s) => ({ ...s, activeFileId: fid }));
  };

  // Closing a log discards its workspace (filters, sets) — confirm first. Closing
  // several takes ONE confirm for the batch, not one per file.
  const deleteFiles = async (fids: string[]) => {
    const ids = new Set(fids);
    if (!ids.size) return;
    const docFiles = getDoc().files;
    const first = docFiles.find((x) => ids.has(x.id));
    const many = ids.size > 1;
    const ok = await useStore.getState().confirm({
      title: many ? `Close ${ids.size} logs?` : "Close log?",
      message: many
        ? `Close ${ids.size} logs? Their filters in this workspace will be discarded.`
        : `Close "${first?.name ?? "this log"}"? Its filters in this workspace will be discarded.`,
      okLabel: "Close",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;
    patchState(
      (s) => {
        s.files = s.files.filter((x) => !ids.has(x.id));
        if (s.activeFileId && ids.has(s.activeFileId))
          s.activeFileId = s.files[0]?.id ?? null;
        for (const id of ids) delete linesStore[id];
      },
      { undoable: false },
    );
  };

  const deleteFile = (fid: string) => deleteFiles([fid]);

  // Read each path from disk and add it as a log file. The same path may be
  // opened more than once — each open is a separate entry (duplicates get a
  // "(n)" suffix so the sidebar stays readable). Filter sets are global (shared by
  // every file), so a new file needs none of its own — it shows the same sets.
  //
  // `activate: false` opens the files WITHOUT touching the active file. A caller
  // that will place the file itself (a drop routed to a specific split pane) must
  // pass it: activating here would first pull the file into whichever pane is
  // focused — useSplitView syncs the active file into the focused pane — and it
  // would end up in two panes at once.
  const loadPaths = useCallback(
    async (paths: string[], opts?: { activate?: boolean }) => {
      const activate = opts?.activate ?? true;
      let lastErr = "";
      try {
        for (const path of paths) {
          let text: string;
          let encoding: string;
          // VS Code behaviour: never open the same file twice. If it's already
          // open, just activate it (callers that want it in a specific split pane
          // reference the existing id by path) — no duplicate entry, no re-read.
          const already = getDoc().files.find((f) => f.path === path);
          if (already) {
            if (activate) setState((s) => ({ ...s, activeFileId: already.id }));
            continue;
          }
          setBusy({ name: baseName(path) });
          // The busy overlay is non-blocking, so the user may switch files while
          // this one reads — snapshot the selection nonce to detect it.
          const selectAtStart = selectNonceRef.current;
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
              // The set LIST is global; a new document adopts the current file's
              // active set as its starting lens (else the first set).
              const cur = s.files.find((x) => x.id === s.activeFileId);
              const f: LogFile = {
                id,
                name: baseName(path),
                path,
                lineCount: lns.length,
                encoding,
                detectedEncoding: encoding,
                activeSetId: cur?.activeSetId ?? s.filterSets[0]?.id ?? null,
              };
              s.files.push(f);
              // Auto-activate the freshly opened file — unless the caller places
              // it itself, or the user selected a file mid-read (don't yank them
              // away).
              if (activate && selectNonceRef.current === selectAtStart)
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
    [patchState, pushRecent],
  );

  const openFiles = useCallback(async () => {
    const sel = await open({ multiple: true });
    if (sel == null) return;
    await loadPaths(Array.isArray(sel) ? sel : [sel]);
    setOpenScreen(false); // a file is now active — leave the open screen
  }, [loadPaths]);

  // Re-decode a file with a user-forced encoding (the escape hatch for files
  // auto-detection gets wrong). The override is persisted on the file so a
  // reopen re-decodes the same way. Re-splitting changes line contents/numbers,
  // so the file's compare selection is dropped (as a reload does).
  const setFileEncoding = useCallback(
    async (fid: string, label: string | null) => {
      const f = getDoc().files.find((x) => x.id === fid);
      if (!f || !f.path) return;
      const { path, name } = f;
      setBusy({ name });
      await nextPaint();
      let res: { text: string; encoding: string };
      try {
        res = await invoke<{ text: string; encoding: string }>(
          "read_text_file",
          { path, encoding: label ?? undefined },
        );
      } catch (e) {
        setBusy(null);
        toast.error(`Could not re-decode ${name}: ${String(e)}`);
        return;
      }
      const lns = splitLines(res.text);
      linesStore[fid] = lns;
      patchState(
        (s) => {
          const ff = s.files.find((x) => x.id === fid);
          if (!ff) return;
          ff.encodingOverride = label ?? undefined;
          ff.encoding = res.encoding;
          // Only an un-forced decode re-ran detection; a forced one must not
          // overwrite what the Auto-detect row reports.
          if (!label) ff.detectedEncoding = res.encoding;
          ff.lineCount = lns.length;
        },
        { undoable: false },
      );
      setState((s) => ({
        ...s,
        compareLinesByFile: {
          ...(s.compareLinesByFile ?? {}),
          [fid]: [],
        },
      }));
      setLinesVersion((v) => v + 1);
      setBusy(null);
    },
    [patchState, setState],
  );

  // On restart the persisted file list has paths but no cached lines; reload the
  // active file's contents from disk when they're missing.
  useEffect(() => {
    if (!file || !file.path || linesStore[file.id]) return;
    const { id, path, name, encodingOverride } = file;
    let cancelled = false;
    // Show the loading overlay: the read can be slow (a large file, or one on a
    // network share), and without feedback the blank workspace looks stuck.
    setBusy({ name });
    (async () => {
      try {
        const res = await invoke<{ text: string; encoding: string }>(
          "read_text_file",
          { path, encoding: encodingOverride },
        );
        // Even when the user has switched away mid-read (`cancelled`), keep the
        // result: the cache is keyed by file id, and caching it makes switching
        // back instant instead of triggering a second read.
        linesStore[id] = splitLines(res.text);
        patchState(
          (s) => {
            const f = s.files.find((x) => x.id === id);
            if (!f) return;
            f.encoding = res.encoding;
            // Without an override this read auto-detected; record the result
            // (also backfills files persisted before detectedEncoding existed).
            if (!encodingOverride) f.detectedEncoding = res.encoding;
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

  // The same reload, for the documents the OTHER split panes are showing. The split
  // layout persists, so a restored pane can show a log that was never the active
  // file — the effect above would never read it and the pane would come up blank
  // ("no lines match"). Read quietly: the active file's read owns the loading
  // overlay, and a background pane filling in shouldn't cover the workspace.
  useEffect(() => {
    const todo = paneFileIds.filter(
      (id) => id !== file?.id && !linesStore[id] && !readsInFlight.has(id),
    );
    if (!todo.length) return;
    let cancelled = false;
    for (const id of todo) {
      const f = getDoc().files.find((x) => x.id === id);
      if (!f?.path) continue;
      const { path, name, encodingOverride } = f;
      readsInFlight.add(id);
      void (async () => {
        try {
          const res = await invoke<{ text: string; encoding: string }>(
            "read_text_file",
            { path, encoding: encodingOverride },
          );
          linesStore[id] = splitLines(res.text);
          patchState(
            (s) => {
              const x = s.files.find((y) => y.id === id);
              if (!x) return;
              x.encoding = res.encoding;
              if (!encodingOverride) x.detectedEncoding = res.encoding;
            },
            { undoable: false },
          );
          if (!cancelled) setLinesVersion((v) => v + 1);
        } catch (e) {
          if (!cancelled) toast.error(`Could not reload ${name}: ${String(e)}`);
        } finally {
          readsInFlight.delete(id);
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [paneFileIds, file?.id, patchState]);

  // OS drag-and-drop of files onto the window (Tauri handles this natively).
  const loadPathsRef = useRef(loadPaths);
  loadPathsRef.current = loadPaths;
  // True while a genuine file drag is in flight. Tauri's `over` events carry a
  // position but NOT `paths` (only `enter`/`drop` do), so we latch "this is a file
  // drag" on enter and keep updating the pane highlight on every over — without
  // this, the highlight stuck to wherever the cursor first entered.
  const fileDragActive = useRef(false);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    try {
      getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload;
          const hasFiles =
            "paths" in p && Array.isArray(p.paths) && p.paths.length > 0;
          const pos = "position" in p ? p.position : null;
          if (p.type === "enter") {
            // Only a real file drag carries paths; in-webview drags (e.g. selecting
            // log text) also emit enter/over but with none, and must be ignored.
            if (hasFiles) {
              fileDragActive.current = true;
              setDragOver(true);
              if (osDragRef?.current && pos) osDragRef.current(pos.x, pos.y);
            }
          } else if (p.type === "over") {
            // `over` has no paths — keep going if we already latched a file drag.
            if (fileDragActive.current && osDragRef?.current && pos)
              osDragRef.current(pos.x, pos.y);
          } else if (p.type === "drop") {
            fileDragActive.current = false;
            setDragOver(false);
            if (!p.paths.length) return;
            const paths = p.paths;
            // Let App route the drop to a specific split pane (position is physical
            // px). If it claims the drop, skip the default replace-active handling.
            if (
              osDropRef?.current &&
              pos &&
              osDropRef.current(paths, pos.x, pos.y)
            )
              return;
            // Anywhere else in the window (the open screen, the docks, the sidebar):
            // a drop always OPENS the files. Landing a few px off the log view must
            // not mean something else — it used to offer to replace the open log,
            // which the tab/pane model has made both redundant and destructive.
            void (async () => {
              await loadPathsRef.current(paths);
              setOpenScreen(false);
            })();
          } else {
            // leave / cancel
            fileDragActive.current = false;
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
    // Stable refs; listed only to satisfy the exhaustive-deps lint.
  }, [osDropRef, osDragRef]);

  return {
    lines,
    linesFor,
    busy,
    dragOver,
    openScreen,
    setOpenScreen,
    selectFile,
    deleteFile,
    deleteFiles,
    openFiles,
    loadPaths,
    setFileEncoding,
  };
}
