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
 */

import type { PieceId, SeatId } from "@/engine/types";

export type DieFace = "L" | "R" | "C" | "dot";

export interface LrcState {
  seats: number;
  /** Where every physical chip currently sits — the source of truth. */
  chipOwner: Record<PieceId, SeatId | "pot">;
  /** Whose turn. Always a seat that currently holds at least one chip. */
  turn: SeatId;
  /** Set once `isOver` becomes true. Kept in state so it's cheap to read. */
  winner: SeatId | null;
}

/**
 * The only action in the game. `legalActions` returns a shape sentinel
 * with an empty `dice` array — it answers "can this seat act," not "what
 * will the dice say," since that's resolved at submission time, not
 * enumeration time.
 */
export type LrcAction = { t: "roll"; dice: DieFace[] };
