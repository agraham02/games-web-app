/**
 * Mind Meld constants and pure queries over a position. No `reduce` here.
 */

import { hashString } from "@/engine/rng";
import type { SeatId } from "@/engine/types";
import type { MindMeldRules, MindMeldState, Pair } from "./types";

export const MIN_SEATS = 2;
/** Ten seats: five pairs, the most any game here seats. */
export const MAX_SEATS = 10;
export const SEAT_STEP = 2;
export const DEFAULT_SEATS = 4;

export const ROUNDS_MIN = 1;
export const ROUNDS_MAX = 9;
export const DEFAULT_ROUNDS = 5;
export const DEFAULT_TRIES = 10;
export const TRIES_CHOICES = [8, 10, 15] as const;
export const THINK_CHOICES = [0, 30, 60, 90] as const;

export const DEFAULT_RULES: MindMeldRules = {
  rounds: DEFAULT_ROUNDS,
  tries: DEFAULT_TRIES,
  thinkSeconds: 0,
  start: "free",
  showLast: false,
  familySafe: true,
};

/** How much longer the DRIVER waits than the clock a player is shown. */
export const THINK_GRACE_MS = 900;

/**
 * With no think time set, a table still must not be parked for ever by a
 * person who has walked away. Long enough that nobody who is there will meet
 * it, and what an idle room's seat is handed to a bot by.
 */
export const BACKSTOP_MS = 10 * 60 * 1000;

/** A bot never has a word sooner than this, in ms from the try opening... */
export const BOT_MIN_MS = 2_500;
/** ...nor later than this. Wide on purpose: two bots never lock together. */
export const BOT_MAX_MS = 8_000;

/** The beat between one seat's lock-in and the next's. */
export const LOCK_BEAT_MS = 150;

/** The pair a seat belongs to: partners sit side by side, 0 and 1, 2 and 3. */
export function pairIndexOf(seat: SeatId): number {
  return Math.floor(seat / 2);
}

export function partnerOf(seat: SeatId): SeatId {
  return (seat % 2 === 0 ? seat + 1 : seat - 1) as SeatId;
}

/** Seats are always pairs: odd counts round up, which is where a bot comes in. */
export function evenSeats(seats: number): number {
  const clamped = Math.min(MAX_SEATS, Math.max(MIN_SEATS, Math.round(seats)));
  return clamped % 2 === 0 ? clamped : Math.min(MAX_SEATS, clamped + 1);
}

/** What a meld on this try is worth: ten for the first, one for the tenth and after. */
export function pointsFor(tries: number): number {
  return Math.max(1, 11 - tries);
}

/** A pair still in the round: not melded, and with tries left. */
export function isActive(pair: Pair, rules: MindMeldRules): boolean {
  return pair.meldedOn === null && pair.tries < rules.tries;
}

/** The pair this seat is in. */
export function pairOf(state: MindMeldState, seat: SeatId): Pair | undefined {
  return state.pairs[pairIndexOf(seat)];
}

/** The last two words said, which the next try bridges; none before two are said. */
export function lastTwo(pair: Pair): [string, string] | null {
  const n = pair.chain.length;
  return n >= 2 ? [pair.chain[n - 2]!, pair.chain[n - 1]!] : null;
}

/** How long a bot takes to think of a word this try, in ms. Hashed, so a seed replays it. */
export function botMs(state: MindMeldState, seat: SeatId): number {
  const span = BOT_MAX_MS - BOT_MIN_MS + 1;
  return BOT_MIN_MS + (hashString(`mindmeld|${state.round}|${state.tryNo}|${seat}`) % span);
}
