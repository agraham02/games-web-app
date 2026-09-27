"use client";

/**
 * Whether a media query matches, kept current as the window changes.
 *
 * For the rare control whose BEHAVIOUR changes with the screen, not just
 * its look — Poker's Raise button opens its sizing on a phone and raises
 * at once on a laptop, where the sizing is always showing. Anything that
 * only looks different belongs in CSS (a Tailwind variant), not here.
 *
 * `false` on the server and for the first client render, so hydration
 * matches; the real answer follows immediately. `false`, too, wherever
 * `matchMedia` does not exist at all (jsdom).
 */

import { useSyncExternalStore } from "react";

function mediaList(query: string): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(query)
    : null;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = mediaList(query);
      list?.addEventListener("change", onChange);
      return () => list?.removeEventListener("change", onChange);
    },
    () => mediaList(query)?.matches ?? false,
    () => false,
  );
}
