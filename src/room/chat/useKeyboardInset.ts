"use client";

import { useEffect, useState } from "react";

const NONE = { top: 0, bottom: 0 } as const;

/**
 * How much of the page the on-screen keyboard is covering, in px, so a
 * sheet can pull its bottom edge up above it (and its top down, where iOS
 * scrolls the page to show the focused field).
 *
 * The visual viewport is what the keyboard shrinks, on iOS and on Android
 * alike; the layout viewport stays put. Measuring it here, for the one
 * sheet that needs it, is what lets the page keep its default
 * `interactive-widget` — the alternative, resizing the whole layout to the
 * keyboard, would re-lay the table out under the chat every time a player
 * started typing.
 */
export function useKeyboardInset(active: boolean): { top: number; bottom: number } {
  const [inset, setInset] = useState<{ top: number; bottom: number }>(NONE);

  useEffect(() => {
    const vv = typeof window === "undefined" ? null : window.visualViewport;
    if (!active || !vv) return;
    const update = () => {
      const top = Math.max(0, Math.round(vv.offsetTop));
      const bottom = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      setInset((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
    };
    const first = requestAnimationFrame(update);
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(first);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [active]);

  return active ? inset : NONE;
}
