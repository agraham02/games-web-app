import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import { parseCard, RANKS, SUITS } from "@/games/_shared/cards";
import { bestOfSeven, compareHandValues, pokerRank } from "./hand";
import { equityFor, handEquity, handScore } from "./equity";

const DECK = SUITS.flatMap((suit) => RANKS.map((rank) => `${suit}${rank}`));

const SUIT_INDEX: Record<string, number> = { S: 0, H: 1, D: 2, C: 3 };

function scoreOf(ids: readonly string[]): number {
  const cards = ids.map(parseCard);
  return handScore(
    cards.map((c) => pokerRank(c.rank)),
    cards.map((c) => SUIT_INDEX[c.suit]!),
  );
}

function sign(n: number): number {
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

describe("handScore — the fast evaluator agrees with hand.ts", () => {
  /**
   * `equity.ts` duplicates hand ranking for speed. The duplication is
   * only acceptable while the two orderings are identical, so this
   * compares them directly on thousands of real seven-card hands rather
   * than spot-checking a handful of categories.
   */
  it("orders 4000 random seven-card pairings identically to compareHandValues", () => {
    const rng = createRng(7);
    let compared = 0;
    for (let i = 0; i < 4000; i++) {
      const a = rng.shuffle(DECK).slice(0, 7);
      const b = rng.shuffle(DECK).slice(0, 7);
      const fast = sign(scoreOf(a) - scoreOf(b));
      const canonical = sign(compareHandValues(bestOfSeven(a.map(parseCard)), bestOfSeven(b.map(parseCard))));
      expect(fast).toBe(canonical);
      compared++;
    }
    expect(compared).toBe(4000);
  });

  it("ranks the categories in the right order, including the wheel", () => {
    const straightFlush = scoreOf(["S9", "S8", "S7", "S6", "S5", "H2", "D3"]);
    const quads = scoreOf(["S9", "H9", "D9", "C9", "S5", "H2", "D3"]);
    const boat = scoreOf(["S9", "H9", "D9", "C5", "S5", "H2", "D3"]);
    const flush = scoreOf(["SA", "S8", "S7", "S6", "S2", "H9", "D3"]);
    const straight = scoreOf(["S9", "H8", "D7", "C6", "S5", "H2", "D3"]);
    const wheel = scoreOf(["SA", "H2", "D3", "C4", "S5", "H9", "D10"]);
    const pair = scoreOf(["S9", "H9", "D7", "C6", "S4", "H2", "D3"]);
    expect(straightFlush).toBeGreaterThan(quads);
    expect(quads).toBeGreaterThan(boat);
    expect(boat).toBeGreaterThan(flush);
    expect(flush).toBeGreaterThan(straight);
    expect(straight).toBeGreaterThan(wheel);
    expect(wheel).toBeGreaterThan(pair);
  });

  it("separates hands that differ only by kicker", () => {
    const aceKing = scoreOf(["SA", "HA", "DK", "C7", "S4", "H2", "D3"]);
    const aceQueen = scoreOf(["SA", "HA", "DQ", "C7", "S4", "H2", "D3"]);
    expect(aceKing).toBeGreaterThan(aceQueen);
  });
});

describe("handEquity — real probabilities", () => {
  /**
   * Reference numbers are the well-known preflop all-in equities. The
   * bands are wide enough to absorb Monte Carlo noise but narrow enough
   * that a genuinely wrong evaluator or a mis-built deck fails them.
   */
  it("puts pocket aces near 85% heads-up and a trash hand near 35%", () => {
    const aces = handEquity(["SA", "HA"], [], 1, 4000, createRng(1));
    expect(aces).toBeGreaterThan(0.8);
    expect(aces).toBeLessThan(0.89);

    const trash = handEquity(["S7", "H2"], [], 1, 4000, createRng(2));
    expect(trash).toBeGreaterThan(0.29);
    expect(trash).toBeLessThan(0.41);
  });

  it("drops the same hand's equity sharply as opponents are added", () => {
    const heads = handEquity(["SA", "HA"], [], 1, 3000, createRng(3));
    const four = handEquity(["SA", "HA"], [], 4, 3000, createRng(4));
    expect(four).toBeLessThan(heads - 0.15);
    expect(four).toBeGreaterThan(0.4);
  });

  it("reads a made hand on a real board as far ahead of a busted draw", () => {
    const board = ["SK", "S7", "D2"];
    const topSet = handEquity(["HK", "CK"], board, 2, 3000, createRng(5));
    const nothing = handEquity(["H5", "C4"], board, 2, 3000, createRng(6));
    expect(topSet).toBeGreaterThan(0.85);
    expect(nothing).toBeLessThan(0.2);
  });

  it("values a flush draw well above the same high card with no draw", () => {
    const board = ["S9", "S4", "H2"];
    const flushDraw = handEquity(["SQ", "SJ"], board, 1, 3000, createRng(7));
    const dry = handEquity(["HQ", "DJ"], board, 1, 3000, createRng(8));
    expect(flushDraw).toBeGreaterThan(dry + 0.12);
  });

  it("scores a guaranteed chop as a half, not as a loss", () => {
    // The board plays: a royal flush nobody can beat or be beaten by.
    const board = ["SA", "SK", "SQ", "SJ", "S10"];
    const chop = handEquity(["H2", "D3"], board, 1, 400, createRng(9));
    expect(chop).toBeCloseTo(0.5, 1);
  });
});

describe("equityFor — memoised and position-seeded", () => {
  it("returns exactly the same number for the same spot", () => {
    const a = equityFor(["SA", "HK"], ["D7", "C2", "S5"], 3);
    const b = equityFor(["SA", "HK"], ["D7", "C2", "S5"], 3);
    expect(a).toBe(b);
  });

  it("treats suit-isomorphic starting hands as one preflop entry", () => {
    expect(equityFor(["SA", "SK"], [], 2)).toBe(equityFor(["HA", "HK"], [], 2));
    expect(equityFor(["SA", "HK"], [], 2)).toBe(equityFor(["DA", "CK"], [], 2));
    // Suited really is better than offsuit, so they must NOT collapse.
    expect(equityFor(["SA", "SK"], [], 2)).toBeGreaterThan(equityFor(["SA", "HK"], [], 2));
  });

  it("orders the classic starting hands the way every poker chart does", () => {
    const aces = equityFor(["SA", "HA"], [], 3);
    const kings = equityFor(["SK", "HK"], [], 3);
    const ako = equityFor(["SA", "HK"], [], 3);
    const eights = equityFor(["S8", "H8"], [], 3);
    const trash = equityFor(["S7", "H2"], [], 3);
    expect(aces).toBeGreaterThan(kings);
    expect(kings).toBeGreaterThan(ako);
    expect(ako).toBeGreaterThan(trash);
    expect(eights).toBeGreaterThan(trash);
  });
});
