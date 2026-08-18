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

/**
 * Which ruleset is being played.
 *
 *  - `classic` — Block & Draw from a double-six set, 7/7/6 hands, a
 *    boneyard you draw from until it is down to two, scored on the
 *    losers' pips. Unchanged since this game was written.
 *  - `caribbean` — the documented Caribbean/Jamaican game: exactly four
 *    players, all 28 tiles dealt 7 apiece, **no boneyard at all**, and
 *    you simply pass when you cannot play. Each round won is worth one
 *    "game" rather than a pile of pips.
 */
export type DomMode = "classic" | "caribbean";

/**
 * Rules chosen at setup. Lives ON state rather than only in the factory
 * closure, because `reduce`, `legalActions` and every bot are pure
 * functions of state and never see the closure — the same reason
 * `SpadesState.rules` exists.
 *
 * `teams`, `keyTileBonus` and `sixLove` are Caribbean-only and ignored
 * in classic.
 */
export interface DomRules {
  mode: DomMode;
  /** 2v2, partners across (seats 0/2 against 1/3). Cut-throat when false. */
  teams: boolean;
  /**
   * Going out on the "key tile" — the only tile in the set that could
   * legally have been played, with the two open ends differing — is
   * worth two games instead of one. Never applies to a double.
   */
  keyTileBonus: boolean;
  /**
   * The traditional win condition: your score returns to zero whenever
   * the other side takes a round, so the match is won on a streak.
   * Team-only, and deliberately so — see `defaultTarget`.
   */
  sixLove: boolean;
}

export interface RoundResult {
  /** How the round finished: someone went out, or nobody could play. */
  kind: "domino" | "blocked";
  /**
   * Null when nobody scored — a classic blocked round tied on pips and
   * on the lightest tile, or a Caribbean blocked round tied on pips
   * (which redeals).
   */
  winner: SeatId | null;
  /**
   * Every seat on the winning SIDE — `[winner]` cut-throat, both
   * partners in team mode. Read structurally by the runtime's
   * `roundWinningSeats` so both partners' pods are crowned, not just
   * the one who happened to lay the last tile.
   */
  winningSeats: SeatId[] | null;
  /** Pips left in each seat's hand when the round ended. */
  pips: Record<SeatId, number>;
  /**
   * Awarded to the winning side. Classic: the losers' pips less their
   * own. Caribbean: one game, or two on a key tile.
   */
  points: number;
  /** Caribbean only — the extra point came from the key-tile rule. */
  bonus: boolean;
}

export interface DomState {
  seats: number;
  rules: DomRules;
  /**
   * The match's rng seed, copied once in `setup`. `reduce` receives no
   * `Rng` (deliberately — see engine/rng.ts), so anything inside it that
   * needs to look random hashes a key built from this plus the position.
   * That keeps the result a pure function of the state, so a seed
   * replays a match's slams exactly as it replays its deals.
   */
  seed: number;
  /**
   * Match target. Points in classic; rounds won in Caribbean.
   */
  target: number;
  /** 1-based; 0 before the first deal. */
  round: number;
  /**
   * Cumulative score. In team mode this is PER SEAT but always mirrored
   * across a side's two seats (`scores[0] === scores[2]`), the same
   * shape and for the same reason as `SpadesState.scores`: a seat's own
   * number already is its side's number, so every downstream reader —
   * the win check, the standings, the seat pods — keeps working without
   * knowing whether teams are on.
   */
  scores: Record<SeatId, number>;
  hands: Record<SeatId, PieceId[]>;
  /** Face down, drawn from the front. Always empty in Caribbean. */
  boneyard: PieceId[];
  /** Left-to-right order. `chain[0].a` and `chain.at(-1)!.b` are open. */
  chain: PlacedTile[];
  arms: Record<ChainEnd, ArmState>;
  turn: SeatId;
  /** Consecutive passes; equals `seats` when the round is blocked. */
  passes: number;
  /** Who leads the next round. */
  opener: SeatId;
  /**
   * Who took the LAST round that had a winner — which is not `opener`
   * (a tied round leaves no winner but does hand the lead back to the
   * double-six holder) and not `result.winner` (that is cleared and
   * refilled every round). Only reader is the slam roll, which gives a
   * player on a winning streak longer odds.
   */
  lastRoundWinner: SeatId | null;
  /** Set when the round ends; cleared by `startRound`. */
  result: RoundResult | null;
  /** Set once a side reaches `target`. */
  winner: SeatId | null;
  /**
   * Every seat on the winning side at match end. Structural — the
   * runtime already reads this field (it was added for Spades' team
   * win) and the host crowns every seat in it.
   */
  winningSeats: SeatId[] | null;
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
