import { useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import type { AppState, LogFile, ViewResult } from "@/types";

interface Deps {
  view: ViewResult;
  file: LogFile | null;
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
}

/**
 * The comparison panel: the per-file set of lines pinned for field comparison
 * (persisted, not undoable — mirrors the timeline) plus the rows they resolve
 * to and CSV export. Pinned lines live in `compareLinesByFile[file.id]`.
 */
export function useCompare({ view, file, state, setState }: Deps) {
  // Lines explicitly added to the comparison panel. Persisted per file (survives
  // reload / document switch / filter switch), keyed by file id like the timeline.
  const compareLines = useMemo(
    () => new Set(file ? (state.compareLinesByFile?.[file.id] ?? []) : []),
    [state.compareLinesByFile, file],
  );
  // Rows shown in the comparison panel: explicitly-added, still-visible, parsed lines.
  const compareRows = useMemo(
    () =>
      view.rows
        .filter(
          (r) =>
            !r.excluded &&
            compareLines.has(r.n) &&
            r.fieldsFromId !== undefined,
        )
        .map((r) => ({ ...r, fields: view.fieldsFor(r.n) })),
    [view, compareLines],
  );

  // Compare lines persist per file (survive reload / document switch / filter
  // switch) but are not on the undo stack, so they go through plain setState into
  // `compareLinesByFile[file.id]` — mirroring the timeline.
  const mutateCompare = (fn: (cur: Set<number>) => void) =>
    setState((s) => {
      const fid = (s.files.find((f) => f.id === s.activeFileId) ?? s.files[0])
        ?.id;
      if (!fid) return s;
      const cur = new Set(s.compareLinesByFile?.[fid] ?? []);
      fn(cur);
      return {
        ...s,
        compareLinesByFile: {
          ...(s.compareLinesByFile ?? {}),
          [fid]: [...cur],
        },
      };
    });
  const addToCompare = (ns: number[]) => {
    mutateCompare((c) => ns.forEach((n) => c.add(n)));
    // Surface the comparison: focus its tab, or expand it if it's popped out.
    setState((s) =>
      s.comparePopped
        ? { ...s, poppedCollapsed: false, poppedActiveTab: "compare" }
        : { ...s, activePanelTab: "compare", filterCollapsed: false },
    );
  };
  const removeFromCompare = (ns: number[]) =>
    mutateCompare((c) => ns.forEach((n) => c.delete(n)));
  const clearCompare = () => mutateCompare((c) => c.clear());
  // Clear just one pattern-table's lines (its Compare group header button).
  const clearCompareGroup = (id: string | undefined) => {
    const ns = compareRows
      .filter((r) => (r.fieldsFromId ?? "") === (id ?? ""))
      .map((r) => r.n);
    if (ns.length) removeFromCompare(ns);
  };
  // Import every visible line this filter parses into the comparison (its group
  // header button) — the analogue of the timeline track's "import matching lines".
  const importCompareGroup = (id: string | undefined) => {
    const ns = view.rows
      .filter(
        (r) =>
          !r.excluded &&
          r.fieldsFromId !== undefined &&
          (r.fieldsFromId ?? "") === (id ?? ""),
      )
      .map((r) => r.n);
    if (ns.length) addToCompare(ns);
  };

  // Build CSV text for a single pattern-set's rows.
  const buildCsv = (rows: typeof compareRows) => {
    const esc = (s: string) =>
      /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    const cols: string[] = [];
    const seen = new Set<string>();
    for (const r of rows)
      for (const k of Object.keys(r.fields ?? {}))
        if (!seen.has(k)) {
          seen.add(k);
          cols.push(k);
        }
    const parts: string[] = [["line", ...cols].map(esc).join(",")];
    for (const r of rows)
      parts.push(
        [String(r.n), ...cols.map((c) => r.fields?.[c]?.raw ?? "")]
          .map(esc)
          .join(","),
      );
    return parts.join("\n") + "\n";
  };

  // Export one compared pattern's table as CSV via a native save dialog.
  const exportGroupCsv = useCallback(
    async (id: string | undefined, label: string) => {
      const rows = compareRows.filter(
        (r) => (r.fieldsFromId ?? "") === (id ?? ""),
      );
      if (!rows.length) return;
      // Default name is a timestamp (yyyymmdd_hhmmss.csv); `label` is unused here
      // now but kept in the signature for call sites / future use.
      void label;
      const d = new Date();
      const p2 = (n: number) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      const path = await save({
        defaultPath: stamp + ".csv",
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (typeof path !== "string") return;
      try {
        await invoke("write_text_file", { path, contents: buildCsv(rows) });
        toast.success("CSV saved");
      } catch (e) {
        toast.error("Could not save CSV: " + String(e));
      }
    },
    [compareRows],
  );

  return {
    compareLines,
    compareRows,
    addToCompare,
    removeFromCompare,
    clearCompare,
    clearCompareGroup,
    importCompareGroup,
    exportGroupCsv,
  };
}
