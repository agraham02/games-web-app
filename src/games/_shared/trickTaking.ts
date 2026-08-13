/**
 * Mechanics shared by any trick-taking game: follow-suit legality,
 * trump-lead gating, and trick-winner resolution. Deliberately holds no
 * rank knowledge of its own — every game supplies its own `strength`
 * function (Spades' cards are always trump and can rank a 2 above an ace
 * under house rules; a future game might not) — so this stays reusable
 * rather than becoming a second copy of Spades' own rules.
 */

import type { PieceId, SeatId } from "@/engine/types";
import type { Suit } from "./cards";

export interface TrickCard {
  id: PieceId;
  /**
   * The suit this card counts as for FOLLOW-SUIT purposes — not
   * necessarily its literal identity. A card with no ordinary suit that
   * still counts as trump (Spades' jokers) reports the trump suit here,
   * exactly like an ordinary trump card would, since that is the whole
   * point of "counts as spades for follow-suit": a spade lead must be
   * followed by a joker just as much as by a real spade, and a joker
   * lead is a trump lead like any other.
   */
  suit: Suit;
  isTrump: boolean;
}

export interface TrickPlay {
  seat: SeatId;
  card: TrickCard;
}

/**
 * Cards from `hand` that may legally follow `ledSuit`. `ledSuit === null`
 * means this call IS the lead — every card is a legal reply to "nothing
 * led yet" at the follow-suit level; use `canLeadTrump` separately to
 * gate leading trump specifically.
 */
export function legalFollows(
  hand: readonly TrickCard[],
  ledSuit: Suit | null,
): TrickCard[] {
  if (ledSuit === null) return [...hand];
  const inSuit = hand.filter((c) => c.suit === ledSuit);
  return inSuit.length > 0 ? inSuit : [...hand]; // void in the led suit -> anything, including trump
}

/** Trump may not be LED until broken, unless the leader holds nothing
 * else — then they're forced to lead it even unbroken. */
export function canLeadTrump(hand: readonly TrickCard[], trumpBroken: boolean): boolean {
  return trumpBroken || hand.every((c) => c.isTrump);
}

/**
 * Highest card of the led suit wins the trick, unless it was trumped —
 * then the highest trump wins regardless of the led suit. `strength` is
 * only ever asked to compare cards already known to be in the same pool
 * (all trump, or all the led suit), so it needs no suit awareness itself.
 */
export function resolveTrick(
  plays: readonly TrickPlay[],
  ledSuit: Suit | null,
  strength: (id: PieceId) => number,
): SeatId {
  if (plays.length === 0) {
    throw new Error("resolveTrick: no plays to resolve");
  }
  const trumped = plays.filter((p) => p.card.isTrump);
  const pool = trumped.length > 0 ? trumped : plays.filter((p) => p.card.suit === ledSuit);
  const contest = pool.length > 0 ? pool : plays; // defensive: never leave the trick unresolved
  let best = contest[0]!;
  for (const p of contest) {
    if (strength(p.card.id) > strength(best.card.id)) best = p;
  }
  return best.seat;
}
