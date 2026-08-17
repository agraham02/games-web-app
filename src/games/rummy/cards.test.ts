import { describe, expect, it } from "vitest";
import {
  canExtend,
  cardPoints,
  cardsValue,
  findCompletion,
  handDisplayOrder,
  isRun,
  isSet,
  isValidMeld,
  meldDisplayOrder,
  meldLabel,
  orderExtensions,
  runReading,
  rummyDeck,
} from "./cards";

describe("rummy cards — point values", () => {
  it("scores Rummy 500's own scale, not standard-Gin deadwood", () => {
    expect(cardPoints("A")).toBe(15);
    expect(cardPoints("K")).toBe(10);
    expect(cardPoints("Q")).toBe(10);
    expect(cardPoints("J")).toBe(10);
    // The ten scores with the PICTURES, not with the numbers. It reads
    // like a number card, which is exactly why it was wrong once.
    expect(cardPoints("10")).toBe(10);
    for (const rank of ["2", "3", "4", "5", "6", "7", "8", "9"] as const) {
      expect(cardPoints(rank), rank).toBe(5);
    }
  });

  it("sums a hand", () => {
    expect(cardsValue(["SA", "HK", "D5"])).toBe(15 + 10 + 5);
    expect(cardsValue(["C10"])).toBe(10);
  });

  it("values a whole deck at the total the rules imply", () => {
    // 4 aces at 15, 16 ten-or-picture at 10, 32 number cards at 5.
    expect(cardsValue(rummyDeck())).toBe(4 * 15 + 16 * 10 + 32 * 5);
  });

  it("builds one clean 52-card deck with no jokers", () => {
    const deck = rummyDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
    expect(deck.some((id) => id.startsWith("X"))).toBe(false);
  });
});

describe("rummy cards — sets", () => {
  it("accepts 3 and 4 of a rank in distinct suits", () => {
    expect(isSet(["S7", "H7", "D7"])).toBe(true);
    expect(isSet(["S7", "H7", "D7", "C7"])).toBe(true);
  });

  it("rejects a pair, a duplicate suit, and a mixed rank", () => {
    expect(isSet(["S7", "H7"])).toBe(false);
    expect(isSet(["S7", "S7", "H7"])).toBe(false);
    expect(isSet(["S7", "H7", "D8"])).toBe(false);
  });

  it("extends only into a suit not already present, and never past four", () => {
    expect(canExtend(["S7", "H7", "D7"], "C7")).toBe(true);
    expect(canExtend(["S7", "H7", "D7"], "S7")).toBe(false);
    expect(canExtend(["S7", "H7", "D7", "C7"], "S7")).toBe(false);
    expect(canExtend(["S7", "H7", "D7"], "C8")).toBe(false);
  });
});

describe("rummy cards — runs and the ace", () => {
  it("accepts consecutive same-suit cards", () => {
    expect(isRun(["S5", "S6", "S7"])).toBe(true);
    expect(isRun(["S5", "S7", "S8"])).toBe(false);
    expect(isRun(["S5", "H6", "S7"])).toBe(false);
    expect(isRun(["S5", "S6"])).toBe(false);
  });

  it("reads the ace low when it sits under a 2", () => {
    const run = runReading(["SA", "S2", "S3"]);
    expect(run).toEqual({ aceHigh: false, low: 1, high: 3 });
  });

  it("reads the ace high when it sits over a King", () => {
    const run = runReading(["SJ", "SQ", "SK", "SA"]);
    expect(run).toEqual({ aceHigh: true, low: 11, high: 14 });
  });

  it("never wraps K-A-2", () => {
    expect(isRun(["SK", "SA", "S2"])).toBe(false);
    expect(isRun(["SQ", "SK", "SA", "S2"])).toBe(false);
  });

  it("attaches an ace above a King, committing the run to ace-high", () => {
    expect(canExtend(["SJ", "SQ", "SK"], "SA")).toBe(true);
    expect(runReading(["SJ", "SQ", "SK", "SA"])?.aceHigh).toBe(true);
  });

  it("uses a committed ace-high run's TRUE low bound, not the ace's raw value", () => {
    // The regression this exists for: the ace's raw rankValue is 1, so a
    // naive Math.min reports this run's low end as "1" and accepts a 2,
    // producing J-Q-K-A-2 by the back door.
    const aceHigh = ["SJ", "SQ", "SK", "SA"];
    expect(canExtend(aceHigh, "S2")).toBe(false);
    expect(canExtend(aceHigh, "S10")).toBe(true);
  });

  it("extends an ace-low run upward without re-reading the ace", () => {
    expect(canExtend(["SA", "S2", "S3"], "S4")).toBe(true);
    expect(canExtend(["SA", "S2", "S3"], "SK")).toBe(false);
  });

  it("rejects a card of the wrong suit or one already in the meld", () => {
    expect(canExtend(["S5", "S6", "S7"], "H8")).toBe(false);
    expect(canExtend(["S5", "S6", "S7"], "S6")).toBe(false);
  });
});

describe("rummy cards — orderExtensions", () => {
  it("orders a multi-card lay-off so each card fits when it is played", () => {
    // Reported from play: a 9 and a 10 onto a J-Q-K run had to be laid
    // one at a time, correct end first. The 9 does not touch that run
    // until the 10 has extended its low end, so order is the whole
    // problem — and the player can already see both cards fit.
    expect(orderExtensions(["SJ", "SQ", "SK"], ["S9", "S10"])).toEqual(["S10", "S9"]);
    expect(orderExtensions(["SJ", "SQ", "SK"], ["S10", "S9"])).toEqual(["S10", "S9"]);
  });

  it("extends both ends of a run in one go", () => {
    const order = orderExtensions(["S5", "S6", "S7"], ["S4", "S8"]);
    expect(order).not.toBeNull();
    expect([...order!].sort()).toEqual(["S4", "S8"]);
  });

  it("completes a set with its fourth suit, and has no room for a fifth", () => {
    // A set is 3-4 cards, so unlike a run it only ever accepts one
    // extension — there is no ordering question to get wrong.
    expect(orderExtensions(["S7", "H7", "D7"], ["C7"])).toEqual(["C7"]);
    expect(orderExtensions(["S7", "H7", "D7", "C7"], ["S7"])).toBeNull();
  });

  it("refuses when any one card never fits", () => {
    expect(orderExtensions(["SJ", "SQ", "SK"], ["S10", "H2"])).toBeNull();
    // ...including a card that would wrap a committed ace-high run.
    expect(orderExtensions(["SJ", "SQ", "SK", "SA"], ["S2"])).toBeNull();
  });

  it("returns an empty order for nothing to lay", () => {
    expect(orderExtensions(["S5", "S6", "S7"], [])).toEqual([]);
  });
});

describe("rummy cards — display order", () => {
  it("sorts a run low-to-high regardless of the order it was laid", () => {
    // The reported bug: a run laid 9-10 and later hit with J stores as
    // ["S9","S10","SJ"] only by luck of lay order; hitting the low end
    // stores out of order and rendered as a scrambled run.
    expect(meldDisplayOrder(["S10", "SJ", "S9"])).toEqual(["S9", "S10", "SJ"]);
    expect(meldDisplayOrder(["S9", "SJ", "S10"])).toEqual(["S9", "S10", "SJ"]);
  });

  it("sorts an ace-high run with the ace last", () => {
    expect(meldDisplayOrder(["SA", "SQ", "SK", "SJ"])).toEqual(["SJ", "SQ", "SK", "SA"]);
  });

  it("sorts an ace-low run with the ace first", () => {
    expect(meldDisplayOrder(["S3", "SA", "S2"])).toEqual(["SA", "S2", "S3"]);
  });

  it("sorts a hand by suit group then rank", () => {
    const sorted = handDisplayOrder(["SK", "D3", "HA", "DA", "C5"]);
    // HAND_DISPLAY_SUIT_ORDER is D, C, H, S.
    expect(sorted).toEqual(["DA", "D3", "C5", "HA", "SK"]);
  });

  it("labels melds compactly", () => {
    expect(meldLabel(["S9", "S10", "SJ"])).toBe("9-J♠");
    expect(meldLabel(["S7", "H7", "D7"])).toContain("7");
  });
});

describe("rummy cards — findCompletion", () => {
  it("finds a set using a hand card", () => {
    expect(findCompletion("S7", ["H7", "D7", "CK"])).not.toBeNull();
  });

  it("finds a run using a hand card", () => {
    expect(findCompletion("S7", ["S5", "S6"])).not.toBeNull();
  });

  it("refuses a completion made entirely of pile cards", () => {
    // The reported exploit: three aces sitting together in the discard
    // pile let a player dig to the deepest and "complete" a set from the
    // other two aces STILL IN THE PILE, with no hand card involved. The
    // pile happening to hold a meld next to itself proves nothing about
    // whether the player can use the card.
    expect(findCompletion("SA", [], ["HA", "DA"])).toBeNull();
    expect(findCompletion("SA", ["CK", "D4"], ["HA", "DA"])).toBeNull();
  });

  it("accepts a completion mixing one hand card with pile cards", () => {
    const meld = findCompletion("SA", ["HA"], ["DA"]);
    expect(meld).not.toBeNull();
    expect(meld).toContain("SA");
    expect(meld).toContain("HA");
  });

  it("finds a longer run when every 3-card window avoids the hand card", () => {
    // Target 5, hand card 8, pile carries 6 and 7. The only 3-card
    // window containing the 5 is 5-6-7, which uses no hand card at all —
    // so a minimal-meld-only search would wrongly reject this pickup.
    const meld = findCompletion("S5", ["S8"], ["S6", "S7"]);
    expect(meld).not.toBeNull();
    expect(meld).toEqual(["S5", "S6", "S7", "S8"]);
  });

  it("returns null when nothing completes", () => {
    expect(findCompletion("S7", ["H2", "D9", "CK"])).toBeNull();
  });

  it("only ever returns genuinely valid melds", () => {
    const deck = rummyDeck();
    for (let i = 0; i < deck.length; i++) {
      const target = deck[i]!;
      const hand = [deck[(i + 7) % 52]!, deck[(i + 14) % 52]!, deck[(i + 21) % 52]!];
      const pool = [deck[(i + 3) % 52]!, deck[(i + 11) % 52]!];
      const meld = findCompletion(target, hand, pool);
      if (!meld) continue;
      expect(isValidMeld(meld), `${target} -> ${meld.join(",")}`).toBe(true);
      expect(meld, `${target} must be in its own completion`).toContain(target);
    }
  });
});
