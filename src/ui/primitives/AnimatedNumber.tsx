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

export function AnimatedNumber({
  value,
  duration = DURATION.count,
  className,
  format = (n: number) => String(Math.round(n)),
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
