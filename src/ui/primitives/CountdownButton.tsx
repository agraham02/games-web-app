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

import { useEffect, useState } from "react";
import { animate, motion, useMotionValue, useTransform } from "motion/react";

/** Where the ring turns amber, then red, as a fraction of time REMAINING. */
const WARN_AT = 0.5;
const DANGER_AT = 0.25;

export interface CountdownButtonProps {
  /** How long the ring takes to empty. */
  ms: number;
  onClick: () => void;
  children: React.ReactNode;
  /** Quieter entrance and no glow, for a second button in the same row. */
  tone?: "loud" | "quiet";
}

export function CountdownButton({ ms, onClick, children, tone = "loud" }: CountdownButtonProps) {
  // Keyed by `ms` so a fresh window gets fresh timers rather than a reset
  // written from inside an effect. One window is one button; there is no
  // state here worth carrying between them.
  const [phase, setPhase] = useState<"safe" | "warn" | "danger">("safe");

  useEffect(() => {
    const a = setTimeout(() => setPhase("warn"), ms * (1 - WARN_AT));
    const b = setTimeout(() => setPhase("danger"), ms * (1 - DANGER_AT));
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [ms]);

  // Driven by real timers rather than interpolated keyframes, so each band
  // is a flat colour and the switch is a switch.
  const stroke =
    phase === "safe"
      ? "var(--color-emerald-400, #34d399)"
      : phase === "warn"
        ? "var(--color-amber-400, #fbbf24)"
        : "var(--color-red-400, #f87171)";

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
      <CountdownRing ms={ms} colour={stroke} />
    </motion.button>
  );
}

/**
 * The depleting border — a real border around the button, not a drawing of
 * one inside it.
 *
 * The first version was an SVG `<rect rx="9999">` laid over the button. It
 * read as cheap for two reasons that are the same reason: an SVG rect cannot
 * share the button's `border-radius`, it can only approximate it, and it had
 * to be inset to keep its stroke from clipping — so it sat visibly INSIDE
 * the edge rather than being the edge.
 *
 * This is a conic gradient masked to a ring. `border-radius: 9999px` on the
 * overlay resolves against the overlay's own box, so it is the button's pill
 * exactly, at any width the text happens to produce; the two-layer mask
 * (`content-box` minus the whole box) punches out the middle, leaving
 * `padding` worth of ring. Sweeping the gradient's stop from a full turn to
 * nothing empties it.
 *
 * The sweep is driven by a motion VALUE composed into the whole `background`
 * string, rather than by animating a CSS custom property. Both would work in
 * a browser, but only this one fails loudly: if Motion could not drive a
 * custom property the ring would simply sit full and the countdown would be
 * silently wrong, which is the worst way for a timer to break. Here the
 * property being animated is `background` itself, a plain style binding.
 *
 * The colour comes through `currentColor` rather than the transform, so the
 * phase switch is an ordinary re-render and cannot capture a stale value in
 * the transform's closure.
 */
function CountdownRing({ ms, colour }: { ms: number; colour: string }) {
  const sweep = useMotionValue(1);
  const background = useTransform(
    sweep,
    (v) => `conic-gradient(from -90deg, currentColor ${v * 360}deg, transparent 0)`,
  );

  useEffect(() => {
    sweep.set(1);
    const controls = animate(sweep, 0, { duration: ms / 1000, ease: "linear" });
    return () => controls.stop();
  }, [ms, sweep]);

  const ring = "linear-gradient(#000 0 0)";
  return (
    <motion.span
      aria-hidden
      className="pointer-events-none absolute rounded-full"
      style={{
        // Just OUTSIDE the button, so it reads as a border around it rather
        // than as decoration painted on the face.
        inset: -3,
        padding: 3,
        color: colour,
        background,
        // Two mask layers, the inner one clipped to the content box,
        // composited so the middle is punched out — what is left is exactly
        // `padding` worth of ring following the element's own
        // `border-radius`. An SVG rect can only approximate that radius,
        // which is why the first version looked pasted on.
        WebkitMask: `${ring} content-box, ${ring}`,
        WebkitMaskComposite: "xor",
        mask: `${ring} content-box, ${ring}`,
        maskComposite: "exclude",
      }}
    />
  );
}
