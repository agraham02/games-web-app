"use client";

/**
 * A row that scrolls sideways, made to work with a mouse too.
 *
 * A finger swipes an `overflow-x-auto` row with nothing more. A mouse
 * cannot: with the scrollbar hidden, its wheel scrolls up and down and a
 * drag selects nothing and moves nothing. On a desktop the quick replies
 * past the first few were simply out of reach ("I was on desktop and I could
 * not scroll the quick reply section", the user, 2026-10-01). So:
 *
 * - The wheel scrolls it sideways. Only an up-and-down wheel, and only when
 *   there is somewhere to go: a trackpad's own sideways swipe is the
 *   browser's already.
 * - A mouse drags it. Past a few pixels a press is a drag, and the click
 *   that ends it is swallowed, so letting go over a reply does not send it.
 * - `edges` says which ends have more beyond them, for the caller to fade.
 *
 * Scroll snapping fights both (each small step snaps back to where it
 * started), so the row should snap only for a coarse pointer.
 */

import { useEffect, useRef, useState } from "react";

/** How far a mouse moves, pressed, before the press is a drag. */
const DRAG_FROM_PX = 5;

/**
 * `watch` is whatever decides what is in the row: when it changes the row is
 * measured again, since a row that gains or loses items does not change size
 * itself, and nothing else would notice its ends had moved.
 */
export function useSidewaysScroll<T extends HTMLElement>(watch?: unknown) {
  const ref = useRef<T>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const room = () => el.scrollWidth - el.clientWidth;

    const update = () => {
      const next = { start: el.scrollLeft > 1, end: el.scrollLeft < room() - 1 };
      setEdges((was) => (was.start === next.start && was.end === next.end ? was : next));
    };

    const onWheel = (e: WheelEvent) => {
      // A pinch on a trackpad arrives as a wheel with ctrl held.
      if (e.ctrlKey || room() <= 0) return;
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1;
      e.preventDefault();
      el.scrollLeft += e.deltaY * unit;
    };

    let drag: { id: number; x: number; from: number; moved: boolean } | null = null;
    let swallowClick = false;
    const onDown = (e: PointerEvent) => {
      swallowClick = false;
      if (e.pointerType !== "mouse" || e.button !== 0 || room() <= 0) return;
      drag = { id: e.pointerId, x: e.clientX, from: el.scrollLeft, moved: false };
    };
    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved) {
        if (Math.abs(dx) < DRAG_FROM_PX) return;
        drag.moved = true;
        el.setPointerCapture?.(e.pointerId);
      }
      el.scrollLeft = drag.from - dx;
    };
    const onUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      swallowClick = drag.moved;
      drag = null;
    };
    const onClick = (e: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    };

    update();
    el.addEventListener("scroll", update, { passive: true });
    // Not passive: `preventDefault` is what stops the page scrolling too.
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("click", onClick, { capture: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("click", onClick, { capture: true });
      observer?.disconnect();
    };
  }, [watch]);

  return { ref, edges };
}

/** A `mask-image` that fades whichever ends have more beyond them. */
export function edgeFade(edges: { start: boolean; end: boolean }, px = 24): string | undefined {
  if (!edges.start && !edges.end) return undefined;
  const from = edges.start ? `transparent 0, #000 ${px}px` : "#000 0";
  const to = edges.end ? `#000 calc(100% - ${px}px), transparent 100%` : "#000 100%";
  return `linear-gradient(to right, ${from}, ${to})`;
}
