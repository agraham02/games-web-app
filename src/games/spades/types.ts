/**
 * Spades — state and action shapes.
 *
 * The one thing worth understanding before reading state.ts or rules.ts:
 * bidding is not a separate mini-game bolted onto play — it is driven
 * through the exact same `currentSeat` -> `legalActions` -> `reduce` turn
 * loop as every other action in this app. `phase` just tells `reduce`
 * which family of actions is currently legal, the same way Dominoes
 * branches on `result`/`dealt`.
 *
 * Scores and bags are PER SEAT but always mirrored across a team's two
 * seats (`scores[0] === scores[2]` when 0 and 2 are partners) rather than
 * a separate team-keyed record. That is a deliberate choice, not laziness:
 * every existing seat-indexed shape this app already has — `ScoreRow`,
 * `GameHost`'s standings, a seat pod's `meta` string — reads a Spades
 * score with no new concept at all, because each player's own number
 * already IS their team's number.
 */

import type { PieceId, SeatId } from "@/engine/types";
import type { Suit } from "@/games/_shared/cards";
import type { SpadesRules } from "./cards";

export type SpadesPhase = "bid" | "play";

export interface Bid {
  /** Trick target, 0-13. A Nil bid stores 0 here too — `nil` is what
   * changes scoring, this is just "how many tricks were promised". */
  tricks: number;
  nil: boolean;
  /** Bid before looking at the hand — Blind Nil, or a blind numeric bid
   * (>= 6). Doubles the payoff on success either way. */
  blind: boolean;
}

/**
 * The optional 2-card swap after a Blind Nil bid, before the first lead.
 * `giver` discards unseen; `taker` picks the 2 up and sends 2 back.
 */
export interface Exchange {
  giver: SeatId;
  taker: SeatId;
  stage: "give" | "take";
  /** Set once the giver has committed. Rendered face-up in the "discard"
   * zone while the taker decides what to send back. */
  given?: [PieceId, PieceId];
}

export interface RoundResult {
  bids: Record<SeatId, Bid>;
  tricksWon: Record<SeatId, number>;
  /** This round's point swing, mirrored per team. */
  deltas: Record<SeatId, number>;
  /** Cumulative bag count AFTER this round, mirrored per team. */
  bags: Record<SeatId, number>;
  /** -100 per bag-penalty threshold crossed this round (0 if none),
   * mirrored per team. */
  bagPenalty: Record<SeatId, number>;
}

export interface TrickCardPlay {
  seat: SeatId;
  card: PieceId;
}

export interface SpadesState {
  rules: SpadesRules;
  /** Match target in points. */
  target: number;
  /** A team at or below this score has lost the match. */
  autoLoss: number;
  /** 1-based; 0 before the first deal. */
  round: number;
  dealer: SeatId;
  phase: SpadesPhase;
  /** Whose action is next — a bidder, an exchange giver/taker, or the
   * player to move in the current trick. */
  turn: SeatId;
  hands: Record<SeatId, PieceId[]>;
  /** Whether this seat has actually seen its own hand yet this round.
   * True immediately for a non-blind-eligible seat; a blind-eligible
   * seat stays false until it either looks or locks in a blind bid. */
  handRevealed: Record<SeatId, boolean>;
  /** Frozen at deal time from the PRE-round scores — whether this seat's
   * team trails by >= 100 and so may bid blind this round. */
  blindEligible: Record<SeatId, boolean>;
  bids: Record<SeatId, Bid | null>;
  exchange: Exchange | null;
  /** The trick currently on the table, in play order. Empty between
   * tricks. */
  trick: TrickCardPlay[];
  ledSuit: Suit | null;
  trumpBroken: boolean;
  /** Who leads the next trick — the round's opening leader, or the
   * winner of the last trick. */
  leader: SeatId;
  /** Tricks won this round only. */
  tricksWon: Record<SeatId, number>;
  /** The actual cards each seat has collected this round — `placements`
   * needs every one of the 52 ids to still have a home somewhere, not
   * just a count. */
  won: Record<SeatId, PieceId[]>;
  /** Cumulative match score, mirrored per team. */
  scores: Record<SeatId, number>;
  /** Cumulative bag count, mirrored per team, never reset (the -100
   * penalty is derived from crossing multiples of 10, not from a
   * separately-tracked "since last penalty" counter). */
  bags: Record<SeatId, number>;
  /** Running match totals for the end-of-game "Nils made" stat, mirrored
   * per team. */
  nilsAttempted: Record<SeatId, number>;
  nilsMade: Record<SeatId, number>;
  /** Set when the round ends; cleared by the next `startRound`. */
  result: RoundResult | null;
  /** Every seat on the winning TEAM, set once the match ends. A
   * partnership win is two seats, not one — see useGameRuntime's
   * `winningSeats` extension. */
  winningSeats: SeatId[] | null;
  /** A single representative seat from `winningSeats` (the hero if the
   * hero's team won, else the lower-numbered partner) — kept so the
   * existing single-seat `winner` convention (GameEndSummary's headline)
   * still reads correctly with no changes on that end. */
  winner: SeatId | null;
  /** False between `setup` and the first `startRound`. */
  dealt: boolean;
}

export type SpadesAction =
  | { t: "look" }
  | { t: "bid"; tricks: number; nil: boolean }
  | { t: "blindNil" }
  | { t: "blindBid"; tricks: number }
  | { t: "skipExchange" }
  | { t: "exchangeGive"; cards: [PieceId, PieceId] }
  | { t: "exchangeTake"; cards: [PieceId, PieceId] }
  | { t: "play"; card: PieceId };
