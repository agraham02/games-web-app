"use client";

/**
 * Every route fades in and rises a few pixels as it arrives — home, a
 * setup screen, the room. They used to replace each other in a single
 * frame.
 *
 * Enter only: the App Router unmounts the old page at once, so there is
 * nothing to animate out. A template rather than the layout, because a
 * template remounts on every navigation, which is what makes the entrance
 * play each time.
 */

import { Reveal } from "@/ui/motion";

export default function Template({ children }: { children: React.ReactNode }) {
  return <Reveal>{children}</Reveal>;
}
