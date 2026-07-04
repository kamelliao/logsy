import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useEditor, type Editor } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { Highlight } from "@tiptap/extension-highlight";
import { TableKit, TableCell, TableHeader } from "@tiptap/extension-table";

// Add a `backgroundColor` attribute to table cells/headers so a cell can be
// tinted (prosemirror-tables' `setCellAttribute` writes it; it renders as an
// inline style). TableKit's bundled cell/header are disabled below in favour of
// these extended nodes.
const cellBackground = {
  backgroundColor: {
    default: null as string | null,
    parseHTML: (el: HTMLElement) =>
      el.style.backgroundColor || el.getAttribute("data-cell-bg") || null,
    renderHTML: (attrs: Record<string, unknown>) => {
      const bg = attrs.backgroundColor as string | null;
      return bg ? { style: `background-color:${bg}`, "data-cell-bg": bg } : {};
    },
  },
};

const TableCellBg = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...cellBackground };
  },
});

const TableHeaderBg = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...cellBackground };
  },
});

// In a blockquote, Enter exits the quote and starts a fresh block below (split
// the paragraph at the cursor, then lift the new part out of the quote).
// Shift+Enter is left to the default hard break — a new line still inside the
// quote. High priority so this runs before the core's default Enter handler.
const BlockquoteExit = Extension.create({
  name: "blockquoteExit",
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        if (!this.editor.isActive("blockquote")) return false;
        return this.editor.chain().splitBlock().lift("paragraph").run();
      },
    };
  },
});
import { PinnedLinesNode } from "@/components/notebook/PinnedLinesNode";
import { ResizableImageNode } from "@/components/notebook/ResizableImageNode";
import { ImagePaste } from "@/components/notebook/ImagePaste";
import { CompareCardNode } from "@/components/notebook/CompareCardNode";
import { TimelineCardNode } from "@/components/notebook/TimelineCardNode";
import { CodeBlockNode } from "@/components/notebook/CodeBlockNode";
import { SlashCommand } from "@/components/notebook/SlashCommand";
import { useStore } from "@/store";

interface NotebookCtx {
  editor: Editor | null;
}

const NotebookContext = createContext<NotebookCtx | null>(null);

// ── module-level insert callback ────────────────────────────────────────────
// Lets callers outside the provider tree (e.g. App hooks) insert embeds
// without needing React context access. Same pattern as setPinnedLinesJumpHandler.
let _insertEmbed:
  | ((type: string, attrs: Record<string, unknown>) => void)
  | null = null;

// "Add to notebook" may fire the same tick a notebook is first created (its
// editor hasn't mounted yet). Buffer such inserts and let the manager drain
// them once its editor is ready, so the first capture into a brand-new notebook
// isn't dropped.
const _pendingEmbeds: { type: string; attrs: Record<string, unknown> }[] = [];

function callInsertEmbed(type: string, attrs: Record<string, unknown>) {
  if (_insertEmbed) _insertEmbed(type, attrs);
  else _pendingEmbeds.push({ type, attrs });
}

export function callAddPinnedLines(
  lines: { n: number; text: string }[],
  file: string,
  fileId: string,
) {
  callInsertEmbed("pinnedLines", {
    file,
    fileId,
    lines: JSON.stringify(lines),
    caption: "",
  });
}

export function callAddCompareCard(
  label: string,
  cols: string[],
  rows: { n: number; cells: Record<string, string> }[],
) {
  callInsertEmbed("compareCard", {
    label,
    cols: JSON.stringify(cols),
    rows: JSON.stringify(rows),
    caption: "",
  });
}

export function callAddTimelineCard(src: string) {
  callInsertEmbed("timelineCard", { src, caption: "" });
}

// ── editor manager ──────────────────────────────────────────────────────────

interface ManagerProps {
  notebookId: string;
  onEditor: (e: Editor | null) => void;
}

/**
 * Owns one notebook's TipTap editor: creation, autosave, embed inserts. Renders
 * nothing — NotebookHost keys THIS component by notebook id, so switching
 * notebooks remounts a null-rendering leaf (fresh editor + fresh private undo
 * history) instead of the whole app subtree, which made the log view flash.
 * It lives at app level (not in the panel) so the editor survives dock-tab
 * switches that unmount the Notebook panel.
 */
function NotebookEditorManager({ notebookId, onEditor }: ManagerProps) {
  const saveNotebookDoc = useStore((s) => s.saveNotebookDoc);
  const saveDoc = useCallback(
    (doc: Record<string, unknown>) => saveNotebookDoc(notebookId, doc),
    [notebookId, saveNotebookDoc],
  );

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initial content is read once, non-reactively: the editor is the source of
  // truth while mounted, and subscribing here would re-render on every autosave.
  const [initialDoc] = useState(
    () =>
      useStore.getState().notebooks.find((n) => n.id === notebookId)?.doc ??
      null,
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      Placeholder.configure({ placeholder: "Start writing your analysis…" }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      TableKit.configure({
        table: { resizable: true, HTMLAttributes: { class: "nb-table" } },
        tableCell: false,
        tableHeader: false,
      }),
      TableCellBg,
      TableHeaderBg,
      BlockquoteExit,
      ResizableImageNode.configure({
        allowBase64: true,
        HTMLAttributes: { class: "nb-image" },
      }),
      ImagePaste,
      PinnedLinesNode,
      CompareCardNode,
      TimelineCardNode,
      CodeBlockNode,
      SlashCommand,
    ],
    content: (initialDoc as object | null) ?? "",
    immediatelyRender: true,
    onUpdate: ({ editor: e }) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        saveDoc(e.getJSON() as Record<string, unknown>);
      }, 400);
    },
  });

  // Flush a pending debounced autosave when this notebook's editor goes away
  // (switching notebooks / deleting) so the last <400ms of edits aren't lost.
  useEffect(() => {
    return () => {
      if (!timerRef.current) return;
      clearTimeout(timerRef.current);
      timerRef.current = null;
      try {
        if (!editor.isDestroyed)
          saveDoc(editor.getJSON() as Record<string, unknown>);
      } catch {
        /* editor already torn down — the debounced save had it anyway */
      }
    };
  }, [editor, saveDoc]);

  const insertEmbed = useCallback(
    (type: string, attrs: Record<string, unknown>) => {
      editor.chain().focus().insertContent({ type, attrs }).run();
    },
    [editor],
  );

  useEffect(() => {
    _insertEmbed = insertEmbed;
    // Drain anything captured before this editor was ready (e.g. an embed added
    // the same tick a fresh notebook was created).
    if (_pendingEmbeds.length) {
      const queued = _pendingEmbeds.splice(0);
      for (const e of queued) insertEmbed(e.type, e.attrs);
    }
    return () => {
      _insertEmbed = null;
    };
  }, [insertEmbed]);

  useEffect(() => {
    onEditor(editor);
    // Dev-only escape hatch so e2e tests can inspect ProseMirror state.
    if (import.meta.env.DEV)
      (window as unknown as { __nbEditor?: Editor | null }).__nbEditor = editor;
    return () => {
      onEditor(null);
      if (import.meta.env.DEV)
        (window as unknown as { __nbEditor?: Editor | null }).__nbEditor = null;
    };
  }, [editor, onEditor]);

  return null;
}

// ── host ────────────────────────────────────────────────────────────────────

export function NotebookHost({ children }: { children: ReactNode }) {
  const activeNotebookId = useStore((s) => s.activeNotebookId);
  const [editor, setEditor] = useState<Editor | null>(null);
  const ctx = useMemo(() => ({ editor }), [editor]);
  // The manager (not this provider) carries the per-notebook key: `children` is
  // the whole app, and re-keying an ancestor of it remounted everything — the
  // log view flashed on every notebook switch. No notebook → no editor; the
  // panel renders its empty state.
  return (
    <NotebookContext.Provider value={ctx}>
      {activeNotebookId && (
        <NotebookEditorManager
          key={activeNotebookId}
          notebookId={activeNotebookId}
          onEditor={setEditor}
        />
      )}
      {children}
    </NotebookContext.Provider>
  );
}

export function useNotebookEditor(): Editor | null {
  return useContext(NotebookContext)?.editor ?? null;
}
