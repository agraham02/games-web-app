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
 * ## Why a measured SVG path
 *
 * Third try. The first was an SVG `<rect rx="9999">` laid over the button.
 * It read as cheap: a rect cannot share the element's `border-radius`, only
 * approximate it (an `rx` past half the width turns it into an ellipse),
 * and it was inset to keep its stroke from clipping — so it sat visibly
 * INSIDE the edge rather than being the edge.
 *
 * The second was a conic gradient masked to a ring, which had the shape
 * exactly but swept by ANGLE from the middle. On anything wider than it is
 * tall, equal angles are very unequal lengths of edge: it raced round the
 * ends and crawled along the long sides — "really fast at the start, then
 * slow in the middle, and then really fast again" (the user, 2026-10-01,
 * on the scorecard's Continue) — and its tip was a hard radial cut where
 * they wanted a rounded end.
 *
 * So: the overlay is measured (its layout size, which a `scale` animation
 * does not touch, and its computed corner radius, so any CSS length works)
 * and a rounded rectangle is drawn along the middle of the band, with round
 * caps and `overflow: visible` so nothing clips. The visible part is a dash
 * of `fraction × perimeter`: it empties by DISTANCE, which is what an eye
 * follows, at one speed all the way round.
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

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  animate,
  motion,
  useMotionValue,
  useTransform,
  type AnimationPlaybackControls,
  type MotionValue,
} from "motion/react";

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

/**
 * The ring's path, along the middle of its stroke: a rounded rectangle in
 * a `width` × `height` box (the overlay — the element plus the ring round
 * it), whose OUTER corners have `radius`. Starts at the middle of the left
 * side and runs clockwise, where the conic gradient before it did.
 *
 * `length` is the true perimeter, so a dash of `fraction × length` is that
 * fraction of the way round by distance.
 */
export function ringPath(
  width: number,
  height: number,
  radius: number,
  stroke: number,
): { d: string; length: number } {
  const half = stroke / 2;
  const w = Math.max(0, width - stroke);
  const h = Math.max(0, height - stroke);
  // What CSS does with a radius too big for the box (a pill's 9999px):
  // clamped to half the shorter side.
  const r = Math.max(0, Math.min(radius - half, w / 2, h / 2));
  const n = (v: number) => Math.round(v * 100) / 100;
  const [left, top, right, bottom] = [half, half, half + w, half + h];
  const d = [
    `M ${n(left)} ${n(top + h / 2)}`,
    `V ${n(top + r)}`,
    `A ${n(r)} ${n(r)} 0 0 1 ${n(left + r)} ${n(top)}`,
    `H ${n(right - r)}`,
    `A ${n(r)} ${n(r)} 0 0 1 ${n(right)} ${n(top + r)}`,
    `V ${n(bottom - r)}`,
    `A ${n(r)} ${n(r)} 0 0 1 ${n(right - r)} ${n(bottom)}`,
    `H ${n(left + r)}`,
    `A ${n(r)} ${n(r)} 0 0 1 ${n(left)} ${n(bottom - r)}`,
    `V ${n(top + h / 2)}`,
  ].join(" ");
  return { d, length: 2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * Math.PI * r };
}

export function CountdownRing({ totalMs, endsAt, radius = "9999px", inset = 3 }: CountdownRingProps) {
  const sweep = useCountdownSweep(totalMs, endsAt);
  const colour = useTransform(sweep, (v) => BAND_COLOUR[bandOf(v)]);

  const ref = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState<{ width: number; height: number; radius: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // Layout size, not `getBoundingClientRect`: a pod grows 6% while it is
      // that seat's turn, and the button this sits in lands with a bounce.
      const next = {
        width: el.offsetWidth,
        height: el.offsetHeight,
        radius: parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0,
      };
      setBox((was) =>
        was && was.width === next.width && was.height === next.height && was.radius === next.radius
          ? was
          : next,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [radius, inset]);

  const path = box && box.width > 0 && box.height > 0 ? ringPath(box.width, box.height, box.radius, inset) : null;
  const length = useMotionValue(0);
  useEffect(() => length.set(path?.length ?? 0), [length, path?.length]);
  // The gap is longer than the whole path, so the dash never repeats.
  const dash = useTransform([sweep, length], ([v, l]: number[]) => `${v! * l!} ${l! + inset * 2}`);
  // A round cap on an empty dash is still a dot.
  const opacity = useTransform(sweep, (v) => (v > 0 ? 1 : 0));

  return (
    <span
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute"
      // Just OUTSIDE the element, so it reads as a border around it rather
      // than as decoration painted on the face. The radius is here only to
      // be read back as pixels.
      style={{ inset: -inset, borderRadius: radius }}
    >
      {path ? (
        <svg className="absolute inset-0 overflow-visible" width={box!.width} height={box!.height}>
          <motion.path
            d={path.d}
            fill="none"
            strokeWidth={inset}
            strokeLinecap="round"
            style={{ stroke: colour, strokeDasharray: dash, opacity }}
          />
        </svg>
      ) : null}
    </span>
  );
}

/**
 * How full a countdown is, 1 to 0, as a motion value. Held full while more
 * than a clock's worth is left, then linear; re-read from the time whenever
 * the tab is shown again.
 */
function useCountdownSweep(totalMs: number, endsAt?: number): MotionValue<number> {
  const sweep = useMotionValue(1);
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
  return sweep;
}
