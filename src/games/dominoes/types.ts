/**
 * Dominoes — state and action shapes.
 *
 * The one thing worth understanding before reading board.ts or rules.ts:
 * **a tile's position is part of game state, not a render-time
 * derivation.** Everywhere else in this app a piece's position is a pure
 * function of (index, count) — that is what keeps table/layout.ts O(1)
 * per piece with no sibling access. A domino chain cannot work that way:
 * a double is laid crosswise and so advances the line by ONE unit where
 * every other tile advances it by two, which means a tile's spot depends
 * on the exact run of tiles before it.
 *
 * So the walk happens once, at the moment the tile is played, and the
 * answer is frozen into `PlacedTile`. It is never recomputed. That is
 * not an optimisation — it is the requirement: a tile that shifted after
 * it was laid would pull the player's frame of reference out from under
 * them. What moves as the chain grows is the camera that views this
 * space (see `boardCamera` in table/layout.ts), which preserves every
 * relative position exactly.
 */

import type { PieceId, SeatId } from "@/engine/types";

/** A run direction in board space. Screen y runs downward. */
export type Heading = "R" | "D" | "L" | "U";

export const HEADING_VEC: Record<Heading, { x: number; y: number }> = {
  R: { x: 1, y: 0 },
  D: { x: 0, y: 1 },
  L: { x: -1, y: 0 },
  U: { x: 0, y: -1 },
};

/** Which end of the chain a tile is joined to. `chain[0]` is the left. */
export type ChainEnd = "left" | "right";

export interface PlacedTile {
  id: PieceId;
  /** Centre in board units (1 unit = a tile's short side). Immutable. */
  x: number;
  y: number;
  /**
   * Final face rotation in degrees. 0 is upright with the tile's HIGH
   * half at the top, which is how TileFace draws it, so this alone is
   * enough for the renderer to put matching pips against each other.
   */
  rot: number;
  /** Pip facing the chain's left end. */
  a: number;
  /** Pip facing the chain's right end. */
  b: number;
}

/**
 * How one end of the chain is currently travelling. Only what cannot be
 * recovered from the end tile itself lives here.
 */
export interface ArmState {
  /** The run direction this end is growing in right now. */
  heading: Heading;
  /**
   * The last HORIZONTAL heading. While mid-turn the arm needs to know
   * which way to resume, and it always resumes reversed — that is what
   * makes the chain snake back on itself instead of spiralling into
   * its own tail.
   */
  horiz: Heading;
  /** Board y of the horizontal leg this arm is on. */
  rowY: number;
  /** True while running perpendicular, part-way through a corner. */
  turning: boolean;
}

export interface RoundResult {
  /** How the round finished: someone went out, or nobody could play. */
  kind: "domino" | "blocked";
  /** Null only on a blocked round tied for lowest pips — then nobody scores. */
  winner: SeatId | null;
  /** Pips left in each seat's hand when the round ended. */
  pips: Record<SeatId, number>;
  /** Awarded to `winner`: the losers' pips minus their own. */
  points: number;
}

export interface DomState {
  seats: number;
  /** Match target in points. */
  target: number;
  /** 1-based; 0 before the first deal. */
  round: number;
  scores: Record<SeatId, number>;
  hands: Record<SeatId, PieceId[]>;
  /** Face down, drawn from the front. */
  boneyard: PieceId[];
  /** Left-to-right order. `chain[0].a` and `chain.at(-1)!.b` are open. */
  chain: PlacedTile[];
  arms: Record<ChainEnd, ArmState>;
  turn: SeatId;
  /** Consecutive passes; equals `seats` when the round is blocked. */
  passes: number;
  /** Who leads the next round. */
  opener: SeatId;
  /** Set when the round ends; cleared by `startRound`. */
  result: RoundResult | null;
  /** Set once someone reaches `target`. */
  winner: SeatId | null;
  /** False between `setup` and the first `startRound`. */
  dealt: boolean;
}

/**
 * `draw` and `pass` name no tile deliberately: the boneyard is face down,
 * so a bot that picked which tile it drew would be reading through the
 * backs. `reduce` takes the front of the pile.
 */
export type DomAction =
  | { t: "play"; tile: PieceId; end: ChainEnd }
  | { t: "draw" }
  | { t: "pass" };
