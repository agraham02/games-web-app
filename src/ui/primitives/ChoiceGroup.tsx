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
 * by anyone but the leader.
 */

import { ToggleGroup, ToggleGroupItem } from "@/ui/base/toggle-group";
import { cn } from "@/lib/utils";

export interface Choice<T extends string> {
  value: T;
  label: React.ReactNode;
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
  className,
}: ChoiceGroupProps<T>) {
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
      className={cn(fill && "grid auto-cols-fr grid-flow-col", className)}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value}>
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
