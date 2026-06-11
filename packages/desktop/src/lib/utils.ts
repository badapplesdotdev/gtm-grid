import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn's class-merge helper: clsx for conditionals + tailwind-merge to dedupe. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
