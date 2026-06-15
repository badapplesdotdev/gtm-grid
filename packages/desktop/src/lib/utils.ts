import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn's class-merge helper: clsx for conditionals + tailwind-merge to dedupe. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Keyboard-activation handler for non-button clickable elements (rows/headers
 * that must stay `<div>`s because they're draggable or contain nested buttons).
 * Pair with `role="button"` + `tabIndex={0}` so Enter/Space activate like a
 * real button. Returns early for modified keypresses.
 */
export function onActivateKey(
  fn: () => void,
): (e: import("react").KeyboardEvent) => void {
  return (e) => {
    if ((e.key === "Enter" || e.key === " ") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      fn();
    }
  };
}
