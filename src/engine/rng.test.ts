import { describe, expect, it } from "vitest";
import { createRng } from "./rng";
import { shuffledDeck, standardDeck } from "@/games/_shared/cards";

describe("createRng", () => {
  it("is fully deterministic for a seed", () => {
    const a = createRng(12345);
    const b = createRng(12345);
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("produces different streams for different seeds", () => {
    const a = createRng(1);
    const b = createRng(2);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it("stays in range", () => {
    const rng = createRng(99);
    for (let i = 0; i < 500; i++) {
      const f = rng.next();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      expect(rng.int(52)).toBeLessThan(52);
    }
  });

  it("rejects a non-positive bound instead of returning NaN", () => {
    expect(() => createRng(1).int(0)).toThrow(RangeError);
  });

  it("refuses to pick from an empty array", () => {
    expect(() => createRng(1).pick([])).toThrow(RangeError);
  });

  it("shuffles without mutating, losing or duplicating cards", () => {
    const rng = createRng(2026);
    const deck = standardDeck();
    const before = deck.map((c) => c.id);
    const shuffled = rng.shuffle(deck);

    expect(deck.map((c) => c.id)).toEqual(before); // input untouched
    expect(shuffled).toHaveLength(52);
    expect(new Set(shuffled.map((c) => c.id)).size).toBe(52);
    expect(shuffled.map((c) => c.id)).not.toEqual(before);
  });

  it("deals the same hand from the same seed — the whole point", () => {
    const one = shuffledDeck(createRng(777)).map((c) => c.id);
    const two = shuffledDeck(createRng(777)).map((c) => c.id);
    expect(one).toEqual(two);
  });
});

describe("standardDeck", () => {
  it("is 52 unique cards", () => {
    const deck = standardDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map((c) => c.id)).size).toBe(52);
  });
});
