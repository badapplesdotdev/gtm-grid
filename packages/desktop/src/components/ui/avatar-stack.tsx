"use client";

import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * A horizontal stack of overlapping {@link Avatar}s. Children (Avatars) overlap
 * via negative spacing; each is lifted above its neighbours on hover. Give each
 * child a `border-2 border-background` (the surface-colored separator ring) so
 * the overlap reads cleanly.
 */
function AvatarStack({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-stack"
      className={cn("flex items-center -space-x-2", className)}
      {...props}
    />
  );
}

export { AvatarStack };
