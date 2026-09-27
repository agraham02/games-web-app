"use client";

/**
 * A number that counts to its value.
 *
 * Tabular figures are non-negotiable here — proportional digits change
 * width as they tick, so the whole scorecard shivers while it counts.
 */

import { useEffect, useRef } from "react";
import { animate, useReducedMotion } from "motion/react";
import { DURATION, EASE_OUT_QUINT } from "@/motion/presets";

/**
 * A whole number with a real minus sign (U+2212), not a hyphen: the
 * scorecard's deltas already print "−145", and a total beside it reading
 * "-145" was visibly a different character.
 */
export function formatWhole(n: number): string {
  const whole = Math.round(n);
  return whole < 0 ? `−${Math.abs(whole)}` : String(whole);
}

export function AnimatedNumber({
  value,
  duration = DURATION.count,
  className,
  format = formatWhole,
}: {
  value: number;
  duration?: number;
  className?: string;
  format?: (n: number) => string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const from = useRef(value);
  const reduced = useReducedMotion();

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const start = from.current;
    from.current = value;

    if (reduced || start === value) {
      node.textContent = format(value);
      return;
    }

    const controls = animate(start, value, {
      duration,
      ease: EASE_OUT_QUINT,
      onUpdate: (n) => {
        node.textContent = format(n);
      },
    });
    return () => controls.stop();
  }, [value, duration, format, reduced]);

  return (
    <span ref={ref} className={`tnum ${className ?? ""}`}>
      {format(value)}
    </span>
  );
}
