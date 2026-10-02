import { describe, expect, it } from "vitest";
import { CLEAR_RTT_MS, LinkMonitor, STALL_MS, WEAK_RTT_MS } from "./link";

/** Pings `rtt` ms apart in time, each answered after `rtt`. */
function pings(link: LinkMonitor, rtts: number[], start = 0): number {
  let now = start;
  rtts.forEach((rtt, i) => {
    link.sent(start + i, now);
    now += rtt;
    link.answered(start + i, now);
  });
  return now;
}

describe("LinkMonitor", () => {
  it("is fine until it knows otherwise, and reads the median round trip", () => {
    const link = new LinkMonitor();
    expect(link.weak).toBe(false);
    expect(link.rttMs()).toBeNull();
    pings(link, [80, 2000, 90]);
    // One bad sample is noise.
    expect(link.rttMs()).toBe(90);
    expect(link.weak).toBe(false);
  });

  it("calls a slow round trip slow, and lets go only well below the line", () => {
    const link = new LinkMonitor();
    let now = pings(link, [600, 600, 600]);
    expect(link.weak).toBe(true);
    // Between the two lines: still slow, so the icon does not blink.
    now = pings(link, Array(5).fill((WEAK_RTT_MS + CLEAR_RTT_MS) / 2), now);
    expect(link.weak).toBe(true);
    pings(link, Array(5).fill(CLEAR_RTT_MS - 50), now);
    expect(link.weak).toBe(false);
  });

  it("calls silence slow without waiting for an answer", () => {
    const link = new LinkMonitor();
    const now = pings(link, [60, 60, 60]);
    link.sent(99, now);
    expect(link.tick(now + STALL_MS - 1)).toBe(false);
    expect(link.tick(now + STALL_MS)).toBe(true);
    expect(link.weak).toBe(true);
    // The answer arriving at last clears it, if the round trips are good.
    link.answered(99, now + STALL_MS + 10);
    // That one took 1.5s: one sample among good ones, the median holds.
    expect(link.weak).toBe(false);
  });

  it("says when it changed, and only then", () => {
    const link = new LinkMonitor();
    link.sent(1, 0);
    expect(link.answered(1, 700)).toBe(true);
    link.sent(2, 1000);
    expect(link.answered(2, 1700)).toBe(false);
    // An answer to nothing outstanding changes nothing.
    expect(link.answered(42, 2000)).toBe(false);
    expect(link.weak).toBe(true);
  });
});
