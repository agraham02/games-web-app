import { describe, expect, it } from "vitest";
import type { SeatId } from "@/engine/types";
import { cardId, BIG_JOKER_ID } from "@/games/_shared/cards";
import {
  isBlindEligible,
  isHiddenFromSelf,
  legalPlays,
  minLegalBid,
  partnerOf,
  teamOf,
  teammates,
} from "./state";
import type { SpadesState } from "./types";

function baseState(overrides: Partial<SpadesState> = {}): SpadesState {
  const empty4 = <T>(v: T): Record<SeatId, T> => ({ 0: v, 1: v, 2: v, 3: v });
  return {
    rules: { jokers: false, twoOfSpadesHigh: false },
    target: 500,
    autoLoss: -200,
    round: 1,
    dealer: 3,
    phase: "bid",
    turn: 0,
    hands: { 0: [], 1: [], 2: [], 3: [] },
    handRevealed: empty4(true),
    blindEligible: empty4(false),
    bids: { 0: null, 1: null, 2: null, 3: null },
    exchange: null,
    trick: [],
    ledSuit: null,
    trumpBroken: false,
    leader: 0,
    tricksWon: empty4(0),
    won: { 0: [], 1: [], 2: [], 3: [] },
    scores: empty4(0),
    bags: empty4(0),
    nilsAttempted: empty4(0),
    nilsMade: empty4(0),
    result: null,
    winningSeats: null,
    winner: null,
    dealt: true,
    ...overrides,
  };
}

describe("partnerOf / teamOf / teammates", () => {
  it("seats a partner directly across the table (0<->2, 1<->3)", () => {
    expect(partnerOf(0)).toBe(2);
    expect(partnerOf(2)).toBe(0);
    expect(partnerOf(1)).toBe(3);
    expect(partnerOf(3)).toBe(1);
  });

  it("alternates teams every seat around the table", () => {
    expect([teamOf(0), teamOf(1), teamOf(2), teamOf(3)]).toEqual([0, 1, 0, 1]);
  });

  it("teammates() is the inverse of teamOf()/partnerOf()", () => {
    for (const seat of [0, 1, 2, 3] as SeatId[]) {
      expect(teammates(teamOf(seat))).toContain(seat);
      expect(teammates(teamOf(seat))).toContain(partnerOf(seat));
    }
  });
});

describe("minLegalBid — the team minimum-4 rule (\"the Board\")", () => {
  it("is 0 for a team's first bidder regardless of anything else", () => {
    const state = baseState({ bids: { 0: null, 1: null, 2: null, 3: null } });
    expect(minLegalBid(state, 0)).toBe(0);
    expect(minLegalBid(state, 1)).toBe(0);
  });

  it("floors the second bidder at 4 minus partner's numeric contribution", () => {
    const state = baseState({ bids: { 0: { tricks: 1, nil: false, blind: false }, 1: null, 2: null, 3: null } });
    expect(minLegalBid(state, 2)).toBe(3); // 4 - 1
  });

  it("is 0 for the second bidder once partner alone already reaches 4", () => {
    const state = baseState({ bids: { 0: { tricks: 6, nil: false, blind: false }, 1: null, 2: null, 3: null } });
    expect(minLegalBid(state, 2)).toBe(0);
  });

  it("never goes negative — never demands more than 13", () => {
    const state = baseState({ bids: { 0: { tricks: 13, nil: false, blind: false }, 1: null, 2: null, 3: null } });
    expect(minLegalBid(state, 2)).toBe(0);
  });

  it("requires the second bidder to make up the full 4 after a partner's Nil", () => {
    const state = baseState({ bids: { 0: { tricks: 0, nil: true, blind: false }, 1: null, 2: null, 3: null } });
    expect(minLegalBid(state, 2)).toBe(4);
  });

  it("makes double-Nil on one team unreachable (0 contribution, floor still 4)", () => {
    const state = baseState({ bids: { 0: { tricks: 0, nil: true, blind: false }, 1: null, 2: null, 3: null } });
    // Nil is only legal when minLegalBid is 0 — it's 4 here, so a second
    // Nil from seat 2 is never an option legalActions would offer.
    expect(minLegalBid(state, 2)).toBeGreaterThan(0);
  });
});

describe("isBlindEligible", () => {
  it("is false exactly at a 99-point deficit", () => {
    const scores: Record<SeatId, number> = { 0: 0, 1: 99, 2: 0, 3: 99 };
    expect(isBlindEligible(scores, 0)).toBe(false);
  });

  it("is true exactly at a 100-point deficit", () => {
    const scores: Record<SeatId, number> = { 0: 0, 1: 100, 2: 0, 3: 100 };
    expect(isBlindEligible(scores, 0)).toBe(true);
  });

  it("stays true past 100", () => {
    const scores: Record<SeatId, number> = { 0: 0, 1: 101, 2: 0, 3: 101 };
    expect(isBlindEligible(scores, 0)).toBe(true);
  });

  it("agrees between a seat and its partner (symmetric within a team)", () => {
    const scores: Record<SeatId, number> = { 0: 50, 1: 150, 2: 50, 3: 150 };
    expect(isBlindEligible(scores, 0)).toBe(isBlindEligible(scores, 2));
    expect(isBlindEligible(scores, 0)).toBe(true);
    expect(isBlindEligible(scores, 1)).toBe(false);
  });
});

describe("isHiddenFromSelf", () => {
  it("is true only while blind-eligible AND not yet revealed", () => {
    const eligibleUnrevealed = baseState({
      blindEligible: { 0: true, 1: false, 2: true, 3: false },
      handRevealed: { 0: false, 1: true, 2: false, 3: true },
    });
    expect(isHiddenFromSelf(eligibleUnrevealed, 0)).toBe(true);

    const eligibleRevealed = baseState({
      blindEligible: { 0: true, 1: false, 2: true, 3: false },
      handRevealed: { 0: true, 1: true, 2: true, 3: true },
    });
    expect(isHiddenFromSelf(eligibleRevealed, 0)).toBe(false);

    const ineligible = baseState({
      blindEligible: { 0: false, 1: false, 2: false, 3: false },
      handRevealed: { 0: false, 1: true, 2: true, 3: true },
    });
    expect(isHiddenFromSelf(ineligible, 0)).toBe(false);
  });
});

describe("legalPlays — lead gating", () => {
  it("forbids leading trump before it's broken, with a non-spade available", () => {
    const state = baseState({
      hands: { 0: [cardId("S", "A"), cardId("H", "K")], 1: [], 2: [], 3: [] },
      trumpBroken: false,
    });
    const legal = legalPlays(state, 0);
    expect(legal).toEqual([cardId("H", "K")]);
  });

  it("allows leading trump once it's broken", () => {
    const state = baseState({
      hands: { 0: [cardId("S", "A"), cardId("H", "K")], 1: [], 2: [], 3: [] },
      trumpBroken: true,
    });
    expect(legalPlays(state, 0).sort()).toEqual([cardId("H", "K"), cardId("S", "A")].sort());
  });

  it("forces a trump lead, even unbroken, when the hand is all spades (or jokers)", () => {
    const state = baseState({
      hands: { 0: [cardId("S", "3"), BIG_JOKER_ID], 1: [], 2: [], 3: [] },
      trumpBroken: false,
    });
    expect(legalPlays(state, 0).sort()).toEqual([BIG_JOKER_ID, cardId("S", "3")].sort());
  });

  it("forces following the led suit when the hand holds it", () => {
    const state = baseState({
      hands: { 0: [cardId("H", "2"), cardId("S", "A"), cardId("C", "9")], 1: [], 2: [], 3: [] },
      trick: [{ seat: 3, card: cardId("H", "K") }],
      ledSuit: "H",
    });
    expect(legalPlays(state, 0)).toEqual([cardId("H", "2")]);
  });

  it("allows anything, including trump, when void in the led suit", () => {
    const state = baseState({
      hands: { 0: [cardId("S", "A"), cardId("C", "9")], 1: [], 2: [], 3: [] },
      trick: [{ seat: 3, card: cardId("H", "K") }],
      ledSuit: "H",
    });
    expect(legalPlays(state, 0).sort()).toEqual([cardId("C", "9"), cardId("S", "A")].sort());
  });

  it("treats a joker as spades when following a spade lead", () => {
    const state = baseState({
      rules: { jokers: true, twoOfSpadesHigh: false },
      hands: { 0: [BIG_JOKER_ID, cardId("C", "9")], 1: [], 2: [], 3: [] },
      trick: [{ seat: 3, card: cardId("S", "4") }],
      ledSuit: "S",
    });
    expect(legalPlays(state, 0)).toEqual([BIG_JOKER_ID]);
  });
});
