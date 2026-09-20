/**
 * BS (Cheat, I Doubt It) state and actions.
 *
 * Two fields sit outside the ordinary turn loop, and both exist for the
 * same reason Rummy's `claimWindow` does — a moment where MORE THAN ONE
 * seat is entitled to act:
 *
 *   `window`      the play just made, open to a challenge from anyone
 *   `pendingTake` the pile waiting to be swallowed by whoever lost
 *
 * Neither is hero-only, and neither may be resolved inline for "the
 * bots". That was the single mistake that kept Rummy out of online play
 * for so long: any seat may have a person in it, so a decision that
 * belongs to a seat has to PARK in state and let the driver run a bot for
 * the seats nobody is at.
 *
 * `round`, `winner` and `result.winner` are named to match what
 * `useGameRuntime` reads STRUCTURALLY (`extractRound` / `extractWinner` /
 * `extractRoundWinner`) — that naming alone buys the round intro card,
 * the round-end scorecard, the pod crown and the hero-win confetti with
 * no per-game wiring.
 */

import type { PieceId, SeatId } from "@/engine/types";
import type { Rank } from "@/games/_shared/cards";

/** One claim: the cards that went down, and what they were said to be. */
export interface PilePlay {
  seat: SeatId;
  claimed: Rank;
  /**
   * What actually went down. Redacted to stand-ins by `playerView` for
   * every viewer but the player who put them there — see there for why
   * this is the one collection in the game nobody else may identify.
   */
  cards: PieceId[];
}

/**
 * The play on the table that anyone may still call BS on.
 *
 * Open from the moment the cards land until either somebody calls, every
 * entitled seat has let it go, or the next player plays over the top of
 * it. That last one is why `legalActions` hands the seat on turn its plays
 * while this is set: a window must never be able to hold up the table, and
 * the most natural thing that ends one is the game simply moving on.
 */
export interface ChallengeWindow {
  /** Index into `plays` of the challengeable play. */
  play: number;
  /**
   * Every entitled seat with its reaction time in ms, soonest first. A
   * seat leaves the moment it calls or lets it go; when the list empties,
   * the play stands.
   *
   * This is the field that makes the challenge a RACE rather than a
   * queue, and it carries no opinion at all about who is sitting in any
   * of these seats. A seat nobody is at is played by its bot and spends
   * its reaction time as a `think`; a seat with a person in it is offered
   * the window and races the clock. `currentSeat` names the soonest,
   * which is who the PACING waits on, and `legalActions` entitles ALL of
   * them — so a person three deep in this list can still beat the bot at
   * the front by being quick, which is the entire mechanic.
   *
   * The times live in STATE rather than in a page because they decide who
   * wins, and that has to replay from a seed like everything else here.
   * `reduce` gets no rng, so they are hashed from the position instead —
   * see `challengeReactions`.
   *
   * Unlike Rummy's claim race, a person's own deadline is NOT capped by
   * the fastest rival's reaction: the seats ahead of them in this list
   * have already had their turn by the time they get theirs, and capping
   * would hand a player 250ms to answer a window that opens after every
   * single play. Being beaten to it happens by being further down the
   * list, not by running out of a shortened clock.
   */
  pending: ReadonlyArray<{ seat: SeatId; ms: number }>;
}

/**
 * A resolved challenge, held while the table reads the verdict.
 *
 * It has to survive into the state `reduce` returns, not merely ride along
 * as events, because `placements` is the authority for FACING: the
 * revealed cards are face up to EVERYONE, and if the settled position
 * said otherwise the redaction layer would quite correctly send them out
 * as anonymous backs and the reveal would be four blank cards. Which is
 * also why taking the pile is its own action — see `pendingTake`.
 */
export interface Reveal {
  cards: PieceId[];
  claimed: Rank;
  caller: SeatId;
  claimer: SeatId;
  /** Was the claim true? Decides which of the two swallows the pile. */
  truthful: boolean;
  loser: SeatId;
  /** How many cards the loser is about to pick up. */
  pile: number;
}

export interface RoundResult {
  /** 1 to the seat that took the round, 0 to everyone else. */
  deltas: Record<SeatId, number>;
  cardsLeft: Record<SeatId, number>;
  /** Who emptied their hand, or null when the backstop ended it. */
  wentOut: SeatId | null;
  /** True when the no-progress backstop ended it rather than a player. */
  blocked: boolean;
  /** Who took the round — what the pod crown reads. */
  winner: SeatId;
}

export interface BsState {
  seats: number;
  /** Round wins needed to take the match. */
  target: number;
  /**
   * How long a PERSON gets to answer a challenge window, in ms.
   *
   * A rules option rather than a constant because the right number
   * differs by where the game is being played: alone against bots the
   * table is waiting on you and nothing else, so it is short; in a room
   * everyone is waiting on each other anyway, and a window that the next
   * player can cut short by playing can afford to be generous.
   */
  windowMs: number;
  round: number;
  dealer: SeatId;
  /** Who plays next. Advances on every play, challenged or not. */
  turn: SeatId;
  /** False before a round's deal. */
  dealt: boolean;
  /** The rank the next play must claim. Cycles A, 2, 3 ... K, A ... */
  rank: Rank;

  hands: Record<SeatId, PieceId[]>;
  /** The pile, oldest first. The last entry is the challengeable one. */
  plays: PilePlay[];

  window: ChallengeWindow | null;
  reveal: Reveal | null;
  /** The seat that must swallow the pile before play resumes. */
  pendingTake: SeatId | null;

  scores: Record<SeatId, number>;

  /**
   * No-progress backstop. A table where everybody is caught every time
   * genuinely can cycle forever: the only thing that ever removes cards
   * from hands is a play that SURVIVES, and a challenge puts every one of
   * them straight back. Total cards held falls only on a surviving play,
   * so a low-water mark plus a count of plays since it last fell detects
   * "nothing is happening" without any wall-clock, exactly as Rummy's
   * stalemate check does.
   */
  handTotalFloor: number;
  noProgressStreak: number;

  result: RoundResult | null;
  winner: SeatId | null;
}

export type BsAction =
  /**
   * 1 to 4 cards, claimed as whatever `state.rank` currently is. The rank
   * is deliberately NOT carried: it is forced by the cycle, so a client
   * that sent one could only ever agree or be wrong.
   */
  | { t: "play"; cards: PieceId[] }
  /**
   * The three actions below name their seat, unlike `play`, because a
   * challenge window entitles SEVERAL seats at once — so "whoever is on
   * turn" is not enough to say who spoke.
   *
   * Never trusted from a client: `completeAction` overwrites the seat with
   * the one the session knows submitted, so a spoofed seat calls for the
   * spoofer or not at all.
   */
  | { t: "callBs"; seat: SeatId }
  | { t: "declineBs"; seat: SeatId }
  | { t: "takePile"; seat: SeatId };
