"use client";

/**
 * The window's width in px, kept current — for the rare size that has to be a
 * NUMBER rather than a class (the home carousel places its slides by
 * transform). 0 on the server and for the first client render, so hydration
 * matches; callers treat 0 as "not measured yet".
 */

import { useSyncExternalStore } from "react";

export function useViewportWidth(): number {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener("resize", onChange);
      return () => window.removeEventListener("resize", onChange);
    },
    () => window.innerWidth,
    () => 0,
  );
}
