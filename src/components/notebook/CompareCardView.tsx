import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { TableProperties } from "lucide-react";

interface CompareRow {
  n: number;
  cells: Record<string, string>;
}

export function CompareCardView({ node }: NodeViewProps) {
  const {
    label,
    cols: colsJson,
    rows: rowsJson,
  } = node.attrs as {
    label: string;
    cols: string;
    rows: string;
  };

  const cols: string[] = (() => {
    try {
      return JSON.parse(colsJson || "[]");
    } catch {
      return [];
    }
  })();
  const rows: CompareRow[] = (() => {
    try {
      return JSON.parse(rowsJson || "[]");
    } catch {
      return [];
    }
  })();

  return (
    <NodeViewWrapper className="cc-card" contentEditable={false}>
      <div className="cc-source-bar">
        <span className="cc-source-icon">
          <TableProperties size={13} />
        </span>
        <span className="cc-source-name">{label || "Compare"}</span>
        <span className="cc-badge">{rows.length} rows</span>
      </div>
      <div className="cc-table-wrap">
        <table className="cc-table">
          <thead>
            <tr>
              <th className="cc-ln-h">#</th>
              {cols.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.n}>
                <td className="cc-ln">{r.n}</td>
                {cols.map((c) => (
                  <td key={c}>{r.cells[c] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </NodeViewWrapper>
  );
}
