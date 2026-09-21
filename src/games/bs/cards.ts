/**
 * BS's card vocabulary: the ascending rank cycle, and the words for it.
 *
 * Thin on purpose. BS cares about exactly one property of a card — its
 * rank — and nothing at all about suit, strength or trumps, so almost
 * everything here defers to `_shared/cards`. The two things it does own
 * are the cycle (A, 2, 3 ... K, A ...) and the copy, because a claim is
 * spoken out loud: "three sevens" has to read as a sentence.
 */

import type { PieceId } from "@/engine/types";
import {
  HAND_DISPLAY_SUIT_ORDER,
  RANKS,
  SUITS,
  parseCard,
  rankValue,
  type Rank,
  type Suit,
} from "@/games/_shared/cards";

/** The rank a claim must name after one claiming `rank`. Wraps K -> A. */
export function nextRank(rank: Rank): Rank {
  return RANKS[(RANKS.indexOf(rank) + 1) % RANKS.length]!;
}

/**
 * How many plays away a rank is from the one on the table — 0 for the
 * current rank, 12 for the one that just went past.
 *
 * This is the whole of BS's card evaluation. A card you can claim
 * honestly next turn is worth keeping; one whose rank you have just
 * missed is twelve plays of dead weight, and is what a bot sheds when it
 * has to lie. See `bots.ts`.
 */
export function turnsUntil(rank: Rank, current: Rank): number {
  return (RANKS.indexOf(rank) - RANKS.indexOf(current) + RANKS.length) % RANKS.length;
}

/**
 * Nothing here ever needs a suit, so this is the only accessor bots use.
 *
 * Null for anything that is not a real card id, which in practice means one
 * of `playerView`'s stand-ins. A bot only ever asks this of its OWN hand,
 * where every id is real, so this is the safe failure rather than the
 * expected path — but `parseCard` does NOT reject a stand-in (it only guards
 * against jokers, and happily reads "??" as suit "?" of rank "?"), so the
 * check has to be made here or a counted rank of "?" quietly becomes a
 * plausible-looking wrong answer.
 */
export function rankOf(id: PieceId): Rank | null {
  let suit: Suit;
  let rank: Rank;
  try {
    ({ suit, rank } = parseCard(id));
  } catch {
    return null;
  }
  if (!SUITS.includes(suit) || !RANKS.includes(rank)) return null;
  return rank;
}

export function countOfRank(hand: readonly PieceId[], rank: Rank): number {
  return hand.reduce((n, id) => (rankOf(id) === rank ? n + 1 : n), 0);
}

const RANK_PLURALS: Record<Rank, string> = {
  A: "aces",
  "2": "twos",
  "3": "threes",
  "4": "fours",
  "5": "fives",
  "6": "sixes",
  "7": "sevens",
  "8": "eights",
  "9": "nines",
  "10": "tens",
  J: "jacks",
  Q: "queens",
  K: "kings",
};

/** "sevens" — what a claim is announced as. */
export function rankPlural(rank: Rank): string {
  return RANK_PLURALS[rank];
}

/** "Sevens" — for a heading or a badge. */
export function rankPluralTitle(rank: Rank): string {
  const word = RANK_PLURALS[rank];
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * The singular of each, written out rather than derived.
 *
 * A rule would have to know that "sixes" drops two letters and "threes"
 * drops one, which is a table with extra steps and one that gets
 * "thre" wrong on the way.
 */
const RANK_SINGULARS: Record<Rank, string> = {
  A: "ace",
  "2": "two",
  "3": "three",
  "4": "four",
  "5": "five",
  "6": "six",
  "7": "seven",
  "8": "eight",
  "9": "nine",
  "10": "ten",
  J: "jack",
  Q: "queen",
  K: "king",
};

/**
 * "one ace", "two aces" - the count and the rank agreeing.
 *
 * A claim is always announced with its count, and the count is one often
 * enough that "one aces" was on screen most turns.
 */
export function claimWords(count: number, rank: Rank): string {
  return `${countWord(count)} ${count === 1 ? RANK_SINGULARS[rank] : RANK_PLURALS[rank]}`;
}

const COUNT_WORDS = ["no", "one", "two", "three", "four"] as const;

/** Spelled out, because "3 sevens" and "37" look alike at a glance. */
export function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

/**
 * Display order for the viewer's OWN hand: grouped by rank, ascending.
 *
 * Deliberately not `sortHandForDisplay`, which groups by suit — right for
 * a trick-taking game and wrong here. A BS player selects cards by rank,
 * so the cards that answer "how many sevens do I have" belong next to
 * each other. That is not a hint about what to do: it is what anybody
 * holding physical cards arranges for themselves before the deal is over.
 */
export function handDisplayOrder(hand: readonly PieceId[]): PieceId[] {
  // Suit only ever breaks a tie within a rank, and it uses the app's own
  // display order (diamonds, clubs, hearts, spades) rather than deck order,
  // so there is one answer to "which suit comes first" across every game.
  const suitOf = (id: PieceId) => HAND_DISPLAY_SUIT_ORDER.indexOf(parseCard(id).suit);
  return [...hand].sort(
    (a, b) => rankValue(parseCard(a).rank) - rankValue(parseCard(b).rank) || suitOf(a) - suitOf(b),
  );
}
