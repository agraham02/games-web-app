"use client";

/**
 * The home screen's game carousel: endless, and dragged by a mouse as
 * readily as by a thumb (the user, 2026-10-30).
 *
 * It is NOT native scroll-snap any more. That gave a free swipe on a phone,
 * but a scroller has two ends — so no wrapping — and a mouse cannot drag it.
 * Here every slide is placed by a transform, and the strip is a window onto
 * an unending line of slides: `virtual` is an integer that only ever moves
 * by steps, slide `k` shows game `k mod count`, and only the slides within
 * `REACH` of `virtual` are mounted. Moving one step mounts the next slide
 * off one edge and drops one off the other, so nothing ever has to jump
 * across the strip to wrap.
 *
 * `active` (0..count-1) is controlled, and goes both ways. When the page
 * changes it (a dot, an arrow) the strip takes the SHORTEST way there, so
 * from the last game to the first is one step right, not seven left.
 *
 * Dragging follows the pointer exactly (no animation while held), and on
 * release moves by however many slides it was dragged, plus a little for a
 * flick. `touch-action: pan-y` keeps a vertical swipe scrolling the page.
 */

import { useState, useRef } from "react";
import { motion, useReducedMotion } from "motion/react";

/** Slides mounted either side of the one in front. */
const REACH = 4;
const EASE = [0.22, 1, 0.36, 1] as const;

export interface CarouselProps {
  active: number;
  onActive: (index: number) => void;
  count: number;
  /** One slide's width (and height: slides are square), in px. */
  slide: number;
  /** Space between slides, in px. */
  gap?: number;
  label: string;
  className?: string;
  children: (index: number, isActive: boolean) => React.ReactNode;
}

export function Carousel({ active, onActive, count, slide, gap = 16, label, className, children }: CarouselProps) {
  const reduced = useReducedMotion();
  const wrap = (i: number) => ((i % count) + count) % count;
  const [virtual, setVirtual] = useState(active);
  const [drag, setDrag] = useState(0);
  const [held, setHeld] = useState(false);
  /** A press that moved is a drag, and must not also count as a tap on a slide. */
  const moved = useRef(false);
  const stride = slide + gap;

  // Follow `active` when the page moves it: the shortest way round. Set
  // during render, React's pattern for state that tracks a prop.
  if (wrap(virtual) !== active) {
    let delta = active - wrap(virtual);
    if (delta > count / 2) delta -= count;
    if (delta < -count / 2) delta += count;
    setVirtual(virtual + delta);
  }

  const step = (by: number) => {
    if (by === 0) return;
    setVirtual(virtual + by);
    onActive(wrap(virtual + by));
  };

  const slides: number[] = [];
  for (let k = virtual - REACH; k <= virtual + REACH; k++) slides.push(k);

  return (
    <motion.div
      role="group"
      aria-roledescription="carousel"
      aria-label={label}
      tabIndex={0}
      className={`relative w-full touch-pan-y overflow-x-clip select-none outline-none ${held ? "cursor-grabbing" : "cursor-grab"} ${className ?? ""}`}
      style={{ height: slide }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          step(1);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          step(-1);
        }
      }}
      onPanStart={() => {
        moved.current = false;
        setHeld(true);
      }}
      onPan={(_, info) => {
        if (Math.abs(info.offset.x) > 4) moved.current = true;
        setDrag(info.offset.x);
      }}
      onPanEnd={(_, info) => {
        setHeld(false);
        setDrag(0);
        step(Math.round(-(info.offset.x + info.velocity.x * 0.15) / stride));
      }}
    >
      {slides.map((k) => {
        const offset = k - virtual;
        // Where the slide is right now, in slides, counting the drag.
        const live = offset + drag / stride;
        const d = Math.abs(live);
        const scale = d < 1 ? 1 - 0.24 * d : 0.76;
        const opacity = d < 1 ? 1 - 0.68 * d : d < 3 ? 0.32 : Math.max(0, 0.32 * (REACH - d));
        return (
          <motion.div
            key={k}
            role="group"
            aria-roledescription="slide"
            aria-label={`${wrap(k) + 1} of ${count}`}
            aria-hidden={offset !== 0}
            className="absolute top-0 left-1/2"
            style={{ width: slide, height: slide, marginLeft: -slide / 2 }}
            initial={false}
            animate={{ x: offset * stride + drag, scale, opacity }}
            transition={held || reduced ? { duration: 0 } : { duration: 0.55, ease: EASE }}
            onClick={() => {
              if (!moved.current && offset !== 0) step(offset);
            }}
          >
            {children(wrap(k), offset === 0)}
          </motion.div>
        );
      })}
    </motion.div>
  );
}
