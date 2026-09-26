/**
 * A stable per-seat personality, within a difficulty tier.
 *
 * `botTable(seats, tier)` hands every seat the same tier, so before
 * this the whole table was one strategy running five times. That reads
 * as obviously artificial on its own, but in poker it was actively
 * harmful: identical thresholds acting on correlated reads meant two
 * bots that both liked their hands re-raised each other in lockstep
 * until someone was all-in.
 *
 * The offsets here are small and stay inside the tier's own band, so
 * the difficulty slider still means exactly what its copy says — a
 * `steady` table is still a table of steady players, they just are not
 * the same steady player.
 *
 * Derived from `hashString` rather than an `Rng` for the same reason
 * `reduce` uses it for slams: it is a pure function of the position, so
 * a seed replays a match's personalities exactly, and nothing has to be
 * threaded through `BotStrategy.choose`'s fixed `(state, seat, rng)`
 * signature to carry it.
 */

import { hashString } from "@/engine/rng";
import type { SeatId } from "@/engine/types";

export interface BotPersonality {
  /**
   * How much more (positive) or less (negative) this seat needs before
   * it will put money in. A cautious seat folds marginal spots a loose
   * one calls.
   */
  tight: number;
  /** How readily this seat raises rather than calls. */
  aggro: number;
  /** A multiplier on the tier's own bluff rate, roughly 0.5x to 1.5x. */
  bluff: number;
}

/**
 * A signed value in [-spread, spread], stable for this (game, seat,
 * trait) triple.
 */
function jitter(game: string, seat: SeatId, trait: string, spread: number): number {
  const h = hashString(`${game}|${seat}|${trait}`);
  return ((h % 2001) / 1000 - 1) * spread;
}

/**
 * The seat's personality. Call it freely — it is pure and cheap, so
 * there is no need to cache it across a decision.
 */
export function personality(game: string, seat: SeatId): BotPersonality {
  return {
    tight: jitter(game, seat, "tight", 0.045),
    aggro: jitter(game, seat, "aggro", 0.06),
    bluff: 1 + jitter(game, seat, "bluff", 0.5),
  };
}

/**
 * A stable 0..1 roll for a decision that should hold still rather than
 * being re-rolled every time a bot is asked.
 *
 * A bluff is the motivating case: poker's bots used to roll
 * `rng.next() < BLUFF_CHANCE` fresh on every single decision, so a bot
 * could bluff-raise the flop and then fold the very same hand to the
 * min-raise back. Keying the roll to the street instead makes a bluff a
 * line the bot commits to, which is the only thing that makes it read
 * as a bluff at all.
 */
export function stableRoll(key: string): number {
  return (hashString(key) % 10007) / 10007;
}
