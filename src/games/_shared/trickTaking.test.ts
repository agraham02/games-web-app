import { describe, expect, it } from "vitest";
import { canLeadTrump, legalFollows, resolveTrick, type TrickCard, type TrickPlay } from "./trickTaking";
import { BIG_JOKER_ID, LITTLE_JOKER_ID, cardId } from "./cards";
import { cardStrength, effectiveSuit, isTrump } from "@/games/spades/cards";

/** Build a generic TrickCard — spades ("S") stands in as the trump suit,
 * matching how every real caller (Spades) will use this module. */
function card(id: string, suit: TrickCard["suit"]): TrickCard {
  return { id, suit, isTrump: suit === "S" };
}

describe("legalFollows", () => {
  it("forces following the led suit when the hand holds it", () => {
    const heart = card("h", "H");
    const hand = [heart, card("s", "S"), card("c", "C")];
    expect(legalFollows(hand, "H")).toEqual([heart]);
  });

  it("allows anything, including trump, when void in the led suit", () => {
    const hand = [card("s", "S"), card("c", "C")];
    expect(legalFollows(hand, "H")).toEqual(hand);
  });

  it("treats a null led suit (the lead itself) as no restriction", () => {
    const hand = [card("h", "H"), card("c", "C")];
    expect(legalFollows(hand, null)).toEqual(hand);
  });
});

describe("canLeadTrump", () => {
  it("forbids leading trump before it's broken, with a non-trump card available", () => {
    const hand = [card("s", "S"), card("h", "H")];
    expect(canLeadTrump(hand, false)).toBe(false);
  });

  it("allows leading trump once it's broken", () => {
    const hand = [card("s", "S"), card("h", "H")];
    expect(canLeadTrump(hand, true)).toBe(true);
  });

  it("forces a trump lead, even unbroken, when the hand holds nothing else", () => {
    const hand = [card("s1", "S"), card("s2", "S")];
    expect(canLeadTrump(hand, false)).toBe(true);
  });
});

describe("resolveTrick", () => {
  const strength = (id: string): number => {
    const order: Record<string, number> = { low: 1, mid: 2, high: 3, trumpLow: 10, trumpHigh: 20 };
    return order[id] ?? 0;
  };

  it("awards the trick to the highest card of the led suit when nobody trumps", () => {
    const plays: TrickPlay[] = [
      { seat: 0, card: card("low", "H") },
      { seat: 1, card: card("high", "H") },
      { seat: 2, card: card("mid", "H") },
    ];
    expect(resolveTrick(plays, "H", strength)).toBe(1);
  });

  it("awards the trick to trump over a higher off-suit card", () => {
    const plays: TrickPlay[] = [
      { seat: 0, card: card("high", "H") },
      { seat: 1, card: card("trumpLow", "S") },
    ];
    expect(resolveTrick(plays, "H", strength)).toBe(1);
  });

  it("awards the trick to the higher of two trump plays", () => {
    const plays: TrickPlay[] = [
      { seat: 0, card: card("trumpLow", "S") },
      { seat: 1, card: card("trumpHigh", "S") },
    ];
    expect(resolveTrick(plays, "H", strength)).toBe(1);
  });

  it("never lets a void off-suit discard win, even if numerically high", () => {
    const plays: TrickPlay[] = [
      { seat: 0, card: card("low", "H") },
      // Seat 1 was void in hearts and discarded a high-numbered club — it
      // is not trump and not the led suit, so it cannot contest the trick.
      { seat: 1, card: card("high", "C") },
    ];
    expect(resolveTrick(plays, "H", strength)).toBe(0);
  });
});

describe("resolveTrick, integrated with Spades' real card strength and jokers", () => {
  const rules = { jokers: true, twoOfSpadesHigh: true };
  const strength = (id: string) => cardStrength(id, rules);
  const toCard = (id: string): TrickCard => ({ id, suit: effectiveSuit(id), isTrump: isTrump(id) });

  it("the Big Joker beats a trumped Little Joker and 2 of spades", () => {
    const plays: TrickPlay[] = [
      { seat: 0, card: toCard(cardId("H", "K")) },
      { seat: 1, card: toCard(LITTLE_JOKER_ID) },
      { seat: 2, card: toCard(cardId("S", "2")) },
      { seat: 3, card: toCard(BIG_JOKER_ID) },
    ];
    expect(resolveTrick(plays, "H", strength)).toBe(3);
  });

  it("a lone spade ruff beats every card of the led suit", () => {
    const plays: TrickPlay[] = [
      { seat: 0, card: toCard(cardId("C", "A")) },
      { seat: 1, card: toCard(cardId("C", "K")) },
      { seat: 2, card: toCard(cardId("S", "3")) },
    ];
    expect(resolveTrick(plays, "C", strength)).toBe(2);
  });
});
