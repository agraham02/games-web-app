"use client";

import { AnimatePresence, motion } from "motion/react";
import { WifiLow } from "lucide-react";
import { DURATION } from "@/motion/presets";

/**
 * "This connection is slow" — a translucent wifi glyph that pulses gently
 * (the user, 2026-10-02: "can just be a translucent pulsing icon"). One
 * glyph for your own link, in the table's corner, and for anybody else's,
 * on their pod and in the lobby — `LinkMonitor` decides the same way for
 * both.
 *
 * Opacity only, so it reads as ambient rather than alarming, and survives
 * reduced motion (Motion keeps opacity under `reducedMotion="user"`). The
 * exit carries its own transition: the pulse repeats for ever, and an exit
 * that inherited it would never finish (memory: motion exit inherits
 * transition).
 */
export function WeakLinkIcon({
  show,
  label,
  size = 14,
  className = "",
}: {
  show: boolean;
  /** The whole sentence, for a title and a screen reader. */
  label: string;
  size?: number;
  className?: string;
}) {
  return (
    <AnimatePresence>
      {show ? (
        <motion.span
          key="weak-link"
          role="img"
          aria-label={label}
          title={label}
          className={`pointer-events-auto inline-flex items-center justify-center text-warn ${className}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: [0.35, 0.85, 0.35] }}
          exit={{ opacity: 0, transition: { duration: DURATION.ui } }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
        >
          <WifiLow size={size} strokeWidth={2.5} aria-hidden />
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}
