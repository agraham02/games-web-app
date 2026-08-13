/**
 * Standard 52-card deck.
 *
 * Card ids are short and stable ("SA", "H10", "DQ") because they double
 * as piece ids in the table layer, and a piece id that changes mid-game
 * destroys the animation for that card.
 */

import type { PieceId } from "@/engine/types";
import type { Rng } from "@/engine/rng";

export const SUITS = ["S", "H", "D", "C"] as const;
export type Suit = (typeof SUITS)[number];

export const RANKS = [
  "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K",
] as const;
export type Rank = (typeof RANKS)[number];

export interface Card {
  id: PieceId;
  suit: Suit;
  rank: Rank;
}

export const SUIT_GLYPH: Record<Suit, string> = {
  S: "♠",
  H: "♥",
  D: "♦",
  C: "♣",
};

export const SUIT_NAME: Record<Suit, string> = {
  S: "spades",
  H: "hearts",
  D: "diamonds",
  C: "clubs",
};

export function isRed(suit: Suit): boolean {
  return suit === "H" || suit === "D";
}

export function cardId(suit: Suit, rank: Rank): PieceId {
  return `${suit}${rank}`;
}

/**
 * Joker ids. "X" is never a real `Suit`, so these can never collide with
 * `cardId()`'s `${suit}${rank}` scheme — a game that never enables jokers
 * (every game but Spades, today) never produces or sees one.
 */
export const BIG_JOKER_ID: PieceId = "XB";
export const LITTLE_JOKER_ID: PieceId = "XL";

export function isJokerId(id: PieceId): boolean {
  return id === BIG_JOKER_ID || id === LITTLE_JOKER_ID;
}

/** `"big" | "little"` for a joker id, `null` for an ordinary card. */
export function jokerLabel(id: PieceId): "big" | "little" | null {
  if (id === BIG_JOKER_ID) return "big";
  if (id === LITTLE_JOKER_ID) return "little";
  return null;
}

/** Throws on a joker id rather than silently mis-parsing it as suit "X" —
 * callers that might see one (Spades' own code, CardFace) must check
 * `isJokerId`/`jokerLabel` first. */
export function parseCard(id: PieceId): Card {
  if (isJokerId(id)) {
    throw new Error(`parseCard: "${id}" is a joker — check isJokerId() first`);
  }
  const suit = id[0] as Suit;
  const rank = id.slice(1) as Rank;
  return { id, suit, rank };
}

/** Ace low (1) through King (13). Games that want ace-high remap. */
export function rankValue(rank: Rank): number {
  return RANKS.indexOf(rank) + 1;
}

/** Rummy 500 deadwood values: face cards 10, ace 1, pip = face value. */
export function pipValue(rank: Rank): number {
  if (rank === "A") return 1;
  if (rank === "J" || rank === "Q" || rank === "K") return 10;
  return Number(rank);
}

export function standardDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ id: cardId(suit, rank), suit, rank });
    }
  }
  return deck;
}

export function shuffledDeck(rng: Rng): Card[] {
  return rng.shuffle(standardDeck());
}

/**
 * Suit order for a HELD hand's on-screen display: diamonds, clubs,
 * hearts, spades. Alternating red/black, so two adjacent suit groups in
 * the fan are never the same colour — easier to tell apart at a glance
 * than dealing order (which is arbitrary) or a same-colour-adjacent
 * grouping would be. Lives in `_shared` because any game with a
 * face-up fanned hand wants this, not just Spades.
 */
export const HAND_DISPLAY_SUIT_ORDER: readonly Suit[] = ["D", "C", "H", "S"];

/**
 * Sorts a hand for on-screen display — grouped by
 * `HAND_DISPLAY_SUIT_ORDER`, ascending strength (weakest to strongest,
 * left to right) within each group. Returns a new array; never mutates
 * `ids` or anything it points at, so a caller's own authoritative hand
 * order (whatever engine logic or bots read from) is untouched — this
 * is purely a cosmetic reordering for the piece layer.
 *
 * `suitOf`/`strength` are callbacks, the same shape `trickTaking.ts`
 * takes a `strength` callback: a game with its own ranking rules
 * (Spades' 2-of-spades-high and joker toggles, a future game's own)
 * plugs those in without this helper knowing any house rules exist.
 */
export function sortHandForDisplay<T>(
  ids: readonly T[],
  suitOf: (id: T) => Suit,
  strength: (id: T) => number,
): T[] {
  const groupOf = (id: T) => HAND_DISPLAY_SUIT_ORDER.indexOf(suitOf(id));
  return [...ids].sort((a, b) => groupOf(a) - groupOf(b) || strength(a) - strength(b));
}

/** Human-readable, for announcements and screen readers. */
export function cardLabel(card: Card): string {
  const rankName: Partial<Record<Rank, string>> = {
    A: "Ace", J: "Jack", Q: "Queen", K: "King",
  };
  return `${rankName[card.rank] ?? card.rank} of ${SUIT_NAME[card.suit]}`;
}
