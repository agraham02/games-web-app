/**
 * Pure queries over PokerState — turn order, side pots, positions.
 *
 * Split out from rules.ts the same way LRC's state.ts is: rules.ts and
 * bots.ts both need these, and neither should own them.
 *
 * Seat numbering runs anticlockwise (table/geometry.ts) — seat N+1 is
 * the physical player to seat N's left, which is the direction every
 * "next to act" walk below moves in.
 */

import type { PieceId, SeatId } from "@/engine/types";
import type { HandValue } from "./hand";
import { compareHandValues } from "./hand";
import type { PokerState, PokerStreet, PotLayer } from "./types";

export const MIN_SEATS = 2;
export const MAX_SEATS = 10;

/* ============================================================
   Seat walks
   ============================================================ */

/** Every seat, starting AT `from` (inclusive), walking anticlockwise
 * once around the table. */
function seatOrderFromInclusive(from: SeatId, seats: number): SeatId[] {
  return Array.from({ length: seats }, (_, i) => (from + i) % seats);
}

/** Every seat, starting immediately LEFT of `from` (exclusive), walking
 * anticlockwise once around — the shape both "first to act postflop"
 * and "first eligible seat for an odd chip" need. */
export function seatOrderAfter(from: SeatId, seats: number): SeatId[] {
  return seatOrderFromInclusive((from + 1) % seats, seats);
}

function nextInList(list: readonly SeatId[], from: SeatId, seats: number): SeatId {
  const set = new Set(list);
  let s = from;
  for (let i = 0; i < seats; i++) {
    s = (s + 1) % seats;
    if (set.has(s)) return s;
  }
  return from;
}

/* ============================================================
   Who is in this hand
   ============================================================ */

/** Every seat dealt into the CURRENT hand — `folded`'s keys are set once,
 * for exactly the live-at-deal-time seats, at the top of `startRound`,
 * and never gain or lose members for the rest of the hand's lifetime.
 * Safe to read at any point in the hand, including while `startRound`
 * is still assembling the rest of the state. */
export function dealtSeats(state: Pick<PokerState, "folded">): SeatId[] {
  return Object.keys(state.folded)
    .map(Number)
    .sort((a, b) => a - b);
}

export function isHeadsUp(state: Pick<PokerState, "folded">): boolean {
  return dealtSeats(state).length === 2;
}

/** Still eligible to WIN a pot layer this hand: dealt in and not folded
 * — includes an all-in seat, who cannot act further but can still win. */
export function contestingSeats(state: PokerState): SeatId[] {
  return dealtSeats(state).filter((s) => !state.folded[s]);
}

/** Can still voluntarily ACT this street: dealt in, not folded, and
 * holds more than 0 chips. An all-in seat has nothing left to bet and is
 * excluded, though it stays eligible for the pot via `contestingSeats`. */
export function actableSeats(state: PokerState): SeatId[] {
  return dealtSeats(state).filter((s) => !state.folded[s] && (state.stacks[s] ?? 0) > 0);
}

/** True only BETWEEN hands — mid-hand, a 0 stack usually means all-in,
 * not busted (see `isAllIn`). Read this at the top of `startRound`,
 * never mid-hand. */
export function liveMatchSeats(state: Pick<PokerState, "seats" | "stacks">): SeatId[] {
  const out: SeatId[] = [];
  for (let s = 0; s < state.seats; s++) if ((state.stacks[s] ?? 0) > 0) out.push(s);
  return out;
}

/** Dealt in, not folded, holds 0 chips — genuinely all-in for this hand,
 * not merely between-hands busted (see the caution on `stacks` above). */
export function isAllIn(state: PokerState, seat: SeatId): boolean {
  return seat in state.folded && !state.folded[seat] && (state.stacks[seat] ?? 0) === 0;
}

/* ============================================================
   Blinds and the dealer button
   ============================================================ */

/** Pure, list-based form — used by `startRound` to derive blind seats
 * BEFORE `folded` has been committed to a draft state object. */
export function smallBlindOf(button: SeatId, dealt: readonly SeatId[], seats: number): SeatId {
  // Heads-up: the button IS the small blind — the one real inversion
  // this game has, and only for who POSTS it; postflop action order
  // (seatOrderAfter(button)) already produces the correct "big blind
  // acts first postflop" result with no extra branching.
  if (dealt.length === 2) return button;
  return nextInList(dealt, button, seats);
}

export function bigBlindOf(button: SeatId, dealt: readonly SeatId[], seats: number): SeatId {
  return nextInList(dealt, smallBlindOf(button, dealt, seats), seats);
}

export function smallBlindSeat(state: PokerState): SeatId {
  return smallBlindOf(state.button, dealtSeats(state), state.seats);
}

export function bigBlindSeat(state: PokerState): SeatId {
  return bigBlindOf(state.button, dealtSeats(state), state.seats);
}

/** Next LIVE-MATCH seat past `from`, skipping busted seats — the same
 * walk LRC's `passInDirection` does for its own elimination. Used to
 * rotate the button each hand. */
export function nextButton(state: Pick<PokerState, "seats" | "stacks">, from: SeatId): SeatId {
  return nextInList(liveMatchSeats(state), from, state.seats);
}

/**
 * A single badge for a seat pod: dealer takes priority, then blinds.
 * Heads-up deliberately shows just `"D"` for the button (which is also
 * the small blind) rather than a combined "D/SB" tag — real tables mark
 * it with one disc, and a second seat still reads unambiguously as the
 * big blind.
 */
export function positionBadge(state: PokerState, seat: SeatId): "D" | "SB" | "BB" | null {
  if (!(seat in state.folded)) return null;
  if (seat === state.button) return "D";
  if (seat === smallBlindSeat(state)) return "SB";
  if (seat === bigBlindSeat(state)) return "BB";
  return null;
}

/* ============================================================
   Street and turn order
   ============================================================ */

export function deriveStreet(state: Pick<PokerState, "communityOrder">): PokerStreet {
  const n = state.communityOrder.length;
  if (n >= 5) return "river";
  if (n === 4) return "turn";
  if (n === 3) return "flop";
  return "preflop";
}

/**
 * PREFLOP first-to-act order. 3+-handed: UTG (the seat after the big
 * blind) first. Heads-up inverts this — the button (== small blind)
 * acts first, the one place this game's turn order genuinely differs by
 * seat count. Postflop needs no equivalent branch — see `postflopOrder`.
 */
export function preflopOrder(state: PokerState): SeatId[] {
  const eligible = new Set(actableSeats(state));
  const order = isHeadsUp(state)
    ? seatOrderFromInclusive(state.button, state.seats)
    : seatOrderAfter(bigBlindSeat(state), state.seats);
  return order.filter((s) => eligible.has(s));
}

/** POSTFLOP first-to-act order for any street: the first live seat
 * immediately left of the button. This single rule already produces the
 * correct heads-up result too (the only other seat, i.e. the big blind,
 * acts first postflop) with no special case. */
export function postflopOrder(state: PokerState): SeatId[] {
  const eligible = new Set(actableSeats(state));
  return seatOrderAfter(state.button, state.seats).filter((s) => eligible.has(s));
}

export function toActForStreet(state: PokerState, street: PokerStreet): SeatId[] {
  return street === "preflop" ? preflopOrder(state) : postflopOrder(state);
}

/* ============================================================
   Betting amounts
   ============================================================ */

function highestStreetCommitted(state: PokerState): number {
  return Math.max(0, ...Object.values(state.streetCommitted));
}

export function amountToCall(state: PokerState, seat: SeatId): number {
  return Math.max(0, highestStreetCommitted(state) - (state.streetCommitted[seat] ?? 0));
}

/**
 * The [min, max] TOTAL `streetCommitted` a bet/raise may bring this
 * seat's commitment to. `max` is always their whole remaining stack
 * (an all-in shove); `min` is a full bet/raise, clamped down to `max`
 * when the seat can't afford one — their only legal bet-shaped action
 * is then to shove for less than a full raise.
 */
export function betRange(state: PokerState, seat: SeatId): { min: number; max: number } {
  const already = state.streetCommitted[seat] ?? 0;
  const max = already + (state.stacks[seat] ?? 0);
  const highest = highestStreetCommitted(state);
  const minTo = highest === 0 ? state.bigBlind : highest + state.lastRaiseSize;
  return { min: Math.min(max, minTo), max };
}

export function potTotal(state: PokerState): number {
  return Object.values(state.totalCommitted).reduce((n, v) => n + v, 0);
}

/* ============================================================
   Cards
   ============================================================ */

/** This seat's 2 hole card ids, sorted for a stable, testable order. */
export function seatHoleCards(state: PokerState, seat: SeatId): PieceId[] {
  return Object.entries(state.cardOwner)
    .filter(([, owner]) => owner === seat)
    .map(([id]) => id)
    .sort();
}

/* ============================================================
   Side pots
   ============================================================ */

/**
 * Layers the pot by distinct contribution level. A layer with exactly
 * one eligible (non-folded) seat pays it outright at award time —
 * arithmetically identical to refunding an uncalled excess, so that is
 * not a separate rule here, it falls out for free.
 */
export function computePots(
  totalCommitted: Record<SeatId, number>,
  folded: Record<SeatId, boolean>,
): PotLayer[] {
  const seats = Object.keys(totalCommitted).map(Number);
  const levels = [...new Set(seats.map((s) => totalCommitted[s] ?? 0).filter((n) => n > 0))].sort(
    (a, b) => a - b,
  );
  const layers: PotLayer[] = [];
  let prev = 0;
  for (const level of levels) {
    const covering = seats.filter((s) => (totalCommitted[s] ?? 0) >= level);
    const amount = (level - prev) * covering.length;
    if (amount > 0) {
      layers.push({ amount, eligible: covering.filter((s) => !folded[s]) });
    }
    prev = level;
  }
  return layers;
}

/**
 * Pays every layer to its best eligible hand(s), splitting a tie evenly
 * and handing any remainder chip(s) one at a time to tied winners in
 * seat order starting immediately left of the button (the standard
 * odd-chip rule). Independent per layer, so a main pot and a side pot
 * can split differently and both resolve correctly.
 */
export function awardPots(
  layers: readonly PotLayer[],
  bestHand: (seat: SeatId) => HandValue,
  button: SeatId,
  seats: number,
): { deltas: Record<SeatId, number>; winningSeats: SeatId[] } {
  const deltas: Record<SeatId, number> = {};
  const winningSeats = new Set<SeatId>();
  const award = (seat: SeatId, amount: number) => {
    deltas[seat] = (deltas[seat] ?? 0) + amount;
  };

  for (const layer of layers) {
    if (layer.eligible.length === 0) continue; // Defensive: unreachable by construction.
    if (layer.eligible.length === 1) {
      award(layer.eligible[0]!, layer.amount);
      winningSeats.add(layer.eligible[0]!);
      continue;
    }
    let best: SeatId[] = [layer.eligible[0]!];
    let bestValue = bestHand(layer.eligible[0]!);
    for (const seat of layer.eligible.slice(1)) {
      const value = bestHand(seat);
      const cmp = compareHandValues(value, bestValue);
      if (cmp > 0) {
        best = [seat];
        bestValue = value;
      } else if (cmp === 0) {
        best.push(seat);
      }
    }
    const per = Math.floor(layer.amount / best.length);
    const remainder = layer.amount % best.length;
    const ordered = seatOrderAfter(button, seats).filter((s) => best.includes(s));
    ordered.forEach((s, i) => award(s, per + (i < remainder ? 1 : 0)));
    best.forEach((s) => winningSeats.add(s));
  }

  return { deltas, winningSeats: [...winningSeats] };
}
