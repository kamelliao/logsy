import { useRef } from "react";
import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";

/** React NodeView giving pasted images a bottom-right drag handle to resize.
 *  The width is stored as a plain `width` attribute (px) on the node, so it
 *  round-trips through autosave JSON and the HTML export. */
export function ImageView({ node, updateAttributes, selected }: NodeViewProps) {
  const src = node.attrs.src as string;
  const alt = (node.attrs.alt as string) || undefined;
  const width = node.attrs.width as number | string | null;
  const imgRef = useRef<HTMLImageElement>(null);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const img = imgRef.current;
    if (!img) return;
    const startX = e.clientX;
    const startW = img.getBoundingClientRect().width;
    // Never grow past the editor column (the image already maxes at 100%).
    const maxW = img.parentElement?.parentElement?.clientWidth ?? Infinity;

    const onMove = (ev: PointerEvent) => {
      const w = Math.round(startW + (ev.clientX - startX));
      updateAttributes({ width: Math.max(60, Math.min(w, maxW)) });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("nb-img-resizing");
    };
    document.body.classList.add("nb-img-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <NodeViewWrapper
      className={"nb-image-wrap" + (selected ? " is-selected" : "")}
      style={
        width
          ? { width: typeof width === "number" ? `${width}px` : width }
          : undefined
      }
    >
      <img
        ref={imgRef}
        className="nb-image"
        src={src}
        alt={alt}
        draggable={false}
      />
      <span
        className="nb-image-resize"
        onPointerDown={startResize}
        // block the plugin's HTML5 drag / text selection during a resize
        onDragStart={(ev) => ev.preventDefault()}
      />
    </NodeViewWrapper>
  );
}
