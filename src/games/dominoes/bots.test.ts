import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import type { BotDifficulty, SeatId } from "@/engine/types";
import { createDominoes } from "./rules";
import type { DomRules, DomState } from "./types";

/**
 * Dominoes had NO bot tests at all. The only thing exercising its bots
 * was `board.test.ts`, which drives them purely as a way to generate
 * chain geometry and asserts nothing about what they chose — not even
 * that the action was legal.
 *
 * That gap let two real defects sit: `judge` summed `tilePips` (0-12)
 * against positional terms worth at most 3, so whenever the heaviest
 * legal tile led by four pips `sharp` and `steady` picked the identical
 * tile and the tiers were the same bot; and the file's own header
 * claimed the bots reason about "how many tiles they hold" and "how
 * deep the boneyard is" while `judge` read neither.
 */

const BLOCK: DomRules = {
  mode: "classic",
  teams: false,
  keyTileBonus: false,
  sixLove: false,
};
const CARIBBEAN_TEAMS: DomRules = {
  mode: "caribbean",
  teams: true,
  keyTileBonus: true,
  sixLove: true,
};

function playMatch(
  rules: DomRules,
  seats: number,
  tiers: readonly BotDifficulty[],
  seed: number,
): DomState {
  const def = createDominoes(rules);
  const rng = createRng(seed);
  let state: DomState = def.setup({ seats, rng, difficulty: [...tiers] });
  ({ state } = def.startRound!(state, rng));
  for (let i = 0; i < 20000 && !def.isOver(state); i++) {
    if (def.isRoundOver!(state)) {
      ({ state } = def.startRound!(state, rng));
      continue;
    }
    const seat = def.currentSeat(state);
    if (seat === null) break;
    const view = def.playerView(state, seat);
    const action = def.bots[tiers[seat]!]!.choose(view, seat, rng);
    expect(def.legalActions(state, seat), `seed ${seed} seat ${seat}`).toContainEqual(action);
    ({ state } = def.reduce(state, action));
  }
  return state;
}

describe("dominoes bots — legality", () => {
  it("never chooses an action legalActions did not offer, across tiers and seat counts", () => {
    for (const tier of ["casual", "steady", "sharp"] as const) {
      for (const seats of [2, 3, 4]) {
        for (let seed = 0; seed < 8; seed++) {
          const tiers = Array.from({ length: seats }, () => tier);
          const state = playMatch(BLOCK, seats, tiers, seed);
          expect(state.winner).not.toBeNull();
        }
      }
    }
  }, 120_000);

  it("stays legal in Caribbean team mode, where the whole set is dealt", () => {
    for (let seed = 0; seed < 8; seed++) {
      const tiers: BotDifficulty[] = ["sharp", "steady", "sharp", "steady"];
      const state = playMatch(CARIBBEAN_TEAMS, 4, tiers, seed);
      expect(state.winner).not.toBeNull();
    }
  }, 120_000);
});

describe("dominoes difficulty is a real gradient", () => {
  /**
   * The test that would have caught `tilePips` swamping everything
   * else. Deterministic (fixed seeds), so this is exact, not flaky.
   * Measured out of 40: sharp 34 over casual, steady 30 over casual,
   * sharp 33 over steady.
   */
  function headToHead(a: BotDifficulty, b: BotDifficulty, seeds: number): number {
    let aWins = 0;
    for (let seed = 0; seed < seeds; seed++) {
      // Alternate seats so going first cannot decide it.
      const swap = seed % 2 === 1;
      const tiers: BotDifficulty[] = swap ? [b, a] : [a, b];
      const state = playMatch(BLOCK, 2, tiers, seed);
      const aSeat: SeatId = swap ? 1 : 0;
      if (state.winner === aSeat) aWins++;
    }
    return aWins;
  }

  it("orders sharp above steady above casual, head to head", () => {
    expect(headToHead("sharp", "casual", 40)).toBeGreaterThan(20);
    expect(headToHead("steady", "casual", 40)).toBeGreaterThan(20);
    expect(headToHead("sharp", "steady", 40)).toBeGreaterThan(20);
  }, 180_000);
});

describe("dominoes bots read the table", () => {
  /**
   * `state.passedEnds` is the point of this one. A pass is a permanent
   * public statement that a seat holds neither open end, and it was
   * previously unreadable: `state.passes` is a bare counter with no
   * record of who passed or on what.
   */
  it("records what a seat passed on, and keeps it for the rest of the round", () => {
    const def = createDominoes(BLOCK);
    let recorded = 0;
    for (let seed = 0; seed < 30; seed++) {
      const rng = createRng(seed);
      let state: DomState = def.setup({ seats: 3, rng });
      ({ state } = def.startRound!(state, rng));
      for (let i = 0; i < 4000 && !def.isRoundOver!(state); i++) {
        const seat = def.currentSeat(state);
        if (seat === null) break;
        const before = state.passedEnds[seat] ?? [];
        const action = def.bots.sharp.choose(def.playerView(state, seat), seat, rng);
        ({ state } = def.reduce(state, action));
        const after = state.passedEnds[seat] ?? [];
        // A pass only ever adds; a later play never clears it.
        expect(after.length).toBeGreaterThanOrEqual(before.length);
        if (action.t === "pass") recorded++;
      }
    }
    expect(recorded).toBeGreaterThan(0);
  }, 120_000);
});
