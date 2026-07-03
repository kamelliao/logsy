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
        `<span class="pl-row"><span class="pl-num">${l.n}</span><span class="pl-text">${escapeHtml(l.text)}</span></span>`,
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
      initialized.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveContent = useCallback(() => {
    if (preRef.current) {
      updateAttributes({ richContent: preRef.current.innerHTML });
    }
  }, [updateAttributes]);

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
