import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { TimelineCardView } from "./TimelineCardView";

export const TimelineCardNode = Node.create({
  name: "timelineCard",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: "" }, // WebP dataURL
      caption: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: 'figure[data-type="timeline-card"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const { src, caption } = HTMLAttributes as { src: string; caption: string };
    return [
      "figure",
      mergeAttributes({ "data-type": "timeline-card" }, HTMLAttributes),
      ["img", { src, alt: "Timeline snapshot" }],
      ["figcaption", {}, caption || "Timeline snapshot"],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(TimelineCardView);
  },
});
