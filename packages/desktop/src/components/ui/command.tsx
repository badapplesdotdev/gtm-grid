"use client";

/**
 * Command-palette primitive (TRI keyboard-a11y) — cmdk wrapped in shadcn styling.
 *
 * `CommandDialog` renders the cmdk palette inside a Radix Dialog so it gets the
 * focus trap, Escape-to-close, and focus restore. cmdk itself provides the
 * arrow-key list navigation, fuzzy filtering, and Enter-to-select. Styled with
 * the app's shadcn token utilities so it matches light/dark themes.
 *
 * cmdk's exported component types resolve against whichever `@types/react` wins
 * in the install tree (the monorepo has both 18 (desktop) and 19 (web)), which
 * can make its components fail JSX assignment under a clean install. We coerce
 * cmdk's components to plain React component types here so this file always
 * typechecks against the desktop's React 18 — props pass through unchanged.
 */

import * as React from "react";
import { Command as CommandImpl } from "cmdk";

import { cn } from "../../lib/utils";
import { Dialog, DialogContent, DialogTitleHidden } from "./dialog";

type DivProps = React.HTMLAttributes<HTMLDivElement>;

const CommandRoot = CommandImpl as unknown as React.FC<
  DivProps & { loop?: boolean }
>;
const CInput = CommandImpl.Input as unknown as React.FC<
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
    value?: string;
    onValueChange?: (value: string) => void;
  }
>;
const CList = CommandImpl.List as unknown as React.FC<DivProps>;
const CEmpty = CommandImpl.Empty as unknown as React.FC<DivProps>;
const CGroup = CommandImpl.Group as unknown as React.FC<
  DivProps & { heading?: React.ReactNode }
>;
const CItem = CommandImpl.Item as unknown as React.FC<
  Omit<DivProps, "onSelect"> & {
    value?: string;
    onSelect?: (value: string) => void;
    disabled?: boolean;
  }
>;

function Command({ className, ...props }: DivProps & { loop?: boolean }) {
  return (
    <CommandRoot
      className={cn(
        "bg-popover text-popover-foreground flex h-full w-full flex-col overflow-hidden rounded-md",
        className,
      )}
      {...props}
    />
  );
}

function CommandDialog({
  children,
  open,
  onOpenChange,
}: {
  children: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="modal cmd-palette"
        overlayClassName="cmd-overlay"
        srTitle="Command palette"
      >
        <DialogTitleHidden>Command palette</DialogTitleHidden>
        <Command
          loop
          className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2.5"
        >
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({ className, ...props }: React.ComponentProps<typeof CInput>) {
  return (
    <div className="flex items-center border-b px-3" cmdk-input-wrapper="">
      <CInput
        className={cn(
          "placeholder:text-muted-foreground flex h-11 w-full rounded-md bg-transparent py-3 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: DivProps) {
  return (
    <CList
      className={cn("max-h-[320px] overflow-y-auto overflow-x-hidden", className)}
      {...props}
    />
  );
}

function CommandEmpty(props: DivProps) {
  return <CEmpty className="py-6 text-center text-sm" {...props} />;
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof CGroup>) {
  return (
    <CGroup
      className={cn("text-foreground overflow-hidden p-1", className)}
      {...props}
    />
  );
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CItem>) {
  return (
    <CItem
      className={cn(
        "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
};
