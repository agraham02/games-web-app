import { describe, expect, it } from "vitest";
import { RANKS, standardDeck, type Rank } from "@/games/_shared/cards";
import {
  claimWords,
  countOfRank,
  countWord,
  handDisplayOrder,
  nextRank,
  rankOf,
  rankPlural,
  rankPluralTitle,
  turnsUntil,
} from "./cards";

describe("bs — the rank cycle", () => {
  it("walks every rank once and wraps K back to A", () => {
    let rank: Rank = RANKS[0]!;
    const seen: Rank[] = [rank];
    for (let i = 0; i < RANKS.length - 1; i++) {
      rank = nextRank(rank);
      seen.push(rank);
    }
    expect(seen).toEqual([...RANKS]);
    expect(nextRank("K")).toBe("A");
  });

  it("measures the wait for a rank from the one on the table", () => {
    expect(turnsUntil("A", "A")).toBe(0);
    expect(turnsUntil("2", "A")).toBe(1);
    // The rank that just went past is the longest wait there is, which is
    // what makes it the right card to shed. See `bots.ts`.
    expect(turnsUntil("K", "A")).toBe(12);
    expect(turnsUntil("A", "K")).toBe(1);
  });
});

describe("bs — reading a card", () => {
  it("counts a rank in a hand", () => {
    expect(countOfRank(["H7", "D7", "S2", "C7"], "7")).toBe(3);
    expect(countOfRank([], "7")).toBe(0);
  });

  it("answers null for a redacted stand-in instead of throwing", () => {
    // A bot only ever asks this of its own hand, where every id is real. A
    // slip that reached the pile should be a wrong answer, not a crash.
    expect(rankOf("??")).toBeNull();
    expect(countOfRank(["??", "H7", "??"], "7")).toBe(1);
  });
});

describe("bs — the words", () => {
  it("spells a claim out, because 3 sevens and 37 look alike", () => {
    expect(countWord(3)).toBe("three");
    expect(rankPlural("7")).toBe("sevens");
    expect(rankPlural("A")).toBe("aces");
    expect(rankPluralTitle("K")).toBe("Kings");
    // Every rank has a word; a missing one would read as "claims three 10".
    for (const rank of RANKS) expect(rankPlural(rank), rank).toMatch(/^[a-z]+$/);
  });
});

describe("bs — hand display order", () => {
  it("groups by rank, because a BS player selects by rank", () => {
    // Deliberately not the suit grouping `sortHandForDisplay` gives, which is
    // right for a trick-taking game and wrong here.
    // Within a rank the tiebreak is the app's own display suit order —
    // diamonds, clubs, hearts, spades — so there is one answer everywhere.
    const ordered = handDisplayOrder(["SK", "H2", "D2", "CA", "S2"]);
    expect(ordered).toEqual(["CA", "D2", "H2", "S2", "SK"]);
  });

  it("never loses or invents a card", () => {
    const hand = standardDeck().map((c) => c.id).slice(0, 17);
    expect([...handDisplayOrder(hand)].sort()).toEqual([...hand].sort());
  });
});

describe("claimWords", () => {
  it("agrees with its count", () => {
    // "one aces" was on screen most turns: a claim is always announced
    // with its count, and the count is one more often than not.
    expect(claimWords(1, "A")).toBe("one ace");
    expect(claimWords(2, "A")).toBe("two aces");
    expect(claimWords(1, "6")).toBe("one six");
    expect(claimWords(3, "6")).toBe("three sixes");
    expect(claimWords(1, "3")).toBe("one three");
    expect(claimWords(1, "10")).toBe("one ten");
    expect(claimWords(4, "K")).toBe("four kings");
  });

  it("has a singular for every rank", () => {
    // Derived from the plural, this is where "threes" became "thre".
    for (const rank of RANKS) {
      const one = claimWords(1, rank);
      expect(one.endsWith("s"), `${rank}: ${one}`).toBe(false);
    }
  });
});
