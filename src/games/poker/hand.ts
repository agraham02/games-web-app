/**
 * Texas Hold'em hand evaluation — standard best-5-of-N poker ranking.
 *
 * Genuinely new: no poker hand-ranking logic exists anywhere else in this
 * repo, and `_shared/cards.ts`'s `rankValue` is ace-LOW (A=1..K=13, for
 * Rummy's own deadwood scoring), which is the wrong ordering for poker.
 *
 * Pure over plain `Card[]` — no `PokerState` dependency, no import from
 * this game's own `rules.ts`/`state.ts` — so it is independently testable
 * and reusable from both `rules.ts` (showdown resolution) and `bots.ts`
 * (hand-strength reads) with no coupling between them.
 */

import type { PieceId } from "@/engine/types";
import type { Card, Rank } from "@/games/_shared/cards";

/** 0 = high card … 8 = straight flush. A royal flush is just the top
 * straight flush (`ranks: [14]`) — it needs no category of its own. */
export type HandCategory = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** High to low — the order a reference list should read in. */
export const HAND_CATEGORY_INFO: ReadonlyArray<{
  category: HandCategory;
  name: string;
  example: string;
}> = [
  { category: 8, name: "Straight Flush", example: "Five sequential cards, one suit" },
  { category: 7, name: "Four of a Kind", example: "Four cards of the same rank" },
  { category: 6, name: "Full House", example: "Three of a kind plus a pair" },
  { category: 5, name: "Flush", example: "Five cards of the same suit" },
  { category: 4, name: "Straight", example: "Five sequential cards, any suits" },
  { category: 3, name: "Three of a Kind", example: "Three cards of the same rank" },
  { category: 2, name: "Two Pair", example: "Two separate pairs" },
  { category: 1, name: "Pair", example: "Two cards of the same rank" },
  { category: 0, name: "High Card", example: "No pair or better" },
];

export interface HandValue {
  category: HandCategory;
  /**
   * Descending tiebreak ranks, always ace-high (2..14). Meaning is
   * category-specific — e.g. full house: `[tripRank, pairRank]`; two
   * pair: `[highPairRank, lowPairRank, kicker]`. Comparing two hands is
   * comparing `[category, ...ranks]` lexicographically, which
   * `compareHandValues` does directly.
   */
  ranks: number[];
  /** The exact 5 cards making up this hand — for showdown UI highlight. */
  cards: PieceId[];
}

/** Ace-high rank: 2-10 -> 2-10, J/Q/K/A -> 11/12/13/14. Do not reuse
 * `_shared/cards.ts`'s `rankValue`, which is ace-LOW for Rummy. */
export function pokerRank(rank: Rank): number {
  if (rank === "A") return 14;
  if (rank === "K") return 13;
  if (rank === "Q") return 12;
  if (rank === "J") return 11;
  return Number(rank);
}

function compareRankLists(a: readonly number[], b: readonly number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** >0 if `a` wins, <0 if `b` wins, 0 on an exact tie. */
export function compareHandValues(a: HandValue, b: HandValue): number {
  if (a.category !== b.category) return a.category - b.category;
  return compareRankLists(a.ranks, b.ranks);
}

/** Exactly 5 cards — throws otherwise, since a caller with a different
 * count almost certainly meant `bestOfSeven`. */
export function evaluateFive(cards: readonly Card[]): HandValue {
  if (cards.length !== 5) {
    throw new Error(`evaluateFive: expected exactly 5 cards, got ${cards.length}`);
  }
  const sorted = [...cards].sort((a, b) => pokerRank(b.rank) - pokerRank(a.rank));
  const ranks = sorted.map((c) => pokerRank(c.rank));
  const ids = sorted.map((c) => c.id);
  const isFlush = sorted.every((c) => c.suit === sorted[0]!.suit);

  // Straight detection, including the ace-low wheel (A-2-3-4-5) — the
  // one real special case here. Its straight-high for tiebreak purposes
  // is 5, not 14, so a wheel straight always loses to 6-high or better.
  const distinctDesc = [...new Set(ranks)].sort((a, b) => b - a);
  let straightHigh: number | null = null;
  if (distinctDesc.length === 5) {
    if (distinctDesc[0]! - distinctDesc[4]! === 4) straightHigh = distinctDesc[0]!;
    else if (distinctDesc.join(",") === "14,5,4,3,2") straightHigh = 5;
  }

  if (straightHigh !== null && isFlush) {
    return { category: 8, ranks: [straightHigh], cards: ids };
  }

  // Rank -> how many cards share it, then group ranks by that count
  // (highest count first, ties broken by rank) — this is what lets
  // quads/full-house/trips/two-pair/pair fall out of one shared shape
  // instead of five separate branches, each correctly ordered for its
  // own tiebreak rule for free.
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const groupRanks = groups.map(([r]) => r);
  const topCount = groups[0]![1];
  const secondCount = groups[1]?.[1] ?? 0;

  if (topCount === 4) return { category: 7, ranks: groupRanks, cards: ids };
  if (topCount === 3 && secondCount === 2) return { category: 6, ranks: groupRanks, cards: ids };
  if (isFlush) return { category: 5, ranks, cards: ids };
  if (straightHigh !== null) return { category: 4, ranks: [straightHigh], cards: ids };
  if (topCount === 3) return { category: 3, ranks: groupRanks, cards: ids };
  if (topCount === 2 && secondCount === 2) return { category: 2, ranks: groupRanks, cards: ids };
  if (topCount === 2) return { category: 1, ranks: groupRanks, cards: ids };
  return { category: 0, ranks, cards: ids };
}

/**
 * Best hand from any 5+ cards (2 hole + up to 5 community). Brute-forces
 * every 5-card combination — at most C(7,5) = 21 — and keeps the max via
 * `compareHandValues`. Trivial cost even called many times per bot
 * decision; no memoization needed.
 */
export function bestOfSeven(cards: readonly Card[]): HandValue {
  if (cards.length < 5) {
    throw new Error(`bestOfSeven: need at least 5 cards, got ${cards.length}`);
  }
  if (cards.length === 5) return evaluateFive(cards);

  let best: HandValue | null = null;
  for (const combo of fiveCardCombinations(cards)) {
    const value = evaluateFive(combo);
    if (!best || compareHandValues(value, best) > 0) best = value;
  }
  return best!;
}

/** Every 5-card combination of `cards`, in no particular order. */
function* fiveCardCombinations<T>(cards: readonly T[]): Generator<T[]> {
  const n = cards.length;
  const k = 5;
  const indices = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield indices.map((i) => cards[i]!);
    let i = k - 1;
    while (i >= 0 && indices[i] === i + n - k) i--;
    if (i < 0) return;
    indices[i] = indices[i]! + 1;
    for (let j = i + 1; j < k; j++) indices[j] = indices[j - 1]! + 1;
  }
}
