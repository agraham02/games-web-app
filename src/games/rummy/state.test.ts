import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import { createRummy } from "./rules";
import {
  contributedValue,
  handValue,
  layableMelds,
  layoffs,
  legalDrawDepths,
  mandatoryMelds,
  maxDealSize,
  nextSeat,
  sortHand,
  totalHandCards,
  validDealSizes,
} from "./state";
import { isValidMeld } from "./cards";
import type { Meld, RummyState } from "./types";

const def = createRummy();

function fixture(overrides: Partial<RummyState> = {}): RummyState {
  const base = def.setup({ seats: 4, rng: createRng(7) });
  return {
    ...base,
    round: 1,
    dealt: true,
    turn: 0,
    hands: { 0: [], 1: [], 2: [], 3: [] },
    stock: [],
    discard: [],
    melds: [],
    ...overrides,
  };
}

function meld(id: number, owner: number, cards: string[], hitBy: Record<string, number> = {}): Meld {
  return { id, owner, cards, hitBy };
}

describe("rummy state — deal sizes", () => {
  it("never serves more cards than the deck holds", () => {
    for (let seats = 2; seats <= 6; seats++) {
      expect(seats * maxDealSize(seats)).toBeLessThanOrEqual(52);
      expect(maxDealSize(seats) % 2).toBe(1);
    }
  });

  it("lists every odd size from 1 up to the max", () => {
    expect(validDealSizes(6)).toEqual([1, 3, 5, 7]);
    expect(validDealSizes(4)).toEqual([1, 3, 5, 7, 9, 11, 13]);
  });
});

describe("rummy state — turn order", () => {
  it("wraps at the seat count", () => {
    const s = fixture();
    expect(nextSeat(s, 0)).toBe(1);
    expect(nextSeat(s, 3)).toBe(0);
  });
});

describe("rummy state — scoring inputs", () => {
  it("counts held cards against a seat", () => {
    const s = fixture({ hands: { 0: ["SA", "HK", "D5"], 1: [], 2: [], 3: [] } });
    expect(handValue(s, 0)).toBe(15 + 10 + 5);
    expect(handValue(s, 1)).toBe(0);
  });

  it("credits each board card to its own contributor, not the meld's owner", () => {
    const s = fixture({
      melds: [meld(1, 1, ["S5", "S6", "S7", "S8"], { S7: 2, S8: 2 })],
    });
    // Seat 1 laid 5 and 6; seat 2 hit 7 and 8. All fives apiece.
    expect(contributedValue(s, 1)).toBe(10);
    expect(contributedValue(s, 2)).toBe(10);
    expect(contributedValue(s, 3)).toBe(0);
  });

  it("totals hand cards across the table", () => {
    const s = fixture({ hands: { 0: ["SA", "S2"], 1: ["H3"], 2: [], 3: ["D4"] } });
    expect(totalHandCards(s)).toBe(4);
  });
});

describe("rummy state — what a hand can do", () => {
  it("finds melds a hand can lay on its own", () => {
    const melds = layableMelds(["S7", "H7", "D7", "CK", "C2"]);
    expect(melds.length).toBeGreaterThan(0);
    for (const m of melds) expect(isValidMeld(m)).toBe(true);
  });

  it("finds nothing in a hand with no meld", () => {
    expect(layableMelds(["S2", "H5", "D9", "CK"])).toEqual([]);
  });

  it("lists every legal lay-off, across every meld on the board", () => {
    const s = fixture({
      melds: [meld(1, 1, ["S5", "S6", "S7"]), meld(2, 2, ["H9", "D9", "C9"])],
    });
    const offs = layoffs(s, ["S8", "S9", "CK"]);
    expect(offs).toContainEqual({ meldId: 1, card: "S8" });
    expect(offs).toContainEqual({ meldId: 2, card: "S9" });
    expect(offs.some((o) => o.card === "CK")).toBe(false);
  });

  it("never offers a lay-off that would wrap a run past its committed ace", () => {
    const s = fixture({ melds: [meld(1, 1, ["SJ", "SQ", "SK", "SA"])] });
    const offs = layoffs(s, ["S2", "S10"]);
    expect(offs).toEqual([{ meldId: 1, card: "S10" }]);
  });
});

describe("rummy state — legalDrawDepths", () => {
  it("offers a depth only when the DEEPEST card can be melded", () => {
    const s = fixture({
      hands: { 0: ["H7", "D7"], 1: [], 2: [], 3: [] },
      // Bottom to top: the S7 is the top card.
      discard: ["CK", "S7"],
    });
    // Depth 1 takes S7 and completes the sevens; depth 2's deepest is CK,
    // which completes nothing.
    expect(legalDrawDepths(s, 0)).toEqual([1]);
  });

  it("lets the cards riding along help, but never on their own", () => {
    const s = fixture({
      hands: { 0: ["S8"], 1: [], 2: [], 3: [] },
      discard: ["S5", "S6", "S7"],
    });
    // Depth 3's deepest is S5; S6 and S7 ride along and the hand's S8
    // makes it a real run — one hand card involved, so it is legal.
    expect(legalDrawDepths(s, 0)).toContain(3);
  });

  it("returns nothing for an empty pile", () => {
    expect(legalDrawDepths(fixture(), 0)).toEqual([]);
  });
});

describe("rummy state — hand sort", () => {
  const hand = ["SK", "D3", "HA", "DA", "C5", "S7", "H7", "D7"];

  it("never adds, drops or mutates cards, whatever the mode", () => {
    for (const mode of ["smart", "suit", "rank", "dealt"] as const) {
      const sorted = sortHand(hand, mode);
      expect([...sorted].sort(), mode).toEqual([...hand].sort());
      expect(hand, `${mode} must not mutate its input`).toEqual([
        "SK", "D3", "HA", "DA", "C5", "S7", "H7", "D7",
      ]);
    }
  });

  it("leaves the dealt order exactly alone", () => {
    expect(sortHand(hand, "dealt")).toEqual(hand);
  });

  it("groups by rank first in rank order", () => {
    const sorted = sortHand(["SK", "D3", "S3"], "rank");
    expect(sorted.slice(0, 2).every((id) => id.endsWith("3"))).toBe(true);
  });

  it("pulls a complete meld to the front, contiguously, in smart order", () => {
    const sorted = sortHand(hand, "smart");
    const sevens = ["S7", "H7", "D7"].map((id) => sorted.indexOf(id)).sort((a, b) => a - b);
    expect(sevens[0], "the meld should lead").toBe(0);
    // Contiguous — a meld split across the fan is not grouped at all.
    expect(sevens[2]! - sevens[0]!).toBe(2);
  });

  it("copes with an empty hand", () => {
    expect(sortHand([], "smart")).toEqual([]);
  });
});

describe("rummy state — mandatoryMelds", () => {
  it("only returns melds containing the obligation card", () => {
    const melds = mandatoryMelds(["S7", "H7", "D7", "SJ", "SQ", "SK"], "S7");
    expect(melds.length).toBeGreaterThan(0);
    for (const m of melds) {
      expect(m).toContain("S7");
      expect(isValidMeld(m)).toBe(true);
    }
  });

  it("finds the obligation's meld even when another meld would be found first", () => {
    // The livelock this guards: `layableMelds` keeps one answer per
    // starting card, so a meld containing the obligation card can be
    // shadowed. An empty result here would leave a seat with no legal
    // action and the runtime asking it forever.
    const hand = ["SJ", "SQ", "SK", "H7", "D7", "S7"];
    expect(mandatoryMelds(hand, "S7").length).toBeGreaterThan(0);
  });

  it("is empty when the card genuinely cannot be melded", () => {
    expect(mandatoryMelds(["S7", "H2", "D9"], "S7")).toEqual([]);
  });
});
