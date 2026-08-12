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

export function parseCard(id: PieceId): Card {
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

/** Human-readable, for announcements and screen readers. */
export function cardLabel(card: Card): string {
  const rankName: Partial<Record<Rank, string>> = {
    A: "Ace", J: "Jack", Q: "Queen", K: "King",
  };
  return `${rankName[card.rank] ?? card.rank} of ${SUIT_NAME[card.suit]}`;
}
