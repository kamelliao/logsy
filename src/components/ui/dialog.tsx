import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

import { cn } from "@/lib/utils";

function useDrag() {
  const [pos, setPos] = React.useState({ x: 0, y: 0 });
  const r = React.useRef({
    dragging: false,
    startMx: 0,
    startMy: 0,
    startPx: 0,
    startPy: 0,
    currX: 0,
    currY: 0,
  });

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!(e.target as HTMLElement).closest('[data-slot="dialog-header"]'))
      return;
    if ((e.target as HTMLElement).closest("button")) return;
    r.current.dragging = true;
    r.current.startMx = e.clientX;
    r.current.startMy = e.clientY;
    r.current.startPx = r.current.currX;
    r.current.startPy = r.current.currY;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!r.current.dragging) return;
    const x = r.current.startPx + e.clientX - r.current.startMx;
    const y = r.current.startPy + e.clientY - r.current.startMy;
    r.current.currX = x;
    r.current.currY = y;
    setPos({ x, y });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    r.current.dragging = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return { pos, onPointerDown, onPointerMove, onPointerUp };
}

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn("modal-overlay", className)}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  ...props
}: DialogPrimitive.Popup.Props) {
  const { pos, onPointerDown, onPointerMove, onPointerUp } = useDrag();
  return (
    <DialogPortal>
      <DialogOverlay />
      <div
        className="modal-drag-wrap"
        style={{
          transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <DialogPrimitive.Popup
          data-slot="dialog-content"
          className={cn("modal", className)}
          {...props}
        >
          {children}
        </DialogPrimitive.Popup>
      </div>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("modal-head", className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("modal-foot", className)}
      {...props}
    >
      {children}
    </div>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("mh-title", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
