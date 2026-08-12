/**
 * Motion vocabulary for the neo-felt direction: weighted and settled.
 * Pieces have mass — nothing bounces, things arrive.
 *
 * Durations mirror the tokens in globals.css. They live here in seconds
 * because that is what Motion consumes.
 */

import type { Transition } from "motion/react";

export const DURATION = {
  deal: 0.38,
  play: 0.3,
  collect: 0.42,
  flip: 0.3,
  ui: 0.2,
  count: 0.9,
} as const;

export const STAGGER = {
  deal: 0.065,
  collect: 0.04,
  meld: 0.05,
} as const;

/** Overshoot-free spring: damping is high enough that it never rebounds. */
export const SETTLE: Transition = {
  type: "spring",
  stiffness: 260,
  damping: 30,
  mass: 0.9,
};

export const EASE_OUT_QUINT = [0.22, 1, 0.36, 1] as const;

export const TRANSITIONS = {
  deal: SETTLE,
  play: { duration: DURATION.play, ease: EASE_OUT_QUINT },
  collect: { duration: DURATION.collect, ease: EASE_OUT_QUINT },
  flip: { duration: DURATION.flip, ease: EASE_OUT_QUINT },
  ui: { duration: DURATION.ui, ease: "easeOut" },
  /** Resize and reflow: instant, because it is not a game event. */
  reflow: { duration: 0 },
} satisfies Record<string, Transition>;

/** Honoured by the choreographer and by <Piece>. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
