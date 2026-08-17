"use client";

/**
 * Drag-to-pan for a fanned pile that has stopped compressing and started
 * hiding content (see geometry's `fanPanRange`).
 *
 * COORDINATE-BASED, NOT HIT-TESTED, and that is the entire point of the
 * file. The obvious implementation is a catcher `div` sitting below the
 * cards in z-order, letting a card win a tap over its own footprint and
 * catching drags in the gaps between cards. That silently fails exactly
 * when it is needed most: a heavily compressed, overflowing fan has
 * almost no exposed gap left to grab, and a `pointerdown` that lands ON
 * a card never reaches the catcher underneath it at all — the browser
 * routes the event to whichever element is topmost, and DOM bubbling
 * climbs the ancestor chain, never sideways to a covered sibling. So
 * most real drag attempts on a badly compressed fan simply never start
 * a pan.
 *
 * Listening at `document` level and testing the pointer's own
 * coordinates against the catcher's `getBoundingClientRect()` — which
 * stays geometrically accurate no matter what is painted on top of it —
 * works regardless of z-order. The discard pile's wider felt margins
 * happen to leave enough slack that the naive version "works" there;
 * both surfaces use this anyway, because an inconsistent mechanism
 * between two things that look identical to a player is not worth the
 * fragility of leaving one of them on the version that breaks.
 *
 * A gesture is only claimed as a pan once it has moved past a small
 * threshold AND is clearly along the intended axis. Cross-axis movement
 * releases it back to the browser, so a vertical page gesture that
 * happens to start inside a horizontal pan zone is not hijacked; and
 * nothing calls `preventDefault` until real panning is confirmed, so a
 * short, mostly-still gesture still reaches the card underneath as an
 * ordinary tap.
 *
 * Companion setup, without which none of this survives a real
 * touchscreen: `body { overflow: hidden }` on BOTH axes (globals.css)
 * and `touch-action: none` on the felt (TableSurface). See their own
 * comments — a native scroll container will claim a swipe before any JS
 * handler ever sees the pointer.
 */

import { useEffect, useRef, type RefObject } from "react";

/** Movement, in px, before a gesture counts as a pan rather than a tap. */
const PAN_THRESHOLD = 6;

export interface PanZoneOptions {
  /** The region a gesture must start inside. Read geometrically only. */
  ref: RefObject<HTMLElement | null>;
  /** Which way this fan runs. */
  axis: "x" | "y";
  /** Current pan offset, in px. */
  value: number;
  /** Clamp bounds, inclusive. */
  min: number;
  max: number;
  onChange: (value: number) => void;
  /** Turns the whole gesture off — e.g. nothing is hidden yet. */
  enabled?: boolean;
}

export function usePanZone({
  ref,
  axis,
  value,
  min,
  max,
  onChange,
  enabled = true,
}: PanZoneOptions) {
  // Everything the listeners read lives in a ref, so the listeners
  // themselves can be attached once and never re-bound mid-gesture —
  // re-binding on every pan frame would drop the gesture it is serving.
  const live = useRef({ axis, value, min, max, onChange, enabled });
  // Refreshed in an effect rather than during render: a ref written
  // mid-render is a real hazard (it can be lost to a discarded render
  // pass), and nothing reads this until a pointer event fires, which is
  // always after commit.
  useEffect(() => {
    live.current = { axis, value, min, max, onChange, enabled };
  });

  useEffect(() => {
    const start = { x: 0, y: 0, from: 0 };
    let tracking = false;
    let committed = false;

    const inZone = (e: PointerEvent) => {
      const el = ref.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return (
        e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
      );
    };

    const onDown = (e: PointerEvent) => {
      if (!live.current.enabled) return;
      if (!inZone(e)) return;
      tracking = true;
      committed = false;
      start.x = e.clientX;
      start.y = e.clientY;
      start.from = live.current.value;
    };

    const onMove = (e: PointerEvent) => {
      if (!tracking) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const along = live.current.axis === "x" ? dx : dy;
      const across = live.current.axis === "x" ? dy : dx;

      if (!committed) {
        if (Math.abs(along) < PAN_THRESHOLD) {
          // Not yet a pan. If the gesture has instead committed clearly
          // to the OTHER axis, let go of it entirely — a vertical page
          // swipe that happens to begin inside a horizontal pan zone
          // belongs to the browser, not to us.
          if (Math.abs(across) > PAN_THRESHOLD) tracking = false;
          return;
        }
        committed = true;
      }

      // Only now, once this is definitely a pan, do we take the gesture
      // away from the browser's own default handling.
      e.preventDefault();
      const { min: lo, max: hi, onChange: emit } = live.current;
      emit(Math.max(lo, Math.min(hi, start.from + along)));
    };

    const onUp = () => {
      tracking = false;
      committed = false;
    };

    // `passive: false` on move so `preventDefault` is actually honoured;
    // down/up never prevent anything, so they stay passive.
    document.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("pointermove", onMove, { passive: false });
    document.addEventListener("pointerup", onUp, { passive: true });
    document.addEventListener("pointercancel", onUp, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
  }, [ref]);
}
