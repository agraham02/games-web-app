"use client";

/**
 * A draggable sheet that lives INSIDE the table, not over the page.
 *
 * Deliberately not vaul, despite vaul being the shadcn drawer: vaul
 * portals to document.body, which would escape the table surface (and
 * the lab's device frame), and it is modal by default. This rail must
 * be non-modal — the whole point is reading the board WHILE you look at
 * your hand, which a modal makes impossible.
 *
 * Three snap points, matching the three tiers of Rummy's disclosure:
 *   peek  — a strip above the hand, always present, costs nothing
 *   half  — browse the board without losing sight of your cards
 *   full  — the board is the task
 */

import { useEffect, useRef, useState } from "react";
import { motion, useMotionValue, animate, type PanInfo } from "motion/react";
import { TRANSITIONS } from "@/motion/presets";

export interface PeekRailProps {
  /** Visible heights in px, ascending. Typically [peek, half, full]. */
  snapPoints: readonly number[];
  snapIndex: number;
  onSnapChange: (index: number) => void;
  header?: React.ReactNode;
  children?: React.ReactNode;
  /** Rendered pinned at the bottom of the sheet at the largest snap. */
  footer?: React.ReactNode;
  /**
   * Distance from the bottom of the container, in px. Games pass the
   * hand-zone height so the rail stops above the player's cards —
   * even fully open it must never cover your own hand, or "check the
   * board" turns into "lose sight of what you were comparing".
   */
  offsetBottom?: number;
}

export function PeekRail({
  snapPoints,
  snapIndex,
  onSnapChange,
  header,
  children,
  footer,
  offsetBottom = 0,
}: PeekRailProps) {
  const tallest = snapPoints[snapPoints.length - 1] ?? 0;
  const y = useMotionValue(0);
  const dragging = useRef(false);

  // The section's real CSS height, not just its transform. Framer's
  // drag needs the full `tallest` range to move through, but leaving
  // the box that tall AT REST — with `y` merely translating the
  // "extra" part out of view — does not remove that part from hit
  // testing: `translateY` moves where a box paints, not whether the
  // browser still resolves clicks against the space it vacated. Since
  // this rail sits above the hero's hand, that invisible leftover slice
  // silently ate every tap on a hand card underneath it. Inflating to
  // `tallest` only while an actual drag gesture is in progress — when
  // the pointer is already committed to the rail — keeps the resting
  // box exactly as tall as what's visible, every other time.
  const [boxHeight, setBoxHeight] = useState(snapPoints[snapIndex] ?? 0);

  // Follow controlled changes, but never fight the user mid-drag.
  useEffect(() => {
    if (dragging.current) return;
    setBoxHeight(snapPoints[snapIndex] ?? 0);
    y.set(0);
  }, [snapIndex, snapPoints, y]);

  const startDrag = () => {
    dragging.current = true;
    // Grow to the full drag range without a visual jump: height and y
    // change together so the rendered top edge doesn't move.
    const current = snapPoints[snapIndex] ?? 0;
    y.set(tallest - current);
    setBoxHeight(tallest);
  };

  const settle = (_: unknown, info: PanInfo) => {
    // Project where a flick would land, so a fast swipe skips a stop
    // instead of creeping to the neighbouring one.
    const projected = y.get() + info.velocity.y * 0.12;
    const visible = tallest - projected;

    let best = 0;
    let bestDist = Infinity;
    snapPoints.forEach((p, i) => {
      const d = Math.abs(p - visible);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });

    animate(y, tallest - (snapPoints[best] ?? 0), {
      ...TRANSITIONS.ui,
      onComplete: () => {
        // Only now — once the settle animation has visually finished —
        // shrink back to a real, non-inflated box.
        dragging.current = false;
        setBoxHeight(snapPoints[best] ?? 0);
        y.set(0);
      },
    });
    onSnapChange(best);
  };

  const atFull = snapIndex === snapPoints.length - 1;

  return (
    <motion.section
      className="absolute right-0 left-0 z-1500 flex flex-col rounded-t-sheet border-t border-brass-400/30 bg-linear-to-b from-felt-800/95 to-felt-900 shadow-[0_-8px_40px_rgb(0_0_0/0.5)] backdrop-blur-lg"
      style={{ height: boxHeight, y, bottom: offsetBottom }}
      drag="y"
      dragConstraints={{ top: 0, bottom: tallest - (snapPoints[0] ?? 0) }}
      dragElastic={0.04}
      dragMomentum={false}
      onDragStart={startDrag}
      onDragEnd={settle}
    >
      {/* Grab handle. Tapping it steps through the snap points, so the
          rail is usable without a drag gesture at all. */}
      <button
        type="button"
        aria-label="Resize board panel"
        className="w-full shrink-0 cursor-grab touch-none px-3 pt-2.5 pb-1.5 active:cursor-grabbing"
        onClick={() => onSnapChange((snapIndex + 1) % snapPoints.length)}
      >
        <span className="mx-auto block h-1 w-9 rounded-full bg-bone-50/28" />
      </button>

      {header ? (
        <div className="shrink-0 px-3.5 pb-2">{header}</div>
      ) : null}

      <div
        className={`min-h-0 flex-1 px-3.5 ${atFull ? "overflow-y-auto" : "overflow-hidden"}`}
      >
        {children}
      </div>

      {footer && atFull ? (
        <div className="shrink-0 px-3.5 pt-2 pb-5">{footer}</div>
      ) : null}
    </motion.section>
  );
}
