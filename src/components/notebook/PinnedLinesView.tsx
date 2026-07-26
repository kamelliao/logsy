import { useRef, useEffect, useCallback } from "react";
import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { ArrowUpRight, FileText } from "lucide-react";
import { getPinnedLinesJumpHandler, registerPLSave } from "./PinnedLinesNode";

interface LineEntry {
  n: number;
  text: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildHtmlFromLines(lines: LineEntry[]): string {
  return lines
    .map(
      (l) =>
        // `contenteditable="false"` makes the line number a non-editable atomic
        // island: the text caret can't land in it (no blinking `|`) and, with
        // `user-select:none`, a multi-line drag-selection skips it entirely.
        `<span class="pl-row"><span class="pl-num" contenteditable="false">${l.n}</span><span class="pl-text">${escapeHtml(l.text)}</span></span>`,
    )
    .join("");
}

export function PinnedLinesView({ node, updateAttributes }: NodeViewProps) {
  const {
    file,
    fileId,
    lines: linesJson,
    richContent,
  } = node.attrs as {
    file: string;
    fileId: string;
    lines: string;
    richContent: string;
  };

  const lines: LineEntry[] = (() => {
    try {
      return JSON.parse(linesJson || "[]") as LineEntry[];
    } catch {
      return [];
    }
  })();

  const preRef = useRef<HTMLPreElement>(null);
  const initialized = useRef(false);

  // Set innerHTML once on mount — uncontrolled after that
  useEffect(() => {
    if (preRef.current && !initialized.current) {
      preRef.current.innerHTML = richContent || buildHtmlFromLines(lines);
      // Older cards were saved before line numbers were marked non-editable;
      // normalise on restore so the caret never lands in a number and drag
      // selections skip them (see buildHtmlFromLines).
      preRef.current.querySelectorAll(".pl-num").forEach((el) => {
        (el as HTMLElement).contentEditable = "false";
      });
      initialized.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveContent = useCallback(() => {
    if (preRef.current) {
      updateAttributes({ richContent: preRef.current.innerHTML });
    }
  }, [updateAttributes]);

  // Where the pointer went down, so a drag that ends on a number reads as the text
  // selection it is rather than a click. This has to be measured, not inferred from
  // `window.getSelection()`: the numbers are `contentEditable=false` inside an
  // editable <pre>, so merely clicking one makes the browser select that element —
  // the selection is never collapsed, and testing for that swallowed every click.
  const downAt = useRef<{ x: number; y: number } | null>(null);
  const onBodyMouseDown = useCallback((e: React.MouseEvent<HTMLPreElement>) => {
    downAt.current = { x: e.clientX, y: e.clientY };
  }, []);

  // Click a line number to jump to that line in its source log (switching to the
  // file first, if it isn't the active one). Delegated from the <pre> rather than
  // bound per row: the rows are uncontrolled innerHTML — that's what lets the user's
  // inline styling (`richContent`) survive — so there are no React elements to hang
  // a handler on. The number is read back from the row's text, which keeps the DOM
  // free of extra attributes and so keeps the exported HTML plain text.
  const onBodyClick = useCallback(
    (e: React.MouseEvent<HTMLPreElement>) => {
      const from = downAt.current;
      downAt.current = null;
      const target = e.target as HTMLElement | null;
      const num = target?.closest?.(".pl-num");
      if (!num) return;
      // Slop, not zero: a click almost always drifts a pixel or two.
      if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 4)
        return;
      const n = parseInt(num.textContent ?? "", 10);
      if (!Number.isFinite(n)) return;
      getPinnedLinesJumpHandler()?.(fileId, n);
    },
    [fileId],
  );

  return (
    <NodeViewWrapper className="pl-card" contentEditable={false}>
      <div className="pl-source-bar">
        <span className="pl-source-icon">
          <FileText size={13} />
        </span>
        <span className="pl-source-name">{file}</span>
        <div className="pl-spacer" />
        {lines[0] !== undefined && (
          <button
            className="pl-jump-btn"
            title={`Jump to line ${lines[0].n}`}
            onClick={() => {
              const jump = getPinnedLinesJumpHandler();
              if (jump && lines[0]) jump(fileId, lines[0].n);
            }}
          >
            <ArrowUpRight size={13} />
          </button>
        )}
      </div>
      <pre
        ref={preRef}
        className="pl-body"
        contentEditable={true}
        suppressContentEditableWarning
        onMouseDown={onBodyMouseDown}
        onClick={onBodyClick}
        onKeyDown={(e) => {
          e.stopPropagation();
          const mod = e.ctrlKey || e.metaKey;
          const nav = [
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "Home",
            "End",
            "PageUp",
            "PageDown",
          ];
          if (nav.includes(e.key)) return;
          if (mod && (e.key === "a" || e.key === "c")) return; // select-all / copy
          e.preventDefault(); // block typing, delete, paste, cut, etc.
        }}
        onKeyUp={(e) => e.stopPropagation()}
        onPaste={(e) => e.preventDefault()}
        onDrop={(e) => e.preventDefault()}
        onFocus={() => registerPLSave(saveContent)}
        onBlur={() => {
          saveContent();
          registerPLSave(null);
        }}
      />
    </NodeViewWrapper>
  );
}
