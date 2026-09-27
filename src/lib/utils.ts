/**
 * `cn` — join class names, and let a later Tailwind class override an
 * earlier one of the same kind (`px-3` then `px-6` keeps `px-6`).
 *
 * The shadcn convention, written out here rather than taken from the `cn`
 * package the CLI reaches for: `clsx` and `tailwind-merge` are already
 * dependencies, and two lines do not need a third.
 */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
