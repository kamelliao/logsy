import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { ChartGantt } from "lucide-react";

export function TimelineCardView({ node, selected }: NodeViewProps) {
  const { src } = node.attrs as { src: string };

  // A media atom, styled after ResizableImage/ImageView (which selects cleanly):
  // the wrapper is NOT forced contentEditable={false}, so PM handles the leaf
  // node's click as a NodeSelection (blue selectednode ring) and the browser
  // never spills a text range into the next block. Only the static source-bar
  // label is contentEditable={false} chrome so no caret can land in its text.
  return (
    <NodeViewWrapper className={"tc-card" + (selected ? " is-selected" : "")}>
      <div className="tc-source-bar" contentEditable={false}>
        <span className="tc-source-icon">
          <ChartGantt size={13} />
        </span>
        <span className="tc-source-name">Timeline snapshot</span>
      </div>
      {src && (
        <div className="tc-img-wrap">
          <img
            src={src}
            alt="Timeline snapshot"
            className="tc-img"
            draggable={false}
          />
        </div>
      )}
    </NodeViewWrapper>
  );
}
