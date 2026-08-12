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
  /**
   * A chain of pieces laid end to end — dominoes' line of play. Unlike
   * every other zone, position here is NOT derived from index/count:
   * where a domino sits depends on the exact run of tiles before it
   * (a double advances the line by half as much as anything else), and
   * a played tile must never move again. See `Placement.cell`.
   */
  | "line"
  /** Face-down pool drawn from — dominoes' boneyard. */
  | "boneyard"
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
  /**
   * Position in an abstract board-unit space, for zones where a piece
   * sits where the pieces before it put it rather than at an index in a
   * fan (`zone: "line"`).
   *
   * This exists because everywhere else, position is a pure function of
   * (index, count) — which is what lets layout stay O(1) per piece with
   * no sibling knowledge. A domino chain breaks that: a double advances
   * the line by one unit and everything else by two, so a tile's spot
   * depends on the whole run before it. The game does that walk once,
   * at the moment the piece is played, and stores the answer here. It is
   * then immutable for the rest of the round — which is the point. The
   * player's frame of reference is never re-derived under them; only the
   * camera that views this space moves (see `boardCamera` in
   * table/layout.ts).
   *
   * Units are the piece's short side, so a domino is 1x2. `rot` is the
   * final face rotation in degrees (0 = upright, high half at the top),
   * which is all the renderer needs to make matching pips touch.
   *
   * Structural, not a transient interaction flag — do NOT add it to the
   * store's `clearFlags`.
   */
  cell?: { x: number; y: number; rot: number };
}

export type PlacementMap = Record<PieceId, Placement>;

/**
 * What a piece physically is. Placement says WHERE it is; this says WHAT
 * it looks like — and unlike Placement, it never changes during a game,
 * so it's a setup-time concern (`GameDefinition.pieces`), not a per-turn
 * one. Lives here, not in the table store, because every game needs to
 * describe its own physical pieces regardless of how the React layer
 * happens to cache them.
 */
export type PieceKind = "card" | "tile" | "chip";

export interface PieceMeta {
  kind: PieceKind;
  /** Face identity: card id, "6-3" for a tile, a colour token for a chip. */
  face: string;
}

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
   * Returns many pieces to a shared pile at once — a spent chain, or
   * every seat's leftover hand, gathered face down before a fresh deal.
   * Deliberately its OWN event rather than a batch of `move`s: a single
   * deliberate placement (`move`) and "clear the table" are different
   * GESTURES, and giving them the same choreography would force a
   * round-transition sweep to play at the same weight as one careful
   * move — which is what actually made an early version of a
   * many-tile sweep look sluggish. `move`'s own pace stays exactly what
   * it was; this gets its own, deliberately fast one (see `choreograph`).
   */
  | { t: "sweep"; pieces: PieceId[]; to: ZoneId }
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
   * The physical pieces this game uses and what they look like. Fixed
   * once `setup` runs — a game's piece SET never changes, only where
   * each one sits — so the runtime calls this once and caches it,
   * unlike `placements` which it calls after every batch of events.
   */
  pieces(state: S): Record<PieceId, PieceMeta>;

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

  /**
   * Deals (or re-deals) and returns the events that show it happening.
   * The runtime calls this once before the first turn, and again each
   * time the player continues from a round summary.
   *
   * Optional: a single-round game (LRC) sets up entirely in `setup` and
   * omits this. Implementing it buys an ANIMATED opening deal, which
   * `setup` alone cannot give you — `setup` returns state only, so a game
   * that deals there has its cards simply appear. A game with this hook
   * returns an undealt state from `setup` (everything still in the deck
   * or boneyard) and lets the deal fly out of the pile like a real one.
   *
   * The piece SET must not change between rounds — `pieces()` is called
   * once and cached.
   */
  startRound?(state: S, rng: Rng): ReduceResult<S>;

  /**
   * True between a round ending and `startRound` being called again.
   * Games that run a single round omit this.
   *
   * `currentSeat` should return null while this is true; the runtime
   * stops pacing turns and shows the round summary instead.
   */
  isRoundOver?(state: S): boolean;

  bots: Record<BotDifficulty, BotStrategy<S, A>>;
}
