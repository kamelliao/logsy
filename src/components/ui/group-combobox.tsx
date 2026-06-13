import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronDown, Search } from "lucide-react";
import type { FilterGroup } from "../../types";

// Sentinel item value standing in for "no group"; the public API still speaks
// `null` for ungrouped, so it's mapped at the onChange / value boundary.
const NONE = "__none__";

interface GroupComboboxProps {
  value: string | null;
  groups: FilterGroup[];
  onChange: (groupId: string | null) => void;
}

export function GroupCombobox({ value, groups, onChange }: GroupComboboxProps) {
  const items = [NONE, ...groups.map((g) => g.id)];
  const byId = new Map(groups.map((g) => [g.id, g] as const));
  const labelOf = (id: string) => (id === NONE ? "No group (ungrouped)" : byId.get(id)?.name ?? id);
  const current = value ?? NONE;

  return (
    <Combobox.Root
      items={items}
      value={current}
      onValueChange={(v) => { if (typeof v === "string") onChange(v === NONE ? null : v); }}
      itemToStringLabel={labelOf}
    >
      <Combobox.Trigger className="section-select">
        <span className={"ss-label" + (value === null ? " placeholder" : "")}>{labelOf(current)}</span>
        <Combobox.Icon className="ss-chev"><ChevronDown size={15} /></Combobox.Icon>
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner side="bottom" align="start" sideOffset={6} style={{ zIndex: 1000 }}>
          {/* prefix is grpc- (group combobox); gc- is the gen-chip namespace in
              EditModal, whose .gc-name carries its own background */}
          <Combobox.Popup className="grpc-popup">
            <div className="grpc-search">
              <Search size={14} />
              <Combobox.Input placeholder="Search group…" className="grpc-input" />
            </div>
            <Combobox.Empty className="grpc-empty">No groups found</Combobox.Empty>
            <Combobox.List className="grpc-list">
              {(id: string) => (
                <Combobox.Item key={id} value={id} className="grpc-item">
                  <span className={"grpc-name" + (id === NONE ? " placeholder" : "")}>{labelOf(id)}</span>
                  <Combobox.ItemIndicator className="grpc-check"><Check size={14} /></Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
