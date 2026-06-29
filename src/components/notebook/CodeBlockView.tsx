import { useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronDown, Copy } from "lucide-react";
import { NodeViewWrapper, NodeViewContent } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { CODE_LANGUAGES } from "./lowlight";

const ITEMS = CODE_LANGUAGES.map((l) => l.value);
const LABELS = new Map(CODE_LANGUAGES.map((l) => [l.value, l.label] as const));
const labelOf = (v: string) => LABELS.get(v) ?? v;

export function CodeBlockView({ node, updateAttributes }: NodeViewProps) {
  const language = (node.attrs.language as string) || "plaintext";
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(node.textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <NodeViewWrapper className="cb-card">
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
          className="cb-tool-btn"
          title={copied ? "Copied" : "Copy code"}
          onClick={copy}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <pre className="cb-pre">
        <NodeViewContent<"code"> as="code" className={`language-${language}`} />
      </pre>
    </NodeViewWrapper>
  );
}
