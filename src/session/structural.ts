/**
 * Structural reads over an opaque game state.
 *
 * `GameDefinition` deliberately requires only `isOver` and `currentSeat`
 * as turn-level signals — "who won" is not part of the contract, because
 * not every game has a single winner and a game with no rounds has no
 * round number. Games that DO have them put the answer on their own
 * state, and these read it back by shape rather than forcing every
 * definition to grow a method for the one game that needs it.
 *
 * Lifted out of `useGameRuntime` when the loop moved into `GameSession`:
 * they are pure, they answer questions the SERVER needs to answer too
 * (a frame reports the winner), and they were never React-coupled to
 * begin with. `useGameRuntime` re-exports `resolveRoundWinningSeats` so
 * its existing test keeps its import path.
 */

import type { SeatId } from "@/engine/types";

export function extractWinner<S>(state: S): SeatId | null {
  const maybe = state as unknown as { winner?: SeatId | null };
  return typeof maybe.winner === "number" ? maybe.winner : null;
}

/** Reads `state.winningSeats` if a game sets it (Spades' team win). */
export function extractWinningSeats<S>(state: S): SeatId[] | null {
  const maybe = state as unknown as { winningSeats?: SeatId[] | null };
  return Array.isArray(maybe.winningSeats) ? maybe.winningSeats : null;
}

/**
 * Prefers the structural multi-seat field, falling back to wrapping the
 * single `winner` — so a game that never sets `winningSeats` produces an
 * IDENTICAL truth table through `.includes()` to what `=== winner` gave.
 */
export function resolveWinningSeats<S>(state: S): SeatId[] | null {
  const structural = extractWinningSeats(state);
  if (structural) return structural;
  const single = extractWinner(state);
  return single !== null ? [single] : null;
}

/** For a scorecard heading. Defaults to 1 for a round-less game. */
export function extractRound<S>(state: S): number {
  const maybe = state as unknown as { round?: number };
  return typeof maybe.round === "number" ? maybe.round : 1;
}

export function extractRoundWinner<S>(state: S): SeatId | null {
  const maybe = state as unknown as { result?: { winner?: SeatId | null } | null };
  const winner = maybe.result?.winner;
  return typeof winner === "number" ? winner : null;
}

/**
 * The round-level twin of `resolveWinningSeats` — same precedence, same
 * fallback, so a game that sets neither field behaves exactly as before.
 *
 * Exported separately so that equivalence can be pinned by a test without
 * standing up the whole runtime: the claim worth proving is that adding
 * this changed nothing for the four games that came before it, and that
 * is a property of this function alone.
 */
export function resolveRoundWinningSeats<S>(state: S): SeatId[] | null {
  const maybe = state as unknown as { result?: { winningSeats?: SeatId[] | null } | null };
  const structural = maybe.result?.winningSeats;
  if (Array.isArray(structural)) return structural;
  const single = extractRoundWinner(state);
  return single !== null ? [single] : null;
}
