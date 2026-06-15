"use client";

/**
 * Anchored Popover primitive (TRI keyboard-a11y).
 *
 * Wraps @radix-ui/react-popover for the app's anchored popovers (sync panel,
 * add-column, column settings…). Radix handles positioning relative to the
 * trigger, Escape-to-close, outside-click dismissal, focus management, and
 * `aria-expanded`/`aria-controls` wiring — replacing the hand-rolled
 * `popover-scrim` + manual rect math. Content is intentionally unstyled so call
 * sites keep their existing panel classes (`.sync-pop`, `.fnx-*`, …).
 */

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "../../lib/utils";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;
const PopoverClose = PopoverPrimitive.Close;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "start", sideOffset = 6, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn("z-[120]", className)}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = "PopoverContent";

export {
  Popover,
  PopoverTrigger,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
};
