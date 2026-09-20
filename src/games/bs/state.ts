/**
 * BS constants and pure queries over a position. No `reduce` here.
 */

import { hashString } from "@/engine/rng";
import type { PieceId, SeatId } from "@/engine/types";
import type { BsState, PilePlay } from "./types";

export const MIN_SEATS = 2;
/**
 * Six, not ten. The whole deck is dealt, so a seventh seat means seven
 * cards each and a round that is over before the rank cycle has been round
 * once — and the bluffing only starts once a hand is big enough that
 * nobody can account for it.
 */
export const MAX_SEATS = 6;
export const DECK_SIZE = 52;

/** Four of a rank exist, so nobody can ever honestly claim a fifth. */
export const MAX_PER_PLAY = 4;

/** Round wins needed to take the match, by default. */
export const DEFAULT_TARGET = 3;

/**
 * How long a person gets to answer a window, alone against bots.
 *
 * The table really is waiting on them here: bots let a play go in a
 * couple of hundred milliseconds, so this number is the entire beat
 * between one play and the next. The "let it go" chip is what keeps that
 * from being five seconds forty times a round.
 */
export const CHALLENGE_MS_SOLO = 5000;

/**
 * And in a room. Longer, because the next player can end it early simply
 * by playing — so a generous window costs nobody anything except the
 * person who chooses to use all of it.
 */
export const CHALLENGE_MS_ONLINE = 10000;

/**
 * How much longer the DRIVER waits than the ring a player is watching.
 *
 * Deliberately not tuned to fire together. The client's own countdown
 * should resolve an ordinary window, and it is the thing that feels fair
 * because it is running on the machine the player is looking at. The
 * driver's timer is a backstop for a client whose timers are throttled to
 * about one a minute in a backgrounded tab. If the two fired at the same
 * moment, a buzzer-beater call would be a coin toss decided by latency.
 */
export const CHALLENGE_GRACE_MS = 900;

/**
 * The beat between one seat's answer to a window and the next seat's.
 *
 * Small, and handed to the driver through `GameDefinition.turnHold`: a
 * seat that lets a play go produces no events at all, so at the ordinary
 * 900ms a table of three opponents spent nearly three seconds showing
 * nothing after every single play. At this pace the same sequence reads as
 * a flicker of eyes around the table, which is what it is — each seat's
 * pod lights as its turn comes round, for free, via `seatCue`.
 */
export const WINDOW_BEAT_MS = 120;

/** The beat before the loser picks the pile up, once the verdict is in. */
export const TAKE_BEAT_MS = 500;

/**
 * How long the reveal stays up before the pile is swallowed, for a seat
 * with a PERSON in it. Nobody is deciding anything here — this is the
 * driver acting on their behalf so a table never waits on a player to
 * acknowledge bad news, the same way Rummy auto-passes an unanswered
 * claim.
 */
export const REVEAL_HOLD_MS = 1400;

/**
 * Reaction-time bounds for the challenge race, in ms.
 *
 * Every entitled seat draws one and the list is sorted by it, so who gets
 * the first look is chance rather than seat order. The spread is wide on
 * purpose: a narrow one would mean the fastest seat is effectively always
 * whoever happens to be earliest, and a person would never get in first.
 */
export const REACTION_MIN = 220;
export const REACTION_MAX = 1800;

/**
 * Plays without the total cards held reaching a new low before a round is
 * declared stuck. See `BsState.noProgressStreak` for why a round can need
 * this at all.
 */
export const NO_PROGRESS_LIMIT = 120;

export function nextSeat(seats: number, seat: SeatId): SeatId {
  return ((seat + 1) % seats) as SeatId;
}

/** Every card on the pile, oldest first. */
export function pileCardsOf(plays: readonly PilePlay[]): PieceId[] {
  return plays.flatMap((p) => p.cards);
}

export function pileSize(state: BsState): number {
  return state.plays.reduce((n, p) => n + p.cards.length, 0);
}

/** The play a window is open on, if one is. */
export function livePlay(state: BsState): PilePlay | null {
  if (!state.window) return null;
  return state.plays[state.window.play] ?? null;
}

/** Is this seat still able to call BS on the play on the table? */
export function entitledToCall(state: BsState, seat: SeatId): boolean {
  if (state.pendingTake !== null) return false;
  return state.window?.pending.some((p) => p.seat === seat) ?? false;
}

/** Alias that reads better at a call site asking about the UI. */
export function inChallengeWindow(state: BsState, seat: SeatId): boolean {
  return entitledToCall(state, seat);
}

/**
 * How long this seat's ring should run for, in ms.
 *
 * Simply the table's window: see `ChallengeWindow.pending` for why this is
 * not shortened by a rival's reaction the way Rummy's claim deadline is.
 */
export function challengeDeadlineMs(state: BsState): number {
  return state.windowMs;
}

export function handTotalOf(hands: Record<SeatId, PieceId[]>, seats: number): number {
  let total = 0;
  for (let seat = 0; seat < seats; seat++) total += (hands[seat as SeatId] ?? []).length;
  return total;
}

/** The smallest hand at the table other than this seat's. */
export function nearestRivalCount(state: BsState, seat: SeatId): number {
  let best = Number.POSITIVE_INFINITY;
  for (let s = 0; s < state.seats; s++) {
    if (s === seat) continue;
    best = Math.min(best, (state.hands[s as SeatId] ?? []).length);
  }
  return Number.isFinite(best) ? best : 0;
}

/**
 * Who is watching the play that just landed, and how quickly each of them
 * reacts — sorted soonest first.
 *
 * Hashed from the position rather than drawn from an `Rng`, because
 * `reduce(state, action)` receives none by design. The key names
 * everything that makes this play unique, so a seed replays a match's
 * races exactly as it replays its deals. See `hashString`.
 */
export function challengeReactions(
  state: BsState,
  claimer: SeatId,
  play: PilePlay,
  playIndex: number,
): Array<{ seat: SeatId; ms: number }> {
  const key = `bs|${state.round}|${playIndex}|${claimer}|${play.claimed}|${play.cards.join(",")}`;
  const span = REACTION_MAX - REACTION_MIN + 1;
  const out: Array<{ seat: SeatId; ms: number }> = [];
  for (let s = 0; s < state.seats; s++) {
    const seat = s as SeatId;
    if (seat === claimer) continue;
    out.push({ seat, ms: REACTION_MIN + (hashString(`${key}|${seat}`) % span) });
  }
  // Ties broken by seat so the order is total, not merely sorted — an
  // unstable order here would mean two identical positions could resolve
  // the same race differently, which is the one thing seeding is for.
  out.sort((a, b) => a.ms - b.ms || a.seat - b.seat);
  return out;
}
