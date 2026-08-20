"use client";

import type { BotDifficulty } from "@/engine/types";

/**
 * How smart the table is, as a three-stop slider.
 *
 * Shared by every game's setup screen rather than copied into each, for
 * the same reason `NumberStepper` is: four bespoke copies of one control
 * is how four subtly different controls happen. The three tiers are the
 * engine's own `BotDifficulty`, so a game gets this by naming its bots
 * and nothing else.
 *
 * A slider rather than three buttons because every setup screen here
 * already picks its player count with one, and because the tiers are
 * genuinely ordered — "more or less of the same thing", which is what a
 * slider means and what a segmented control does not.
 *
 * Each tier carries a line of copy stating what actually changes. "Sharp"
 * on its own tells a player nothing; "never misses a lay-off, and won't
 * feed your melds" tells them what they are in for — but what actually
 * changes is different in every game (a lay-off is a Rummy word; Poker
 * has no discard to punish), so `blurbs` is a required per-game prop, not
 * a shared default. It was one for a while — the default set was written
 * FOR Rummy and then quietly reused verbatim by Dominoes, Spades and
 * Poker, none of which have a "loose discard" to punish. Making it
 * required rather than an easy-to-forget optional override is what stops
 * a sixth game shipping the same mismatch again.
 */
export const DIFFICULTY_NAMES: Record<BotDifficulty, string> = {
  casual: "Casual",
  steady: "Steady",
  sharp: "Sharp",
};

const TIER_ORDER: readonly BotDifficulty[] = ["casual", "steady", "sharp"];

export type DifficultyBlurbs = Record<BotDifficulty, string>;

export interface DifficultyPickerProps {
  value: BotDifficulty;
  onChange: (v: BotDifficulty) => void;
  /** One line per tier stating what actually changes IN THIS GAME. */
  blurbs: DifficultyBlurbs;
  /** Overrides the default "Opponents" heading. */
  label?: string;
}

export function DifficultyPicker({
  value,
  onChange,
  blurbs,
  label = "Opponents",
}: DifficultyPickerProps) {
  const index = Math.max(0, TIER_ORDER.indexOf(value));
  const tier = TIER_ORDER[index]!;

  return (
    <label className="flex w-full flex-col gap-2">
      <span className="flex items-center justify-between text-xs font-bold text-bone-200">
        {label} <span className="text-brass-300">{DIFFICULTY_NAMES[tier]}</span>
      </span>
      <input
        type="range"
        min={0}
        max={TIER_ORDER.length - 1}
        step={1}
        value={index}
        onChange={(e) => onChange(TIER_ORDER[Number(e.target.value)]!)}
        aria-label={`${label} difficulty`}
        className="w-full accent-brass-400"
      />
      {/* Fixed two-line box, so stepping through the tiers does not
          reflow everything below it — a setup screen that jumps as you
          drag a slider reads as broken. */}
      <span className="min-h-8 text-[11px] leading-4 text-bone-400">{blurbs[tier]}</span>
    </label>
  );
}

/**
 * The per-seat table `useGameRuntime` wants, filled with one tier.
 *
 * Seat 0 is the hero and is ignored by the runtime, but it is included
 * so the array is indexed by seat id rather than by "bot number" — an
 * off-by-one there would silently hand seat 1 the wrong brain and be
 * almost impossible to notice.
 */
export function botTable(seats: number, tier: BotDifficulty): BotDifficulty[] {
  return Array.from({ length: seats }, (): BotDifficulty => tier);
}
