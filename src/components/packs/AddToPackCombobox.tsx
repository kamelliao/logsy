import { useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { PackagePlus, Search } from "lucide-react";
import type { FilterPack } from "@/types";
import { Button } from "@/components/ui/button";

// Sentinel item that stands for "save the selection as a brand-new pack". Kept as
// the first entry so creating a pack and adding to one live behind a single
// control (no separate "Save pack" button needed).
const NEW = "__new__";

/**
 * Select-bar "Add to pack" control: a searchable picker over the pack library
 * (so choosing a target stays quick even with many packs), with "Save as new
 * pack…" pinned at the top.
 *
 * Each existing pack row reveals two labeled actions on hover / keyboard focus:
 * `Append` (also the row's default click / Enter) merges the selection in, while
 * `Overwrite` replaces the pack's whole contents (the caller confirms first,
 * since it's destructive). Labeled buttons — rather than a bare icon or a nested
 * flyout — keep the choice legible without a second popup layer.
 */
export function AddToPackCombobox({
  packs,
  disabled,
  onAppend,
  onOverwrite,
  onCreateNew,
}: {
  packs: FilterPack[];
  disabled: boolean;
  onAppend: (packId: string) => void;
  onOverwrite: (packId: string) => void;
  onCreateNew: () => void;
}) {
  // Controlled open so the per-row buttons (which don't "select" an item) can
  // close the popup after firing.
  const [open, setOpen] = useState(false);
  const labelOf = (id: string) =>
    id === NEW
      ? "Save as new pack…"
      : (packs.find((p) => p.id === id)?.name ?? id);
  // A row's default activation (click on the name / Enter while highlighted).
  const activate = (id: string) => {
    setOpen(false);
    if (id === NEW) onCreateNew();
    else onAppend(id);
  };
  return (
    <Combobox.Root
      open={open}
      onOpenChange={setOpen}
      items={[NEW, ...packs.map((p) => p.id)]}
      onValueChange={(v) => {
        if (typeof v === "string") activate(v);
      }}
      itemToStringLabel={labelOf}
    >
      <Combobox.Trigger
        render={
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            title="Save the selection as a pack, or append/overwrite an existing one"
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
                    <>
                      <span className="grpc-name">{labelOf(id)}</span>
                      {/* Hover/keyboard-revealed actions. stopPropagation keeps a
                          button click from also firing the row's default append. */}
                      <span className="grpc-actions">
                        <button
                          type="button"
                          className="grpc-act"
                          title={`Append the selection to "${labelOf(id)}"`}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            setOpen(false);
                            onAppend(id);
                          }}
                        >
                          Append
                        </button>
                        <button
                          type="button"
                          className="grpc-act grpc-act-danger"
                          title={`Overwrite "${labelOf(id)}" with the selection`}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            setOpen(false);
                            onOverwrite(id);
                          }}
                        >
                          Overwrite
                        </button>
                      </span>
                    </>
                  )}
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
