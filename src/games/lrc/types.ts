/**
 * Left Right Center — state and action shapes.
 *
 * The one thing worth understanding before reading rules.ts: `reduce`
 * takes no `rng`. Every other game so far resolves its randomness once,
 * at setup (shuffle the deck, done) — LRC is the first to need fresh
 * randomness on almost every turn. Rather than break `reduce`'s purity to
 * accommodate that, the dice values are resolved into the action BEFORE
 * `reduce` ever sees it: a bot's `choose(state, seat, rng)` already gets
 * an `rng` and rolls its own dice; the human path does the same at the
 * moment "Roll" is tapped (see dice.ts). `reduce` just applies whatever
 * `LrcAction.dice` says. That keeps it a pure function of (state, action)
 * — replay a game from its action log and you need no rng at all, since
 * every roll's outcome is already baked into the log.
 *
 * A single pot-win used to BE the whole game. It is now one ROUND of a
 * match — `startRound` deals fresh chips and cuts fresh for who rolls
 * first, `scores` accumulates rounds won per seat, and the match ends
 * once someone reaches `target`. That shape (round/scores/result/winner/
 * dealt) mirrors Dominoes exactly, which is what lets `useGameRuntime`'s
 * generic round machinery — `RoundIntro`, `RoundEndScorecard`, the
 * between-rounds hold — drive LRC for free.
 */

import type { PieceId, SeatId } from "@/engine/types";

export type DieFace = "L" | "R" | "C" | "dot";

export interface LrcState {
  seats: number;
  /** Match target — rounds a seat must WIN to take the match. */
  target: number;
  /** 1-based; 0 before the first deal. */
  round: number;
  /** Cumulative rounds won per seat. */
  scores: Record<SeatId, number>;
  /**
   * Where every physical chip currently sits. `"bank"` is a chip not yet
   * dealt into this round — the reserve `startRound` deals FROM, the
   * same role a boneyard plays for a deck of cards. Every chip starts
   * there at `setup` and returns there in the sweep before each redeal.
   */
  chipOwner: Record<PieceId, SeatId | "pot" | "bank">;
  /** Whose turn. Always a seat that currently holds at least one chip.
   * Meaningless before the first deal (`dealt: false`). */
  turn: SeatId;
  /** Set when a round ends (one seat holds every chip); cleared by
   * `startRound`. */
  result: { winner: SeatId } | null;
  /** Set once a seat's `scores` reaches `target`. */
  winner: SeatId | null;
  /** False between `setup` and the first `startRound`. */
  dealt: boolean;
}

/**
 * The only action in the game. `legalActions` returns a shape sentinel
 * with an empty `dice` array — it answers "can this seat act," not "what
 * will the dice say," since that's resolved at submission time, not
 * enumeration time.
 */
export type LrcAction = { t: "roll"; dice: DieFace[] };
