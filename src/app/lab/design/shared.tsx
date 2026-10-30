"use client";

/**
 * What the two design test pages (/lab/design/bold, /lab/design/luxury) have
 * in common. The behaviour moved into `ui/stage` when Quiet luxury was
 * chosen and built for real; this re-exports it so the two pages still run,
 * and keeps the mock room only they use.
 */

export { GameArt } from "@/ui/stage/GameArt";
export { GameBackdrop } from "@/ui/stage/GameBackdrop";
export { Carousel } from "@/ui/stage/Carousel";

export const MOCK_CODE = "KQHM";

export const MOCK_ROSTER: ReadonlyArray<{ name: string; you?: boolean; leader?: boolean; bot?: boolean; status: string }> = [
  { name: "Ada", you: true, leader: true, status: "Here" },
  { name: "Ben", status: "Here" },
  { name: "Cy", status: "Joining…" },
  { name: "Bot", bot: true, status: "Steady" },
];
