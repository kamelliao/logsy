import { Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { PinnedLinesView } from "./PinnedLinesView";

/** Called when the "jump to line" button is clicked. App installs this. A card
 *  carries the id of the file its lines came from, so a notebook that cites
 *  several logs can switch to the right one before scrolling. */
let _onJump: ((fileId: string, n: number) => void) | null = null;
export function setPinnedLinesJumpHandler(
  fn: (fileId: string, n: number) => void,
) {
  _onJump = fn;
}
export function getPinnedLinesJumpHandler() {
  return _onJump;
}

/** Registered by the focused PinnedLinesView so the notebook toolbar can save. */
let _plSave: (() => void) | null = null;
export function registerPLSave(fn: (() => void) | null) {
  _plSave = fn;
}
export function triggerPLSave() {
  _plSave?.();
}

export const PinnedLinesNode = Node.create({
  name: "pinnedLines",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      file: { default: "" },
      /** Id of the source log file, so "jump to line" can switch to it first.
       *  Plain attribute: it round-trips natively in the autosaved doc JSON, and
       *  the manual renderHTML below emits it as `data-file-id` for exports. */
      fileId: { default: "" },
      /** JSON-encoded array of { n: number; text: string } */
      lines: { default: "[]" },
      caption: { default: "" },
      /** Annotated HTML version of lines (set after user applies inline styles). */
      richContent: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="pinned-lines"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    // Return a real DOM node so that:
    //   1. richContent HTML is set via innerHTML (not escaped as text)
    //   2. line spans are built as DOM children (not raw HTML strings)
    const {
      file,
      fileId,
      lines: linesJson,
      richContent,
    } = HTMLAttributes as {
      file: string;
      fileId: string;
      lines: string;
      richContent: string;
    };
    const lines: { n: number; text: string }[] = (() => {
      try {
        return JSON.parse(linesJson || "[]");
      } catch {
        return [];
      }
    })();

    const wrap = document.createElement("div");
    wrap.setAttribute("data-type", "pinned-lines");
    wrap.setAttribute("data-file", file);
    if (fileId) wrap.setAttribute("data-file-id", fileId);
    wrap.setAttribute("data-lines", linesJson);

    const bar = document.createElement("div");
    bar.className = "pl-source-bar";
    bar.textContent = `📄 ${file}`;
    wrap.appendChild(bar);

    const pre = document.createElement("pre");
    pre.className = "pl-body";
    if (richContent) {
      pre.innerHTML = richContent;
    } else {
      for (const l of lines) {
        const row = document.createElement("span");
        row.className = "pl-row";
        const num = document.createElement("span");
        num.className = "pl-num";
        num.textContent = String(l.n);
        const txt = document.createElement("span");
        txt.className = "pl-text";
        txt.textContent = l.text;
        row.appendChild(num);
        row.appendChild(txt);
        pre.appendChild(row);
      }
    }
    wrap.appendChild(pre);

    return wrap;
  },

  addNodeView() {
    return ReactNodeViewRenderer(PinnedLinesView);
  },
});
