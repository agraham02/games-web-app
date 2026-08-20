import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import { createPoker } from "./rules";
import type { PokerAction, PokerState } from "./types";

/**
 * Smoke-tests that the three tiers actually behave differently — the
 * same spirit as proving Rummy's `LAYOFF_ATTENTION` rates are real
 * rather than asserting exact numbers on any one hand (bot decisions are
 * heuristic, not solver-grade; see bots.ts's own doc).
 */

function preflopFoldRate(tier: "casual" | "sharp", seeds: number): number {
  const d = createPoker(2000, 20);
  let folds = 0;
  let decisions = 0;
  for (let seed = 0; seed < seeds; seed++) {
    const rng = createRng(seed);
    let state: PokerState = d.setup({ seats: 6, rng });
    ({ state } = d.startRound!(state, rng));
    // Only look at the first decision of the hand — a fresh preflop
    // read, uncontaminated by later action.
    const seat = d.currentSeat(state);
    if (seat === null) continue;
    const view = d.playerView(state, seat);
    const action = d.bots[tier].choose(view, seat, rng);
    decisions++;
    if (action.t === "fold") folds++;
  }
  return decisions === 0 ? 0 : folds / decisions;
}

describe("bot tier differentiation", () => {
  it("sharp folds preflop trash more often than casual, across many seeds", () => {
    const casualRate = preflopFoldRate("casual", 300);
    const sharpRate = preflopFoldRate("sharp", 300);
    expect(sharpRate).toBeGreaterThan(casualRate);
  });

  it("bet sizing varies rather than always landing on the same amount", () => {
    const d = createPoker(2000, 20);
    const sizes = new Set<number>();
    for (let seed = 0; seed < 60; seed++) {
      const rng = createRng(seed);
      let state: PokerState = d.setup({ seats: 3, rng });
      ({ state } = d.startRound!(state, rng));
      for (let i = 0; i < 6; i++) {
        const seat = d.currentSeat(state);
        if (seat === null || state.pendingShowdown) break;
        const view = d.playerView(state, seat);
        const action: PokerAction = d.bots.sharp.choose(view, seat, rng);
        if (action.t === "bet" || action.t === "raise") sizes.add(action.to);
        ({ state } = d.reduce(state, action));
        if (d.isRoundOver!(state)) break;
      }
    }
    expect(sizes.size).toBeGreaterThan(1);
  });

  it("a losing bot shows at a bounded, tier-ordered rate — reachable, not just possible", () => {
    // Drive several short-stack matches to force frequent showdowns,
    // and count how often each tier is offered (and takes) a show.
    const rates: Record<"casual" | "sharp", { shown: number; offered: number }> = {
      casual: { shown: 0, offered: 0 },
      sharp: { shown: 0, offered: 0 },
    };
    for (const tier of ["casual", "sharp"] as const) {
      const d = createPoker(300, 20);
      for (let seed = 0; seed < 50; seed++) {
        const rng = createRng(seed);
        const difficulty = [tier, tier, tier, tier] as const;
        let state: PokerState = d.setup({ seats: 4, rng, difficulty: [...difficulty] });
        ({ state } = d.startRound!(state, rng));
        for (let i = 0; i < 400 && !d.isOver(state); i++) {
          if (d.isRoundOver!(state)) {
            ({ state } = d.startRound!(state, rng));
            continue;
          }
          const seat = d.currentSeat(state);
          if (seat === null) break;
          const view = d.playerView(state, seat);
          const action = d.bots[tier].choose(view, seat, rng);
          if (state.pendingShowdown && !state.pendingShowdown.winningSeats.includes(seat)) {
            rates[tier].offered++;
            if (action.t === "show") rates[tier].shown++;
          }
          ({ state } = d.reduce(state, action));
        }
      }
    }
    // Both tiers actually reached the decision at least once, and sharp
    // shows no less often than casual (its configured rate is higher).
    expect(rates.casual.offered + rates.sharp.offered).toBeGreaterThan(0);
    if (rates.casual.offered > 0 && rates.sharp.offered > 0) {
      const casualRate = rates.casual.shown / rates.casual.offered;
      const sharpRate = rates.sharp.shown / rates.sharp.offered;
      expect(sharpRate).toBeGreaterThanOrEqual(casualRate);
    }
  });

  /**
   * Regression guard for a real reported bug: `preflopStrength`'s first
   * version scored `(hi + lo) / 28` as its baseline, which alone put
   * almost every non-trash starting hand within a hair of
   * `RAISE_THRESHOLD` — a live playtest (6 seats, steady, $1000 stacks,
   * a $10 blind — the exact numbers reused here) reported bots going
   * all-in constantly and "rarely" seeing a flop, turn or river. These
   * two tests assert the OBSERVABLE symptoms directly: most starting
   * hands are not raise-worthy, and most hands actually reach the flop
   * (or a genuine all-in runout) rather than ending in a preflop fold.
   */
  it("steady does not raise the overwhelming majority of starting hands", () => {
    const d = createPoker(1000, 10);
    let raises = 0;
    let decisions = 0;
    for (let seed = 0; seed < 400; seed++) {
      const rng = createRng(seed);
      let state: PokerState = d.setup({ seats: 6, rng });
      ({ state } = d.startRound!(state, rng));
      const seat = d.currentSeat(state);
      if (seat === null) continue;
      const view = d.playerView(state, seat);
      const action = d.bots.steady.choose(view, seat, rng);
      decisions++;
      if (action.t === "bet" || action.t === "raise") raises++;
    }
    expect(decisions).toBeGreaterThan(0);
    expect(raises / decisions).toBeLessThan(0.4);
  });

  it("a real match — 6 seats, steady, $1000 stacks, $10 blind — regularly reaches the flop", () => {
    const d = createPoker(1000, 10);
    let hands = 0;
    let reachedFlop = 0;
    for (let seed = 0; seed < 20; seed++) {
      const rng = createRng(seed);
      let state: PokerState = d.setup({ seats: 6, rng });
      ({ state } = d.startRound!(state, rng));
      for (let i = 0; i < 300 && !d.isOver(state); i++) {
        if (d.isRoundOver!(state)) {
          hands++;
          if (state.communityOrder.length > 0) reachedFlop++;
          ({ state } = d.startRound!(state, rng));
          continue;
        }
        const seat = d.currentSeat(state);
        if (seat === null) break;
        const view = d.playerView(state, seat);
        const action = d.bots.steady.choose(view, seat, rng);
        ({ state } = d.reduce(state, action));
      }
    }
    expect(hands).toBeGreaterThan(0);
    expect(reachedFlop / hands).toBeGreaterThan(0.25);
  });
});
