import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { CompareCardView } from "./CompareCardView";

export const CompareCardNode = Node.create({
  name: "compareCard",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      label: { default: "" },
      /** JSON-encoded string[] */
      cols: { default: "[]" },
      /** JSON-encoded { n: number; cells: Record<string, string> }[] */
      rows: { default: "[]" },
      caption: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="compare-card"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const {
      label,
      cols: colsJson,
      rows: rowsJson,
      caption,
    } = HTMLAttributes as {
      label: string;
      cols: string;
      rows: string;
      caption: string;
    };
    const cols: string[] = JSON.parse(colsJson || "[]");
    const rows: { n: number; cells: Record<string, string> }[] = JSON.parse(
      rowsJson || "[]",
    );

    return [
      "div",
      mergeAttributes(
        { "data-type": "compare-card", "data-label": label },
        HTMLAttributes,
      ),
      ["div", { class: "cc-source-bar" }, `▦ ${escHtml(label)}`],
      [
        "table",
        { class: "cc-table" },
        ["thead", {}, ["tr", {}, ...cols.map((c) => ["th", {}, c])]],
        [
          "tbody",
          {},
          ...(rows.map((r) => [
            "tr",
            {},
            ["td", { class: "cc-ln" }, String(r.n)],
            ...cols.map((c) => ["td", {}, r.cells[c] ?? ""]),
          ]) as never[]),
        ],
      ],
      ...(caption
        ? [["figcaption", { class: "cc-caption" }, caption] as never]
        : []),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CompareCardView);
  },
});

function escHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
