import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import type { PieceId, SeatId } from "@/engine/types";
import { BIG_JOKER_ID, LITTLE_JOKER_ID } from "@/games/_shared/cards";
import { spadesDeck, type SpadesRules } from "./cards";
import { createSpades, minLegalBid, reduce, startRound } from "./rules";
import type { SpadesState } from "./types";

const STANDARD: SpadesRules = { jokers: false, twoOfSpadesHigh: false };

function fresh(seed = 7, rules: SpadesRules = STANDARD) {
  const rng = createRng(seed);
  const def = createSpades(rules);
  const { state } = startRound(def.setup({ seats: 4, rng }), rng);
  return { def, rng, state };
}

/** Every card in the deck is in exactly one of: a hand, a won pile, or
 * the current trick. */
function allCardsAccountedFor(state: SpadesState): PieceId[] {
  return [
    ...Object.values(state.hands).flat(),
    ...Object.values(state.won).flat(),
    ...state.trick.map((p) => p.card),
  ].sort();
}

describe("spades — the deal", () => {
  it("deals 13 cards to each of 4 seats and uses every card exactly once (standard deck)", () => {
    const { state } = fresh();
    for (let seat = 0; seat < 4; seat++) expect(state.hands[seat]).toHaveLength(13);
    expect(allCardsAccountedFor(state)).toEqual([...spadesDeck(STANDARD)].sort());
  });

  it("deals 13 cards to each of 4 seats with jokers enabled, still 52 cards total", () => {
    const rules: SpadesRules = { jokers: true, twoOfSpadesHigh: false };
    const { state } = fresh(3, rules);
    for (let seat = 0; seat < 4; seat++) expect(state.hands[seat]).toHaveLength(13);
    const all = allCardsAccountedFor(state);
    expect(all).toHaveLength(52);
    expect(all).toContain(BIG_JOKER_ID);
    expect(all).toContain(LITTLE_JOKER_ID);
  });

  it("starts undealt so the opening deal can animate", () => {
    const def = createSpades();
    const state = def.setup({ seats: 4, rng: createRng(1) });
    expect(state.dealt).toBe(false);
    expect(def.currentSeat(state)).toBeNull();
  });

  it("gives the first bid (and the first lead) to the seat left of the dealer", () => {
    const { state } = fresh();
    expect(state.dealer).toBe(3);
    expect(state.leader).toBe(0);
    expect(state.turn).toBe(0);
  });

  it("rotates the dealer each round", () => {
    const rng = createRng(5);
    const def = createSpades();
    let state = def.setup({ seats: 4, rng });
    ({ state } = startRound(state, rng));
    expect(state.dealer).toBe(3);
    // Force the round to look finished so startRound can be called again.
    state = { ...state, result: { bids: state.bids as never, tricksWon: state.tricksWon, deltas: {}, bags: {}, bagPenalty: {} } };
    ({ state } = startRound(state, rng));
    expect(state.dealer).toBe(0);
  });
});

describe("spades — bidding order and the Board (team minimum-4) rule", () => {
  it("proceeds seat 0, 1, 2, 3 in order, alternating teams each turn", () => {
    const { def, state } = fresh();
    let s = state;
    expect(def.currentSeat(s)).toBe(0);
    ({ state: s } = reduce(s, { t: "bid", tricks: 3, nil: false }));
    expect(def.currentSeat(s)).toBe(1);
    ({ state: s } = reduce(s, { t: "bid", tricks: 3, nil: false }));
    expect(def.currentSeat(s)).toBe(2);
    ({ state: s } = reduce(s, { t: "bid", tricks: 4, nil: false }));
    expect(def.currentSeat(s)).toBe(3);
  });

  it("requires the second bidder to cover a Nil partner with at least 4", () => {
    const { def, state } = fresh();
    let s = state;
    ({ state: s } = reduce(s, { t: "bid", tricks: 0, nil: true })); // seat 0: Nil
    ({ state: s } = reduce(s, { t: "bid", tricks: 2, nil: false })); // seat 1
    expect(def.currentSeat(s)).toBe(2);
    expect(minLegalBid(s, 2)).toBe(4);
    const legal = def.legalActions(s, 2);
    // 3 is not enough...
    expect(legal.some((a) => a.t === "bid" && a.tricks === 3)).toBe(false);
    // ...4 is.
    expect(legal.some((a) => a.t === "bid" && a.tricks === 4)).toBe(true);
  });

  it("never offers double-Nil on one team as a legal option", () => {
    const { def, state } = fresh();
    const { state: afterNil } = reduce(state, { t: "bid", tricks: 0, nil: true });
    const legalForPartner = def.legalActions(afterNil, 2);
    expect(legalForPartner.some((a) => a.t === "bid" && a.nil)).toBe(false);
  });

  it("lets a first bidder bid Nil freely (no Board restriction yet)", () => {
    const { def, state } = fresh();
    const legal = def.legalActions(state, 0);
    expect(legal.some((a) => a.t === "bid" && a.nil)).toBe(true);
  });
});

describe("spades — blind eligibility and the hidden hand", () => {
  it("deals a blind-eligible hero's own hand face down; a non-eligible hero's face up", () => {
    const rng = createRng(9);
    const def = createSpades();
    const eligible = { ...def.setup({ seats: 4, rng }), scores: { 0: 0, 1: 100, 2: 0, 3: 100 } };
    const { state: eligibleState, events: eligibleEvents } = startRound(eligible, rng);
    expect(eligibleState.blindEligible[0]).toBe(true);
    expect(eligibleState.handRevealed[0]).toBe(false);
    const heroDeals = eligibleEvents.filter((e) => e.t === "deal" && e.to === 0);
    expect(heroDeals.every((e) => e.t === "deal" && e.faceUp === false)).toBe(true);

    const rng2 = createRng(9);
    const notEligible = { ...def.setup({ seats: 4, rng: rng2 }), scores: { 0: 0, 1: 50, 2: 0, 3: 50 } };
    const { state: normalState, events: normalEvents } = startRound(notEligible, rng2);
    expect(normalState.blindEligible[0]).toBe(false);
    expect(normalState.handRevealed[0]).toBe(true);
    const heroDeals2 = normalEvents.filter((e) => e.t === "deal" && e.to === 0);
    expect(heroDeals2.every((e) => e.t === "deal" && e.faceUp === true)).toBe(true);
  });

  it("reveals a blind NUMERIC bid's hand immediately on locking in", () => {
    const rng = createRng(9);
    const def = createSpades();
    const eligible = { ...def.setup({ seats: 4, rng }), scores: { 0: 0, 1: 100, 2: 0, 3: 100 } };
    let { state } = startRound(eligible, rng);
    expect(state.handRevealed[0]).toBe(false);
    ({ state } = reduce(state, { t: "blindBid", tricks: 6 }));
    expect(state.bids[0]).toEqual({ tricks: 6, nil: false, blind: true });
    expect(state.handRevealed[0]).toBe(true);
  });

  it("keeps a Blind Nil bidder's hand hidden through bidding, until the exchange resolves", () => {
    const rng = createRng(9);
    const def = createSpades();
    const eligible = { ...def.setup({ seats: 4, rng }), scores: { 0: 0, 1: 100, 2: 0, 3: 100 } };
    let { state } = startRound(eligible, rng);
    ({ state } = reduce(state, { t: "blindNil" }));
    expect(state.handRevealed[0]).toBe(false);
    ({ state } = reduce(state, { t: "bid", tricks: 3, nil: false })); // seat 1
    expect(state.handRevealed[0]).toBe(false);
    ({ state } = reduce(state, { t: "bid", tricks: 4, nil: false })); // seat 2, covers the Board
    expect(state.handRevealed[0]).toBe(false);
    ({ state } = reduce(state, { t: "bid", tricks: 2, nil: false })); // seat 3 — all 4 bids in now
    expect(state.handRevealed[0]).toBe(false); // exchange now pending, still hidden
    expect(state.exchange).not.toBeNull();
    ({ state } = reduce(state, { t: "skipExchange" }));
    expect(state.handRevealed[0]).toBe(true);
    expect(state.phase).toBe("play");
  });
});

describe("spades — the blind-nil card exchange", () => {
  it("runs give -> take: exactly the right 4 cards swap, both hands land back at 13", () => {
    const rng = createRng(11);
    const def = createSpades();
    let state: SpadesState = { ...def.setup({ seats: 4, rng }), scores: { 0: 0, 1: 100, 2: 0, 3: 100 } };
    ({ state } = startRound(state, rng));

    ({ state } = reduce(state, { t: "blindNil" })); // seat 0
    ({ state } = reduce(state, { t: "bid", tricks: 3, nil: false })); // seat 1
    expect(minLegalBid(state, 2)).toBe(4);
    ({ state } = reduce(state, { t: "bid", tricks: 4, nil: false })); // seat 2
    ({ state } = reduce(state, { t: "bid", tricks: 2, nil: false })); // seat 3

    expect(state.phase).toBe("bid");
    expect(state.exchange).toEqual({ giver: 0, taker: 2, stage: "give" });
    expect(def.currentSeat(state)).toBe(0);

    const giverBefore = state.hands[0]!;
    const takerBefore = state.hands[2]!;
    expect(giverBefore).toHaveLength(13);
    expect(takerBefore).toHaveLength(13);

    const given: [PieceId, PieceId] = [giverBefore[0]!, giverBefore[1]!];
    ({ state } = reduce(state, { t: "exchangeGive", cards: given }));
    expect(state.exchange).toEqual({ giver: 0, taker: 2, stage: "take", given });
    expect(state.hands[0]).toHaveLength(11);
    expect(state.hands[2]).toHaveLength(13); // untouched until the take resolves
    expect(def.currentSeat(state)).toBe(2);

    const takeBack: [PieceId, PieceId] = [takerBefore[0]!, takerBefore[1]!];
    ({ state } = reduce(state, { t: "exchangeTake", cards: takeBack }));

    expect(state.exchange).toBeNull();
    expect(state.phase).toBe("play");
    expect(state.hands[0]).toHaveLength(13);
    expect(state.hands[2]).toHaveLength(13);
    for (const id of given) expect(state.hands[2]).toContain(id);
    for (const id of takeBack) expect(state.hands[0]).toContain(id);
    expect(state.handRevealed[0]).toBe(true);
    expect(def.currentSeat(state)).toBe(state.leader);
  });

  it("skips cleanly straight to play when the giver declines", () => {
    const rng = createRng(11);
    const def = createSpades();
    let state: SpadesState = { ...def.setup({ seats: 4, rng }), scores: { 0: 0, 1: 100, 2: 0, 3: 100 } };
    ({ state } = startRound(state, rng));
    ({ state } = reduce(state, { t: "blindNil" }));
    ({ state } = reduce(state, { t: "bid", tricks: 3, nil: false }));
    ({ state } = reduce(state, { t: "bid", tricks: 4, nil: false }));
    ({ state } = reduce(state, { t: "bid", tricks: 2, nil: false }));
    const before = state.hands[0]!;
    ({ state } = reduce(state, { t: "skipExchange" }));
    expect(state.exchange).toBeNull();
    expect(state.phase).toBe("play");
    expect(state.hands[0]).toEqual(before);
    expect(state.handRevealed[0]).toBe(true);
  });

  it("never creates an exchange when nobody bid Blind Nil", () => {
    const { state } = fresh();
    let s = state;
    ({ state: s } = reduce(s, { t: "bid", tricks: 3, nil: false }));
    ({ state: s } = reduce(s, { t: "bid", tricks: 3, nil: false }));
    ({ state: s } = reduce(s, { t: "bid", tricks: 4, nil: false }));
    ({ state: s } = reduce(s, { t: "bid", tricks: 2, nil: false }));
    expect(s.exchange).toBeNull();
    expect(s.phase).toBe("play");
  });
});

describe("spades — full-match simulation invariants", () => {
  function runMatch(seed: number, rules: SpadesRules, target: number, guard = 20000): SpadesState {
    const rng = createRng(seed);
    const def = createSpades(rules);
    let state: SpadesState = { ...def.setup({ seats: 4, rng }), target };
    ({ state } = startRound(state, rng));
    let n = 0;
    let lastRound = state.round;
    let sawTrumpBrokenThisRound = state.trumpBroken;

    while (!def.isOver(state) && n++ < guard) {
      if (def.isRoundOver!(state)) {
        ({ state } = startRound(state, rng));
        lastRound = state.round;
        sawTrumpBrokenThisRound = state.trumpBroken;
        continue;
      }

      // Invariants checked on every single step, not just at the end.
      expect(state.scores[0]).toBe(state.scores[2]);
      expect(state.scores[1]).toBe(state.scores[3]);
      expect(state.bags[0]).toBe(state.bags[2]);
      expect(state.bags[1]).toBe(state.bags[3]);
      const cards = allCardsAccountedFor(state);
      expect(cards).toHaveLength(spadesDeck(rules).length);
      expect(new Set(cards).size).toBe(cards.length);
      if (state.round === lastRound) {
        // trumpBroken must never flip back off within the same round.
        if (sawTrumpBrokenThisRound) expect(state.trumpBroken).toBe(true);
        sawTrumpBrokenThisRound = state.trumpBroken;
      }

      const seat = def.currentSeat(state)!;
      const view = def.playerView(state, seat);
      const action = def.bots.steady.choose(view, seat, rng);
      const legal = def.legalActions(state, seat);
      expect(legal).toContainEqual(action);

      ({ state } = def.reduce(state, action));
    }
    return state;
  }

  it("holds every invariant across a full standard match", () => {
    const final = runMatch(101, STANDARD, 100);
    expect(final.winner).not.toBeNull();
    expect(final.winningSeats).not.toBeNull();
  });

  it("holds every invariant across full matches with jokers and 2-of-spades-high, several seeds", () => {
    const rules: SpadesRules = { jokers: true, twoOfSpadesHigh: true };
    for (const seed of [3, 17, 88]) {
      const final = runMatch(seed, rules, 60);
      expect(final.winner).not.toBeNull();
      expect(final.winningSeats).toHaveLength(2);
      expect(final.winningSeats).toContain(final.winner);
    }
  });

  it("ends the match once a team's score reaches the target", () => {
    const final = runMatch(42, STANDARD, 1);
    expect(final.winner).not.toBeNull();
    const [a, b] = final.winningSeats!;
    expect(final.scores[a!]).toBeGreaterThanOrEqual(1);
    expect(final.scores[a!]).toBe(final.scores[b!]);
  });

  it("ends the match once a team falls to or below the auto-loss threshold", () => {
    const rng = createRng(55);
    const def = createSpades(STANDARD);
    // Target effectively unreachable; a tight auto-loss makes THAT the
    // only possible way this match ends — disambiguates the path taken.
    let state: SpadesState = { ...def.setup({ seats: 4, rng }), target: 1_000_000, autoLoss: -1 };
    ({ state } = startRound(state, rng));
    let n = 0;
    while (!def.isOver(state) && n++ < 20000) {
      if (def.isRoundOver!(state)) {
        ({ state } = startRound(state, rng));
        continue;
      }
      const seat = def.currentSeat(state)!;
      const action = def.bots.steady.choose(def.playerView(state, seat), seat, rng);
      ({ state } = def.reduce(state, action));
    }
    expect(def.isOver(state)).toBe(true);
    expect(state.winningSeats).toHaveLength(2);
    // The LOSING team's score is the one at/under the threshold.
    const losingTeamSeats: [SeatId, SeatId] = state.winningSeats!.includes(0) ? [1, 3] : [0, 2];
    expect(state.scores[losingTeamSeats[0]]).toBeLessThanOrEqual(-1);
  });
});
