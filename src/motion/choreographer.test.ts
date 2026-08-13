import { describe, expect, it } from "vitest";
import { choreograph, totalDuration } from "./choreographer";
import type { GameEvent } from "@/engine/types";
import { STAGGER } from "./presets";

describe("choreograph", () => {
  it("staggers a run of deals instead of queueing them end to end", () => {
    const deals: GameEvent[] = Array.from({ length: 8 }, (_, i) => ({
      t: "deal",
      piece: `S${i}`,
      to: i % 4,
      faceUp: false,
    }));
    const steps = choreograph(deals);

    // First deal starts immediately; each subsequent one one stagger later.
    expect(steps[0]!.offset).toBe(0);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]!.offset).toBe(STAGGER.deal * 1000);
    }
  });

  it("keeps a full 52-card deal under four seconds", () => {
    // End-to-end at 380ms each would be twenty seconds, which is why
    // the run overlaps at all.
    const deals: GameEvent[] = Array.from({ length: 52 }, (_, i) => ({
      t: "deal",
      piece: `c${i}`,
      to: i % 4,
      faceUp: false,
    }));
    expect(totalDuration(choreograph(deals))).toBeLessThan(4000);
  });

  it("gives bot deliberation exactly the time it asked for", () => {
    const [step] = choreograph([{ t: "think", seat: 2, ms: 1400 }]);
    expect(step!.duration).toBe(1400);
  });

  it("holds a completed trick on screen before it sweeps away", () => {
    const [step] = choreograph([{ t: "collect", pieces: ["SA", "SK"], to: 1 }]);
    // A visible pause to actually read who won, not an instant sweep —
    // see HOLD.trick.
    expect(step!.offset).toBeGreaterThanOrEqual(800);
  });

  it("scales a collect with the number of cards swept", () => {
    const small = choreograph([{ t: "collect", pieces: ["a", "b"], to: 1 }]);
    const big = choreograph([
      { t: "collect", pieces: ["a", "b", "c", "d", "e", "f"], to: 1 },
    ]);
    expect(big[0]!.duration).toBeGreaterThan(small[0]!.duration);
  });

  it("never blocks on an announcement", () => {
    const [step] = choreograph([{ t: "announce", text: "Sam knocked" }]);
    expect(step!.duration).toBe(0);
    expect(step!.offset).toBe(0);
  });

  it("emits one step per event, in order", () => {
    const events: GameEvent[] = [
      { t: "play", piece: "SA", from: 0, to: "trick" },
      { t: "think", seat: 1, ms: 600 },
      { t: "play", piece: "SK", from: 1, to: "trick" },
      { t: "collect", pieces: ["SA", "SK"], to: 1 },
    ];
    const steps = choreograph(events);
    expect(steps).toHaveLength(4);
    expect(steps.map((s) => s.event.t)).toEqual([
      "play",
      "think",
      "play",
      "collect",
    ]);
  });

  it("returns nothing for an empty batch", () => {
    expect(choreograph([])).toEqual([]);
    expect(totalDuration([])).toBe(0);
  });
});
