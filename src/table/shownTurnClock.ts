import { useState } from "react";
import type { SeatId } from "@/engine/types";

/**
 * The turn timer's clock as THIS screen should draw it: only once the seat
 * it counts is actually on turn here.
 *
 * The server arms a clock the moment it broadcasts the frame that hands a
 * person the move, and counts that frame's playback into it. Drawn on
 * arrival, the ring sat on the next person while a bot was still thinking
 * and playing, and the clock ran over the deal (the user, 2026-10-02). So
 * it waits for this screen to finish showing the move and name the seat
 * on turn — the moment that person can actually act.
 *
 * Once drawn it stays for as long as the clock is the same one (`key`):
 * something else animating mid-move — a bot answering a BS play — must
 * not blink it off and on.
 */
export function useShownTurnClock<C extends { seat: SeatId; key: string }>(
  clock: C | null | undefined,
  onScreen: { currentSeat: SeatId | null; animating: boolean },
): C | null {
  const [revealed, setRevealed] = useState<string | null>(null);
  if (!clock) return null;
  const ready = !onScreen.animating && onScreen.currentSeat === clock.seat;
  // State derived during render, React's own pattern for it: re-renders
  // at once, before anything is painted.
  if (ready && revealed !== clock.key) setRevealed(clock.key);
  return ready || revealed === clock.key ? clock : null;
}
