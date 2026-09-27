"use client";

/**
 * shadcn's Toggle (Base UI), restyled in Neo-Felt — one pressable choice.
 *
 * The pressed look is the one Dominoes' rules buttons already had: a brass
 * tint and ring, not solid brass. Solid brass is the primary action's; a
 * CHOICE that is currently made is quieter than the thing that acts on it.
 */

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const toggleVariants = cva(
  [
    "inline-flex items-center justify-center gap-1.5 rounded-lg font-bold whitespace-nowrap ring-1 transition-colors duration-(--duration-ui) outline-none",
    "bg-bone-50/5 text-bone-300 ring-bone-50/12 hover:bg-bone-50/10 hover:text-bone-100",
    "aria-pressed:bg-brass-400/18 aria-pressed:text-brass-300 aria-pressed:ring-brass-400/60",
    "focus-visible:ring-2 focus-visible:ring-ring",
    "data-disabled:cursor-not-allowed data-disabled:opacity-45",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      size: {
        default: "px-3 py-2.5 text-sm",
        sm: "px-3 py-2 text-xs",
      },
    },
    defaultVariants: { size: "default" },
  },
);

function Toggle({
  className,
  size = "default",
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ size, className }))}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
