import { describe, expect, it } from "vitest";
import { choreograph, totalDuration } from "./choreographer";
import type { GameEvent } from "@/engine/types";
import { DURATION, STAGGER } from "./presets";

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

  it("staggers a run of flips instead of queueing them end to end", () => {
    // A whole-hand reveal (Spades: Blind Nil look, blind bid lock-in,
    // team blind bid) is one flourish, not 13 independently-paced
    // flips — before STAGGER.flip existed this fell back to `beatOf`'s
    // per-event pace (~216ms/card via useChoreographer, since `offset`
    // was unconditionally 0), stretching a 13-card reveal past 2.5s.
    const flips: GameEvent[] = Array.from({ length: 13 }, (_, i) => ({
      t: "flip",
      piece: `S${i}`,
      faceUp: true,
    }));
    const steps = choreograph(flips);

    expect(steps[0]!.offset).toBe(0);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]!.offset).toBe(STAGGER.flip * 1000);
    }
    // A full 13-card reveal reads as one quick flourish, not a slow
    // scramble — well under a second total.
    expect(totalDuration(steps)).toBeLessThan(1000);
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

  describe("slam", () => {
    const pair: GameEvent[] = [
      { t: "slam", piece: "6-3", shake: ["0-0", "0-6"], final: false },
      {
        t: "move",
        piece: "6-3",
        to: { zone: "line", index: 2, count: 1, faceUp: true },
      },
    ];

    it("takes real time, so the next event cannot stomp the flourish", () => {
      // The failure this guards against is silent: an event with no
      // `case` in `choreograph` falls through to `default` and gets
      // duration 0, which lets whatever follows apply in the same frame.
      const [slam] = choreograph(pair);
      expect(slam!.duration).toBe(DURATION.slam * 1000);
      expect(slam!.duration).toBeGreaterThan(0);
    });

    it("gives the round-ending tile its own, longer duration", () => {
      const finalPair: GameEvent[] = [
        { t: "slam", piece: "6-3", shake: [], final: true },
        pair[1]!,
      ];
      const [slam] = choreograph(finalPair);
      expect(slam!.duration).toBe(DURATION.slamFinal * 1000);
      expect(slam!.duration).toBeGreaterThan(DURATION.slam * 1000);
    });

    it("lets its own move land in the same frame", () => {
      // The tile has to be travelling while it grows. A non-zero offset
      // here would play the two as separate gestures.
      const [, move] = choreograph(pair);
      expect(move!.offset).toBe(0);
    });

    it("budgets the whole flourish before the batch is done", () => {
      expect(totalDuration(choreograph(pair))).toBeGreaterThanOrEqual(DURATION.slam * 1000);
    });
  });

  describe("pause", () => {
    it("takes the same weight as an ordinary single move — the whole point", () => {
      // The bug this exists to fix: a turn that moved nothing (LRC's
      // all-dots roll) snapped straight to the next one, reading as
      // rushed next to a turn that moved a chip. Giving it its own,
      // SHORTER duration would just relocate that same inconsistency.
      const [pause] = choreograph([{ t: "pause" }]);
      const [move] = choreograph([
        { t: "move", piece: "chip-0-0", to: { zone: "collected", index: 0, count: 1, faceUp: true } },
      ]);
      expect(pause!.duration).toBe(move!.duration);
      expect(pause!.duration).toBe(DURATION.play * 1000);
    });

    it("starts immediately regardless of what precedes it", () => {
      // Unlike `deal`/`move`, a run of `pause`s never staggers — there
      // is only ever one per turn, so there is no "run" to space out.
      const [, second] = choreograph([{ t: "pause" }, { t: "pause" }]);
      expect(second!.offset).toBe(0);
    });
  });
});
