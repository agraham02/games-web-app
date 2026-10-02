// @vitest-environment jsdom

/**
 * What somebody said, beside their pod — and only what they say while the
 * table is up.
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTable } from "./geometry";
import { SeatBubbles, bubbleMs, placeFor } from "./SeatBubbles";
import type { SeatView } from "./SeatRing";
import { useTableStore } from "./store";

const g = resolveTable({ seats: 4, width: 390, height: 844 });

// Motion's own switch for tests: every animation completes at once, so an
// exit leaves the DOM instead of waiting on frames jsdom never paints.
beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});

beforeEach(() => {
  useTableStore.getState().setGeometry(g);
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const pods = (bubbles: Record<number, { id: number; text: string } | undefined>): SeatView[] =>
  [0, 1, 2, 3].map((seat) => ({ seat, name: `P${seat}`, colour: "red", bubble: bubbles[seat] ?? null }));

describe("SeatBubbles", () => {
  it("shows what was just said beside that seat's pod, then lets it go", async () => {
    const { rerender } = render(<SeatBubbles players={pods({})} />);
    rerender(<SeatBubbles players={pods({ 2: { id: 5, text: "nice hand" } })} />);
    expect(screen.getByRole("status").textContent).toBe("nice hand");

    act(() => vi.advanceTimersByTime(bubbleMs("nice hand") - 100));
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => vi.advanceTimersByTime(200));
    // Its fade is a Motion animation, which jsdom never finishes on its own.
    vi.useRealTimers();
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("does not replay what was said before the table appeared", () => {
    // A refresh, or coming back from the lobby: the last thing each person
    // said is old news, not something they are saying now.
    const { rerender } = render(<SeatBubbles players={pods({ 1: { id: 3, text: "earlier" } })} />);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<SeatBubbles players={pods({ 1: { id: 7, text: "now" } })} />);
    expect(screen.getByRole("status").textContent).toBe("now");
  });

  it("never shows your own, which has no pod", () => {
    const { rerender } = render(<SeatBubbles players={pods({})} />);
    rerender(<SeatBubbles players={pods({ 0: { id: 9, text: "me talking" } })} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("hangs below a pod in the top half and above one in the bottom half, on the table", () => {
    // Beside a pod was the first try, and put a phone's high left seat's
    // bubble into the toast lane.
    for (const slot of g.seats.filter((s) => !s.isHero)) {
      const place = placeFor(slot, g.density, g.box);
      const upper = slot.anchor === "top" || (slot.anchor !== "bottom" && slot.y < g.box.y + g.box.h / 2);
      expect(place.transform, `seat ${slot.seat}`).toBe(upper ? "translate(-50%, 0)" : "translate(-50%, -100%)");
      expect(place.left - 76).toBeGreaterThanOrEqual(g.box.x);
      expect(place.left + 76).toBeLessThanOrEqual(g.box.x + g.box.w);
    }
  });

  it("keeps a long message up longer, within reason", () => {
    expect(bubbleMs("ok")).toBeLessThan(bubbleMs("x".repeat(60)));
    expect(bubbleMs("x".repeat(120))).toBe(6_000);
  });
});
