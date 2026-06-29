import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { ChartGantt } from "lucide-react";

export function TimelineCardView({ node }: NodeViewProps) {
  const { src } = node.attrs as { src: string };

  return (
    <NodeViewWrapper className="tc-card" contentEditable={false}>
      <div className="tc-source-bar">
        <span className="tc-source-icon">
          <ChartGantt size={13} />
        </span>
        <span className="tc-source-name">Timeline snapshot</span>
      </div>
      {src && (
        <div className="tc-img-wrap">
          <img src={src} alt="Timeline snapshot" className="tc-img" />
        </div>
      )}
    </NodeViewWrapper>
  );
}
