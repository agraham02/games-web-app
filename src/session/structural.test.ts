import { describe, expect, it } from "vitest";
import { extractRound } from "./structural";

describe("extractRound", () => {
  it("reads a game's round", () => {
    expect(extractRound({ round: 4 })).toBe(4);
  });

  it("reads poker's hand count, which poker calls `hand`", () => {
    // Every poker hand was "Round 1" on the scorecard and the intro.
    expect(extractRound({ hand: 3 })).toBe(3);
  });

  it("falls back to 1 for a game with neither", () => {
    expect(extractRound({})).toBe(1);
  });
});
