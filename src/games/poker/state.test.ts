import { describe, expect, it } from "vitest";
import type { HandValue } from "./hand";
import {
  amountToCall,
  awardPots,
  betRange,
  bigBlindOf,
  computePots,
  positionBadge,
  postflopOrder,
  preflopOrder,
  smallBlindOf,
} from "./state";
import type { PokerState } from "./types";

function hv(category: HandValue["category"], ranks: number[] = []): HandValue {
  return { category, ranks, cards: [] };
}

function makeState(overrides: Partial<PokerState> & Pick<PokerState, "seats">): PokerState {
  const seats = overrides.seats;
  const folded =
    overrides.folded ?? Object.fromEntries(Array.from({ length: seats }, (_, s) => [s, false]));
  const stacks =
    overrides.stacks ?? Object.fromEntries(Array.from({ length: seats }, (_, s) => [s, 1000]));
  return {
    smallBlind: 10,
    bigBlind: 20,
    hand: 1,
    button: 0,
    winner: null,
    cardOwner: {},
    deck: [],
    communityOrder: [],
    streetCommitted: {},
    totalCommitted: {},
    lastRaiseSize: 20,
    raisesThisStreet: 0,
    raiseCapped: false,
    toAct: [],
    pendingShowdown: null,
    result: null,
    ...overrides,
    folded,
    stacks,
  };
}

describe("computePots", () => {
  it("layers a 3-way all-in at three different depths", () => {
    const totalCommitted = { 0: 50, 1: 150, 2: 300 };
    const folded = { 0: false, 1: false, 2: false };
    const layers = computePots(totalCommitted, folded);
    expect(layers).toEqual([
      { amount: 150, eligible: [0, 1, 2] }, // 50 * 3
      { amount: 200, eligible: [1, 2] }, // 100 * 2
      { amount: 150, eligible: [2] }, // 150 * 1
    ]);
    expect(layers.reduce((n, l) => n + l.amount, 0)).toBe(500);
  });

  it("excludes a folded seat's contribution from eligibility but still counts it toward the layer size", () => {
    const totalCommitted = { 0: 50, 1: 150, 2: 300 };
    const folded = { 0: true, 1: false, 2: false };
    const layers = computePots(totalCommitted, folded);
    expect(layers[0]).toEqual({ amount: 150, eligible: [1, 2] });
  });

  it("all-in below the blind still forms a correct layer boundary", () => {
    // Seat 0 posts the big blind (20) but only has 12 chips.
    const totalCommitted = { 0: 12, 1: 20, 2: 60 };
    const folded = { 0: false, 1: false, 2: false };
    const layers = computePots(totalCommitted, folded);
    expect(layers).toEqual([
      { amount: 36, eligible: [0, 1, 2] }, // 12 * 3
      { amount: 16, eligible: [1, 2] }, // 8 * 2
      { amount: 40, eligible: [2] }, // 40 * 1
    ]);
  });

  it("a single uncalled excess resolves as a trivial single-eligible layer (no separate refund rule needed)", () => {
    const totalCommitted = { 0: 20, 1: 100 };
    const folded = { 0: false, 1: false };
    const layers = computePots(totalCommitted, folded);
    expect(layers).toEqual([
      { amount: 40, eligible: [0, 1] },
      { amount: 80, eligible: [1] },
    ]);
    // Seat 1 has the better hand and wins the contested layer outright
    // too — the uncalled 80 lands right back with them either way.
    const { deltas } = awardPots(layers, (s) => (s === 1 ? hv(1) : hv(0)), 0, 2);
    expect(deltas[1]).toBe(120);
    expect(deltas[0] ?? 0).toBe(0);
  });
});

describe("awardPots", () => {
  it("lets a short stack win the main pot while a deeper stack takes the side pot", () => {
    const layers = computePots({ 0: 50, 1: 150, 2: 300 }, { 0: false, 1: false, 2: false });
    const values: Record<number, HandValue> = { 0: hv(3), 1: hv(2), 2: hv(1) };
    const { deltas, winningSeats } = awardPots(layers, (s) => values[s]!, 2, 3);
    expect(deltas[0]).toBe(150); // wins the main pot outright
    expect(deltas[1]).toBe(200); // wins the side pot it's eligible for
    expect(deltas[2]).toBe(150); // only eligible for the top layer
    expect(winningSeats.sort()).toEqual([0, 1, 2]);
  });

  it("the reverse: a deep stack's better hand sweeps every layer it's eligible for, leaving the short stack nothing", () => {
    const layers = computePots({ 0: 50, 1: 150, 2: 300 }, { 0: false, 1: false, 2: false });
    const values: Record<number, HandValue> = { 0: hv(0), 1: hv(1), 2: hv(3) };
    const { deltas } = awardPots(layers, (s) => values[s]!, 2, 3);
    expect(deltas[0] ?? 0).toBe(0);
    expect(deltas[1] ?? 0).toBe(0);
    expect(deltas[2]).toBe(500);
  });

  it("splits an odd-chip layer to the first eligible seat left of the button", () => {
    const layers = [{ amount: 101, eligible: [1, 3] }];
    const tie: Record<number, HandValue> = { 1: hv(1, [10]), 3: hv(1, [10]) };
    const fromButton0 = awardPots(layers, (s) => tie[s]!, 0, 4);
    expect(fromButton0.deltas).toEqual({ 1: 51, 3: 50 });

    const fromButton2 = awardPots(layers, (s) => tie[s]!, 2, 4);
    expect(fromButton2.deltas).toEqual({ 3: 51, 1: 50 });
  });

  it("splits a 3-way odd-chip layer one chip at a time, in seat order from the button", () => {
    const layers = [{ amount: 100, eligible: [0, 1, 2] }];
    const tie: Record<number, HandValue> = { 0: hv(2, [9]), 1: hv(2, [9]), 2: hv(2, [9]) };
    const { deltas } = awardPots(layers, (s) => tie[s]!, 2, 3);
    // seatOrderAfter(2, 3) = [0, 1, 2] -> two of the three remainder-1 chips
    // land on 0 and 1.
    expect(deltas).toEqual({ 0: 34, 1: 33, 2: 33 });
  });
});

describe("blind positions", () => {
  it("3+-handed: SB and BB are the two seats after the button", () => {
    expect(smallBlindOf(0, [0, 1, 2, 3], 4)).toBe(1);
    expect(bigBlindOf(0, [0, 1, 2, 3], 4)).toBe(2);
  });

  it("heads-up: the button IS the small blind", () => {
    expect(smallBlindOf(0, [0, 1], 2)).toBe(0);
    expect(bigBlindOf(0, [0, 1], 2)).toBe(1);
  });

  it("positionBadge: dealer takes priority, heads-up shows no separate SB tag", () => {
    const threeHanded = makeState({ seats: 4, button: 1 });
    expect(positionBadge(threeHanded, 1)).toBe("D");
    expect(positionBadge(threeHanded, 2)).toBe("SB");
    expect(positionBadge(threeHanded, 3)).toBe("BB");
    expect(positionBadge(threeHanded, 0)).toBeNull();

    const headsUp = makeState({ seats: 2, button: 0 });
    expect(positionBadge(headsUp, 0)).toBe("D");
    expect(positionBadge(headsUp, 1)).toBe("BB");
  });
});

describe("turn order — the heads-up inversion", () => {
  it("preflop: 3+-handed starts at UTG (after the big blind)", () => {
    const state = makeState({ seats: 4, button: 0 });
    expect(preflopOrder(state)[0]).toBe(3); // BB is seat 2, UTG is seat 3
  });

  it("preflop: heads-up starts at the button (== small blind)", () => {
    const state = makeState({ seats: 2, button: 0 });
    expect(preflopOrder(state)).toEqual([0, 1]);
  });

  it("postflop: heads-up starts at the OTHER seat (the big blind), button acts last — the single shared rule handles both seat counts", () => {
    const headsUp = makeState({ seats: 2, button: 0 });
    expect(postflopOrder(headsUp)).toEqual([1, 0]);

    const threeHanded = makeState({ seats: 4, button: 0 });
    expect(postflopOrder(threeHanded)).toEqual([1, 2, 3, 0]);
  });

  it("an all-in seat is excluded from the queue but not from the hand", () => {
    const state = makeState({
      seats: 3,
      button: 0,
      stacks: { 0: 500, 1: 0, 2: 500 },
    });
    expect(postflopOrder(state)).toEqual([2, 0]);
  });
});

describe("betting amounts", () => {
  it("amountToCall is the gap to the highest street commitment", () => {
    const state = makeState({
      seats: 3,
      streetCommitted: { 0: 20, 1: 60, 2: 20 },
    });
    expect(amountToCall(state, 0)).toBe(40);
    expect(amountToCall(state, 1)).toBe(0);
  });

  it("betRange's min is the big blind on an opening bet, a full raise otherwise, clamped to the seat's stack", () => {
    const opening = makeState({ seats: 3, bigBlind: 20 });
    expect(betRange(opening, 0)).toEqual({ min: 20, max: 1000 });

    const facingABet = makeState({
      seats: 3,
      lastRaiseSize: 60,
      streetCommitted: { 0: 0, 1: 60 },
      stacks: { 0: 1000, 1: 940, 2: 1000 },
    });
    expect(betRange(facingABet, 0)).toEqual({ min: 120, max: 1000 });

    const shortStacked = makeState({
      seats: 3,
      lastRaiseSize: 60,
      streetCommitted: { 0: 0, 1: 60 },
      stacks: { 0: 90, 1: 940, 2: 1000 },
    });
    // Can't afford a full raise to 120 — min collapses to their max (all-in).
    expect(betRange(shortStacked, 0)).toEqual({ min: 90, max: 90 });
  });
});
