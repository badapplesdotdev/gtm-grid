"use client";

/**
 * Behavior-preserving Dialog primitive (TRI keyboard-a11y).
 *
 * Wraps @radix-ui/react-dialog so every migrated modal gets Escape-to-close, a
 * focus trap, focus restore to the trigger, `aria-modal`, and a portal — for
 * free. Visuals are unchanged: the scrim reuses the app's existing `.overlay`
 * and Content is nested inside it so `.overlay`'s flex-centering still positions
 * the panel. Call sites pass their existing panel class (e.g. `"modal sig-modal"`
 * or a fixed-position `"dedupe-pop"`) and keep their inner markup.
 */

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { cn } from "../../lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;
const DialogPortal = DialogPrimitive.Portal;

/**
 * Visually-hidden title. Radix requires a Title for screen-reader labelling;
 * modals that show no visible heading render this to stay accessible + silent.
 */
function DialogTitleHidden({ children }: { children: React.ReactNode }) {
  return (
    <DialogPrimitive.Title
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        padding: 0,
        margin: -1,
        overflow: "hidden",
        clip: "rect(0 0 0 0)",
        whiteSpace: "nowrap",
        border: 0,
      }}
    >
      {children}
    </DialogPrimitive.Title>
  );
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn(className)} {...props} />
));
DialogTitle.displayName = "DialogTitle";

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn(className)} {...props} />
));
DialogDescription.displayName = "DialogDescription";

type DialogContentProps = React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> & {
  /** Class for the scrim/backdrop. Defaults to the app's `.overlay`. */
  overlayClassName?: string;
  /** A title for screen readers when the modal shows no visible heading. */
  srTitle?: string;
};

/**
 * Renders Content nested inside Overlay. The `.overlay` flex container centers
 * the `.modal` box exactly as the old hand-rolled overlays did. Radix manages
 * the focus trap, Escape, and outside-click dismissal.
 */
const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, overlayClassName, srTitle, ...props }, ref) => (
  <DialogPortal>
    <DialogPrimitive.Overlay className={cn("overlay", overlayClassName)}>
      <DialogPrimitive.Content
        ref={ref}
        className={cn(className)}
        {...props}
      >
        {srTitle ? <DialogTitleHidden>{srTitle}</DialogTitleHidden> : null}
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Overlay>
  </DialogPortal>
));
DialogContent.displayName = "DialogContent";

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogPortal,
  DialogContent,
  DialogTitle,
  DialogTitleHidden,
  DialogDescription,
};
