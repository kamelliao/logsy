import { useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronDown, Copy, Hash } from "lucide-react";
import { NodeViewWrapper, NodeViewContent } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { CODE_LANGUAGES } from "./lowlight";

const ITEMS = CODE_LANGUAGES.map((l) => l.value);
const LABELS = new Map(CODE_LANGUAGES.map((l) => [l.value, l.label] as const));
const labelOf = (v: string) => LABELS.get(v) ?? v;

export function CodeBlockView({ node, updateAttributes }: NodeViewProps) {
  const language = (node.attrs.language as string) || "plaintext";
  const showLineNumbers = !!node.attrs.showLineNumbers;
  const highlightLines = (
    Array.isArray(node.attrs.highlightLines) ? node.attrs.highlightLines : []
  ) as number[];
  const hl = new Set(highlightLines);
  const [copied, setCopied] = useState(false);

  // One row per newline-separated line. An empty block still has a single line.
  const lineCount = Math.max(1, node.textContent.split("\n").length);
  const lineNos = Array.from({ length: lineCount }, (_, i) => i + 1);

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
        <span className="cb-tool-sep" />
        <button
          className="cb-tool-btn"
          title={copied ? "Copied" : "Copy code"}
          onClick={copy}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
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
                {n}
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
