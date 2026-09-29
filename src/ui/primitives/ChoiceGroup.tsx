"use client";

/**
 * Exactly one of a few named alternatives — Dominoes' rules and target,
 * the lobby's game, a room's privacy.
 *
 * These were two hand-rolled treatments of one control: tinted brass
 * buttons on the setup screen, solid brass chips in the lobby, and neither
 * told assistive tech which one was chosen. This is Base UI's toggle group
 * (via shadcn), with the one rule every use here wants: something is always
 * chosen, so pressing the chosen one again does nothing rather than leaving
 * the group empty.
 *
 * `locked` shows the choice and stops it changing — a room's settings seen
 * by anyone but the leader. The chosen one stays legible; only the others
 * fade.
 *
 * `tiles` makes each option a small card, a picture over its words — the
 * lobby's game picker, drawn with the home page's thumbnails.
 */

import { ToggleGroup, ToggleGroupItem } from "@/ui/base/toggle-group";
import { cn } from "@/lib/utils";

export interface Choice<T extends string> {
  value: T;
  label: React.ReactNode;
  /** The accessible name, when the label is more than its words (a tile). */
  name?: string;
}

export interface ChoiceGroupProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly Choice<T>[];
  /** The group's accessible name — the question being answered. */
  label: string;
  locked?: boolean;
  size?: "default" | "sm";
  /** Equal-width items across the row, rather than each sized to its text. */
  fill?: boolean;
  /** `tiles`: three to a row, each a picture over its words. */
  variant?: "chips" | "tiles";
  className?: string;
}

export function ChoiceGroup<T extends string>({
  value,
  onChange,
  options,
  label,
  locked = false,
  size = "default",
  fill = false,
  variant = "chips",
  className,
}: ChoiceGroupProps<T>) {
  const tiles = variant === "tiles";
  return (
    <ToggleGroup
      aria-label={label}
      size={size}
      value={[value]}
      onValueChange={(next) => {
        const picked = next[0] as T | undefined;
        if (picked !== undefined && picked !== value) onChange(picked);
      }}
      disabled={locked}
      className={cn(fill && "grid auto-cols-fr grid-flow-col", tiles && "grid grid-cols-3", className)}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          aria-label={option.name}
          className={cn(tiles && "h-auto flex-col justify-start gap-1 px-1.5 pt-2.5 pb-2 text-center whitespace-normal")}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
