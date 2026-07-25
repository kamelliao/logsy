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
      // Source bar mirrors the editor's CompareCardView header: a lucide
      // "TableProperties" glyph (drawn here as inline SVG since export is
      // React-less) followed by the label.
      [
        "div",
        { class: "cc-source-bar" },
        [
          "span",
          { class: "cc-source-icon" },
          [
            "svg",
            {
              width: "13",
              height: "13",
              viewBox: "0 0 24 24",
              fill: "none",
              stroke: "currentColor",
              "stroke-width": "2",
              "stroke-linecap": "round",
              "stroke-linejoin": "round",
              "aria-hidden": "true",
            },
            ["path", { d: "M15 3v18" }],
            ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
            ["path", { d: "M21 9H3" }],
            ["path", { d: "M21 15H3" }],
          ],
        ],
        ["span", { class: "cc-source-name" }, label],
      ] as never,
      [
        "table",
        { class: "cc-table" },
        // Leading gutter header (`#`) mirrors the body rows' `cc-ln` cell;
        // without it the header row is one cell short and every column shifts,
        // dropping the rightmost header.
        [
          "thead",
          {},
          [
            "tr",
            {},
            ["th", { class: "cc-ln-h" }, "#"],
            ...cols.map((c) => ["th", {}, c]),
          ],
        ],
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
