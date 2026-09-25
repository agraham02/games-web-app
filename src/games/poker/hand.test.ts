import { describe, expect, it } from "vitest";
import { parseCard } from "@/games/_shared/cards";
import { bestOfSeven, compareHandValues, describeBest, evaluateFive, pokerRank } from "./hand";

function hand(ids: string[]) {
  return ids.map(parseCard);
}

describe("pokerRank", () => {
  it("is ace-high, unlike _shared/cards.ts's rankValue", () => {
    expect(pokerRank("A")).toBe(14);
    expect(pokerRank("K")).toBe(13);
    expect(pokerRank("2")).toBe(2);
    expect(pokerRank("10")).toBe(10);
  });
});

describe("evaluateFive — category ordering", () => {
  it("ranks a straight flush highest, ace-high (royal) with no special case", () => {
    const royal = evaluateFive(hand(["SA", "SK", "SQ", "SJ", "S10"]));
    expect(royal.category).toBe(8);
    expect(royal.ranks).toEqual([14]);
  });

  it("recognizes the ace-low wheel straight flush, high card 5", () => {
    const wheel = evaluateFive(hand(["SA", "S2", "S3", "S4", "S5"]));
    expect(wheel.category).toBe(8);
    expect(wheel.ranks).toEqual([5]);
    // A wheel straight flush is BELOW a 6-high straight flush.
    const sixHigh = evaluateFive(hand(["H2", "H3", "H4", "H5", "H6"]));
    expect(compareHandValues(sixHigh, wheel)).toBeGreaterThan(0);
  });

  it("quads beat a full house beat a flush beat a straight", () => {
    const quads = evaluateFive(hand(["SA", "HA", "DA", "CA", "S2"]));
    const boat = evaluateFive(hand(["SK", "HK", "DK", "S2", "H2"]));
    const flush = evaluateFive(hand(["S2", "S5", "S7", "S9", "SJ"]));
    const straight = evaluateFive(hand(["H2", "D3", "S4", "C5", "H6"]));
    expect(quads.category).toBe(7);
    expect(boat.category).toBe(6);
    expect(flush.category).toBe(5);
    expect(straight.category).toBe(4);
    expect(compareHandValues(quads, boat)).toBeGreaterThan(0);
    expect(compareHandValues(boat, flush)).toBeGreaterThan(0);
    expect(compareHandValues(flush, straight)).toBeGreaterThan(0);
  });

  it("trips beat two pair beat one pair beat high card", () => {
    const trips = evaluateFive(hand(["SA", "HA", "DA", "C2", "H3"]));
    const twoPair = evaluateFive(hand(["SK", "HK", "D5", "C5", "H2"]));
    const pair = evaluateFive(hand(["SQ", "HQ", "D9", "C5", "H2"]));
    const high = evaluateFive(hand(["SA", "H9", "D7", "C5", "H2"]));
    expect(trips.category).toBe(3);
    expect(twoPair.category).toBe(2);
    expect(pair.category).toBe(1);
    expect(high.category).toBe(0);
    expect(compareHandValues(trips, twoPair)).toBeGreaterThan(0);
    expect(compareHandValues(twoPair, pair)).toBeGreaterThan(0);
    expect(compareHandValues(pair, high)).toBeGreaterThan(0);
  });

  it("does not misfire a straight/flush on a non-sequential or mixed-suit hand", () => {
    const notStraight = evaluateFive(hand(["S2", "H3", "D4", "C5", "S7"]));
    expect(notStraight.category).toBe(0);
    const notFlush = evaluateFive(hand(["S2", "H5", "S7", "S9", "SJ"]));
    expect(notFlush.category).not.toBe(5);
  });
});

describe("evaluateFive — kicker tie-breaks within a category", () => {
  it("full house compares trip rank first, then pair rank", () => {
    const kingsOverTwos = evaluateFive(hand(["SK", "HK", "DK", "C2", "H2"]));
    const queensOverAces = evaluateFive(hand(["SQ", "HQ", "DQ", "CA", "HA"]));
    expect(compareHandValues(kingsOverTwos, queensOverAces)).toBeGreaterThan(0);
  });

  it("two pair compares the high pair, then the low pair, then the kicker", () => {
    const acesAndTwos = evaluateFive(hand(["SA", "HA", "D2", "C2", "H5"]));
    const acesAndThrees = evaluateFive(hand(["SA", "DA", "D3", "C3", "H4"]));
    expect(compareHandValues(acesAndThrees, acesAndTwos)).toBeGreaterThan(0);

    const higherKicker = evaluateFive(hand(["SA", "HA", "D2", "C2", "HK"]));
    const lowerKicker = evaluateFive(hand(["SA", "DA", "S2", "H2", "H5"]));
    expect(compareHandValues(higherKicker, lowerKicker)).toBeGreaterThan(0);
  });

  it("one pair compares the pair, then kickers in order", () => {
    const a = evaluateFive(hand(["SA", "HA", "DK", "C5", "H2"]));
    const b = evaluateFive(hand(["SA", "DA", "DK", "C5", "H3"]));
    expect(compareHandValues(b, a)).toBeGreaterThan(0); // 3-kicker beats 2-kicker
  });

  it("high card compares every card in order", () => {
    const a = evaluateFive(hand(["SA", "HK", "DQ", "C9", "H2"]));
    const b = evaluateFive(hand(["SA", "HK", "DQ", "C9", "H3"]));
    expect(compareHandValues(b, a)).toBeGreaterThan(0);
  });

  it("an exact tie compares equal", () => {
    const a = evaluateFive(hand(["SA", "HK", "DQ", "C9", "H2"]));
    const b = evaluateFive(hand(["DA", "CK", "SQ", "H9", "S2"]));
    expect(compareHandValues(a, b)).toBe(0);
  });
});

describe("evaluateFive — invariants", () => {
  it("throws on anything other than exactly 5 cards", () => {
    expect(() => evaluateFive(hand(["SA", "HK"]))).toThrow();
  });
});

describe("bestOfSeven", () => {
  it("picks the best 5 of 7 cards", () => {
    // Board gives a flush; hole cards are irrelevant to it.
    const value = bestOfSeven(
      hand(["S2", "S5", "S7", "S9", "SJ", "H2", "H3"]),
    );
    expect(value.category).toBe(5);
  });

  it("prefers a pair from the board plus hole cards over 7-card high card", () => {
    const value = bestOfSeven(hand(["SA", "HA", "D2", "C5", "H9", "S3", "H7"]));
    expect(value.category).toBe(1);
  });

  it("throws on fewer than 5 cards", () => {
    expect(() => bestOfSeven(hand(["SA", "HK"]))).toThrow();
  });

  it("handles exactly 5 and exactly 6 cards too, not only 7", () => {
    expect(bestOfSeven(hand(["SA", "SK", "SQ", "SJ", "S10"])).category).toBe(8);
    expect(bestOfSeven(hand(["SA", "SK", "SQ", "SJ", "S10", "H2"])).category).toBe(8);
  });
});

describe("describeHand / describeBest", () => {
  const cards = (...ids: string[]) => ids.map(parseCard);

  it("names which pair, not just that there is one", () => {
    expect(describeBest(cards("S10", "H10", "C2", "D7", "HK"))).toBe("Pair of 10s");
    expect(describeBest(cards("SK", "HK", "C10", "D10", "H2"))).toBe("Two pair, Kings and 10s");
    expect(describeBest(cards("SA", "H2", "C9", "D7", "HK"))).toBe("Ace high");
  });

  it("names the big hands a newcomer most wants to recognise", () => {
    expect(describeBest(cards("SA", "SK", "SQ", "SJ", "S10"))).toBe("Royal flush");
    expect(describeBest(cards("SK", "HK", "CK", "D10", "H10"))).toBe("Full house, Kings and 10s");
    expect(describeBest(cards("S9", "H8", "C7", "D6", "H5"))).toBe("Straight, 9 high");
  });

  it("reads two hole cards before the flop", () => {
    expect(describeBest(cards("S7", "H7"))).toBe("Pair of 7s");
    expect(describeBest(cards("SA", "H2"))).toBe("Ace high");
  });

  it("takes the best five of seven", () => {
    // The reported river: A♣ 2♥ on 9♠ 8♣ K♣ 10♣ 10♥.
    expect(describeBest(cards("CA", "H2", "S9", "C8", "CK", "C10", "H10"))).toBe("Pair of 10s");
  });
});
