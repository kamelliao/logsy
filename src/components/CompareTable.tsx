import { useMemo } from "react";
import { X } from "lucide-react";
import type { ViewRow } from "../types";

interface CompareTableProps {
  rows: ViewRow[];
  onRemove: (n: number) => void;
}

/** Shared-header table comparing the parsed fields of several selected lines. */
export function CompareTable({ rows, onRemove }: CompareTableProps) {
  // Union of field names across the compared rows, in first-seen order.
  const cols = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      for (const k of Object.keys(r.fields ?? {})) if (!seen.has(k)) { seen.add(k); out.push(k); }
    }
    return out;
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
      <table className="cmp-table">
        <thead>
          <tr>
            <th className="cmp-rm" />
            <th className="cmp-ln">line</th>
            {cols.map((c) => <th key={c}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.n}>
              <td className="cmp-rm">
                <button title="Remove from compare" onClick={() => onRemove(r.n)}><X size={12} /></button>
              </td>
              <td className="cmp-ln">{r.n}</td>
              {cols.map((c) => {
                const fv = r.fields?.[c];
                return (
                  <td key={c} className={fv && typeof fv.value === "number" ? "num" : ""}>
                    {fv ? fv.raw : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
