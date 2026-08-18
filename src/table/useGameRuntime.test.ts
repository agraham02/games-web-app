import { describe, expect, it } from "vitest";
import { resolveRoundWinningSeats } from "./useGameRuntime";

/**
 * `roundWinningSeats` was added for Caribbean dominoes' team mode — the
 * first partnership game in this app that scores a WHOLE ROUND, so the
 * first where a per-round crown has to land on two pods instead of one.
 *
 * The thing actually worth proving is the negative: that adding it
 * changed nothing for the four games that came before it. Everything
 * else here is structural reads on a state shape the runtime does not
 * own, so a silent behaviour change would not show up as a type error.
 */

describe("resolveRoundWinningSeats", () => {
  it("is null when there is no round result at all — LRC's shape", () => {
    // LRC has no rounds, so `result` is never set. The crown must stay
    // keyed off the match winner alone there.
    expect(resolveRoundWinningSeats({})).toBeNull();
    expect(resolveRoundWinningSeats({ result: null })).toBeNull();
  });

  it("wraps a single winner when the game names no side", () => {
    // Every pre-existing round-scoring game: `result.winner` and nothing
    // more. `includes(seat)` against this has to be identical to the
    // `=== roundWinner` check GameHost used to do.
    expect(resolveRoundWinningSeats({ result: { winner: 2 } })).toEqual([2]);
    expect(resolveRoundWinningSeats({ result: { winner: 0 } })).toEqual([0]);
  });

  it("is null when a round genuinely had no winner", () => {
    // A blocked, tied dominoes round. Nobody is crowned.
    expect(resolveRoundWinningSeats({ result: { winner: null } })).toBeNull();
  });

  it("prefers an explicit side when the game names one", () => {
    expect(
      resolveRoundWinningSeats({ result: { winner: 2, winningSeats: [0, 2] } }),
    ).toEqual([0, 2]);
  });

  it("trusts an explicit empty side over the single-winner fallback", () => {
    // A game saying "nobody's side won" must not be second-guessed into
    // crowning `winner` anyway — the array is present, so it wins.
    expect(resolveRoundWinningSeats({ result: { winner: 2, winningSeats: [] } })).toEqual([]);
  });

  it("falls back when the field is present but not an array", () => {
    expect(
      resolveRoundWinningSeats({ result: { winner: 1, winningSeats: null } }),
    ).toEqual([1]);
  });
});
