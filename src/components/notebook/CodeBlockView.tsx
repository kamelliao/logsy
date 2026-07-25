import { useRef, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Popover } from "@base-ui/react/popover";
import {
  Check,
  ChevronDown,
  Copy,
  File,
  Hash,
  ListOrdered,
} from "lucide-react";
import { NodeViewWrapper, NodeViewContent } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { CODE_LANGUAGES } from "./lowlight";

const ITEMS = CODE_LANGUAGES.map((l) => l.value);
const LABELS = new Map(CODE_LANGUAGES.map((l) => [l.value, l.label] as const));
const labelOf = (v: string) => LABELS.get(v) ?? v;

export function CodeBlockView({ node, updateAttributes }: NodeViewProps) {
  const language = (node.attrs.language as string) || "plaintext";
  const showLineNumbers = !!node.attrs.showLineNumbers;
  const fileName = (node.attrs.fileName as string) || "";
  const startLine = Math.max(1, (node.attrs.startLine as number) || 1);
  const highlightLines = (
    Array.isArray(node.attrs.highlightLines) ? node.attrs.highlightLines : []
  ) as number[];
  const hl = new Set(highlightLines);
  const [copied, setCopied] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // Keeps the filename header visible while the name is still empty, e.g. right
  // after toggling on the toolbar's filename button.
  const [nameOpen, setNameOpen] = useState(false);

  // One row per newline-separated line. An empty block still has a single line.
  const lineCount = Math.max(1, node.textContent.split("\n").length);
  // hl stores 1-based positions relative to the block; the gutter shows the
  // absolute number (startLine offset applied at display time). The line range
  // is intentionally not printed in the header — the gutter already shows it.
  const lineNos = Array.from({ length: lineCount }, (_, i) => i + 1);

  // The header carries the filename and is meant to be seen — shown
  // persistently, unlike the hover toolbar, but only once there's a name (or the
  // user just toggled the slot on to type one), keeping bare snippets clean.
  const showName = !!fileName || nameOpen;

  // Filename button is a toggle: off -> open the slot and focus it; on -> drop
  // the name and collapse the header.
  const toggleFileName = () => {
    if (showName) {
      if (fileName) updateAttributes({ fileName: "" });
      setNameOpen(false);
      return;
    }
    setNameOpen(true);
    // Focus after the header mounts on the next paint.
    requestAnimationFrame(() => {
      const el = nameInputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    });
  };

  const setStartLine = (raw: string) => {
    const n = parseInt(raw, 10);
    updateAttributes({ startLine: Number.isFinite(n) && n > 0 ? n : 1 });
  };

  const copy = () => {
    void navigator.clipboard.writeText(node.textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const toggleLineNumbers = () =>
    updateAttributes({ showLineNumbers: !showLineNumbers });

  // Click a gutter number to toggle that line's highlight. Numbers past the
  // current line count are dropped so a shrinking block sheds stale marks.
  const toggleHighlight = (n: number) => {
    const next = hl.has(n)
      ? highlightLines.filter((x) => x !== n)
      : [...highlightLines, n];
    updateAttributes({
      highlightLines: next.filter((x) => x <= lineCount).sort((a, b) => a - b),
    });
  };

  return (
    <NodeViewWrapper
      className="cb-card"
      data-line-numbers={showLineNumbers ? "true" : undefined}
    >
      {/* Notion-style floating controls: overlay the code, surface on hover.
          contentEditable=false keeps them out of the editable text. */}
      <div
        className="cb-toolbar"
        contentEditable={false}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <Combobox.Root
          items={ITEMS}
          value={language}
          onValueChange={(v) => {
            if (typeof v === "string") updateAttributes({ language: v });
          }}
          itemToStringLabel={labelOf}
          // select-style: no search box, so never filter the list by input value
          filter={null}
        >
          <Combobox.Trigger className="cb-lang-trigger">
            <span className="cb-lang-name">{labelOf(language)}</span>
            <Combobox.Icon className="cb-lang-chev">
              <ChevronDown size={13} />
            </Combobox.Icon>
          </Combobox.Trigger>
          <Combobox.Portal>
            <Combobox.Positioner
              side="bottom"
              align="end"
              sideOffset={6}
              style={{ zIndex: 1000 }}
            >
              <Combobox.Popup className="cb-lang-popup">
                <Combobox.List className="cb-lang-list">
                  {(value: string) => (
                    <Combobox.Item
                      key={value}
                      value={value}
                      className="cb-lang-item"
                    >
                      <span className="cb-lang-item-name">
                        {labelOf(value)}
                      </span>
                      <Combobox.ItemIndicator className="cb-lang-check">
                        <Check size={13} />
                      </Combobox.ItemIndicator>
                    </Combobox.Item>
                  )}
                </Combobox.List>
              </Combobox.Popup>
            </Combobox.Positioner>
          </Combobox.Portal>
        </Combobox.Root>
        <span className="cb-tool-sep" />
        <button
          className={"cb-tool-btn" + (showName ? " active" : "")}
          title={showName ? "Remove filename" : "Add filename"}
          onClick={toggleFileName}
        >
          <File size={13} />
        </button>
        <button
          className={"cb-tool-btn" + (showLineNumbers ? " active" : "")}
          title={
            showLineNumbers
              ? "Hide line numbers"
              : "Show line numbers (click a number to highlight)"
          }
          onClick={toggleLineNumbers}
        >
          <Hash size={13} />
        </button>
        {showLineNumbers && (
          <Popover.Root>
            <Popover.Trigger
              className={"cb-tool-btn" + (startLine !== 1 ? " active" : "")}
              title="Set starting line number"
            >
              <ListOrdered size={13} />
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner
                side="bottom"
                align="end"
                sideOffset={6}
                style={{ zIndex: 1000 }}
              >
                <Popover.Popup
                  className="cb-startline-popup"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <label className="cb-startline-label">
                    Start at line
                    <input
                      className="cb-startline-input"
                      type="number"
                      min={1}
                      value={startLine}
                      autoFocus
                      onChange={(e) => setStartLine(e.target.value)}
                    />
                  </label>
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        )}
        <span className="cb-tool-sep" />
        <button
          className="cb-tool-btn"
          title={copied ? "Copied" : "Copy code"}
          onClick={copy}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      {showName && (
        <div className="cb-header" contentEditable={false}>
          <span className="cb-file">
            <File size={12} className="cb-file-icon" />
            <input
              ref={nameInputRef}
              className="cb-file-input"
              value={fileName}
              placeholder="filename"
              spellCheck={false}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => updateAttributes({ fileName: e.target.value })}
              // No blur-collapse: while the filename toggle is on the slot stays
              // put (showing its placeholder) until the toggle is switched off.
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "Escape")
                  e.currentTarget.blur();
              }}
            />
          </span>
        </div>
      )}
      <div className="cb-body">
        {/* Highlight rows sit behind the code. They share the code's line model
            (padding + line-height) so each row lines up with a logical line;
            code never wraps (white-space:pre) so a line is always one row. */}
        <div className="cb-hl-layer" aria-hidden contentEditable={false}>
          {lineNos.map((n) => (
            <div key={n} className={"cb-hl-row" + (hl.has(n) ? " on" : "")} />
          ))}
        </div>
        {showLineNumbers && (
          <div className="cb-gutter" contentEditable={false}>
            {lineNos.map((n) => (
              <button
                key={n}
                type="button"
                className={"cb-ln" + (hl.has(n) ? " on" : "")}
                title={hl.has(n) ? "Remove highlight" : "Highlight this line"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggleHighlight(n)}
              >
                {startLine - 1 + n}
              </button>
            ))}
          </div>
        )}
        <pre className="cb-pre">
          <NodeViewContent<"code">
            as="code"
            className={`language-${language}`}
          />
        </pre>
      </div>
    </NodeViewWrapper>
  );
}
