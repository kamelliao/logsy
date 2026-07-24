import { useEffect, useState, useCallback } from "react";
import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import type { Editor } from "@tiptap/react";

interface TocEntry {
  level: number;
  text: string;
  pos: number;
}

/** Walk the doc for headings in document order. */
function collectHeadings(editor: Editor): TocEntry[] {
  const out: TocEntry[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      out.push({
        level: (node.attrs.level as number) || 1,
        text: node.textContent.trim(),
        pos,
      });
    }
  });
  return out;
}

export function TocView({ editor }: NodeViewProps) {
  const [items, setItems] = useState<TocEntry[]>(() => collectHeadings(editor));

  // Re-derive the outline whenever the document changes. A NodeView only
  // re-renders when its OWN node updates, so subscribe to the editor's updates
  // to catch headings edited elsewhere in the doc.
  useEffect(() => {
    const recompute = () => setItems(collectHeadings(editor));
    recompute();
    editor.on("update", recompute);
    return () => {
      editor.off("update", recompute);
    };
  }, [editor]);

  const jump = useCallback(
    (pos: number) => {
      // nodeDOM(pos) resolves the heading element; scroll it into the notebook
      // scroll area. Reading the DOM (not editor scroll commands) avoids the
      // focus-driven scroll jump that fights a smooth scroll.
      const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
      dom?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [editor],
  );

  return (
    <NodeViewWrapper className="toc-card" contentEditable={false}>
      {items.length === 0 ? (
        <div className="toc-empty">
          Add headings (H1–H3) to build the outline.
        </div>
      ) : (
        <div className="toc-list">
          {items.map((h, i) => (
            <button
              key={`${h.pos}-${i}`}
              type="button"
              className={`toc-item toc-l${h.level}`}
              onClick={() => jump(h.pos)}
              title={h.text || "Untitled heading"}
            >
              {h.text || "Untitled heading"}
            </button>
          ))}
        </div>
      )}
    </NodeViewWrapper>
  );
}
