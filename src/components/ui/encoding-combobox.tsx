import { Combobox } from "@base-ui/react/combobox";
import { Check, Search } from "lucide-react";

// Encoding overrides offered by the header pill — the escape hatch for logs that
// auto-detection decodes wrong. Each row shows a friendly `name` (the language /
// region) plus its canonical `value` in small grey — the value doubles as the
// WHATWG label the Rust side's `Encoding::for_label` accepts. A searchable
// combobox lets this list be broad without clutter: the common firmware cases
// (mis-sniffed UTF-16, the East Asian families) plus the long tail (Cyrillic,
// ISO-8859, windows-125x) that the occasional regional/legacy log needs.
const ENCODINGS: { name: string; value: string }[] = [
  { name: "UTF-8", value: "utf-8" },
  { name: "UTF-16 LE", value: "utf-16le" },
  { name: "UTF-16 BE", value: "utf-16be" },
  // "ANSI" is the loose editor term for the legacy Windows code page; map it to
  // windows-1252 (the common Western one). The canonical code shown on the row
  // keeps that mapping visible, and Big5 etc. stay available for other locales.
  { name: "ANSI", value: "windows-1252" },
  { name: "Traditional Chinese", value: "big5" },
  { name: "Simplified Chinese", value: "gbk" },
];

// Sentinel for the "let auto-detection decide" choice (a null override), so it can
// live in the same searchable list as the real encoding labels.
const AUTO = "__auto__";

interface EncodingComboboxProps {
  /** Forced encoding label, or undefined when auto-detecting. */
  value?: string;
  /** Encoding actually used to decode (shown on the trigger). */
  detected?: string;
  /** What auto-detection chose — shown beside the Auto-detect row even while a
   *  manual override is active (when `detected` names the forced encoding). */
  autoDetected?: string;
  /** null = back to auto-detect. */
  onChange: (label: string | null) => void;
}

export function EncodingCombobox({
  value,
  detected,
  autoDetected,
  onChange,
}: EncodingComboboxProps) {
  const items = [AUTO, ...ENCODINGS.map((e) => e.value)];
  const nameByValue = new Map(ENCODINGS.map((e) => [e.value, e.name]));
  const nameOf = (v: string) =>
    v === AUTO ? "Auto-detect" : (nameByValue.get(v) ?? v);
  // Search matches both the friendly name and the canonical code (e.g. "cyrillic"
  // or "koi8" both find KOI8-R). Also what the input shows for a selected item.
  const searchLabelOf = (v: string) =>
    v === AUTO ? "Auto-detect" : `${nameOf(v)} ${v}`;
  const forced = !!value;

  return (
    <Combobox.Root
      items={items}
      value={value ?? AUTO}
      onValueChange={(v) => {
        if (typeof v !== "string") return;
        onChange(v === AUTO ? null : v);
      }}
      itemToStringLabel={searchLabelOf}
    >
      <Combobox.Trigger
        className={"enc-badge enc-badge-btn" + (forced ? " forced" : "")}
        title={
          forced
            ? `Encoding forced to ${detected} — click to change`
            : `Detected encoding: ${detected} — click to override`
        }
      >
        {detected}
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner
          side="bottom"
          align="start"
          sideOffset={6}
          style={{ zIndex: 1000 }}
        >
          <Combobox.Popup className="menu-pop cc-popup">
            <div className="cc-search">
              <Search size={14} />
              <Combobox.Input
                placeholder="Search encoding…"
                className="cc-input"
              />
            </div>
            <Combobox.Empty className="cc-empty">
              No encodings found
            </Combobox.Empty>
            <Combobox.List className="cc-list scroll">
              {(item: string) => (
                <Combobox.Item
                  key={item}
                  value={item}
                  className="cc-item enc-item"
                >
                  <span
                    className="cc-item-name"
                    style={{ textTransform: "none" }}
                  >
                    {nameOf(item)}
                  </span>
                  <span className="cc-item-hex">
                    {item === AUTO ? autoDetected?.toLowerCase() : item}
                  </span>
                  {/* Fixed-width slot reserved on every row (selected or not) so the
                      code column's right edge stays put — the check no longer shoves
                      the active row's code to the left. */}
                  <span className="enc-check">
                    <Combobox.ItemIndicator>
                      <Check size={13} />
                    </Combobox.ItemIndicator>
                  </span>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
