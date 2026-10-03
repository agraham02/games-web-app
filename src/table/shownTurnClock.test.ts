// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useShownTurnClock } from "./shownTurnClock";

const clock = (seat: number, key = `turn:${seat}`) => ({ seat, key, totalMs: 30_000, endsAt: 0 });

type Props = {
  c: ReturnType<typeof clock> | null;
  currentSeat: number | null;
  animating: boolean;
};

function setup(initial: Props) {
  return renderHook((p: Props) => useShownTurnClock(p.c, p), { initialProps: initial });
}

describe("useShownTurnClock", () => {
  it("waits while the bot's move that hands over the turn is still playing", () => {
    // The server has already armed seat 2's clock; this screen is still
    // showing seat 1 (a bot) think and play.
    const { result, rerender } = setup({ c: clock(2), currentSeat: 1, animating: true });
    expect(result.current).toBeNull();
    // The move has landed, but this screen has not moved the turn on yet.
    rerender({ c: clock(2), currentSeat: 1, animating: false });
    expect(result.current).toBeNull();
    rerender({ c: clock(2), currentSeat: 2, animating: false });
    expect(result.current?.seat).toBe(2);
  });

  it("does not run over the deal", () => {
    const { result, rerender } = setup({ c: clock(0), currentSeat: 0, animating: true });
    expect(result.current).toBeNull();
    rerender({ c: clock(0), currentSeat: 0, animating: false });
    expect(result.current?.seat).toBe(0);
  });

  it("stays up through other animation once shown, until the move changes", () => {
    const { result, rerender } = setup({ c: clock(0), currentSeat: 0, animating: false });
    expect(result.current).not.toBeNull();
    // A bot's frame mid-move (BS: a decline) must not blink it off.
    rerender({ c: clock(0), currentSeat: 0, animating: true });
    expect(result.current).not.toBeNull();
    // A new clock waits its own turn.
    rerender({ c: clock(1), currentSeat: 0, animating: true });
    expect(result.current).toBeNull();
    rerender({ c: null, currentSeat: 1, animating: false });
    expect(result.current).toBeNull();
  });
});
