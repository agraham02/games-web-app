"use client";

import { AnimatePresence, motion } from "motion/react";
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
          animate={{ opacity: [0.5, 0.95, 0.5] }}
          exit={{ opacity: 0, transition: { duration: DURATION.ui } }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
        >
          <WeakSignal size={size} />
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * Wifi with one bar of three: lucide's `wifi-low` dot and arc, with the
 * next arc up drawn faint, and the box cropped to the ink. Lucide's own
 * glyph keeps its ink in the bottom of a square, so at a pod badge's 10px
 * it was a speck (seen in Chrome, 2026-10-02).
 */
function WeakSignal({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="4 10 16 11"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 12.859a10 10 0 0 1 14 0" opacity={0.3} />
      <path d="M8.5 16.429a5 5 0 0 1 7 0" />
      <path d="M12 20h.01" />
    </svg>
  );
}
