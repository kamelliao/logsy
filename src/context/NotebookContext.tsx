import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { Highlight } from "@tiptap/extension-highlight";
import { PinnedLinesNode } from "@/components/notebook/PinnedLinesNode";
import { CompareCardNode } from "@/components/notebook/CompareCardNode";
import { TimelineCardNode } from "@/components/notebook/TimelineCardNode";
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

function callInsertEmbed(type: string, attrs: Record<string, unknown>) {
  _insertEmbed?.(type, attrs);
}

export function callAddPinnedLines(
  lines: { n: number; text: string }[],
  file: string,
) {
  callInsertEmbed("pinnedLines", {
    file,
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

// ── provider ────────────────────────────────────────────────────────────────

interface ProviderProps {
  documentId: string;
  children: ReactNode;
}

export function NotebookProvider({ documentId, children }: ProviderProps) {
  const initialDoc = useStore(
    (s) => s.doc.files.find((f) => f.id === documentId)?.notebookDoc ?? null,
  );
  const setState = useStore((s) => s.setDoc);

  const saveDoc = useCallback(
    (doc: Record<string, unknown>) => {
      setState((s) => {
        const files = s.files.map((f) =>
          f.id === documentId ? { ...f, notebookDoc: doc } : f,
        );
        return { ...s, files };
      });
    },
    [documentId, setState],
  );

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: "Start writing your analysis…" }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      PinnedLinesNode,
      CompareCardNode,
      TimelineCardNode,
    ],
    content: (initialDoc as object | null) ?? "",
    immediatelyRender: true,
    onUpdate: ({ editor: e }) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        saveDoc(e.getJSON() as Record<string, unknown>);
      }, 400);
    },
  });

  const insertEmbed = useCallback(
    (type: string, attrs: Record<string, unknown>) => {
      if (!editor) return;
      editor.chain().focus().insertContent({ type, attrs }).run();
    },
    [editor],
  );

  useEffect(() => {
    _insertEmbed = insertEmbed;
    return () => {
      _insertEmbed = null;
    };
  }, [insertEmbed]);

  return (
    <NotebookContext.Provider value={{ editor }}>
      {children}
    </NotebookContext.Provider>
  );
}

export function NotebookHost({ children }: { children: ReactNode }) {
  const activeFileId = useStore((s) => s.doc.activeFileId);
  if (!activeFileId) return <>{children}</>;
  return (
    <NotebookProvider key={activeFileId} documentId={activeFileId}>
      {children}
    </NotebookProvider>
  );
}

export function useNotebookEditor(): Editor | null {
  return useContext(NotebookContext)?.editor ?? null;
}
