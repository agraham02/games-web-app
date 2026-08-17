/**
 * Rummy 500 state and actions.
 *
 * Three fields sit deliberately OUTSIDE the `phase`-driven turn loop,
 * the same way Spades' `exchange` does — each is a sub-decision that
 * seizes `currentSeat` regardless of whose turn it nominally is:
 *
 *   `dealSizePending`  the dealer choosing this round's hand size
 *   `claimWindow`      a discard the hero may snap up before play moves on
 *   `mandatory`        a pickup that must be melded before anything else
 *
 * All three are HERO-only in the sense that matters: a bot's equivalent
 * decision resolves inline inside the same `reduce` call that created
 * the opportunity, so it never needs to park in state at all. Only a
 * human needs a state field, because only a human needs time.
 *
 * `round`, `winner` and `result.winner` are named to match what
 * `useGameRuntime` reads STRUCTURALLY (see its `extractRound` /
 * `extractWinner` / `extractRoundWinner`) — that naming alone buys the
 * round intro card, the round-end scorecard, the pod crown and the
 * hero-win confetti with no per-game wiring.
 */

import type { PieceId, SeatId } from "@/engine/types";
import type { Meld } from "./cards";

export type { Meld } from "./cards";

/** Exactly one action resolves `"draw"`; `"meld"` ends on a discard. */
export type RummyPhase = "draw" | "meld";

/**
 * An unmet obligation created by taking cards off the discard pile.
 * Set the instant ANY discard pickup lands — every depth, including a
 * bare top card. There is no free single-card grab from the pile.
 */
export interface MandatoryPickup {
  /** The deepest card taken. It must appear in a brand-new meld. */
  card: PieceId;
  /** The cards that rode along above it in the same pickup. */
  pool: PieceId[];
}

/**
 * A just-discarded card that extends an existing board meld, offered to
 * the hero before the next seat's turn begins.
 *
 * Resolved to a single meld target the instant the window opens rather
 * than re-derived at claim time, so what the player is offered and what
 * they get cannot drift apart.
 */
export interface ClaimWindow {
  discard: PieceId;
  discarder: SeatId;
  meldId: number;
}

export interface RoundResult {
  /** `contributed - handPenalty`, per seat. */
  deltas: Record<SeatId, number>;
  contributed: Record<SeatId, number>;
  handPenalty: Record<SeatId, number>;
  /** Who emptied their hand, or null when the round ended another way. */
  wentOut: SeatId | null;
  /** True when the stalemate backstop ended it. */
  blocked: boolean;
  /** Highest scorer this round — what the pod crown reads. */
  winner: SeatId;
}

export interface RummyState {
  seats: number;
  /** Match target. Configurable at setup; 250 by default. */
  target: number;
  round: number;
  dealer: SeatId;
  turn: SeatId;
  phase: RummyPhase;
  /** False between rounds and while a deal-size choice is pending. */
  dealt: boolean;
  /** This round's hand size — the dealer's own fresh choice each round. */
  dealSize: number;
  /** Set only for a HUMAN dealer; a bot's choice resolves inline. */
  dealSizePending: SeatId | null;

  hands: Record<SeatId, PieceId[]>;
  stock: PieceId[];
  /** Index 0 is the BOTTOM of the pile; the last element is the top. */
  discard: PieceId[];
  melds: Meld[];
  nextMeldId: number;

  mandatory: MandatoryPickup | null;
  claimWindow: ClaimWindow | null;

  scores: Record<SeatId, number>;

  /**
   * Stalemate backstop. Once every pickup carries a real mandatory-meld
   * obligation a round genuinely CAN cycle forever — confirmed in a
   * 300,000-turn bot simulation that never budged. Total hand-card count
   * only ever drops when a meld is laid or extended (a plain
   * draw-then-discard nets zero), so a checkpoint on that total plus a
   * streak of turns since it last fell is enough to detect "nothing is
   * happening" without any wall-clock.
   *
   * This is also the reason the stock never needs to reshuffle from the
   * discard pile: the backstop is the real safety valve, not an
   * infinite pile.
   */
  handTotalCheckpoint: number;
  noProgressStreak: number;

  result: RoundResult | null;
  winner: SeatId | null;
}

export type RummyAction =
  | { t: "chooseDealSize"; size: number }
  | { t: "drawStock" }
  /** Takes `depth` cards off the top. EVERY depth forces a new meld. */
  | { t: "drawDiscard"; depth: number }
  | { t: "layNewMeld"; cards: PieceId[] }
  | { t: "extendMeld"; meldId: number; card: PieceId }
  | { t: "discard"; card: PieceId }
  | { t: "claim" }
  | { t: "passClaim" };
