import { Combobox } from "@base-ui/react/combobox";
import { Check, CopyPlus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";

// Sentinel for "copy the selection into a brand-new set". Pinned to the top so
// creating a set and copying into one live behind a single control.
const NEW = "__new__";

/**
 * Select-bar "Copy to set" control: a searchable picker over the file's OTHER
 * filter sets (the active one is excluded — you can't copy a selection onto
 * itself), with "New set…" pinned at the top. Copy semantics (the source keeps
 * its filters); carries no retained value — the trigger always reads "Copy to
 * set". `onPick` fires for an existing set, `onCreateNew` for the sentinel.
 *
 * A sibling of AddToPackCombobox, deliberately the same shape: packs are the
 * cross-file library, sets are in-file organization — different targets, one
 * familiar gesture.
 */
export function CopyToSetCombobox({
  sets,
  disabled,
  onPick,
  onCreateNew,
}: {
  /** The destination candidates — every set in the file except the active one. */
  sets: { id: string; name: string }[];
  disabled: boolean;
  onPick: (setId: string) => void;
  onCreateNew: () => void;
}) {
  const labelOf = (id: string) =>
    id === NEW ? "New set…" : (sets.find((s) => s.id === id)?.name ?? id);
  return (
    <Combobox.Root
      items={[NEW, ...sets.map((s) => s.id)]}
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
            title="Copy the selection into another set, or a new one"
          />
        }
      >
        <CopyPlus data-icon="inline-start" />
        <span className="sb-label">Copy to set</span>
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
                placeholder="Search sets…"
                className="grpc-input"
              />
            </div>
            <Combobox.Empty className="grpc-empty">
              No sets found
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
                      <CopyPlus size={13} />
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
