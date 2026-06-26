import { Combobox } from "@base-ui/react/combobox";
import { Check, PackagePlus, Search } from "lucide-react";
import type { FilterPack } from "@/types";
import { Button } from "@/components/ui/button";

// Sentinel item that stands for "save the selection as a brand-new pack". Kept as
// the first entry so creating a pack and adding to one live behind a single
// control (no separate "Save pack" button needed).
const NEW = "__new__";

/**
 * Select-bar "Add to pack" control: a searchable picker over the pack library
 * (so choosing a target stays quick even with many packs), with "Save as new
 * pack…" pinned at the top. Carries no retained value — the trigger always reads
 * "Add to pack"; `onPick` fires for an existing pack, `onCreateNew` for the
 * sentinel.
 */
export function AddToPackCombobox({
  packs,
  disabled,
  onPick,
  onCreateNew,
}: {
  packs: FilterPack[];
  disabled: boolean;
  onPick: (packId: string) => void;
  onCreateNew: () => void;
}) {
  const labelOf = (id: string) =>
    id === NEW
      ? "Save as new pack…"
      : (packs.find((p) => p.id === id)?.name ?? id);
  return (
    <Combobox.Root
      items={[NEW, ...packs.map((p) => p.id)]}
      onValueChange={(v) => {
        if (typeof v !== "string") return;
        if (v === NEW) onCreateNew();
        else onPick(v);
      }}
      itemToStringLabel={labelOf}
    >
      <Combobox.Trigger
        render={
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            title="Save the selection as a pack, or add it to an existing one"
          />
        }
      >
        <PackagePlus data-icon="inline-start" />
        <span className="sb-label">Add to pack</span>
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner
          side="top"
          align="end"
          sideOffset={6}
          style={{ zIndex: 1000 }}
        >
          <Combobox.Popup className="grpc-popup">
            <div className="grpc-search">
              <Search size={14} />
              <Combobox.Input
                placeholder="Search packs…"
                className="grpc-input"
              />
            </div>
            <Combobox.Empty className="grpc-empty">
              No packs found
            </Combobox.Empty>
            <Combobox.List className="grpc-list">
              {(id: string) => (
                <Combobox.Item
                  key={id}
                  value={id}
                  className={"grpc-item" + (id === NEW ? " grpc-new" : "")}
                >
                  {id === NEW ? (
                    <span className="grpc-name">
                      <PackagePlus size={13} />
                      {labelOf(id)}
                    </span>
                  ) : (
                    <span className="grpc-name">{labelOf(id)}</span>
                  )}
                  <Combobox.ItemIndicator className="grpc-check">
                    <Check size={14} />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
