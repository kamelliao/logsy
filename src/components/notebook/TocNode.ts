import { Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { TocView } from "./TocView";

/**
 * Table-of-contents block: a live outline of the document's headings. It stores
 * nothing — the outline is derived from the doc at render time (see TocView), so
 * it always reflects the current headings. In the doc model it's just an empty
 * placeholder div; the HTML export fills it in from the exported headings.
 */
export const TocNode = Node.create({
  name: "tableOfContents",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  parseHTML() {
    return [{ tag: 'div[data-type="table-of-contents"]' }];
  },

  renderHTML() {
    return ["div", { "data-type": "table-of-contents" }];
  },

  addNodeView() {
    return ReactNodeViewRenderer(TocView);
  },
});
