/**
 * Pure queries over LrcState.
 *
 * Split out from rules.ts so both rules.ts and bots.ts can import these
 * without a cycle — bots.ts needs `diceCountFor` to know how many dice
 * to roll, and rules.ts needs it too, so neither can own it.
 */

import type { PieceId, SeatId } from "@/engine/types";
import type { LrcState } from "./types";

/**
 * Seat numbering runs anticlockwise (see table/geometry.ts) — seat N+1
 * is the physical player to seat N's left, seat N-1 is to their right.
 * This is the one place that mapping matters for gameplay, not just
 * layout.
 */
function adjacentSeat(seat: SeatId, seats: number, step: 1 | -1): SeatId {
  return (seat + step + seats) % seats;
}

/**
 * A player who reaches zero chips is out for good — not just skipped
 * for turns (that was always true) but permanently unable to receive
 * chips either, per a deliberate house-rule choice for this app (the
 * printed LCR rules keep them in and let them re-enter play). Reusing
 * "holds zero chips" as the elimination test, rather than a separate
 * stored flag, is safe specifically because only the roller's OWN
 * holdings ever change mid-roll — every other seat's chip count as of
 * the state `reduce` was called with is final for this whole roll, so
 * checking it fresh for each die is exactly as correct as checking it
 * once up front.
 */
export function isEliminated(state: LrcState, seat: SeatId): boolean {
  return chipsHeld(state, seat) === 0;
}

/**
 * Where an L or R die actually sends a chip: the next seat in that
 * direction who is still in the game. Walks past eliminated seats
 * rather than landing on one — that's the mechanic that keeps "out"
 * permanent, since a chip can never reach an eliminated seat to begin
 * with. If every other seat is eliminated, the walk returns to the
 * roller themselves (nothing else to redirect to), which reads as
 * "the chip has nowhere to go" rather than an error.
 */
function passInDirection(state: LrcState, seat: SeatId, step: 1 | -1): SeatId {
  let s = seat;
  for (let i = 0; i < state.seats; i++) {
    s = adjacentSeat(s, state.seats, step);
    if (s === seat || !isEliminated(state, s)) return s;
  }
  return seat;
}

export function passLeft(state: LrcState, seat: SeatId): SeatId {
  return passInDirection(state, seat, 1);
}

export function passRight(state: LrcState, seat: SeatId): SeatId {
  return passInDirection(state, seat, -1);
}

export function chipsHeld(state: LrcState, seat: SeatId): number {
  let n = 0;
  for (const owner of Object.values(state.chipOwner)) {
    if (owner === seat) n++;
  }
  return n;
}

export function potSize(state: LrcState): number {
  let n = 0;
  for (const owner of Object.values(state.chipOwner)) {
    if (owner === "pot") n++;
  }
  return n;
}

/** Seats that currently hold at least one chip. */
export function activeSeats(state: LrcState): SeatId[] {
  const out: SeatId[] = [];
  for (let s = 0; s < state.seats; s++) {
    if (chipsHeld(state, s) > 0) out.push(s);
  }
  return out;
}

/**
 * Next seat with chips, walking anticlockwise from (but not including)
 * `from`. Never infinite-loops because the caller only calls this when
 * `isOver` is false, i.e. at least two seats hold chips.
 */
export function nextActiveSeat(state: LrcState, from: SeatId): SeatId {
  let s = from;
  for (let i = 0; i < state.seats; i++) {
    s = (s + 1) % state.seats;
    if (chipsHeld(state, s) > 0) return s;
  }
  // Unreachable under isOver's invariant, but return something valid
  // rather than throw if it's ever hit.
  return from;
}

/** How many dice `seat` would roll right now — the shared derivation
 * both the human path and every bot use before calling rollDice. */
export function diceCountFor(state: LrcState, seat: SeatId): number {
  return Math.min(chipsHeld(state, seat), 3);
}

/** This seat's own chips, oldest-held-id first — the order `reduce`
 * consumes them in when resolving a roll. Exported so bots and the
 * human path can preview it if needed (they don't have to; `reduce`
 * derives its own copy) without duplicating the sort logic. */
export function ownedChips(state: LrcState, seat: SeatId): PieceId[] {
  return Object.keys(state.chipOwner)
    .filter((id) => state.chipOwner[id] === seat)
    .sort();
}
