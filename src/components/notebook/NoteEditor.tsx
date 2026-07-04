import { useRef, useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { EditorContent, useEditorState } from "@tiptap/react";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Heading1,
  Heading2,
  List,
  ListOrdered,
  Quote,
  Code,
  CodeXml,
  Table as TableIcon,
  Undo2,
  Redo2,
  FileCode2,
  FileJson2,
  Type,
  Highlighter,
  Eraser,
  GripVertical,
  X,
  PaintBucket,
} from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { NodeSelection } from "@tiptap/pm/state";
import { useStore } from "@/store";
import { useNotebookEditor } from "@/context/NotebookContext";
import { triggerPLSave } from "@/components/notebook/PinnedLinesNode";
import { lowlight } from "@/components/notebook/lowlight";
import type { Editor } from "@tiptap/react";

// ── PinnedLines detection ────────────────────────────────────────────────────

function selectionInPL(): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const node = sel.anchorNode;
  const el =
    node?.nodeType === Node.TEXT_NODE
      ? node.parentElement
      : (node as Element | null);
  return !!el?.closest(".pl-body");
}

function rangeInPL(r: Range): boolean {
  const node = r.commonAncestorContainer;
  const el =
    node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  return !!el?.closest(".pl-body");
}

function restoreRange(r: Range) {
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(r);
  }
}

function plExec(cmd: string, value?: string) {
  document.execCommand(cmd, false, value);
  triggerPLSave();
}

// ── Color palettes (Notion-style) ────────────────────────────────────────────

const TEXT_PALETTE = [
  { label: "Default", value: null },
  { label: "Gray", value: "#787774" },
  { label: "Brown", value: "#9f6b53" },
  { label: "Orange", value: "#d9730d" },
  { label: "Yellow", value: "#cb912f" },
  { label: "Green", value: "#448361" },
  { label: "Blue", value: "#337ea9" },
  { label: "Purple", value: "#9065b0" },
  { label: "Pink", value: "#c14f8a" },
  { label: "Red", value: "#d44c47" },
];

const BG_PALETTE = [
  { label: "Default", value: null },
  { label: "Gray", value: "#f1f1ef" },
  { label: "Brown", value: "#f4eeee" },
  { label: "Orange", value: "#fbecdd" },
  { label: "Yellow", value: "#fbf3db" },
  { label: "Green", value: "#edf3ec" },
  { label: "Blue", value: "#e7f3f8" },
  { label: "Purple", value: "#f6f3f9" },
  { label: "Pink", value: "#faf1f5" },
  { label: "Red", value: "#fdebec" },
];

function TextColorBtn({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const apply = (value: string | null) => {
    const inPL = savedRange.current !== null && rangeInPL(savedRange.current);
    if (inPL && savedRange.current) {
      restoreRange(savedRange.current);
      const fb =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--text")
          .trim() || "#1c1f23";
      plExec("foreColor", value ?? fb);
    } else {
      if (value) {
        editor.chain().focus().setColor(value).run();
      } else {
        editor.chain().focus().unsetColor().run();
      }
    }
    setActive(value);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="nb-palette-wrap">
      <button
        className="nb-tbtn"
        title="Text color"
        onMouseDown={(e) => {
          e.preventDefault();
          const sel = window.getSelection();
          if (sel && sel.rangeCount > 0)
            savedRange.current = sel.getRangeAt(0).cloneRange();
        }}
        onClick={() => setOpen((o) => !o)}
      >
        <Type size={14} style={active ? { color: active } : undefined} />
      </button>
      {open && (
        <div className="nb-palette-panel">
          <p className="nb-palette-label">Text color</p>
          <div className="nb-palette-grid">
            {TEXT_PALETTE.map(({ label, value }) => (
              <button
                key={value ?? "default"}
                className={`nb-pswatch nb-pswatch-text${value === null ? " is-default" : ""}${active === value ? " is-active" : ""}`}
                title={label}
                style={value ? { color: value } : {}}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => apply(value)}
              >
                A
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BgColorBtn({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const apply = (value: string | null) => {
    const inPL = savedRange.current !== null && rangeInPL(savedRange.current);
    if (inPL && savedRange.current) {
      restoreRange(savedRange.current);
      plExec("backColor", value ?? "transparent");
    } else {
      if (value) {
        editor.chain().focus().setHighlight({ color: value }).run();
      } else {
        editor.chain().focus().unsetHighlight().run();
      }
    }
    setActive(value);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="nb-palette-wrap">
      <button
        className="nb-tbtn"
        title="Background color"
        onMouseDown={(e) => {
          e.preventDefault();
          const sel = window.getSelection();
          if (sel && sel.rangeCount > 0)
            savedRange.current = sel.getRangeAt(0).cloneRange();
        }}
        onClick={() => setOpen((o) => !o)}
      >
        <Highlighter size={14} style={active ? { color: active } : undefined} />
      </button>
      {open && (
        <div className="nb-palette-panel">
          <p className="nb-palette-label">Background color</p>
          <div className="nb-palette-grid">
            {BG_PALETTE.map(({ label, value }) => (
              <button
                key={value ?? "default"}
                className={`nb-pswatch nb-pswatch-bg${value === null ? " is-default" : ""}${active === value ? " is-active" : ""}`}
                title={label}
                style={value ? { background: value } : {}}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => apply(value)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Export helpers ───────────────────────────────────────────────────────────

/** Minimal hast → HTML string serializer. lowlight only emits `span` elements
 *  (with a className array) and text nodes, so this is all we need. */
function hastToHtml(node: HastNode): string {
  if (node.type === "text") {
    return node.value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  const children = ("children" in node ? node.children : [])
    .map(hastToHtml)
    .join("");
  if (node.type === "root") return children;
  const cls = node.properties?.className?.join(" ");
  return `<span${cls ? ` class="${cls}"` : ""}>${children}</span>`;
}

type HastNode =
  | { type: "text"; value: string }
  | { type: "root"; children: HastNode[] }
  | {
      type: "element";
      tagName: string;
      properties?: { className?: string[] };
      children: HastNode[];
    };

/** getHTML() emits plain `<pre><code>` — highlighting lives in editor
 *  decorations, not the document model — so re-run lowlight over the exported
 *  markup (reusing the editor's instance, only our registered languages). */
function highlightExportedCode(html: string): string {
  if (!/language-/.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("pre code").forEach((code) => {
    const m = (code.getAttribute("class") || "").match(/language-([\w-]+)/);
    const lang = m?.[1];
    const text = code.textContent || "";
    if (lang && lang !== "plaintext" && lowlight.registered(lang)) {
      code.innerHTML = hastToHtml(lowlight.highlight(lang, text) as HastNode);
      code.classList.add("hljs");
    }
  });
  return doc.body.innerHTML;
}

async function exportHTML(editor: Editor, title: string) {
  const path = await save({
    defaultPath: `${title}.html`,
    filters: [{ name: "HTML", extensions: ["html"] }],
  });
  if (typeof path !== "string") return;
  const body = highlightExportedCode(editor.getHTML());
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{max-width:820px;margin:2rem auto;padding:0 1rem;font-family:-apple-system,"Noto Sans TC",sans-serif;line-height:1.7}
  h1,h2,h3{line-height:1.3}
  figure{margin:1.5rem 0}
  figure img{max-width:100%;border:1px solid #ddd;border-radius:6px}
  img{max-width:100%;height:auto;border:1px solid #ddd;border-radius:6px;display:block;margin:.8rem 0}
  figcaption{font-size:.85rem;color:#666;margin-top:.4rem}
  .tableWrapper{overflow-x:auto;margin:1rem 0}
  table{border-collapse:collapse;width:100%}
  td,th{border:1px solid #ccc;padding:6px 9px;font-size:.85rem;vertical-align:top}
  th{background:#f5f5f5;font-weight:600;text-align:left}
  pre{background:#f6f8fa;padding:1rem;border-radius:6px;overflow-x:auto;font-family:ui-monospace,monospace;font-size:.85rem}
  pre code{background:none;padding:0}
  blockquote{border-left:3px solid #ccc;margin:0;padding-left:1rem;color:#555}
  .hljs-comment,.hljs-quote{color:#6e7781;font-style:italic}
  .hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-type{color:#cf222e}
  .hljs-string,.hljs-regexp,.hljs-meta .hljs-string{color:#0a3069}
  .hljs-number,.hljs-built_in,.hljs-symbol,.hljs-attr,.hljs-attribute,.hljs-variable,.hljs-template-variable{color:#0550ae}
  .hljs-title,.hljs-section,.hljs-name{color:#8250df}
  .hljs-tag{color:#116329}
  .hljs-meta{color:#6e7781}
  .hljs-deletion{color:#82071e;background:#ffebe9}
  .hljs-addition{color:#116329;background:#dafbe1}
  .hljs-emphasis{font-style:italic}
  .hljs-strong{font-weight:600}
  [data-type="pinned-lines"]{border:1px solid #e2e8f0;border-radius:6px;overflow:hidden;margin:1rem 0}
  [data-type="compare-card"]{border:1px solid #e2e8f0;border-radius:6px;overflow:hidden;margin:1rem 0}
  [data-type="timeline-card"]{margin:1rem 0}
  .pl-source-bar{display:flex;align-items:center;gap:6px;padding:5px 10px;background:#f8f9fa;border-bottom:1px solid #e2e8f0;font-size:12px;color:#555}
  pre.pl-body{margin:0;padding:6px 10px 8px;line-height:1.55;font-family:ui-monospace,monospace;font-size:12.5px;white-space:pre-wrap}
  .pl-row{display:flex;gap:10px}
  .pl-num{min-width:4ch;text-align:right;color:#9b9a97;flex-shrink:0;user-select:none}
  .pl-text{color:#1c1f23;min-width:0;overflow-wrap:anywhere;word-break:break-word}
  strong,b{font-weight:800}
  /* compare-card: same bordered "log block" chrome as pinned-lines (header bar +
     a borderless, mono, horizontally-ruled table) instead of the generic full
     table styling above. */
  [data-type="compare-card"]{overflow-x:auto}
  .cc-source-bar{display:flex;align-items:center;gap:6px;padding:5px 10px;background:#f8f9fa;border-bottom:1px solid #e2e8f0;font-size:12px;color:#555}
  .cc-table{width:100%;border-collapse:collapse;font-family:ui-monospace,monospace;font-size:12.5px}
  .cc-table th,.cc-table td{border:none;border-bottom:1px solid #eee;padding:3px 10px;font-size:12.5px;text-align:left;white-space:nowrap;vertical-align:top}
  .cc-table th{background:#fff;font-family:-apple-system,"Noto Sans TC",sans-serif;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#555}
  .cc-table tr:last-child td{border-bottom:none}
  .cc-ln,.cc-ln-h{color:#9b9a97;user-select:none}
  .cc-caption{display:block;padding:5px 10px;border-top:1px solid #e2e8f0;font-size:12.5px;color:#555}
</style>
</head>
<body>
<h1>${esc(title)}</h1>
${body}
</body>
</html>`;
  try {
    await invoke("write_text_file", { path, contents: html });
    toast.success("Notebook exported");
  } catch (e) {
    toast.error("Export failed: " + String(e));
  }
}

async function exportJSON(editor: Editor, title: string) {
  const path = await save({
    defaultPath: `${title}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (typeof path !== "string") return;
  const json = JSON.stringify(editor.getJSON(), null, 2);
  try {
    await invoke("write_text_file", { path, contents: json });
    toast.success("Notebook exported");
  } catch (e) {
    toast.error("Export failed: " + String(e));
  }
}

// ── Toolbar ──────────────────────────────────────────────────────────────────

function ToolbarBtn({
  title,
  active,
  disabled,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={"nb-tbtn" + (active ? " active" : "")}
      title={title}
      disabled={disabled}
      onMouseDown={(e) => {
        e.preventDefault(); // keep editor / pl-body focus
        onClick();
      }}
    >
      {children}
    </button>
  );
}

function Toolbar({
  editor,
  onGetTitle,
}: {
  editor: Editor;
  onGetTitle: () => string;
}) {
  // v3's useEditor no longer re-renders per transaction, so the button states
  // must subscribe explicitly — this re-renders just the toolbar (deep-equal
  // gated), not the provider subtree like the old per-transaction render did.
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      bulletList: e.isActive("bulletList"),
      orderedList: e.isActive("orderedList"),
      blockquote: e.isActive("blockquote"),
      codeBlock: e.isActive("codeBlock"),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  return (
    <div className="nb-toolbar">
      <ToolbarBtn
        title="Bold (Ctrl+B)"
        active={st.bold}
        onClick={() =>
          selectionInPL()
            ? plExec("bold")
            : editor.chain().focus().toggleBold().run()
        }
      >
        <Bold size={14} />
      </ToolbarBtn>
      <ToolbarBtn
        title="Italic (Ctrl+I)"
        active={st.italic}
        onClick={() =>
          selectionInPL()
            ? plExec("italic")
            : editor.chain().focus().toggleItalic().run()
        }
      >
        <Italic size={14} />
      </ToolbarBtn>
      <ToolbarBtn
        title="Underline (Ctrl+U)"
        active={st.underline}
        onClick={() =>
          selectionInPL()
            ? plExec("underline")
            : editor.chain().focus().toggleUnderline().run()
        }
      >
        <Underline size={14} />
      </ToolbarBtn>
      <ToolbarBtn
        title="Strikethrough"
        active={st.strike}
        onClick={() =>
          selectionInPL()
            ? plExec("strikeThrough")
            : editor.chain().focus().toggleStrike().run()
        }
      >
        <Strikethrough size={14} />
      </ToolbarBtn>
      <TextColorBtn editor={editor} />
      <BgColorBtn editor={editor} />
      <ToolbarBtn
        title="Clear formatting"
        onClick={() =>
          selectionInPL()
            ? plExec("removeFormat")
            : editor.chain().focus().unsetAllMarks().run()
        }
      >
        <Eraser size={14} />
      </ToolbarBtn>
      <div className="nb-tsep" />
      <ToolbarBtn
        title="Heading 1"
        active={st.h1}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      >
        <Heading1 size={14} />
      </ToolbarBtn>
      <ToolbarBtn
        title="Heading 2"
        active={st.h2}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 size={14} />
      </ToolbarBtn>
      <div className="nb-tsep" />
      <ToolbarBtn
        title="Bullet list"
        active={st.bulletList}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List size={14} />
      </ToolbarBtn>
      <ToolbarBtn
        title="Ordered list"
        active={st.orderedList}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered size={14} />
      </ToolbarBtn>
      <ToolbarBtn
        title="Blockquote"
        active={st.blockquote}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote size={14} />
      </ToolbarBtn>
      <ToolbarBtn
        title="Code block"
        active={st.codeBlock}
        onClick={() => {
          if (selectionInPL()) return;
          editor.chain().focus().toggleCodeBlock().run();
        }}
      >
        <CodeXml size={14} />
      </ToolbarBtn>
      <ToolbarBtn
        title="Insert table"
        onClick={() => {
          if (selectionInPL()) return;
          editor
            .chain()
            .focus()
            .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
            .run();
        }}
      >
        <TableIcon size={14} />
      </ToolbarBtn>
      <div className="nb-tsep" />
      <ToolbarBtn
        title="Undo (Ctrl+Z)"
        disabled={!st.canUndo}
        onClick={() => editor.chain().focus().undo().run()}
      >
        <Undo2 size={14} />
      </ToolbarBtn>
      <ToolbarBtn
        title="Redo (Ctrl+Y)"
        disabled={!st.canRedo}
        onClick={() => editor.chain().focus().redo().run()}
      >
        <Redo2 size={14} />
      </ToolbarBtn>
      <div className="nb-tsep nb-tsep-push" />
      <button
        className="nb-tbtn"
        title="Export as HTML (self-contained, shareable)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          void exportHTML(editor, onGetTitle());
        }}
      >
        <FileCode2 size={14} />
      </button>
      <button
        className="nb-tbtn"
        title="Export as JSON (re-importable)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          void exportJSON(editor, onGetTitle());
        }}
      >
        <FileJson2 size={14} />
      </button>
    </div>
  );
}

// ── Floating selection bubble ─────────────────────────────────────────────────

function FloatingBubble({ editor }: { editor: Editor }) {
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [colorOpen, setColorOpen] = useState<"text" | "bg" | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);
  const isPLRef = useRef(false);

  const syncPos = useCallback(() => {
    // Clicking a block's drag grip selects it as a ProseMirror NodeSelection.
    // The inline-formatting bubble only makes sense for a plain text block, so
    // hide it for a NodeSelection of anything else (image, table, code block,
    // divider, cards…). (pinnedLines is an atom too, but its inner pl-body stays
    // text-editable, so a text-range selection there still gets the bubble.)
    const psel = editor.state.selection;
    if (psel instanceof NodeSelection) {
      const name = psel.node.type.name;
      if (name !== "paragraph" && name !== "heading") {
        setAnchor(null);
        setColorOpen(null);
        return;
      }
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setAnchor(null);
      setColorOpen(null);
      return;
    }
    const node = sel.anchorNode;
    const el =
      node?.nodeType === Node.TEXT_NODE
        ? node.parentElement
        : (node as Element | null);
    const inPL = !!el?.closest(".pl-body");
    const inEmbed = !!el?.closest(".tc-card, .cc-card");
    const inEditor = !!el?.closest(".ProseMirror");
    if (!inPL && !inEditor) {
      setAnchor(null);
      return;
    }
    if (inEmbed) {
      setAnchor(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      setAnchor(null);
      return;
    }
    savedRange.current = range.cloneRange();
    isPLRef.current = inPL;
    setAnchor({ top: rect.top - 48, left: rect.left + rect.width / 2 });
  }, [editor]);

  useEffect(() => {
    document.addEventListener("selectionchange", syncPos);
    editor.on("selectionUpdate", syncPos);
    const onScroll = () => {
      setAnchor(null);
      setColorOpen(null);
    };
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("selectionchange", syncPos);
      editor.off("selectionUpdate", syncPos);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [editor, syncPos]);

  if (!anchor) return null;

  const onBubbleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0)
      savedRange.current = sel.getRangeAt(0).cloneRange();
  };

  const fmt = (tiptapFn: () => void, plCmd: string) => {
    if (isPLRef.current) {
      if (savedRange.current) restoreRange(savedRange.current);
      plExec(plCmd);
    } else {
      tiptapFn();
    }
  };

  const applyColor = (type: "text" | "bg", value: string | null) => {
    if (isPLRef.current && savedRange.current) {
      restoreRange(savedRange.current);
      if (type === "text") {
        const fb =
          getComputedStyle(document.documentElement)
            .getPropertyValue("--text")
            .trim() || "#1c1f23";
        plExec("foreColor", value ?? fb);
      } else {
        plExec("backColor", value ?? "transparent");
      }
    } else {
      if (type === "text") {
        if (value) {
          editor.chain().focus().setColor(value).run();
        } else {
          editor.chain().focus().unsetColor().run();
        }
      } else {
        if (value) {
          editor.chain().focus().setHighlight({ color: value }).run();
        } else {
          editor.chain().focus().unsetHighlight().run();
        }
      }
    }
    setColorOpen(null);
  };

  return createPortal(
    <div
      ref={bubbleRef}
      className="nb-bubble"
      style={{ top: anchor.top, left: anchor.left }}
      onMouseDown={onBubbleMouseDown}
    >
      <button
        className="nb-bbtn"
        title="Bold"
        onClick={() =>
          fmt(() => editor.chain().focus().toggleBold().run(), "bold")
        }
      >
        <Bold size={13} />
      </button>
      <button
        className="nb-bbtn"
        title="Italic"
        onClick={() =>
          fmt(() => editor.chain().focus().toggleItalic().run(), "italic")
        }
      >
        <Italic size={13} />
      </button>
      <button
        className="nb-bbtn"
        title="Underline"
        onClick={() =>
          fmt(() => editor.chain().focus().toggleUnderline().run(), "underline")
        }
      >
        <Underline size={13} />
      </button>
      <button
        className="nb-bbtn"
        title="Strikethrough"
        onClick={() =>
          fmt(
            () => editor.chain().focus().toggleStrike().run(),
            "strikeThrough",
          )
        }
      >
        <Strikethrough size={13} />
      </button>
      <button
        className="nb-bbtn"
        title="Inline code"
        onClick={() => {
          // Inline code is an editor-only mark (pl-body has no execCommand for
          // it), so skip when the selection is in a pinned-lines block.
          if (!isPLRef.current) editor.chain().focus().toggleCode().run();
        }}
      >
        <Code size={13} />
      </button>
      <div className="nb-bsep" />

      {/* text color */}
      <div className="nb-bpalette-wrap">
        <button
          className="nb-bbtn"
          title="Text color"
          onClick={() => setColorOpen((o) => (o === "text" ? null : "text"))}
        >
          <Type size={12} />
        </button>
        {colorOpen === "text" && (
          <div className="nb-bpalette">
            <p className="nb-palette-label">Text color</p>
            <div className="nb-palette-grid">
              {TEXT_PALETTE.map(({ label, value }) => (
                <button
                  key={value ?? "default"}
                  className={`nb-pswatch nb-pswatch-text${value === null ? " is-default" : ""}`}
                  title={label}
                  style={value ? { color: value } : {}}
                  onClick={() => applyColor("text", value)}
                >
                  A
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* background color */}
      <div className="nb-bpalette-wrap">
        <button
          className="nb-bbtn"
          title="Background color"
          onClick={() => setColorOpen((o) => (o === "bg" ? null : "bg"))}
        >
          <Highlighter size={12} />
        </button>
        {colorOpen === "bg" && (
          <div className="nb-bpalette">
            <p className="nb-palette-label">Background color</p>
            <div className="nb-palette-grid">
              {BG_PALETTE.map(({ label, value }) => (
                <button
                  key={value ?? "default"}
                  className={`nb-pswatch nb-pswatch-bg${value === null ? " is-default" : ""}`}
                  title={label}
                  style={value ? { background: value } : {}}
                  onClick={() => applyColor("bg", value)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="nb-bsep" />
      <button
        className="nb-bbtn"
        title="Clear formatting"
        onClick={() => {
          if (isPLRef.current && savedRange.current) {
            restoreRange(savedRange.current);
            plExec("removeFormat");
          } else {
            editor.chain().focus().unsetAllMarks().run();
          }
        }}
      >
        <Eraser size={13} />
      </button>
    </div>,
    document.body,
  );
}

// ── block drag (pointer-based) ───────────────────────────────────────────────
// The @tiptap drag-handle plugin gives us hover-tracking + positioning, but its
// actual drag is native HTML5 DnD — which Tauri's dragDropEnabled (needed for
// OS file drops onto the window) swallows on Windows WebView2. So the grip
// implements the move itself with pointer events: track the hovered block via
// onNodeChange, and on drag compute the drop slot with posAtCoords.

function useBlockDrag(editor: Editor) {
  const hovered = useRef<{ pos: number } | null>(null);

  const onNodeChange = useCallback(
    ({ node, pos }: { node: unknown; pos: number }) => {
      hovered.current = node && pos >= 0 ? { pos } : null;
    },
    [],
  );

  // A click (no drag) on the grip selects the whole block as a NodeSelection
  // (the blue rect) AND focuses the editor, so native Ctrl+C copies it through
  // ProseMirror's own clipboard serializer (perfect paste round-trip).
  const selectBlock = useCallback(
    (pos: number) => {
      const view = editor.view;
      const node = view.state.doc.nodeAt(pos);
      if (!node) return;
      try {
        view.dispatch(
          view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)),
        );
      } catch {
        return; // pos no longer selectable (doc changed) — skip
      }
      view.focus();
    },
    [editor],
  );

  // Delete the block under the drag handle (the gutter X button).
  const deleteHovered = useCallback(() => {
    const src = hovered.current;
    if (!src) return;
    const view = editor.view;
    const node = view.state.doc.nodeAt(src.pos);
    if (node)
      view.dispatch(view.state.tr.delete(src.pos, src.pos + node.nodeSize));
    view.focus();
  }, [editor]);

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      const src = hovered.current;
      if (!src) return;
      e.preventDefault(); // no text selection / native drag while moving
      const view = editor.view;
      const container = view.dom.closest(".nb-content") as HTMLElement | null;
      if (!container) return;

      let indicator: HTMLDivElement | null = null;
      let target: { pos: number; before: boolean } | null = null;
      let moved = false;
      const startY = e.clientY;
      const clearIndicator = () => {
        indicator?.remove();
        indicator = null;
      };

      const onMove = (ev: PointerEvent) => {
        if (!moved && Math.abs(ev.clientY - startY) < 4) return; // click, not drag
        moved = true;
        document.body.classList.add("nb-block-dragging");
        // Probe the CONTENT column, not the pointer's X: the grip sits in the
        // left margin where posAtCoords finds nothing, so a straight up/down
        // drag along the handle should still resolve a drop row. Only clientY
        // (vertical) tracks the pointer.
        const pmRect = view.dom.getBoundingClientRect();
        const probeX = pmRect.left + pmRect.width / 2;
        const hit = view.posAtCoords({ left: probeX, top: ev.clientY });
        if (!hit) {
          target = null;
          clearIndicator();
          return;
        }
        // Top-level drop slot: the doc child under the pointer (atoms report
        // themselves via `inside`), split into before/after at its midline.
        const $pos = view.state.doc.resolve(hit.pos);
        const blockPos = $pos.depth > 0 ? $pos.before(1) : hit.inside;
        const node = blockPos >= 0 ? view.state.doc.nodeAt(blockPos) : null;
        const dom =
          blockPos >= 0 ? (view.nodeDOM(blockPos) as HTMLElement | null) : null;
        if (blockPos < 0 || !node || !dom || dom.nodeType !== 1) {
          target = null;
          clearIndicator();
          return;
        }
        const rect = dom.getBoundingClientRect();
        const before = ev.clientY < rect.top + rect.height / 2;
        target = { pos: blockPos, before };
        // "Insert after A" and "insert before B" are the SAME slot (their doc
        // positions are equal). Draw one line centred in the inter-block gap so
        // both sides of the midline resolve to the identical y — no duplicate
        // top/bottom lines flickering across the boundary. Falls back to the
        // block edge at the doc's very start / end (no neighbour to average).
        const $b = view.state.doc.resolve(blockPos);
        let lineY: number;
        if (before) {
          const prev = $b.nodeBefore;
          const prevDom = prev
            ? (view.nodeDOM(blockPos - prev.nodeSize) as HTMLElement | null)
            : null;
          const prevBottom = prevDom?.getBoundingClientRect().bottom;
          lineY =
            prevBottom !== undefined ? (prevBottom + rect.top) / 2 : rect.top;
        } else {
          const nextPos = blockPos + node.nodeSize;
          const nextNode = view.state.doc.nodeAt(nextPos);
          const nextDom = nextNode
            ? (view.nodeDOM(nextPos) as HTMLElement | null)
            : null;
          const nextTop = nextDom?.getBoundingClientRect().top;
          lineY =
            nextTop !== undefined ? (rect.bottom + nextTop) / 2 : rect.bottom;
        }
        if (!indicator) {
          indicator = document.createElement("div");
          indicator.className = "nb-drop-indicator";
          container.appendChild(indicator);
        }
        const cRect = container.getBoundingClientRect();
        indicator.style.top = `${lineY - cRect.top + container.scrollTop - 1}px`;
        indicator.style.left = `${rect.left - cRect.left}px`;
        indicator.style.width = `${rect.width}px`;
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.classList.remove("nb-block-dragging");
        clearIndicator();
        if (!moved) {
          // No drag: treat as a click — select the block (enables Ctrl+C).
          selectBlock(src.pos);
          return;
        }
        if (!target) return;
        const state = view.state;
        const node = state.doc.nodeAt(src.pos);
        const targetNode = state.doc.nodeAt(target.pos);
        if (!node || !targetNode) return;
        let insertPos = target.before
          ? target.pos
          : target.pos + targetNode.nodeSize;
        // Dropping onto / directly around itself is a no-op.
        if (insertPos >= src.pos && insertPos <= src.pos + node.nodeSize)
          return;
        const tr = state.tr.delete(src.pos, src.pos + node.nodeSize);
        insertPos = tr.mapping.map(insertPos);
        tr.insert(insertPos, node);
        view.dispatch(tr);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [editor, selectBlock],
  );

  return { onNodeChange, startDrag, deleteHovered };
}

// ── table toolbar (add / remove rows & columns) ──────────────────────────────
// A floating bar pinned above the table the caret is in. prosemirror-tables
// gives us the commands (addRowAfter etc.); this surfaces them since there is
// no other affordance to grow a table.

function findTableRect(editor: Editor): DOMRect | null {
  if (!editor.isActive("table")) return null;
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "table") {
      const dom = editor.view.nodeDOM($from.before(d));
      const el =
        dom instanceof HTMLElement
          ? (dom.closest(".tableWrapper") ?? dom)
          : null;
      return el ? el.getBoundingClientRect() : null;
    }
  }
  return null;
}

// Delete-row glyph = the svgrepo "Edit / Delete_Row" path (an open rounded rect
// = a row, + a minus at bottom-right). Delete-column is the same path transposed
// (x↔y) into a portrait column with the minus on its right. currentColor →
// they redden on hover.
function DeleteRowIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 16H20M21 10V9C21 7.89543 20.1046 7 19 7H5C3.89543 7 3 7.89543 3 9V11C3 12.1046 3.89543 13 5 13H11" />
    </svg>
  );
}
function DeleteColumnIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M16 14V20M10 21H9C7.89543 21 7 20.1046 7 19V5C7 3.89543 7.89543 3 9 3H11C12.1046 3 13 3.89543 13 5V11" />
    </svg>
  );
}

// Insert-row/column glyphs, lucide-style line-art to match the delete icons and
// the rest of the toolbar: an outlined 2×2 grid = the existing table, and a `+`
// on the edge where the new row / column lands (plus position = direction).
const iconGProps = {
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
function InsertColLeftIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      {...iconGProps}
    >
      <rect x="10" y="4" width="11" height="16" rx="1.5" />
      <line x1="15.5" y1="4" x2="15.5" y2="20" />
      <line x1="10" y1="12" x2="21" y2="12" />
      <line x1="2" y1="12" x2="7" y2="12" />
      <line x1="4.5" y1="9.5" x2="4.5" y2="14.5" />
    </svg>
  );
}
function InsertColRightIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      {...iconGProps}
    >
      <rect x="3" y="4" width="11" height="16" rx="1.5" />
      <line x1="8.5" y1="4" x2="8.5" y2="20" />
      <line x1="3" y1="12" x2="14" y2="12" />
      <line x1="17" y1="12" x2="22" y2="12" />
      <line x1="19.5" y1="9.5" x2="19.5" y2="14.5" />
    </svg>
  );
}
function InsertRowAboveIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      {...iconGProps}
    >
      <rect x="4" y="10" width="16" height="11" rx="1.5" />
      <line x1="4" y1="15.5" x2="20" y2="15.5" />
      <line x1="12" y1="10" x2="12" y2="21" />
      <line x1="9.5" y1="4.5" x2="14.5" y2="4.5" />
      <line x1="12" y1="2" x2="12" y2="7" />
    </svg>
  );
}
function InsertRowBelowIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      {...iconGProps}
    >
      <rect x="4" y="3" width="16" height="11" rx="1.5" />
      <line x1="4" y1="8.5" x2="20" y2="8.5" />
      <line x1="12" y1="3" x2="12" y2="14" />
      <line x1="9.5" y1="19.5" x2="14.5" y2="19.5" />
      <line x1="12" y1="17" x2="12" y2="22" />
    </svg>
  );
}

// Palette for tinting the selected table cell(s). Reuses the highlight BG hues.
const CELL_BG_PALETTE = [
  { label: "None", value: null },
  { label: "Gray", value: "#f1f1ef" },
  { label: "Brown", value: "#f4eeee" },
  { label: "Orange", value: "#fbecdd" },
  { label: "Yellow", value: "#fbf3db" },
  { label: "Green", value: "#edf3ec" },
  { label: "Blue", value: "#e7f3f8" },
  { label: "Purple", value: "#f6f3f9" },
  { label: "Pink", value: "#faf1f5" },
  { label: "Red", value: "#fdebec" },
];

function CellColorBtn({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const apply = (value: string | null) => {
    editor.chain().focus().setCellAttribute("backgroundColor", value).run();
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="nb-ttcolor">
      <button
        className="nb-ttbtn"
        title="Cell background color"
        onClick={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
      >
        <PaintBucket size={15} />
      </button>
      {open && (
        <div className="nb-ttswatches">
          {CELL_BG_PALETTE.map((c) => (
            <button
              key={c.label}
              className={"nb-ttswatch" + (c.value === null ? " is-none" : "")}
              title={c.label}
              style={c.value ? { background: c.value } : undefined}
              onClick={(e) => {
                e.preventDefault();
                apply(c.value);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TableToolbar({ editor }: { editor: Editor }) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    const sync = () => setRect(findTableRect(editor));
    editor.on("selectionUpdate", sync);
    editor.on("transaction", sync);
    window.addEventListener("scroll", sync, true);
    window.addEventListener("resize", sync);
    return () => {
      editor.off("selectionUpdate", sync);
      editor.off("transaction", sync);
      window.removeEventListener("scroll", sync, true);
      window.removeEventListener("resize", sync);
    };
  }, [editor]);

  if (!rect) return null;

  const run = (fn: (e: Editor) => void) => (ev: React.MouseEvent) => {
    ev.preventDefault();
    fn(editor);
  };

  return createPortal(
    <div
      className="nb-table-toolbar"
      style={{ top: rect.top - 38, left: rect.left }}
      onMouseDown={(e) => e.preventDefault()} // keep the table selection
    >
      <button
        className="nb-ttbtn"
        title="Insert column left"
        onClick={run((e) => e.chain().focus().addColumnBefore().run())}
      >
        <InsertColLeftIcon size={15} />
      </button>
      <button
        className="nb-ttbtn"
        title="Insert column right"
        onClick={run((e) => e.chain().focus().addColumnAfter().run())}
      >
        <InsertColRightIcon size={15} />
      </button>
      <span className="nb-ttsep" />
      <button
        className="nb-ttbtn"
        title="Insert row above"
        onClick={run((e) => e.chain().focus().addRowBefore().run())}
      >
        <InsertRowAboveIcon size={15} />
      </button>
      <button
        className="nb-ttbtn"
        title="Insert row below"
        onClick={run((e) => e.chain().focus().addRowAfter().run())}
      >
        <InsertRowBelowIcon size={15} />
      </button>
      <span className="nb-ttsep" />
      <CellColorBtn editor={editor} />
      <span className="nb-ttsep" />
      <button
        className="nb-ttbtn is-danger"
        title="Delete row"
        onClick={run((e) => e.chain().focus().deleteRow().run())}
      >
        <DeleteRowIcon size={15} />
      </button>
      <button
        className="nb-ttbtn is-danger"
        title="Delete column"
        onClick={run((e) => e.chain().focus().deleteColumn().run())}
      >
        <DeleteColumnIcon size={15} />
      </button>
    </div>,
    document.body,
  );
}

// ── page title (Notion-style) ────────────────────────────────────────────────
// A permanent, editable H1 above the document, two-way bound to the notebook's
// name (the switcher, exports and this header all show the same string). It is
// app chrome, not a ProseMirror node — so it can't be deleted, dragged, or
// captured into the doc JSON.

function NotebookTitle({ editor }: { editor: Editor }) {
  const activeId = useStore((s) => s.activeNotebookId);
  const name = useStore(
    (s) => s.notebooks.find((n) => n.id === s.activeNotebookId)?.name ?? "",
  );
  const renameNotebook = useStore((s) => s.renameNotebook);
  // renameNotebook keeps the old name when handed an empty string (so a blur
  // can't wipe it) — a local draft lets the field go visibly empty mid-edit.
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [activeId]);

  return (
    <div className="nb-title-wrap">
      <input
        className="nb-title"
        value={draft ?? name}
        placeholder="Untitled"
        spellCheck={false}
        onChange={(e) => {
          setDraft(e.target.value);
          if (activeId && e.target.value.trim())
            renameNotebook(activeId, e.target.value);
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "ArrowDown") {
            e.preventDefault();
            editor.chain().focus("start").run();
          }
        }}
      />
    </div>
  );
}

export function NoteEditor({ onGetTitle }: { onGetTitle: () => string }) {
  const editor = useNotebookEditor();
  if (!editor) return null;
  return <NoteEditorInner editor={editor} onGetTitle={onGetTitle} />;
}

function NoteEditorInner({
  editor,
  onGetTitle,
}: {
  editor: Editor;
  onGetTitle: () => string;
}) {
  const { onNodeChange, startDrag, deleteHovered } = useBlockDrag(editor);

  return (
    <div className="nb-editor-wrap">
      <Toolbar editor={editor} onGetTitle={onGetTitle} />
      <div className="nb-content">
        <NotebookTitle editor={editor} />
        <EditorContent editor={editor} className="nb-prosemirror" />
        {/* Gutter controls: an X to delete the block + a grip to drag it (click
            the grip to select the block, which enables Ctrl+C copy). */}
        <DragHandle
          editor={editor}
          className="nb-drag-handle"
          onNodeChange={onNodeChange}
        >
          <button
            className="nb-drag-del"
            title="Delete block"
            onPointerDown={(ev) => ev.preventDefault()} // don't blur/steal focus
            onClick={deleteHovered}
          >
            <X size={14} />
          </button>
          <div
            className="nb-drag-grip"
            onPointerDown={startDrag}
            // Kill the plugin's native HTML5 drag: pointer drag is the only
            // path, so browser dev and the Tauri app behave identically.
            onDragStart={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
            }}
          >
            <GripVertical size={15} />
          </div>
        </DragHandle>
      </div>
      <TableToolbar editor={editor} />
      <FloatingBubble editor={editor} />
    </div>
  );
}
