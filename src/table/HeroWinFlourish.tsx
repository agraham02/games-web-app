"use client";

/**
 * The hero-win counterpart to SeatRing's WinnerCrown. A bot winning has
 * a pod to put a crown on; the hero doesn't render in SeatRing at all,
 * so "you won" had no table-side moment of its own — straight to
 * GameEndSummary, same as any other outcome. This fills that gap with a
 * screen-wide flourish instead of a per-seat one: a soft warm glow
 * sweeping the felt, plus a light scatter of confetti easing down from
 * the top.
 *
 * The confetti itself is `react-confetti`, not a hand-rolled particle
 * system. A first pass animated a handful of `motion.span` rectangles
 * by hand and it read as exactly that — rotating rectangles, not paper.
 * Real confetti physics (per-particle drag, spin, and the way a flat
 * piece flashes edge-on as it tumbles) is a solved problem a dedicated
 * library does properly; reinventing it here would either under-deliver
 * or duplicate work for no reason. `numberOfPieces`, `recycle: false`,
 * and a short `tweenDuration` are what keep it "subtle" — a small,
 * one-shot flurry near the top, not a continuous shower — and `colors`
 * is pinned to this app's own brass/bone tokens (as real hex, since a
 * canvas can't resolve a CSS custom property) so it still reads as this
 * app's confetti, not a generic default rainbow.
 *
 * The library's own particle placement uses `Math.random()` internally
 * — that's a third-party dependency's implementation detail, not this
 * app's own engine or bot code, which is what CLAUDE.md's rng
 * discipline actually governs. The ambient glow below stays hand-rolled
 * and deterministic, same reasoning as everywhere else purely cosmetic
 * in this app.
 */

import Confetti from "react-confetti";
import { AnimatePresence, motion } from "motion/react";
import { useGeometry } from "./store";

// Real hex, not `var(--color-*)` — react-confetti paints to a <canvas>,
// which never participates in the DOM's CSS cascade, so a custom
// property would just resolve to nothing.
const CONFETTI_COLOURS = [
  "#f0dcb4", // brass-200
  "#e3c68f", // brass-300
  "#d4af6a", // brass-400
  "#b8914e", // brass-500
  "#f5f2ea", // bone-50
  "#ddd6c5", // bone-200
];

export function HeroWinFlourish({ show }: { show: boolean }) {
  const geometry = useGeometry();
  const width = geometry?.box.w ?? 0;
  const height = geometry?.box.h ?? 0;

  return (
    <AnimatePresence>
      {show && width > 0 && height > 0 ? (
        <div
          data-testid="hero-win-flourish"
          className="pointer-events-none absolute inset-0 z-1850 overflow-hidden"
        >
          <motion.div
            aria-hidden
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(ellipse 70% 45% at 50% 18%, rgb(212 175 106 / 0.22), transparent 65%)",
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 1, 0.12] }}
            transition={{ duration: 2.2, times: [0, 0.25, 1], ease: "easeOut" }}
          />
          <Confetti
            width={width}
            height={height}
            numberOfPieces={70}
            recycle={false}
            tweenDuration={900}
            gravity={0.22}
            initialVelocityX={{ min: -4, max: 4 }}
            initialVelocityY={{ min: 4, max: 9 }}
            wind={0.008}
            opacity={0.85}
            colors={CONFETTI_COLOURS}
            confettiSource={{ x: width * 0.08, y: -12, w: width * 0.84, h: 4 }}
          />
        </div>
      ) : null}
    </AnimatePresence>
  );
}
