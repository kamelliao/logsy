import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import type { ColorOption } from "@/lib/palette";

interface ColorComboboxProps {
  value: string;
  options: ColorOption[];
  kind: "text" | "bg";
  placeholder?: string;
  onChange: (color: string) => void;
}

export function ColorCombobox({ value, options, kind, placeholder, onChange }: ColorComboboxProps) {
  const colors = options.map((o) => o.color);
  const byColor = new Map(options.map((o) => [o.color.toLowerCase(), o] as const));
  const labelOf = (hex: string) => byColor.get(hex.toLowerCase())?.name ?? hex;
  const current = byColor.get(value.toLowerCase());

  const swatch = (color: string) =>
    kind === "text"
      ? <span className="cc-swatch cc-swatch-text" style={{ color }}>A</span>
      : <span className="cc-swatch cc-swatch-bg" style={{ background: color }} />;

  return (
    <Combobox.Root
      items={colors}
      value={value}
      onValueChange={(v) => { if (typeof v === "string") onChange(v); }}
      itemToStringLabel={labelOf}
    >
      <Combobox.Trigger className="cc-trigger">
        {swatch(value)}
        <span className="cc-trigger-name">{current?.name ?? "custom"}</span>
        <span className="cc-trigger-hex">{value.toLowerCase()}</span>
        <Combobox.Icon className="cc-chev"><ChevronsUpDown size={14} /></Combobox.Icon>
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner side="bottom" align="start" sideOffset={6} style={{ zIndex: 1000 }}>
          <Combobox.Popup className="menu-pop cc-popup">
            <div className="cc-search">
              <Search size={14} />
              <Combobox.Input placeholder={placeholder ?? "Search color…"} className="cc-input" />
            </div>
            <Combobox.Empty className="cc-empty">No colors found</Combobox.Empty>
            <Combobox.List className="cc-list">
              {(color: string) => (
                <Combobox.Item key={color} value={color} className="cc-item">
                  {swatch(color)}
                  <span className="cc-item-name">{labelOf(color)}</span>
                  <span className="cc-item-hex">{color}</span>
                  <Combobox.ItemIndicator className="cc-check"><Check size={14} /></Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
