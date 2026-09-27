"use client";

/**
 * Motion for the screens around the table — home, setup, the room.
 *
 * Those screens had none: a page, a sheet, an error or a player joining
 * simply appeared. The table already moves with a settled, quiet feel
 * (`TRANSITIONS.ui`, 200ms, no bounce), so these match it rather than
 * inventing another: short opacity and translate tweens on the three
 * `uiEnter` / `uiEnterSlow` / `uiExit` tokens in `presets.ts`, and no
 * springs. Every screen uses these four, so there is one set of numbers to
 * change and nothing that calls attention to itself.
 *
 * Reduced motion needs nothing here: `MotionConfig reducedMotion="user"`
 * (MotionProvider) drops the transforms and keeps the fades.
 */

import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { TRANSITIONS } from "@/motion/presets";

/** Fades in and rises a few pixels, once, when it mounts. */
export function Reveal({
  children,
  className,
  delay = 0,
  slow = false,
}: {
  children: ReactNode;
  className?: string;
  /** Seconds — for staggering a few sections, never for making anyone wait. */
  delay?: number;
  /** A whole screen arriving, rather than a part of one. */
  slow?: boolean;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...(slow ? TRANSITIONS.uiEnterSlow : TRANSITIONS.uiEnter), delay }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Cross-fades between states that replace one another — the room's
 * "connecting" → "lobby" → "table", a game's options when the game
 * changes. The old one leaves before the new one arrives, so two never
 * share the space.
 */
export function Swap({
  swapKey,
  children,
  className,
}: {
  /** Changing this is what triggers the swap. */
  swapKey: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={swapKey}
        className={className}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0, transition: TRANSITIONS.uiEnter }}
        exit={{ opacity: 0, transition: TRANSITIONS.uiExit }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

/**
 * Opens and closes its own height — an error under a field, a group of
 * rules that only exist under one ruleset. The content below slides
 * instead of jumping.
 */
export function Collapse({
  open,
  children,
  className,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          key="collapse"
          className={className}
          style={{ overflow: "hidden" }}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1, transition: TRANSITIONS.uiEnter }}
          exit={{ height: 0, opacity: 0, transition: TRANSITIONS.uiExit }}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * A row of a list that people join and leave — the lobby's roster. Fades
 * in and out, and the rows around it close up (`layout`) instead of
 * jumping. Use inside `AnimatePresence`.
 */
export const listItemMotion = {
  layout: true,
  initial: { opacity: 0, y: -4 },
  animate: { opacity: 1, y: 0, transition: TRANSITIONS.uiEnter },
  exit: { opacity: 0, transition: TRANSITIONS.uiExit },
} as const;
