"use client";

/**
 * A pannable region over a fanned pile, plus the affordance that tells
 * the player it is one.
 *
 * The affordance is a felt-coloured edge fade and a softly pulsing
 * chevron, shown only at edges that still hide real content and
 * reactive to the live pan — deliberately NOT a scrollbar or a
 * scroll-wheel widget, which would read as browser chrome sitting on a
 * card table. Without something, a pannable-but-not-obviously-so region
 * is undiscoverable; users have no reason to try dragging felt.
 *
 * It has to be an ADDITIVELY OVERLAID decoration rather than a CSS mask
 * on a wrapping container, because there is no such container to mask:
 * the fan's cards are independent, absolutely positioned pieces in the
 * app's one flat piece layer, not children of a div. This element sits
 * over them and paints; it never clips them.
 *
 * Which is also why it is NOT what hides the panned-away cards. It can
 * only paint over its own box, and an overflowing fan puts cards
 * OUTSIDE that box — under a seat pod, under the board sheet, off the
 * screen. That job belongs to the pieces themselves, which fade out as
 * they cross the boundary (`FanSlot.visible`). What is left here is the
 * hint: a soft edge shade to sit the chevron on, deliberately a plain
 * shadow rather than a felt-coloured cover, since the felt under the
 * pile is a radial gradient and no single flat swatch matches it.
 *
 * The gesture itself is `usePanZone` — see that file for why it listens
 * at document level against a bounding rect rather than hit-testing.
 */

import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import type { Box } from "./geometry";
import { usePanZone } from "./usePanZone";

export interface PanSurfaceProps {
  /** Region the gesture is picked up in, in container px. */
  within: Box;
  axis: "x" | "y";
  /** Total hidden extent. 0 means everything fits and nothing pans. */
  range: number;
  /** Current signed pan. See `fanPanRange` for why it is signed. */
  value: number;
  onChange: (v: number) => void;
}

export function PanSurface({ within, axis, range, value, onChange }: PanSurfaceProps) {
  const ref = useRef<HTMLDivElement>(null);
  const active = range > 1;
  // Signed pan runs [-range/2, +range/2]; +range/2 puts the fan's first
  // piece flush against the near edge, which is where a pile or a hand
  // should start.
  const half = range / 2;

  // Re-clamp when the pile's depth changes under the current pan — a
  // pile that shrinks can leave the stored value outside the new range,
  // which would strand the fan off-screen with no way back.
  useEffect(() => {
    if (value > half) onChange(half);
    else if (value < -half) onChange(-half);
  }, [half, value, onChange]);

  usePanZone({ ref, axis, value, min: -half, max: half, onChange, enabled: active });

  // At +half the fan starts at the near edge, so everything hidden is at
  // the FAR one, and vice versa. Both fade out as the player reaches
  // that end, so the hint clears once it has been acted on.
  const nearHidden = active ? Math.max(0, half - value) : 0;
  const farHidden = active ? Math.max(0, value + half) : 0;

  return (
    <div
      ref={ref}
      aria-hidden
      // Never intercepts a tap: the gesture is read at document level
      // from coordinates, so this element only needs to EXIST at the
      // right place, not receive events. Leaving it click-through is
      // what keeps every card underneath tappable.
      className="pointer-events-none absolute"
      style={{ left: within.x, top: within.y, width: within.w, height: within.h }}
    >
      <EdgeHint axis={axis} side="near" hidden={nearHidden} />
      <EdgeHint axis={axis} side="far" hidden={farHidden} />
    </div>
  );
}

const FADE = 30;

function EdgeHint({
  axis,
  side,
  hidden,
}: {
  axis: "x" | "y";
  side: "near" | "far";
  hidden: number;
}) {
  if (hidden < 2) return null;

  const horizontal = axis === "x";
  const direction = horizontal
    ? side === "near"
      ? "to right"
      : "to left"
    : side === "near"
      ? "to bottom"
      : "to top";

  const box: React.CSSProperties = horizontal
    ? { top: 0, bottom: 0, width: FADE, [side === "near" ? "left" : "right"]: 0 }
    : { left: 0, right: 0, height: FADE, [side === "near" ? "top" : "bottom"]: 0 };

  const glyph = horizontal ? (side === "near" ? "‹" : "›") : side === "near" ? "⌃" : "⌄";

  return (
    <div
      className="absolute flex items-center justify-center"
      style={{
        ...box,
        background: `linear-gradient(${direction}, rgb(7 19 16 / 0.55), transparent)`,
      }}
    >
      <motion.span
        className="text-[13px] leading-none font-bold text-brass-300"
        animate={{ opacity: [0.35, 0.9, 0.35] }}
        transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
      >
        {glyph}
      </motion.span>
    </div>
  );
}
