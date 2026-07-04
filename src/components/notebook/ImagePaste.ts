import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

// Read an image File as a base64 data URL. Notebooks export to self-contained
// HTML/JSON (everything inlined), so pasted images live in the doc as data URIs
// rather than referencing files on disk that a shared export couldn't reach.
function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function imageFiles(list: FileList | null | undefined): File[] {
  if (!list) return [];
  return Array.from(list).filter((f) => f.type.startsWith("image/"));
}

/** Insert pasted / dropped image files into the doc as base64 `image` nodes. */
export const ImagePaste = Extension.create({
  name: "imagePaste",

  addProseMirrorPlugins() {
    const editor = this.editor;

    const insertFiles = (files: File[], at?: number) => {
      void Promise.all(files.map(readAsDataURL)).then((urls) => {
        const chain = editor.chain();
        if (typeof at === "number") chain.focus().setTextSelection(at);
        else chain.focus();
        for (const src of urls)
          chain.insertContent({ type: "image", attrs: { src } });
        chain.run();
      });
    };

    return [
      new Plugin({
        props: {
          handlePaste: (_view, event) => {
            const files = imageFiles(event.clipboardData?.files);
            if (!files.length) return false;
            event.preventDefault();
            insertFiles(files);
            return true;
          },
          handleDrop: (view, event) => {
            const files = imageFiles(event.dataTransfer?.files);
            if (!files.length) return false;
            event.preventDefault();
            const pos = view.posAtCoords({
              left: event.clientX,
              top: event.clientY,
            })?.pos;
            insertFiles(files, pos);
            return true;
          },
        },
      }),
    ];
  },
});
