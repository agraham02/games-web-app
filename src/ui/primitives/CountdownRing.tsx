"use client";

/**
 * Time left, drawn as a border that empties around whatever it sits in —
 * a button (`CountdownButton`), the scorecard's Continue, and next a seat
 * pod. Put it inside a `relative` element; it follows that element's shape.
 *
 * Extracted from `CountdownButton` (2026-09-29) once a second kind of clock
 * needed it, so every countdown in the app empties and changes colour the
 * same way: green, amber at half, red at a fifth — the user's thresholds for
 * the turn timer, adopted everywhere so there is one opinion about it.
 *
 * ## Why a masked conic gradient and not an SVG
 *
 * The first version was an SVG `<rect rx="9999">` laid over the button. It
 * read as cheap for two reasons that are the same reason: an SVG rect cannot
 * share the element's `border-radius`, it can only approximate it, and it
 * had to be inset to keep its stroke from clipping — so it sat visibly
 * INSIDE the edge rather than being the edge.
 *
 * This is a conic gradient masked to a ring. `border-radius` on the overlay
 * resolves against the overlay's own box, so it is the element's shape at
 * any size; the two-layer mask (`content-box` minus the whole box) punches
 * out the middle, leaving `inset` worth of ring. Sweeping the gradient's
 * stop from a full turn to nothing empties it.
 *
 * ## Why it is driven by an end time
 *
 * A clock that starts when it mounts is wrong the moment it mounts late —
 * after a refresh, or in a tab that was hidden while it ran, whose timers
 * the browser throttled to one a minute. Given `endsAt`, it starts
 * however full it really is, and re-reads the time whenever the tab comes
 * back. Without `endsAt` it runs `totalMs` from when it mounted, which is
 * right for a chance that appears as it is offered.
 *
 * The colour is a function of the sweep itself, not a timer of its own, so
 * it cannot disagree with the ring: each band is still a flat colour, and
 * the switch is still a switch.
 */

import { useEffect } from "react";
import { animate, motion, useMotionValue, useTransform, type AnimationPlaybackControls } from "motion/react";

/** Where the ring turns amber, then red, as a fraction of time REMAINING. */
export const WARN_AT = 0.5;
export const DANGER_AT = 0.2;

export type CountdownBand = "safe" | "warn" | "danger";

export const BAND_COLOUR: Record<CountdownBand, string> = {
  safe: "var(--color-emerald-400, #34d399)",
  warn: "var(--color-amber-400, #fbbf24)",
  danger: "var(--color-red-400, #f87171)",
};

export function bandOf(fraction: number): CountdownBand {
  return fraction > WARN_AT ? "safe" : fraction > DANGER_AT ? "warn" : "danger";
}

/**
 * How full the ring is at `now`: 1 for as long as more than `totalMs` is
 * left (a clock whose count has not begun yet), then down to 0 at `endsAt`.
 */
export function ringFraction(now: number, endsAt: number, totalMs: number): number {
  if (totalMs <= 0) return 0;
  return Math.max(0, Math.min(1, (endsAt - now) / totalMs));
}

export interface CountdownRingProps {
  /** A full ring's worth of time. */
  totalMs: number;
  /** When it empties, by `Date.now()`. Omitted: `totalMs` from mounting. */
  endsAt?: number;
  /** The element's own corner radius plus `inset`, as CSS. */
  radius?: string;
  /** How far outside the element, and how thick, in px. */
  inset?: number;
}

export function CountdownRing({ totalMs, endsAt, radius = "9999px", inset = 3 }: CountdownRingProps) {
  const sweep = useMotionValue(1);
  const colour = useTransform(sweep, (v) => BAND_COLOUR[bandOf(v)]);
  const background = useTransform(
    sweep,
    (v) => `conic-gradient(from -90deg, currentColor ${v * 360}deg, transparent 0)`,
  );

  useEffect(() => {
    const end = endsAt ?? Date.now() + totalMs;
    let controls: AnimationPlaybackControls | undefined;
    const run = () => {
      controls?.stop();
      const remaining = Math.max(0, end - Date.now());
      sweep.set(ringFraction(Date.now(), end, totalMs));
      // Held full while more than a ring's worth is left, then linear.
      controls = animate(sweep, 0, {
        duration: Math.min(remaining, totalMs) / 1000,
        delay: Math.max(0, remaining - totalMs) / 1000,
        ease: "linear",
      });
    };
    run();
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controls?.stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [endsAt, totalMs, sweep]);

  const ring = "linear-gradient(#000 0 0)";
  return (
    <motion.span
      aria-hidden
      className="pointer-events-none absolute"
      style={{
        // Just OUTSIDE the element, so it reads as a border around it rather
        // than as decoration painted on the face.
        inset: -inset,
        padding: inset,
        borderRadius: radius,
        color: colour,
        background,
        // Two mask layers, the inner one clipped to the content box,
        // composited so the middle is punched out — what is left is exactly
        // `inset` worth of ring following the overlay's own radius.
        WebkitMask: `${ring} content-box, ${ring}`,
        WebkitMaskComposite: "xor",
        mask: `${ring} content-box, ${ring}`,
        maskComposite: "exclude",
      }}
    />
  );
}
