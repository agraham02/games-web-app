"use client";

/**
 * A snap-scrolling carousel with no library: native `scroll-snap`, and the
 * slide nearest the middle is the active one.
 *
 * `active` is controlled, and goes both ways: swiping updates it; changing
 * it from outside (an arrow button, the lobby) scrolls to it. While WE are
 * scrolling on purpose, the slides passed on the way do not each become the
 * active one (`lock`), or a jump from the first game to the sixth would
 * flash through four themes.
 *
 * The scroller is `relative` so a slide's `offsetLeft` is measured against
 * it; left unpositioned, the maths is against some ancestor and a click on a
 * far slide scrolls nowhere.
 *
 * Reads as a labelled group of slides, and takes ← → when focused.
 */

import { useCallback, useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";

export interface CarouselProps {
  active: number;
  onActive: (index: number) => void;
  count: number;
  /** CSS length of one slide; the scroller pads itself so any slide can centre. */
  slideWidth: string;
  gap?: string;
  label: string;
  className?: string;
  children: (index: number, isActive: boolean) => React.ReactNode;
}

export function Carousel({ active, onActive, count, slideWidth, gap = "1rem", label, className, children }: CarouselProps) {
  const ref = useRef<HTMLDivElement>(null);
  const lock = useRef<number | null>(null);
  const frame = useRef(0);
  const reduced = useReducedMotion();

  const nearest = useCallback(() => {
    const el = ref.current;
    if (!el) return 0;
    const mid = el.scrollLeft + el.clientWidth / 2;
    let best = 0;
    let bestDist = Infinity;
    Array.from(el.children).forEach((child, i) => {
      const c = child as HTMLElement;
      const dist = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid);
      if (dist < bestDist) {
        best = i;
        bestDist = dist;
      }
    });
    return best;
  }, []);

  const scrollToIndex = useCallback(
    (i: number) => {
      const el = ref.current;
      const target = el?.children[i] as HTMLElement | undefined;
      if (!el || !target) return;
      lock.current = i;
      el.scrollTo?.({
        left: target.offsetLeft + target.offsetWidth / 2 - el.clientWidth / 2,
        behavior: reduced ? "auto" : "smooth",
      });
      window.setTimeout(() => {
        if (lock.current === i) lock.current = null;
      }, 700);
    },
    [reduced],
  );

  const goTo = useCallback(
    (i: number) => {
      onActive(i);
      scrollToIndex(i);
    },
    [onActive, scrollToIndex],
  );

  // While the user is scrolling, `active` already IS the nearest slide, so
  // this only acts when the page changed it.
  useEffect(() => {
    if (nearest() !== active) scrollToIndex(active);
  }, [active, nearest, scrollToIndex]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onScroll = () => {
    if (lock.current !== null) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const i = nearest();
      if (i !== active) onActive(i);
    });
  };

  return (
    <div
      ref={ref}
      role="group"
      aria-roledescription="carousel"
      aria-label={label}
      tabIndex={0}
      onScroll={onScroll}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          goTo(Math.min(count - 1, active + 1));
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          goTo(Math.max(0, active - 1));
        }
      }}
      className={`relative flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] focus-visible:outline-none [&::-webkit-scrollbar]:hidden ${className ?? ""}`}
      style={{ gap, paddingInline: `calc(50% - ${slideWidth} / 2)` }}
    >
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          role="group"
          aria-roledescription="slide"
          aria-label={`${i + 1} of ${count}`}
          className="shrink-0 snap-center"
          style={{ width: slideWidth }}
          onClick={() => {
            if (i !== active) goTo(i);
          }}
        >
          {children(i, i === active)}
        </div>
      ))}
    </div>
  );
}
