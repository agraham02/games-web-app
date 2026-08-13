/**
 * Spades' own card-strength scale.
 *
 * Two independent house-rule toggles change how high a card ranks
 * (jokers added above everything; 2 of spades moved above the ace), and
 * they combine freely — four real toggle states. Rather than branching on
 * which combination is active everywhere a comparison happens, every card
 * maps onto ONE monotonic number and every comparison is just `>`. The
 * reserved bands above the ordinary ace-high range (14) are only ever
 * populated when the relevant toggle is on, so `cardStrength` alone is
 * enough to know both the ordering AND whether two cards are even
 * comparable at all (never call it across two different plain suits —
 * `trickTaking.ts`'s resolver pools same-suit/trump plays before it ever
 * asks for a strength).
 */

import type { PieceId } from "@/engine/types";
import type { Rng } from "@/engine/rng";
import {
  BIG_JOKER_ID,
  cardId,
  cardLabel,
  isJokerId,
  jokerLabel,
  LITTLE_JOKER_ID,
  parseCard,
  RANKS,
  SUITS,
  type Rank,
  type Suit,
} from "@/games/_shared/cards";

export interface SpadesRules {
  jokers: boolean;
  twoOfSpadesHigh: boolean;
}

/** Ace-high 2..14 — the baseline every trick-taking game needs and
 * `_shared/cards.ts`'s `rankValue` deliberately doesn't provide (that one
 * is ace-low, "games wanting ace-high remap themselves"). Local to
 * Spades since nothing else needs it yet. */
function plainRankValue(rank: Rank): number {
  return rank === "A" ? 14 : RANKS.indexOf(rank) + 1;
}

/**
 * One monotonic strength scale folding both toggles in without branching
 * on their combination:
 *
 *   neither      : ...2♠(2) ... K♠(13) A♠(14)
 *   2♠-high only : ...3♠(3) ... A♠(14) 2♠(998)
 *   jokers only  : ...2♠(2) ... A♠(14) LittleJoker(999) BigJoker(1000)
 *   both         : ...3♠(3) ... A♠(14) 2♠(998) LittleJoker(999) BigJoker(1000)
 *
 * Only 2♠ is ever elevated (Barmore-style) — 2♦ is untouched by either
 * toggle, same as every other non-spade card.
 */
export function cardStrength(id: PieceId, rules: SpadesRules): number {
  if (id === BIG_JOKER_ID) return 1000;
  if (id === LITTLE_JOKER_ID) return 999;
  const { suit, rank } = parseCard(id);
  if (suit === "S" && rules.twoOfSpadesHigh && rank === "2") return 998;
  return plainRankValue(rank);
}

/** Spades is always trump; jokers count as spades for follow-suit and
 * "spades broken" purposes. Checked before `parseCard` so a joker id
 * never reaches it. */
export function isTrump(id: PieceId): boolean {
  return isJokerId(id) || parseCard(id).suit === "S";
}

/**
 * The suit a card counts as for FOLLOW-SUIT purposes — a joker reports
 * "S" here, exactly like a real spade, since "jokers count as spades for
 * follow-suit" is the whole rule. Use `jokerLabel`/`isJokerId` instead
 * when a card's literal identity (for display, say) is what's needed.
 */
export function effectiveSuit(id: PieceId): Suit {
  return isTrump(id) ? "S" : parseCard(id).suit;
}

/**
 * Always 52 ids / 13 per hand. When jokers are enabled they swap in for
 * 2♣ and 2♥ (Barmore rules) — the deck never grows past 52.
 */
export function spadesDeck(rules: SpadesRules): PieceId[] {
  const ids: PieceId[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      if (rules.jokers && (suit === "C" || suit === "H") && rank === "2") continue;
      ids.push(cardId(suit, rank));
    }
  }
  if (rules.jokers) ids.push(BIG_JOKER_ID, LITTLE_JOKER_ID);
  return ids;
}

export function shuffledSpadesDeck(rng: Rng, rules: SpadesRules): PieceId[] {
  return rng.shuffle(spadesDeck(rules));
}

/** Human-readable, for announcements — jokers included. */
export function spadesCardLabel(id: PieceId): string {
  const joker = jokerLabel(id);
  if (joker) return joker === "big" ? "the Big Joker" : "the Little Joker";
  return cardLabel(parseCard(id));
}
