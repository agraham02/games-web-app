"use client";

/**
 * shadcn's Slider (Base UI), restyled in Neo-Felt: a bone track, a brass
 * fill and a brass thumb with a finger-sized hit area.
 *
 * Replaces the native range input the setup screens used. That one worked,
 * but its look was the browser's (`accent-color` only tints it), it could
 * not show a locked state, and its thumb was a small target on a phone.
 *
 * One thumb only (every use here picks a single value), so the thumb's
 * accessible name and value text are props of the slider itself.
 */

import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "@/lib/utils";

function Slider({
  className,
  label,
  valueText,
  ...props
}: SliderPrimitive.Root.Props & {
  /** The accessible name of the thumb's range input. */
  label: string;
  /** What a screen reader says for a value — "Steady" rather than "1". */
  valueText?: (value: number) => string;
}) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn("w-full data-disabled:opacity-45", className)}
      thumbAlignment="edge"
      {...props}
    >
      <SliderPrimitive.Control className="relative flex h-6 w-full touch-none items-center select-none data-disabled:cursor-not-allowed">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative h-1.5 grow overflow-hidden rounded-full bg-bone-50/15"
        >
          <SliderPrimitive.Indicator data-slot="slider-range" className="h-full bg-primary" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          getAriaLabel={() => label}
          getAriaValueText={valueText ? (_formatted, value) => valueText(value) : undefined}
          className={cn(
            "relative block size-4 shrink-0 rounded-full bg-brass-300 shadow-e1 ring-0 transition-shadow duration-(--duration-ui) outline-none",
            "after:absolute after:-inset-3",
            "hover:ring-4 hover:ring-brass-400/25 has-focus-visible:ring-4 has-focus-visible:ring-ring/50 data-dragging:ring-4 data-dragging:ring-brass-400/35",
            "data-disabled:pointer-events-none",
          )}
        />
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
