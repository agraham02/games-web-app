"use client";

/**
 * App-wide reduced-motion honouring.
 *
 * This closes a real gap rather than adding a nicety. `presets.ts` has
 * always claimed `prefersReducedMotion` was "honoured by the
 * choreographer and by `<Piece>`", and the first half was true — the
 * choreographer collapses every queue delay to zero — but the second was
 * not: `PieceLayer` never checked it. The CSS backstop in globals.css
 * only sets `animation-duration`/`transition-duration`, which cannot
 * touch the inline transforms Motion drives from JS. So a player with
 * reduced motion on still had 52 cards flying across the felt.
 *
 * `reducedMotion="user"` makes Motion drop transform and layout
 * animations while keeping opacity and colour, which is the right pair
 * with the choreographer's zeroed delays: the table resolves instantly
 * and consistently instead of half-animating. Note the scope — this
 * changes behaviour in every game, not just the one that surfaced it.
 *
 * A client boundary because MotionConfig is a context provider and the
 * root layout is a server component. It renders nothing itself.
 */

import { MotionConfig } from "motion/react";

export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
