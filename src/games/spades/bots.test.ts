import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import type { BotDifficulty, PieceId, SeatId } from "@/engine/types";
import { cardId } from "@/games/_shared/cards";
import { spadesBots } from "./bots";
import { legalPlays } from "./state";
import { createSpades, startRound } from "./rules";
import type { SpadesRules } from "./cards";
import type { SpadesState } from "./types";

const STANDARD: SpadesRules = { jokers: false, twoOfSpadesHigh: false };
const TIERS: BotDifficulty[] = ["casual", "steady", "sharp"];

function baseState(overrides: Partial<SpadesState> = {}): SpadesState {
  const num = (): Record<SeatId, number> => ({ 0: 0, 1: 0, 2: 0, 3: 0 });
  const bool = (v: boolean): Record<SeatId, boolean> => ({ 0: v, 1: v, 2: v, 3: v });
  const arr = (): Record<SeatId, PieceId[]> => ({ 0: [], 1: [], 2: [], 3: [] });
  return {
    rules: STANDARD,
    target: 500,
    autoLoss: -200,
    round: 1,
    dealer: 3,
    phase: "bid",
    turn: 0,
    hands: arr(),
    handRevealed: bool(true),
    blindEligible: bool(false),
    bids: { 0: null, 1: null, 2: null, 3: null },
    exchange: null,
    trick: [],
    ledSuit: null,
    trumpBroken: false,
    leader: 0,
    tricksWon: num(),
    won: arr(),
    scores: num(),
    bags: num(),
    nilsAttempted: num(),
    nilsMade: num(),
    result: null,
    winningSeats: null,
    winner: null,
    dealt: true,
    ...overrides,
  };
}

const hand13 = Array.from({ length: 13 }, (_, i) =>
  cardId(
    (["S", "H", "D", "C"] as const)[i % 4]!,
    (["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"] as const)[i]!,
  ),
);

describe("spades bots — every action they choose is legal", () => {
  function runMatch(seed: number, tier: BotDifficulty, target = 60): SpadesState {
    const rng = createRng(seed);
    const def = createSpades(STANDARD);
    let state: SpadesState = { ...def.setup({ seats: 4, rng }), target };
    ({ state } = startRound(state, rng));
    let n = 0;
    while (!def.isOver(state) && n++ < 20000) {
      if (def.isRoundOver!(state)) {
        ({ state } = startRound(state, rng));
        continue;
      }
      const seat = def.currentSeat(state)!;
      const view = def.playerView(state, seat);
      const action = def.bots[tier].choose(view, seat, rng);
      expect(def.legalActions(state, seat)).toContainEqual(action);
      ({ state } = def.reduce(state, action));
    }
    return state;
  }

  for (const tier of TIERS) {
    it(`${tier} bots only ever choose legal actions across a full match`, () => {
      const final = runMatch(202 + TIERS.indexOf(tier), tier);
      expect(final.winner).not.toBeNull();
    });
  }

  it("holds for mixed-tier tables (each bot plays its own difficulty) with jokers + 2-high", () => {
    const rules: SpadesRules = { jokers: true, twoOfSpadesHigh: true };
    const rng = createRng(909);
    const def = createSpades(rules);
    const difficulty: BotDifficulty[] = ["steady", "casual", "sharp", "steady"];
    let state: SpadesState = { ...def.setup({ seats: 4, rng }), target: 60 };
    ({ state } = startRound(state, rng));
    let n = 0;
    while (!def.isOver(state) && n++ < 20000) {
      if (def.isRoundOver!(state)) {
        ({ state } = startRound(state, rng));
        continue;
      }
      const seat = def.currentSeat(state)!;
      const tier = difficulty[seat]!;
      const view = def.playerView(state, seat);
      const action = def.bots[tier].choose(view, seat, rng);
      expect(def.legalActions(state, seat)).toContainEqual(action);
      ({ state } = def.reduce(state, action));
    }
    expect(def.isOver(state)).toBe(true);
  });
});

describe("spades bots — blind bidding honesty", () => {
  function eligibleHiddenState(hand: PieceId[]): SpadesState {
    return baseState({
      hands: { 0: hand, 1: [], 2: [], 3: [] },
      handRevealed: { 0: false, 1: true, 2: true, 3: true },
      blindEligible: { 0: true, 1: false, 2: true, 3: false },
      scores: { 0: 0, 1: 150, 2: 0, 3: 150 },
      turn: 0,
    });
  }

  it("never lets a casual bot go blind, however eligible", () => {
    const state = eligibleHiddenState(hand13);
    for (let seed = 0; seed < 30; seed++) {
      const action = spadesBots.casual.choose(state, 0, createRng(seed));
      expect(action).toEqual({ t: "look" });
    }
  });

  it("steady/sharp sometimes go blind when eligible", () => {
    const state = eligibleHiddenState(hand13);
    for (const tier of ["steady", "sharp"] as const) {
      const actions = Array.from({ length: 60 }, (_, seed) =>
        spadesBots[tier].choose(state, 0, createRng(seed)).t,
      );
      expect(actions).toContain("look");
      expect(actions.some((t) => t === "blindNil" || t === "blindBid")).toBe(true);
    }
  });

  it("the blind-vs-look decision depends only on the score deficit, never on hand contents", () => {
    const otherHand = [...hand13].reverse(); // same cards, different order — and,
    // more to the point, swapped for an entirely different-looking hand below.
    const differentHand: PieceId[] = [
      cardId("S", "A"), cardId("S", "K"), cardId("S", "Q"), cardId("S", "J"),
      cardId("H", "2"), cardId("H", "3"), cardId("H", "4"), cardId("H", "5"),
      cardId("D", "2"), cardId("D", "3"), cardId("D", "4"),
      cardId("C", "2"), cardId("C", "3"),
    ];
    const stateA = eligibleHiddenState(hand13);
    const stateB = eligibleHiddenState(otherHand);
    const stateC = eligibleHiddenState(differentHand);

    for (const tier of ["steady", "sharp"] as const) {
      for (let seed = 0; seed < 25; seed++) {
        const a = spadesBots[tier].choose(stateA, 0, createRng(seed));
        const b = spadesBots[tier].choose(stateB, 0, createRng(seed));
        const c = spadesBots[tier].choose(stateC, 0, createRng(seed));
        expect(b).toEqual(a);
        expect(c).toEqual(a);
      }
    }
  });

  it("bids normally, with no look/blind choice at all, when not eligible", () => {
    // A non-eligible seat's hand is already revealed at deal time in
    // real play (startRound sets handRevealed = !blindEligible) — this
    // fixture matches that real invariant rather than the contradictory
    // "not eligible but still hidden" combination `isHiddenFromSelf`
    // would otherwise treat as blind-eligible.
    const state = baseState({
      hands: { 0: hand13, 1: [], 2: [], 3: [] },
      handRevealed: { 0: true, 1: true, 2: true, 3: true },
      blindEligible: { 0: false, 1: false, 2: false, 3: false },
      scores: { 0: 0, 1: 0, 2: 0, 3: 0 },
      turn: 0,
    });
    for (const tier of TIERS) {
      for (let seed = 0; seed < 15; seed++) {
        const action = spadesBots[tier].choose(state, 0, createRng(seed));
        expect(action.t).toBe("bid");
      }
    }
  });
});

describe("spades bots — trick play only ever picks a legal card", () => {
  it("always plays a card from legalPlays, across a fanned-out set of trick situations", () => {
    const state = baseState({
      phase: "play",
      hands: {
        0: [cardId("H", "2"), cardId("S", "A"), cardId("C", "9")],
        1: [],
        2: [],
        3: [],
      },
      trick: [{ seat: 3, card: cardId("H", "K") }],
      ledSuit: "H",
      turn: 0,
    });
    for (const tier of TIERS) {
      for (let seed = 0; seed < 20; seed++) {
        const card = spadesBots[tier].choose(state, 0, createRng(seed)) as { t: "play"; card: PieceId };
        expect(legalPlays(state, 0)).toContain(card.card);
      }
    }
  });
});

describe("spades bots — the blind-nil exchange", () => {
  it("casual always skips the optional exchange", () => {
    const state = baseState({
      exchange: { giver: 0, taker: 2, stage: "give" },
      hands: { 0: hand13, 1: [], 2: [], 3: [] },
      turn: 0,
    });
    for (let seed = 0; seed < 10; seed++) {
      expect(spadesBots.casual.choose(state, 0, createRng(seed))).toEqual({ t: "skipExchange" });
    }
  });

  it("steady/sharp take the exchange and give exactly 2 cards from the giver's hand", () => {
    const hand = [cardId("S", "2"), cardId("S", "3"), cardId("H", "4")];
    const state = baseState({ exchange: { giver: 0, taker: 2, stage: "give" }, hands: { 0: hand, 1: [], 2: [], 3: [] }, turn: 0 });
    for (const tier of ["steady", "sharp"] as const) {
      const action = spadesBots[tier].choose(state, 0, createRng(1));
      expect(action.t).toBe("exchangeGive");
      if (action.t === "exchangeGive") {
        expect(action.cards).toHaveLength(2);
        for (const id of action.cards) expect(hand).toContain(id);
      }
    }
  });

  it("sends back its two weakest cards when taking", () => {
    const hand = [cardId("S", "A"), cardId("C", "2"), cardId("H", "3"), cardId("D", "K")];
    const state = baseState({
      exchange: { giver: 0, taker: 2, stage: "take", given: [cardId("C", "9"), cardId("C", "10")] },
      hands: { 0: [], 1: [], 2: hand, 3: [] },
      turn: 2,
    });
    const action = spadesBots.sharp.choose(state, 2, createRng(1));
    expect(action.t).toBe("exchangeTake");
    if (action.t === "exchangeTake") {
      expect(action.cards.sort()).toEqual([cardId("C", "2"), cardId("H", "3")].sort());
    }
  });
});
