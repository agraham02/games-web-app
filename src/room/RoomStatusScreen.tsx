"use client";

/**
 * Every screen a room shows on the way somewhere else: connecting, making
 * your room, joining one, waiting to be let in, playing in another tab,
 * leaving.
 *
 * They were a bare eyebrow line in the middle of an empty felt — five
 * hand-built variations on it, one with a button, most with no way out. A
 * server that never answered left "Connecting…" on screen with nothing to
 * press. Now each is the same frame: the app's piece motif, a title, at most
 * one line, at most one action, and a way home.
 *
 * Waiting states breathe (a slow pulse on the motif) so a stalled screen
 * and a working one do not look the same. The pulse repeats forever, so its
 * `exit` carries its own transition: without one, an infinite transition
 * governs the exit too, and `AnimatePresence` waits on it for ever.
 */

import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { TRANSITIONS } from "@/motion/presets";
import { PieceStrip } from "@/ui/primitives/PieceStrip";

export interface RoomStatusScreenProps {
  title: string;
  /** One line saying what is going on, when the title is not enough. */
  line?: ReactNode;
  /** The one thing to do about it. */
  action?: ReactNode;
  /** Something is being waited on: the motif breathes. */
  waiting?: boolean;
  /**
   * Offer the way home. Off only where the action already goes home — and
   * must, because it has something to undo on the way (a knock to withdraw).
   */
  home?: boolean;
}

export function RoomStatusScreen({ title, line, action, waiting = false, home = true }: RoomStatusScreenProps) {
  // Reduced motion keeps opacity animations by default; a pulse that never
  // stops is exactly what that setting is asking not to see.
  const reduced = useReducedMotion();
  const breathe = waiting && !reduced;
  return (
    <main className="felt felt-weave flex h-svh flex-col items-center justify-center gap-5 px-6 text-center">
      <motion.div
        initial={false}
        animate={breathe ? { opacity: [1, 0.45, 1] } : { opacity: 1 }}
        transition={breathe ? { duration: 2.4, ease: "easeInOut", repeat: Infinity } : TRANSITIONS.uiEnter}
        exit={{ opacity: 0, transition: TRANSITIONS.uiExit }}
      >
        <PieceStrip className="scale-90" />
      </motion.div>

      <h1 className="font-display text-2xl tracking-wide text-bone-50">{title}</h1>
      {line ? <p className="max-w-xs text-sm leading-relaxed text-bone-400">{line}</p> : null}
      {action}
      {home ? (
        <Link href="/" className="text-xs text-bone-400 underline-offset-4 hover:text-bone-200 hover:underline">
          ← Home
        </Link>
      ) : null}
    </main>
  );
}
