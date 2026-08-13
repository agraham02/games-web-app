import { describe, expect, it } from "vitest";
import { BIG_JOKER_ID, LITTLE_JOKER_ID, cardId } from "@/games/_shared/cards";
import { cardStrength, effectiveSuit, isTrump, spadesDeck, type SpadesRules } from "./cards";

const RULES = {
  neither: { jokers: false, twoOfSpadesHigh: false } satisfies SpadesRules,
  twoHigh: { jokers: false, twoOfSpadesHigh: true } satisfies SpadesRules,
  jokers: { jokers: true, twoOfSpadesHigh: false } satisfies SpadesRules,
  both: { jokers: true, twoOfSpadesHigh: true } satisfies SpadesRules,
};

function strength(id: string, rules: SpadesRules): number {
  return cardStrength(id, rules);
}

describe("cardStrength", () => {
  it("orders a plain spades run ace-high with neither toggle on", () => {
    const rules = RULES.neither;
    expect(strength(cardId("S", "2"), rules)).toBeLessThan(strength(cardId("S", "3"), rules));
    expect(strength(cardId("S", "K"), rules)).toBeLessThan(strength(cardId("S", "A"), rules));
    // 2 of spades stays at the bottom of the suit.
    expect(strength(cardId("S", "2"), rules)).toBeLessThan(strength(cardId("S", "3"), rules));
  });

  it("moves 2 of spades above the ace when twoOfSpadesHigh is on", () => {
    const rules = RULES.twoHigh;
    const two = strength(cardId("S", "2"), rules);
    const ace = strength(cardId("S", "A"), rules);
    const king = strength(cardId("S", "K"), rules);
    const three = strength(cardId("S", "3"), rules);
    expect(two).toBeGreaterThan(ace);
    expect(ace).toBeGreaterThan(king);
    // The rest of the suit is otherwise untouched — 3 is still the floor.
    expect(three).toBeLessThan(king);
  });

  it("ranks both jokers above every natural card when jokers is on", () => {
    const rules = RULES.jokers;
    const ace = strength(cardId("S", "A"), rules);
    const little = strength(LITTLE_JOKER_ID, rules);
    const big = strength(BIG_JOKER_ID, rules);
    expect(big).toBeGreaterThan(little);
    expect(little).toBeGreaterThan(ace);
    // 2 of spades has NOT moved — jokers alone doesn't imply 2-high.
    expect(strength(cardId("S", "2"), rules)).toBeLessThan(
      strength(cardId("S", "3"), rules),
    );
  });

  it("stacks big joker, little joker, 2 of spades, ace when both toggles are on", () => {
    const rules = RULES.both;
    const big = strength(BIG_JOKER_ID, rules);
    const little = strength(LITTLE_JOKER_ID, rules);
    const two = strength(cardId("S", "2"), rules);
    const ace = strength(cardId("S", "A"), rules);
    const king = strength(cardId("S", "K"), rules);
    expect(big).toBeGreaterThan(little);
    expect(little).toBeGreaterThan(two);
    expect(two).toBeGreaterThan(ace);
    expect(ace).toBeGreaterThan(king);
  });

  it("never elevates 2 of diamonds — only 2 of spades moves (Barmore, not NYC)", () => {
    for (const rules of Object.values(RULES)) {
      const twoOfDiamonds = strength(cardId("D", "2"), rules);
      const threeOfDiamonds = strength(cardId("D", "3"), rules);
      expect(twoOfDiamonds).toBeLessThan(threeOfDiamonds);
    }
  });

  it("leaves off-suit ace-high ordering alone regardless of toggles", () => {
    for (const rules of Object.values(RULES)) {
      expect(strength(cardId("H", "K"), rules)).toBeLessThan(strength(cardId("H", "A"), rules));
    }
  });
});

describe("effectiveSuit / isTrump", () => {
  it("treats both jokers as spades, for follow-suit and for trump", () => {
    expect(effectiveSuit(BIG_JOKER_ID)).toBe("S");
    expect(effectiveSuit(LITTLE_JOKER_ID)).toBe("S");
    expect(isTrump(BIG_JOKER_ID)).toBe(true);
    expect(isTrump(LITTLE_JOKER_ID)).toBe(true);
  });

  it("treats every spade, and only spades, as trump among real cards", () => {
    expect(isTrump(cardId("S", "4"))).toBe(true);
    expect(isTrump(cardId("H", "A"))).toBe(false);
    expect(isTrump(cardId("D", "A"))).toBe(false);
    expect(isTrump(cardId("C", "A"))).toBe(false);
  });
});

describe("spadesDeck", () => {
  it("is always exactly 52 unique ids with jokers off", () => {
    const deck = spadesDeck(RULES.neither);
    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
    expect(deck).not.toContain(BIG_JOKER_ID);
    expect(deck).not.toContain(LITTLE_JOKER_ID);
  });

  it("stays 52 with jokers on, swapping in for 2 of clubs and 2 of hearts", () => {
    const deck = spadesDeck(RULES.jokers);
    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
    expect(deck).toContain(BIG_JOKER_ID);
    expect(deck).toContain(LITTLE_JOKER_ID);
    expect(deck).not.toContain(cardId("C", "2"));
    expect(deck).not.toContain(cardId("H", "2"));
    // 2 of diamonds and 2 of spades are untouched.
    expect(deck).toContain(cardId("D", "2"));
    expect(deck).toContain(cardId("S", "2"));
  });

  it("twoOfSpadesHigh alone changes no deck composition, only ranking", () => {
    const deck = spadesDeck(RULES.twoHigh);
    expect(deck).toHaveLength(52);
    expect(deck).not.toContain(BIG_JOKER_ID);
  });
});
