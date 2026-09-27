"use client";

/**
 * shadcn's Switch (Base UI), restyled in Neo-Felt.
 *
 * Kept close to the upstream shape so a later `shadcn add` diff stays
 * readable; what changed is the look (the track and thumb the app's
 * `Toggle` already had) and that it speaks only in role tokens and
 * Tailwind's own `data-*` variants — no `dark:` (the app is always dark)
 * and none of shadcn's custom variants, which live in a stylesheet this
 * app does not import.
 *
 * `readOnly` is how a switch is shown LOCKED: its real value, dimmed, not
 * changeable. `disabled` is for a switch that is not in effect at all.
 */

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full px-0.5 transition-colors duration-(--duration-ui) outline-none",
        "after:absolute after:-inset-x-2 after:-inset-y-3",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "data-checked:bg-primary data-unchecked:bg-bone-50/15",
        "data-disabled:cursor-not-allowed data-readonly:cursor-not-allowed",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 rounded-full bg-felt-950 transition-transform duration-(--duration-ui) data-checked:translate-x-4 data-unchecked:translate-x-0"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
