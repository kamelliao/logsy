import { useMemo } from "react";
import { Download, X } from "lucide-react";
import type { ViewRow } from "../types";
import { Button } from "./ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface CompareTableProps {
  rows: ViewRow[];
  onRemove: (n: number) => void;
  /** Human label for the filter (pattern) that produced a group of fields. */
  labelFor: (fieldsFromId: string | undefined) => string;
  /** Accent colour for the filter that produced a group of fields. */
  colorFor: (fieldsFromId: string | undefined) => string;
  /** Export a single pattern-group's rows as CSV (opens a save dialog). */
  onExport: (fieldsFromId: string | undefined, label: string) => void;
}

function colsOf(rows: ViewRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r.fields ?? {})) if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

/** Compares parsed fields of selected lines, one table per matching pattern. */
export function CompareTable({ rows, onRemove, labelFor, colorFor, onExport }: CompareTableProps) {
  // Group compared rows by the filter that parsed them (one table per pattern).
  const groups = useMemo(() => {
    const map = new Map<string, ViewRow[]>();
    for (const r of rows) {
      const id = r.fieldsFromId ?? "";
      (map.get(id) ?? map.set(id, []).get(id)!).push(r);
    }
    return [...map.entries()];
  }, [rows]);

  if (!rows.length) {
    return (
      <div className="cmp-empty">
        Right-click a parsed line ▸ <b>Add to compare</b> to line up its fields here.
      </div>
    );
  }

  return (
    <div className="cmp-scroll scroll">
      {groups.map(([id, grpRows]) => {
        const cols = colsOf(grpRows);
        const key = id || undefined;
        const label = labelFor(key);
        return (
          <div className="cmp-group" key={id || "_"}>
            <div className="cmp-group-head">
              <span className="cmp-dot" style={{ background: colorFor(key) }} />
              <span className="cmp-group-label" title={label}>{label}</span>
              <span className="cmp-group-count">{grpRows.length}</span>
              <span className="cmp-group-spacer" />
              <button
                className="cmp-export"
                title="Export this table as CSV"
                onClick={() => onExport(key, label)}
              >
                <Download size={13} />
                <span>Export CSV</span>
              </button>
            </div>
            <div className="cmp-card">
              <Table className="cmp-shadcn">
                <TableHeader>
                  <TableRow>
                    <TableHead className="cmp-rm" />
                    <TableHead className="cmp-ln">line</TableHead>
                    {cols.map((c) => <TableHead key={c}>{c}</TableHead>)}
                    {/* greedy spacer: soaks up slack so real columns hug content */}
                    <TableHead className="cmp-pad" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {grpRows.map((r) => (
                    <TableRow key={r.n}>
                      <TableCell className="cmp-rm">
                        <Tooltip>
                          <TooltipTrigger render={
                            <Button variant="ghost" size="icon-xs" aria-label="Remove from compare" onClick={() => onRemove(r.n)} />
                          }>
                            <X />
                          </TooltipTrigger>
                          <TooltipContent side="top">Remove from compare</TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell className="cmp-ln">{r.n}</TableCell>
                      {cols.map((c) => {
                        const fv = r.fields?.[c];
                        return (
                          <TableCell key={c} className={fv && typeof fv.value === "number" ? "num" : ""}>
                            {fv ? fv.raw : "—"}
                          </TableCell>
                        );
                      })}
                      <TableCell className="cmp-pad" />
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
