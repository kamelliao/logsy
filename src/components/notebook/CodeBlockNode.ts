import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";
import { CodeBlockView } from "./CodeBlockView";
import { lowlight } from "./lowlight";

const INDENT = "    "; // 4 spaces

/** Indent / outdent the selected lines (or insert 4 spaces at the caret).
 *  Returns false when the caret is not inside a code block so Tab keeps its
 *  default behaviour everywhere else. */
function changeIndent(editor: Editor, outdent: boolean): boolean {
  const { state } = editor;
  const { $from, $to, empty } = state.selection;
  if ($from.parent.type.name !== "codeBlock") return false;

  // Plain Tab with no selection: just drop 4 spaces at the caret.
  if (empty && !outdent) {
    editor.view.dispatch(state.tr.insertText(INDENT, $from.pos));
    return true;
  }

  const blockStart = $from.start();
  const text = $from.parent.textContent;
  const from = $from.pos - blockStart;
  const to = $to.pos - blockStart;

  // Expand the affected range to start at the beginning of the first line.
  const lineStart = text.lastIndexOf("\n", from - 1) + 1;
  const regionAbs = blockStart + lineStart;
  const region = text.slice(lineStart, to);
  const lines = region.split("\n");

  const newRegion = outdent
    ? lines.map((l) => l.replace(/^( {1,4}|\t)/, "")).join("\n")
    : lines.map((l) => INDENT + l).join("\n");

  if (newRegion === region) return true;

  const tr = state.tr.insertText(
    newRegion,
    regionAbs,
    regionAbs + region.length,
  );
  tr.setSelection(
    TextSelection.create(tr.doc, regionAbs, regionAbs + newRegion.length),
  );
  editor.view.dispatch(tr);
  return true;
}

export const CodeBlockNode = CodeBlockLowlight.extend({
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      Tab: ({ editor }) => changeIndent(editor, false),
      "Shift-Tab": ({ editor }) => changeIndent(editor, true),
      // Keep an empty code block sticky: swallow Backspace so it isn't deleted
      // (or merged into the previous block) once there's nothing left to remove.
      Backspace: ({ editor }) => {
        const { empty, $from } = editor.state.selection;
        return (
          empty &&
          $from.parent.type.name === "codeBlock" &&
          $from.parent.content.size === 0
        );
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
}).configure({ lowlight, defaultLanguage: "plaintext" });
