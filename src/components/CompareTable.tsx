import { useMemo } from "react";
import { X } from "lucide-react";
import type { ViewRow } from "../types";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

interface CompareTableProps {
  rows: ViewRow[];
  onRemove: (n: number) => void;
  /** Human label for the filter (pattern) that produced a group of fields. */
  labelFor: (fieldsFromId: string | undefined) => string;
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
export function CompareTable({ rows, onRemove, labelFor }: CompareTableProps) {
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
        return (
          <div className="cmp-group" key={id || "_"}>
            {groups.length > 1 && <div className="cmp-group-head">{labelFor(id || undefined)}</div>}
            <Table className="cmp-shadcn">
              <TableHeader>
                <TableRow>
                  <TableHead className="cmp-rm" />
                  <TableHead className="cmp-ln">line</TableHead>
                  {cols.map((c) => <TableHead key={c}>{c}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {grpRows.map((r) => (
                  <TableRow key={r.n}>
                    <TableCell className="cmp-rm">
                      <button title="Remove from compare" onClick={() => onRemove(r.n)}><X size={12} /></button>
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
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        );
      })}
    </div>
  );
}
