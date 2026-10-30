"use client";

/**
 * What the pile says without anyone reading it: the colour in force, the way
 * play is going, and how much is waiting to be taken.
 *
 * The colour is the one fact a player needs on every single turn and the
 * pile's top card cannot always give it (a wild names one that is not on the
 * card), so it is drawn as a halo behind the pile in that colour. The way
 * round is a ring of chevrons that drifts the way play goes, and turns the
 * other way, once, when a Reverse lands.
 *
 * Anchored to the discard's own box from the geometry, not positioned
 * against anything else: it is the table's one geometry-anchored container
 * for this, and it sits under the pieces so a card never has to be told
 * which of them wins. Decoration only - `aria-hidden`, no pointer events -
 * and the same facts are in the band's badge for a screen reader.
 */

import { useRef } from "react";
import { AnimatePresence, motion, useAnimationFrame, useMotionValue } from "motion/react";
import { prefersReducedMotion } from "@/motion/presets";
import type { ChromalyState } from "@/games/chromaly/types";
import { useGeometry } from "@/table/store";
import { CountdownRing } from "@/ui/primitives/CountdownRing";

const COLOUR: Record<string, string> = {
  R: "212 74 63",
  Y: "232 185 47",
  G: "63 157 94",
  B: "58 114 194",
};

/** How long one lap of the ring takes. Slow: it is ambient, not a spinner. */
const LAP_SECONDS = 26;

const CHEVRONS = 10;

/** A Reverse whips the ring round the new way: this much faster at first... */
const WHIP_BOOST = 14;
/** ...easing back to the ambient drift over this long. */
const WHIP_MS = 700;

/**
 * The ring's angle, advanced every frame at a constant rate in the direction
 * of play.
 *
 * Not `animate={{ rotate: dir * 360 }}` with a repeat, which it used to be:
 * that animates from wherever the ring HAPPENS to be to the new target over a
 * fixed 26 seconds, so after a Reverse the speed was however far it had left
 * to go - and after a few Reverses it could be crawling (the user,
 * 2026-10-30). A rate never depends on where the ring has got to.
 */
function useDrift(dir: 1 | -1) {
  const angle = useMotionValue(0);
  const reversedAt = useRef<number | null>(null);
  const lastDir = useRef(dir);
  useAnimationFrame((time, delta) => {
    if (lastDir.current !== dir) {
      lastDir.current = dir;
      reversedAt.current = time;
    }
    if (prefersReducedMotion()) return;
    const since = reversedAt.current === null ? Infinity : time - reversedAt.current;
    const boost = since < WHIP_MS ? 1 + WHIP_BOOST * (1 - since / WHIP_MS) ** 2 : 1;
    // A frame dropped by a background tab is not made up all at once.
    const step = Math.min(delta, 100);
    angle.set((angle.get() + (dir * 360 * boost * step) / (LAP_SECONDS * 1000)) % 360);
  });
  return angle;
}

export function PileChrome({ state }: { state: ChromalyState }) {
  const g = useGeometry();
  const angle = useDrift(state.direction);
  if (!g || !state.dealt || state.discard.length === 0) return null;

  // The discard is drawn at the table card's size, scaled by how far the
  // centre chain had to be fitted (`zoneScale`).
  const zs = g.zoneScale.discard ?? 1;
  const cardW = g.card.w * zs;
  const cardH = cardW * (g.pieceBox.h / g.pieceBox.w);
  const box = g.zones.discard;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const diameter = Math.hypot(cardW, cardH) * 1.3;

  const rgb = COLOUR[state.color] ?? COLOUR.R!;
  const dir = state.direction;
  const stack = state.pendingDraw?.amount ?? state.challenge?.amount ?? 0;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute"
      style={{
        left: cx - diameter / 2,
        top: cy - diameter / 2,
        width: diameter,
        height: diameter,
        // Under every piece: the piece layer's lowest z is well above this.
        zIndex: 1,
      }}
    >
      {/* The colour in force, as a halo. Keyed by colour so a wild's choice
          cross-fades from the old colour to the new rather than snapping. */}
      <AnimatePresence initial={false}>
        <motion.div
          key={state.color}
          className="absolute inset-0 rounded-full"
          style={{
            background: `radial-gradient(closest-side, rgb(${rgb} / 0.78), rgb(${rgb} / 0.32) 62%, transparent 100%)`,
          }}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.45, ease: "easeOut" }}
        />
      </AnimatePresence>

      {/* The way round, drifting the way play goes (`useDrift`). */}
      <motion.svg
        viewBox="0 0 100 100"
        className="absolute inset-0 h-full w-full"
        style={{ rotate: angle }}
      >
        {Array.from({ length: CHEVRONS }, (_, i) => (
          <g key={i} transform={`rotate(${(360 / CHEVRONS) * i} 50 50) translate(50 6)`}>
            <path
              // Points along the tangent; mirrored when play runs the other way.
              d={dir === 1 ? "M -2.6 -3 L 2.6 0 L -2.6 3" : "M 2.6 -3 L -2.6 0 L 2.6 3"}
              fill="none"
              stroke="rgb(251 248 241 / 0.5)"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        ))}
      </motion.svg>

      {/* A window to jump in, as the time left round the pile. Public, like the
          window itself (everybody saw the play that opened it), and the same
          for every seat: it says a chance exists, never who holds it. Keyed
          by the window so each one starts a full ring. */}
      {state.window !== null && state.window.offenders.length === 0 ? (
        <div key={state.window.id} className="absolute inset-0 rounded-full">
          <CountdownRing totalMs={state.rules.windowMs} inset={5} offset={0} />
        </div>
      ) : null}

      {/* What is waiting to be taken. A pill above the pile, growing a little
          with each card added to it. */}
      <AnimatePresence>
        {stack > 0 ? (
          <motion.div
            key="stack"
            className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2"
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={{ duration: 0.2 }}
          >
            <motion.span
              key={stack}
              className="block rounded-full bg-felt-950/90 px-3 py-1 font-display text-base font-extrabold text-brass-300 ring-2 ring-brass-400/70"
              initial={{ scale: 1.35 }}
              animate={{ scale: 1 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
            >
              +{stack}
            </motion.span>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
