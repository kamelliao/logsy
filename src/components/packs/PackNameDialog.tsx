import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * A one-field naming modal, shared by "Save as pack" (from a selection or a set)
 * and "Rename pack". The parent owns the open state and supplies the title,
 * starting value, and what to do with the trimmed result.
 */
export function PackNameDialog({
  open,
  onOpenChange,
  title,
  label = "Pack name",
  initial,
  submitLabel = "Save",
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label?: string;
  initial: string;
  submitLabel?: string;
  onSubmit: (name: string) => void;
}) {
  const [value, setValue] = useState(initial);
  // Re-seed each time the dialog (re)opens for a different target.
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  function commit() {
    const v = value.trim();
    if (!v) return;
    onSubmit(v);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="pack-name-modal">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <label className="pack-name-field">
          <span className="pack-name-label">{label}</span>
          <input
            className="pack-name-input"
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
          />
        </label>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button size="sm" disabled={!value.trim()} onClick={commit}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
