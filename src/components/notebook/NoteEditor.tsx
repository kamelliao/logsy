import { useRef, useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { EditorContent } from "@tiptap/react";
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
  SquareCode,
  Undo2,
  Redo2,
  FileCode2,
  FileJson2,
  Type,
  Highlighter,
  Eraser,
} from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { NodeSelection } from "@tiptap/pm/state";
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
  { label: "預設", value: null },
  { label: "灰色", value: "#787774" },
  { label: "棕色", value: "#9f6b53" },
  { label: "橘色", value: "#d9730d" },
  { label: "黃色", value: "#cb912f" },
  { label: "綠色", value: "#448361" },
  { label: "藍色", value: "#337ea9" },
  { label: "紫色", value: "#9065b0" },
  { label: "粉紅", value: "#c14f8a" },
  { label: "紅色", value: "#d44c47" },
];

const BG_PALETTE = [
  { label: "預設", value: null },
  { label: "灰色背景", value: "#f1f1ef" },
  { label: "棕色背景", value: "#f4eeee" },
  { label: "橘色背景", value: "#fbecdd" },
  { label: "黃色背景", value: "#fbf3db" },
  { label: "綠色背景", value: "#edf3ec" },
  { label: "藍色背景", value: "#e7f3f8" },
  { label: "紫色背景", value: "#f6f3f9" },
  { label: "粉紅背景", value: "#faf1f5" },
  { label: "紅色背景", value: "#fdebec" },
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
        title="文字顏色"
        onMouseDown={(e) => {
          e.preventDefault();
          const sel = window.getSelection();
          if (sel && sel.rangeCount > 0)
            savedRange.current = sel.getRangeAt(0).cloneRange();
        }}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="nb-color-a" style={{ color: active ?? undefined }}>
          A
        </span>
      </button>
      {open && (
        <div className="nb-palette-panel">
          <p className="nb-palette-label">文字顏色</p>
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
        title="背景顏色"
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
          <p className="nb-palette-label">背景顏色</p>
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
  figcaption{font-size:.85rem;color:#666;margin-top:.4rem}
  table{border-collapse:collapse;width:100%}
  td,th{border:1px solid #ccc;padding:4px 8px;font-size:.85rem}
  th{background:#f5f5f5;font-weight:600}
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
  pre.pl-body{margin:0;padding:8px 10px;overflow-x:auto;line-height:1.65;font-family:ui-monospace,monospace;font-size:12.5px}
  .pl-row{display:block}
  .pl-num{display:inline-block;min-width:3.5em;color:#9b9a97;padding-right:.5em;user-select:none}
  .pl-text{color:#1c1f23}
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
  return (
    <div className="nb-toolbar">
      <ToolbarBtn
        title="Bold (Ctrl+B)"
        active={editor.isActive("bold")}
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
        active={editor.isActive("italic")}
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
        active={editor.isActive("underline")}
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
        active={editor.isActive("strike")}
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
        title="移除 Styling"
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
        active={editor.isActive("heading", { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      >
        <Heading1 size={14} />
      </ToolbarBtn>
      <ToolbarBtn
        title="Heading 2"
        active={editor.isActive("heading", { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 size={14} />
      </ToolbarBtn>
      <div className="nb-tsep" />
      <ToolbarBtn
        title="Bullet list"
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List size={14} />
      </ToolbarBtn>
      <ToolbarBtn
        title="Ordered list"
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered size={14} />
      </ToolbarBtn>
      <ToolbarBtn
        title="Blockquote"
        active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote size={14} />
      </ToolbarBtn>
      <ToolbarBtn
        title="Inline code"
        active={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}
      >
        <Code size={14} />
      </ToolbarBtn>
      <ToolbarBtn
        title="Code block"
        active={editor.isActive("codeBlock")}
        onClick={() => {
          if (selectionInPL()) return;
          editor.chain().focus().toggleCodeBlock().run();
        }}
      >
        <SquareCode size={14} />
      </ToolbarBtn>
      <div className="nb-tsep" />
      <ToolbarBtn
        title="Undo (Ctrl+Z)"
        disabled={!editor.can().undo()}
        onClick={() => editor.chain().focus().undo().run()}
      >
        <Undo2 size={14} />
      </ToolbarBtn>
      <ToolbarBtn
        title="Redo (Ctrl+Y)"
        disabled={!editor.can().redo()}
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
    // An atom embed (timeline/compare card) selects as a ProseMirror
    // NodeSelection — its DOM anchor is the .ProseMirror container, not the
    // card, so a `.closest(".tc-card")` test misses it. Guard on the PM
    // selection instead. (pinnedLines is also an atom, but its inner pl-body
    // stays text-editable, so we still want the bubble there.)
    const psel = editor.state.selection;
    if (psel instanceof NodeSelection) {
      const name = psel.node.type.name;
      if (name === "timelineCard" || name === "compareCard") {
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
      <div className="nb-bsep" />

      {/* text color */}
      <div className="nb-bpalette-wrap">
        <button
          className="nb-bbtn"
          title="文字顏色"
          onClick={() => setColorOpen((o) => (o === "text" ? null : "text"))}
        >
          <Type size={12} />
        </button>
        {colorOpen === "text" && (
          <div className="nb-bpalette">
            <p className="nb-palette-label">文字顏色</p>
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
          title="背景顏色"
          onClick={() => setColorOpen((o) => (o === "bg" ? null : "bg"))}
        >
          <Highlighter size={12} />
        </button>
        {colorOpen === "bg" && (
          <div className="nb-bpalette">
            <p className="nb-palette-label">背景顏色</p>
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
        title="移除 Styling"
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

export function NoteEditor({ onGetTitle }: { onGetTitle: () => string }) {
  const editor = useNotebookEditor();
  if (!editor) return null;

  return (
    <div className="nb-editor-wrap">
      <Toolbar editor={editor} onGetTitle={onGetTitle} />
      <div className="nb-content">
        <EditorContent editor={editor} className="nb-prosemirror" />
      </div>
      <FloatingBubble editor={editor} />
    </div>
  );
}
