import { Image } from "@tiptap/extension-image";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { ImageView } from "./ImageView";

/** Image node with a `width` attribute + a React NodeView that adds a
 *  bottom-right resize handle. Base64 pasted/dropped images (see ImagePaste)
 *  render through this so they can be sized down inline. */
export const ResizableImageNode = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => el.getAttribute("width"),
        renderHTML: (attrs) => (attrs.width ? { width: `${attrs.width}` } : {}),
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});
