import { useCallback, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type ConfirmOptions = {
  title: string;
  message: ReactNode;
  okLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). */
  danger?: boolean;
};

type Pending = ConfirmOptions & { resolve: (v: boolean) => void };

/**
 * App-styled replacement for the native `confirm()` dialog: returns a promise
 * that resolves true/false, plus the element to render. Keeps confirmations
 * consistent with the rest of the UI (the EditModal, etc.) instead of popping a
 * native OS dialog. Esc / Cancel resolve false; Enter / OK resolve true.
 * A backdrop click is intentionally ignored so a confirmation can't be
 * dismissed by a stray click outside the dialog.
 */
export function useConfirm(): [
  (opts: ConfirmOptions) => Promise<boolean>,
  ReactNode,
] {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setPending({ ...opts, resolve })),
    [],
  );

  // Functional update so a double-settle (e.g. OK click then onOpenChange) can't
  // resolve twice — the second pass sees a null pending.
  const settle = (v: boolean) =>
    setPending((p) => {
      p?.resolve(v);
      return null;
    });

  const node = pending ? (
    <Dialog
      open
      onOpenChange={(o, details) => {
        if (o) return;
        // Backdrop clicks must not dismiss a confirmation — only Esc and the
        // explicit buttons resolve it.
        if (details?.reason === "outside-press") {
          details.cancel();
          return;
        }
        settle(false);
      }}
    >
      <DialogContent
        className="confirm-modal"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            settle(true);
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{pending.title}</DialogTitle>
        </DialogHeader>
        <div className="modal-body confirm-msg">{pending.message}</div>
        <DialogFooter>
          <Button
            variant="ghost"
            className="confirm-cancel"
            onClick={() => settle(false)}
          >
            {pending.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            variant={pending.danger ? "destructive" : undefined}
            className="confirm-ok"
            onClick={() => settle(true)}
          >
            {pending.okLabel ?? "OK"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null;

  return [confirm, node];
}
