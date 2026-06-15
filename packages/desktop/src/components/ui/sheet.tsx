"use client";

/**
 * Side Sheet / drawer primitive (TRI keyboard-a11y).
 *
 * A Radix Dialog that slides in from an edge. Used for side panels (e.g. cell
 * details) so they gain Escape-to-close, a focus trap, and focus restore. The
 * scrim reuses the app's `.overlay`; the panel styling uses app tokens so it
 * matches the existing surfaces.
 */

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { cn } from "../../lib/utils";
import { DialogTitleHidden } from "./dialog";

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;

type Side = "right" | "left";

type SheetContentProps = React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> & {
  side?: Side;
  srTitle?: string;
};

const sideClasses: Record<Side, string> = {
  right:
    "right-0 top-0 h-full data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right border-l",
  left:
    "left-0 top-0 h-full data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left border-r",
};

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(({ className, children, side = "right", srTitle, ...props }, ref) => (
  <SheetPortal>
    {/* Scrim: align to the sheet side rather than centering. */}
    <DialogPrimitive.Overlay
      className="overlay"
      style={{ justifyContent: side === "right" ? "flex-end" : "flex-start" }}
    >
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "bg-background text-foreground fixed z-[120] flex flex-col shadow-lg outline-none transition ease-in-out data-[state=closed]:duration-200 data-[state=open]:duration-300 data-[state=open]:animate-in data-[state=closed]:animate-out",
          sideClasses[side],
          className,
        )}
        {...props}
      >
        {srTitle ? <DialogTitleHidden>{srTitle}</DialogTitleHidden> : null}
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Overlay>
  </SheetPortal>
));
SheetContent.displayName = "SheetContent";

export { Sheet, SheetTrigger, SheetClose, SheetPortal, SheetContent };
