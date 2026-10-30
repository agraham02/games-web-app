/**
 * Chromaly state and actions.
 *
 * Two things sit outside the ordinary turn loop, both for the reason BS's
 * `window` and Rummy's `claimWindow` do: a moment where MORE THAN ONE seat
 * is entitled to act.
 *
 *   `window`     the beat after a play in which a seat may jump in on it, or
 *                catch a seat that reached its last card without calling
 *   `challenge`  a Wild +4 waiting on the player it was played at
 *
 * Neither is hero-only and neither may be resolved inline "for the bots":
 * any seat may have a person in it, so a decision that belongs to a seat
 * PARKS in state and the driver runs a bot for the seats nobody is at.
 *
 * `round`, `winner` and `result.winner` are named to match what
 * `useGameRuntime` reads STRUCTURALLY (`extractRound` / `extractWinner` /
 * `extractRoundWinner`), which buys the round card, the scorecard, the pod
 * crown and the win confetti with no per-game wiring.
 */

import type { PieceId, SeatId } from "@/engine/types";
import type { Color } from "./cards";

/** How a draw card may be answered with another. `off`: it may not. */
export type Stacking =
  | "off"
  /** A +2 on a +2, a +4 on a +4. Mattel's own "Progressive UNO". */
  | "same"
  /** Equal or higher: a +2 on a +2, a +4 on a +2 or a +4. No Mercy's rule. */
  | "upward";

/** What a Wild +4 means. */
export type PlusFour =
  /** Official: playable only with no card of the colour in force, and challengeable. */
  | "challenge"
  /** Ubisoft's No Bluffing: playable any time, and nobody may challenge it. */
  | "free"
  /** Only legal when it is honest, so there is nothing to challenge. */
  | "honest";

export interface ChromalyRules {
  /** Points to win the match. */
  target: number;
  /** Keep drawing until a card can be played. */
  drawToMatch: boolean;
  /** A drawn card that can be played must be. */
  forcePlay: boolean;
  stacking: Stacking;
  plusFour: PlusFour;
  /** An identical card may be played out of turn. */
  jumpIn: boolean;
  /** A 7 swaps hands with a seat you choose; a 0 passes every hand along. */
  sevenZero: boolean;
  /**
   * Several cards at once: two or more of a number, of Skips, or of
   * Reverses. Exactly two of a number is a Skip if their colours match and a
   * Reverse if they differ, unless `plainPairs`; Skips and Reverses each do
   * their own thing once per card.
   */
  doubles: boolean;
  /**
   * Under `doubles`, two of a number is only a way to shed cards, with no
   * Skip or Reverse (the user, 2026-10-30). Optional so a saved setup from
   * before it existed still loads.
   */
  plainPairs?: boolean;
  /** Adds the Wild Shuffle Hands card to the deck. */
  shuffleHands: boolean;
  /** How long a person gets to answer a window, in ms. */
  windowMs: number;
}

/** A pile of penalty cards the seat on turn is about to take. */
export interface PendingDraw {
  amount: number;
  /** The kind of the last draw card in the chain: what a stack may answer. */
  kind: "draw2" | "wild4";
}

/**
 * A Wild +4 the seat on turn may call a bluff on. Open only under
 * `plusFour: "challenge"`.
 */
export interface Challenge {
  offender: SeatId;
  /**
   * The colour in force when the +4 was played - what "no card of the colour"
   * is measured against. Public: everyone saw it, and it is what a bot
   * reasons from.
   */
  onColor: Color;
  /** What is at stake: the whole chain's penalty, +4 included. */
  amount: number;
  /**
   * Did the offender hold a card of the colour in force? Worked out at play
   * time from the real hands and NEVER sent: `playerView` blanks it, since
   * it is the whole answer to the challenge.
   */
  guilty: boolean;
}

/**
 * The beat after a play. Open until somebody takes it, every seat has let it
 * go, or time runs out; nothing else may happen meanwhile.
 *
 * Two different things share it because they can both be true of one play
 * (a seat reaches its last card with a card somebody could jump in on), and
 * two windows at once would be two races over one table.
 */
export interface Window {
  /** New with every window: what a deadline's key is built from. */
  id: number;
  /**
   * The seat whose play opened it. Public (everybody watched it play), and
   * what the table keeps lit while the window is open, so the glow does not
   * walk round the answering queue and give away who holds what.
   */
  by: SeatId;
  /** The card a jump-in must match, when one may be jumped in on. */
  card: PieceId | null;
  /**
   * Seats holding that card. PRIVATE: `playerView` shows each viewer only
   * themselves, because who holds the twin is a read on somebody's hand.
   */
  jumpers: SeatId[];
  /** Seats on their last card who have not called it. Public: it is a count and a flag. */
  offenders: SeatId[];
  /**
   * Every seat that has yet to answer, with its reaction time in ms, soonest
   * first. This is what makes it a RACE rather than a queue, as in BS: all
   * of them are entitled at once, `currentSeat` names the soonest, and a
   * person three deep can still beat the bot at the front.
   *
   * Only the seats it concerns are listed (the jumpers; everybody once a
   * seat is on its last card), and the other seats' entries are hidden from
   * a viewer for the same reason `jumpers` is.
   */
  pending: ReadonlyArray<{ seat: SeatId; ms: number }>;
  /** The reaction time of the last seat to answer, in ms from the window opening. */
  elapsed?: number;
}

export interface RoundResult {
  /** Points won by the seat that went out; 0 for everyone else. */
  deltas: Record<SeatId, number>;
  cardsLeft: Record<SeatId, number>;
  /** Who went out, or null when the backstop ended the round. */
  wentOut: SeatId | null;
  /** True when the backstop ended it rather than a player. */
  blocked: boolean;
  /** Who took the round — what the pod crown reads. */
  winner: SeatId;
}

export interface ChromalyState {
  seats: number;
  rules: ChromalyRules;
  round: number;
  dealer: SeatId;
  /** False before a round's deal. */
  dealt: boolean;
  /**
   * What shuffles made inside `reduce` are seeded from, so that a reshuffled
   * draw pile cannot be worked out from the public discard. Never sent.
   */
  secret: number;
  /** How many times the draw pile has been rebuilt this round. */
  reshuffles: number;

  /** Who plays next. */
  turn: SeatId;
  /** 1 is clockwise (seat numbers rising), -1 anticlockwise. */
  direction: 1 | -1;
  /** The colour in force: the top card's, or the one a wild named. */
  color: Color;

  hands: Record<SeatId, PieceId[]>;
  /** Undealt cards, next to draw LAST. Never sent. */
  drawPile: PieceId[];
  /** Played cards, the top last. */
  discard: PieceId[];

  /** A card the seat on turn has just drawn and may play or keep. */
  drawn: PieceId | null;
  pendingDraw: PendingDraw | null;
  challenge: Challenge | null;
  window: Window | null;
  windowCount: number;
  /**
   * A 7 jumped in with, whose player is still choosing who to swap hands
   * with. The tap on the card is the claim (the user, 2026-10-30): a window's
   * clock must never run out on somebody who has already jumped, so the 7
   * goes down at once and the choice comes after, with the table waiting on
   * it. Public. Optional so a state from before it existed still loads.
   */
  swapping?: { seat: SeatId; card: PieceId } | null;

  /**
   * Who has called their last card. `called` is said out loud and shown;
   * `passed` is a seat that got through a window uncaught, which is why it
   * cannot be caught afterwards and is never shown as a call.
   */
  calls: Record<SeatId, "called" | "passed">;

  scores: Record<SeatId, number>;
  /** Plays this round — the backstop's clock. */
  plays: number;

  /**
   * Colours a seat has drawn on, most recent last: it had no card of the
   * colour in force. Public (everybody saw them draw), and the one thing a
   * bot can read about an opponent's hand. See the bots.
   */
  misses: Record<SeatId, Color[]>;

  /**
   * The colour each wild still on the discard pile named, so the card can
   * wear it (`Placement.tint`) - including one already covered, whose edge
   * still shows. Public: the whole table saw it named. Optional so a state
   * from before it existed still loads.
   */
  named?: Record<PieceId, Color>;

  result: RoundResult | null;
  winner: SeatId | null;
}

export type ChromalyAction =
  /**
   * One card, or several under `doubles`: the last is the top of the pile.
   * `color` only for a wild; `swapWith` only for a 7 under `sevenZero`;
   * `call` says the last card as it goes down (a bot's way of doing what a
   * person does by pressing the button first).
   */
  | { t: "play"; cards: PieceId[]; color?: Color; swapWith?: SeatId; call?: boolean }
  /** Take a card (or, with draw-to-match, as many as it takes). */
  | { t: "draw" }
  /** Keep the card just drawn and end the turn. */
  | { t: "keep" }
  /** Take the penalty cards rather than answer them. */
  | { t: "acceptPenalty" }
  /** Call a Wild +4 a bluff. */
  | { t: "challenge" }
  /**
   * Say "last card" — on two cards, ahead of the play; or, in a window,
   * either to save yourself (you are the one on a last card) or to catch
   * whoever is.
   *
   * The three below name their seat, unlike the actions above, because a
   * window entitles SEVERAL seats at once. Never trusted from a client:
   * `completeAction` overwrites the seat with the one the session knows
   * submitted.
   */
  | { t: "callLast"; seat: SeatId }
  | { t: "jumpIn"; seat: SeatId; card: PieceId; swapWith?: SeatId }
  | { t: "declineWindow"; seat: SeatId }
  /** Who a jumped-in 7 swaps hands with (see `swapping`). Seat stamped, like the window's. */
  | { t: "chooseSwap"; seat: SeatId; with: SeatId }
  /** Time is up: the window is over for everybody. */
  | { t: "closeWindow" };
