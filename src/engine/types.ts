/**
 * Engine contracts.
 *
 * The load-bearing decision in this file: `reduce` returns BOTH the next
 * state AND the ordered list of things that happened. A snapshot alone
 * cannot drive a table animation — if you only diff state you have to
 * guess whether three cards moved because they were dealt, collected as
 * a trick, or swept into a discard, and each of those looks different.
 *
 * Nothing in src/engine imports React. Keep it that way: the engine must
 * be runnable in a test, a worker, or a future server.
 */

import type { Rng } from "./rng";

/** Seat 0 is ALWAYS the human. Bots occupy 1..n-1. */
export type SeatId = number;

export const HERO: SeatId = 0;

/**
 * Stable identity for a physical piece, e.g. "S-A", "H-10", "D6-3", "C-red".
 * Ids must be stable for the whole game: the piece layer keys off them, and
 * a changing id reads as "old piece destroyed, new piece created", which
 * throws away the animation.
 */
export type PieceId = string;

export type ZoneId =
  | "deck"
  | "discard"
  | "trick"
  | "board"
  | "hand"
  | "collected"
  | "center"
  | "offscreen";

/**
 * Where a piece is and how it should read. This is the ONLY thing the
 * piece layer consumes — it never sees game state.
 */
export interface Placement {
  zone: ZoneId;
  /** Owning seat, for hand / collected / seat-anchored zones. */
  seat?: SeatId;
  /** Position within the zone (or within `group`). */
  index: number;
  /** Total pieces in the same zone/group — drives fan spread and overlap. */
  count: number;
  faceUp: boolean;
  /** Sub-collection: meld number on the board, trick number, train index. */
  group?: number;
  selected?: boolean;
  /** Lit as a legal target. */
  highlighted?: boolean;
  /** Pushed back as an invalid target during a targeting mode. */
  dimmed?: boolean;
  /**
   * Spread a pile out instead of stacking it. Set on every piece in the
   * pile, because a piece is laid out without knowledge of its siblings
   * — that is what keeps layout O(1) per piece and lets each one
   * subscribe to its own placement alone.
   */
  fanned?: boolean;
}

export type PlacementMap = Record<PieceId, Placement>;

/* ============================================================
   Events — the animation vocabulary.
   ============================================================ */

export type Tone = "info" | "good" | "bad";

export type GameEvent =
  /** Deck is randomised. Carries the seed so a log replays exactly. */
  | { t: "shuffle"; seed: number }
  /** Opening deal. Choreographer staggers these automatically. */
  | { t: "deal"; piece: PieceId; to: SeatId; faceUp: boolean }
  /** Taking a piece from a shared pile into a hand. */
  | { t: "draw"; piece: PieceId; from: ZoneId; to: SeatId; faceUp: boolean }
  /** Hand -> table. */
  | { t: "play"; piece: PieceId; from: SeatId; to: ZoneId; group?: number }
  /** Arbitrary relocation when nothing more specific fits. */
  | { t: "move"; piece: PieceId; to: Placement }
  | { t: "flip"; piece: PieceId; faceUp: boolean }
  /** Sweeping a won trick to a seat. Staggered inward. */
  | { t: "collect"; pieces: PieceId[]; to: SeatId }
  /**
   * Bot deliberation. A first-class event, not a setTimeout in the UI:
   * it is what makes an opponent feel like a person rather than a
   * function that returns instantly.
   */
  | { t: "think"; seat: SeatId; ms: number }
  /** Surfaced as a toast. Never blocks. */
  | { t: "announce"; seat?: SeatId; text: string; tone?: Tone }
  | { t: "phase"; phase: string }
  | { t: "score"; deltas: Record<SeatId, number> }
  | { t: "roundEnd"; round: number }
  | { t: "gameEnd"; winner: SeatId };

export interface ReduceResult<S> {
  state: S;
  events: GameEvent[];
}

/* ============================================================
   Game definition
   ============================================================ */

export interface SetupOptions {
  seats: number;
  rng: Rng;
  /** Bot difficulty per seat, index-aligned. Seat 0 is ignored. */
  difficulty?: BotDifficulty[];
}

export type BotDifficulty = "casual" | "steady" | "sharp";

export interface BotStrategy<S, A> {
  id: string;
  /**
   * Chooses from `legalActions`. Must be pure given (state, seat, rng) so
   * bot behaviour replays deterministically alongside the deal.
   */
  choose(state: S, seat: SeatId, rng: Rng): A;
  /** Deliberation window, in ms, before the action is emitted. */
  thinkMs(state: S, seat: SeatId, rng: Rng): number;
}

export interface GameDefinition<S, A> {
  id: string;
  name: string;
  minSeats: number;
  maxSeats: number;

  setup(opts: SetupOptions): S;
  reduce(state: S, action: A): ReduceResult<S>;
  legalActions(state: S, seat: SeatId): A[];

  /**
   * Full visual truth for a state. The choreographer applies events
   * incrementally for animation, then reconciles against this — so a
   * missed or malformed event self-corrects instead of desyncing the
   * board permanently.
   */
  placements(state: S, viewer: SeatId): PlacementMap;

  /** Redacts hidden information. Bots for seat N only ever see view(N). */
  playerView(state: S, viewer: SeatId): S;

  currentSeat(state: S): SeatId | null;
  isOver(state: S): boolean;

  bots: Record<BotDifficulty, BotStrategy<S, A>>;
}
