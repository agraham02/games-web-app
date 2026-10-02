// @vitest-environment node

import { describe, expect, it } from "vitest";
import { toLocalClock } from "./useRoom";

describe("a turn clock, on this machine's time", () => {
  it("ends what was left after it was sent, less the time it took to arrive", () => {
    const clock = { seat: 2, key: "turn:9:2", totalMs: 30_000, endsInMs: 12_000 };
    // Received at 1_000 by this machine's clock, 80ms after it was sent.
    expect(toLocalClock(clock, 1_000, 80)).toEqual({ seat: 2, key: "turn:9:2", totalMs: 30_000, endsAt: 12_920 });
  });

  it("is the same instant on two machines whose clocks disagree", () => {
    const clock = { seat: 0, key: "k", totalMs: 5_000, endsInMs: 4_000 };
    // One machine's clock is an hour ahead of the other's: each ends the
    // ring 4s (less the trip) after it heard, which is the same moment.
    const a = toLocalClock(clock, 10_000, 50);
    const b = toLocalClock(clock, 3_610_000, 50);
    expect(a.endsAt - 10_000).toBe(b.endsAt - 3_610_000);
  });
});
