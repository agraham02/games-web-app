"use client";

/**
 * A button with the time left drawn around it as a depleting ring.
 *
 * Extracted from Rummy's "Rummy!" claim button when BS arrived, because BS
 * asks the same question after every single play and a second copy of this
 * would have been a second opinion about it. What it is FOR is one idea: a
 * chance the player can lose by being slow, where the clock has to be read
 * without looking away from the thing it applies to.
 *
 * The clock is drawn ON the button rather than beside it for that reason —
 * a countdown sitting next to something has to be understood as belonging
 * to it; drawn around it there is nothing to work out.
 *
 * It is deliberately loud. Everything else on these tables settles rather
 * than bounces, and this is the exception: the window is short, it can be
 * lost, and it appears without warning while the player is looking at their
 * own hand. An entrance that merely fades in is one a player misses, which
 * is exactly what was reported of the first version.
 */

import { motion } from "motion/react";
import { CountdownRing } from "./CountdownRing";

export interface CountdownButtonProps {
  /** How long the ring takes to empty. */
  ms: number;
  onClick: () => void;
  children: React.ReactNode;
  /** Quieter entrance and no glow, for a second button in the same row. */
  tone?: "loud" | "quiet";
}

export function CountdownButton({ ms, onClick, children, tone = "loud" }: CountdownButtonProps) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      // Arrives big and lands. A single overshoot-and-settle, not a
      // repeating bounce — the urgency is in the clock, not in a wobble.
      initial={{ scale: 0.4, opacity: 0 }}
      animate={{ scale: [0.4, 1.18, 1], opacity: 1 }}
      transition={{ duration: 0.42, times: [0, 0.55, 1], ease: "easeOut" }}
      className="relative shrink-0 rounded-full bg-linear-to-b from-brass-300 to-brass-500 px-7 py-2.5 font-display text-base font-extrabold tracking-wide text-felt-950"
    >
      {tone === "loud" && (
        /* A pulsing glow underneath, sized past the button's own box so it
           reads as light rather than as a second border. */
        <motion.span
          aria-hidden
          className="pointer-events-none absolute rounded-full"
          style={{
            inset: -7,
            background: "radial-gradient(closest-side, rgb(212 175 106 / 0.75), transparent 70%)",
            filter: "blur(7px)",
          }}
          animate={{ opacity: [0.45, 1, 0.45], scale: [0.95, 1.08, 0.95] }}
          transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
      <span className="relative">{children}</span>
      {/* Keyed by `ms` at the call site's discretion: a fresh window is a
          fresh button, and the ring runs from when it mounts. */}
      <CountdownRing totalMs={ms} />
    </motion.button>
  );
}
