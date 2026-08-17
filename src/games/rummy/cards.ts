/**
 * Rummy 500's card model: point values, meld shapes, and the one piece
 * of genuinely fiddly logic in this game — how a run reads its own ace.
 *
 * Deliberately its own module rather than additions to
 * `_shared/cards.ts`, for the same reason `spades/cards.ts` is: the
 * scoring scale and the meld rules here are house rules, not facts about
 * a deck of cards.
 */

import type { PieceId, SeatId } from "@/engine/types";
import type { Rng } from "@/engine/rng";
import {
  HAND_DISPLAY_SUIT_ORDER,
  RANKS,
  SUITS,
  cardId,
  parseCard,
  rankValue,
  standardDeck,
  type Rank,
  type Suit,
} from "@/games/_shared/cards";

/** Minimum cards in a meld. Applies to the mandatory meld a discard
 *  pickup forces too — a pickup that can only complete a PAIR is not a
 *  legal pickup at all. */
export const MIN_MELD = 3;

/** Ace's value when a run has committed to reading it high. */
const ACE_HIGH = 14;

/**
 * Rummy 500 point values: 2-9 are 5, TEN and the face cards are 10, ace
 * is 15.
 *
 * The ten counting as ten is the part that is easy to get wrong — it
 * looks like a number card and reads like one in "number cards are
 * five", but it scores with the pictures. An earlier version of this
 * scored it 5, which quietly under-counted every hand and every board
 * containing one.
 *
 * NOT `_shared/cards.ts`'s `pipValue`, despite that function's comment
 * claiming to be "Rummy 500 deadwood values" — it implements the
 * standard-Gin scale (ace 1, pip = face value), a different game's
 * scoring entirely.
 */
export function cardPoints(rank: Rank): number {
  if (rank === "A") return 15;
  if (rank === "10" || rank === "J" || rank === "Q" || rank === "K") return 10;
  return 5;
}

export function cardValue(id: PieceId): number {
  return cardPoints(parseCard(id).rank);
}

export function cardsValue(ids: readonly PieceId[]): number {
  return ids.reduce((sum, id) => sum + cardValue(id), 0);
}

/** One standard 52-card deck. No jokers — Rummy 500 here plays clean. */
export function rummyDeck(): PieceId[] {
  return standardDeck().map((c) => c.id);
}

export function shuffledRummyDeck(rng: Rng): PieceId[] {
  return rng.shuffle(rummyDeck());
}

export function suitOf(id: PieceId): Suit {
  return parseCard(id).suit;
}

export function rankOf(id: PieceId): Rank {
  return parseCard(id).rank;
}

/* ============================================================
   Meld shapes
   ============================================================ */

/**
 * A run's committed reading of its own ace, plus its TRUE boundaries in
 * that reading's value space.
 *
 * The ace is low OR high, never both — there is no wrap-around K-A-2.
 * Ace-low is tried first and ace-high only as a fallback, so a run that
 * reads contiguously both ways (impossible for a real run, but the
 * ordering matters for a 2-card intermediate) has one settled answer.
 *
 * `low`/`high` are the reason this returns a structure rather than a
 * boolean: for a run laid as J-Q-K-A the ace's raw `rankValue` is 1, so
 * a naive `Math.min` over raw values reports the run's low end as "1"
 * and happily accepts a 2 to extend it — producing K-A-2 by the back
 * door. Extension must always ask THIS for the boundary, never recompute
 * one from raw ranks.
 */
export interface RunReading {
  aceHigh: boolean;
  low: number;
  high: number;
}

function valueIn(id: PieceId, aceHigh: boolean): number {
  const { rank } = parseCard(id);
  return aceHigh && rank === "A" ? ACE_HIGH : rankValue(rank);
}

function contiguousBounds(values: readonly number[]): { low: number; high: number } | null {
  const sorted = [...values].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! !== sorted[i - 1]! + 1) return null;
  }
  return { low: sorted[0]!, high: sorted[sorted.length - 1]! };
}

/** The run reading these cards commit to, or null if they aren't a run. */
export function runReading(cards: readonly PieceId[]): RunReading | null {
  if (cards.length < MIN_MELD) return null;
  const suit = suitOf(cards[0]!);
  if (!cards.every((id) => suitOf(id) === suit)) return null;

  const low = contiguousBounds(cards.map((id) => valueIn(id, false)));
  if (low) return { aceHigh: false, ...low };

  // Only worth retrying if there's actually an ace to re-read.
  if (!cards.some((id) => rankOf(id) === "A")) return null;
  const high = contiguousBounds(cards.map((id) => valueIn(id, true)));
  if (high) return { aceHigh: true, ...high };

  return null;
}

export function isRun(cards: readonly PieceId[]): boolean {
  return runReading(cards) !== null;
}

/** Same rank, 3-4 cards, every suit distinct. */
export function isSet(cards: readonly PieceId[]): boolean {
  if (cards.length < MIN_MELD || cards.length > 4) return false;
  const rank = rankOf(cards[0]!);
  if (!cards.every((id) => rankOf(id) === rank)) return false;
  return new Set(cards.map(suitOf)).size === cards.length;
}

export function isValidMeld(cards: readonly PieceId[]): boolean {
  return isSet(cards) || isRun(cards);
}

/**
 * A SET nobody can ever add to again, which at the table gets turned face
 * down — the cards that are finished being looked at.
 *
 * The test is "is this rank exhausted", NOT "does this meld hold four
 * cards", and the difference is a real position rather than a nicety.
 * Three aces are down as a set and the fourth is committed to an
 * A-2-3 run: the set holds only three cards, but nothing can ever join
 * it, because the one card that could is laid and laid cards never move.
 * The run itself stays face up — it can still take a 4.
 *
 * `laid` is every card currently on the board, from every meld. This
 * cannot be answered from a meld's own cards alone, which is exactly why
 * the first version got the case above wrong.
 *
 * Runs are excluded deliberately. An ace-to-king run is closed too, but
 * that is not what gets flipped in a real game: the gesture means "all
 * four of this rank are down", and a run stays something players read
 * along. `canExtend` already refuses both, so this is purely how the
 * meld is DRAWN.
 */
export function isDeadMeld(cards: readonly PieceId[], laid: ReadonlySet<PieceId>): boolean {
  if (!isSet(cards)) return false;
  const rank = rankOf(cards[0]!);
  return SUITS.every((suit) => laid.has(cardId(suit, rank)));
}

/** Every card on the board, which is what `isDeadMeld` measures against. */
export function laidCards(melds: ReadonlyArray<{ cards: readonly PieceId[] }>): Set<PieceId> {
  return new Set(melds.flatMap((m) => m.cards));
}

/**
 * Can `card` be added to this existing meld?
 *
 * A set takes a matching rank in a suit not already represented. A run
 * takes the card immediately below its low end or above its high end —
 * measured against the run's own committed reading (see `RunReading`),
 * which is what makes attaching an ace above a King work while a 2 after
 * that same ace correctly does not.
 */
export function canExtend(meld: readonly PieceId[], card: PieceId): boolean {
  if (meld.includes(card)) return false;

  if (isSet(meld)) {
    if (meld.length >= 4) return false;
    if (rankOf(card) !== rankOf(meld[0]!)) return false;
    return !meld.some((id) => suitOf(id) === suitOf(card));
  }

  const run = runReading(meld);
  if (!run) return false;
  if (suitOf(card) !== suitOf(meld[0]!)) return false;

  const asIs = valueIn(card, run.aceHigh);
  if (asIs === run.low - 1 || asIs === run.high + 1) return true;

  // The one re-reading case: an ace joining a run whose high end is
  // already the King. The run was ace-low (or aceless) until now and
  // commits to ace-high by accepting this card. Guarded on the card
  // actually being an ace so nothing else can trigger a re-read.
  return rankOf(card) === "A" && !run.aceHigh && run.high === rankValue("K");
}

/**
 * An order in which every one of `cards` can be laid onto `meld`, or
 * null if some card never fits however the rest are arranged.
 *
 * Order is not a nicety here, it is the whole problem. Laying a 9 and a
 * 10 onto a J-Q-K run only works 10 first: the 9 does not touch the run
 * until the 10 has extended its low end. Asking the player to work that
 * out and tap twice in the right sequence is busywork — they can see
 * both cards fit, and so can this.
 *
 * Greedy is exact for melds. A set only ever accepts same-rank cards in
 * unused suits, so order never matters; a run only grows at its two
 * ends, so at each step at most one card of each end is playable and
 * taking it can never block the others.
 */
export function orderExtensions(
  meld: readonly PieceId[],
  cards: readonly PieceId[],
): PieceId[] | null {
  let grown = [...meld];
  const remaining = [...cards];
  const ordered: PieceId[] = [];

  while (remaining.length > 0) {
    const i = remaining.findIndex((c) => canExtend(grown, c));
    if (i === -1) return null;
    const [card] = remaining.splice(i, 1);
    ordered.push(card!);
    grown = [...grown, card!];
  }
  return ordered;
}

/**
 * Display order for a meld's cards — NOT their stored order.
 *
 * A meld's `cards` array is an append-only log: extension order is real
 * information (it is what `hitBy` lookups and scoring attribution are
 * keyed against), so it must not be re-sorted in place. Rendering that
 * log order directly is what made a run laid 9-10 then hit with J
 * display as "9-J-10". Sort for display, separately, every time.
 */
export function meldDisplayOrder(cards: readonly PieceId[]): PieceId[] {
  const run = runReading(cards);
  if (run) {
    return [...cards].sort((a, b) => valueIn(a, run.aceHigh) - valueIn(b, run.aceHigh));
  }
  return [...cards].sort(
    (a, b) =>
      HAND_DISPLAY_SUIT_ORDER.indexOf(suitOf(a)) - HAND_DISPLAY_SUIT_ORDER.indexOf(suitOf(b)),
  );
}

/** Short label for a meld — "7♠8♠9♠", "Q♦Q♣Q♥". Used in pod strips. */
export function meldLabel(cards: readonly PieceId[]): string {
  const glyph: Record<Suit, string> = { S: "♠", H: "♥", D: "♦", C: "♣" };
  const ordered = meldDisplayOrder(cards);
  if (isSet(ordered)) {
    return `${rankOf(ordered[0]!)}${ordered.map((id) => glyph[suitOf(id)]).join("")}`;
  }
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  return `${rankOf(first)}-${rankOf(last)}${glyph[suitOf(first)]}`;
}

/* ============================================================
   Completion search — what a discard pickup would let you meld
   ============================================================ */

/**
 * Could `target` be melded into a brand-new valid meld, using at least
 * one card from `hand` and optionally any of `alsoAvailable`?
 *
 * The **at least one from `hand`** requirement is the whole point, and
 * it is load-bearing rather than a nicety. Without it, a discard pile
 * that happens to hold three aces in a row lets a player dig to the
 * deepest one and "complete" a set out of the other two aces *still in
 * the pile* — zero cards from their actual hand involved. That is a real
 * reported exploit, not a hypothetical: the pile coincidentally holding
 * a meld next to itself proves nothing about whether the player can use
 * the card.
 *
 * Returns the cards of a qualifying meld (target included) or null.
 * Any meld is searched, not just 3-card ones: a hand card can sit at the
 * far end of a longer run (target 5, hand card 8, pile 6-7) where every
 * 3-card window containing the target avoids it entirely.
 */
export function findCompletion(
  target: PieceId,
  hand: readonly PieceId[],
  alsoAvailable: readonly PieceId[] = [],
): PieceId[] | null {
  const handSet = new Set(hand);
  const pool = [...hand, ...alsoAvailable].filter((id) => id !== target);

  // --- Set: target plus 2-3 same-rank cards in distinct, unused suits.
  const rank = rankOf(target);
  const bySuit = new Map<Suit, PieceId>();
  for (const id of pool) {
    if (rankOf(id) !== rank) continue;
    const s = suitOf(id);
    // Prefer a hand card when both a hand and a pile copy of the same
    // suit exist, so the hand-card requirement is satisfied whenever it
    // possibly can be.
    if (!bySuit.has(s) || handSet.has(id)) bySuit.set(s, id);
  }
  bySuit.delete(suitOf(target));
  const setMates = [...bySuit.values()];
  if (setMates.length >= 2) {
    // Hand cards first, so the two we take always include one if any
    // exist at all — the whole hand-card requirement rides on this.
    const ordered = [
      ...setMates.filter((id) => handSet.has(id)),
      ...setMates.filter((id) => !handSet.has(id)),
    ];
    if (handSet.has(ordered[0]!)) {
      const meld = [target, ordered[0]!, ordered[1]!];
      if (isSet(meld)) return meld;
    }
  }

  // --- Run: scan every contiguous window containing the target, in each
  // ace reading independently (an ace takes exactly one value per
  // reading, so no window can ever wrap K-A-2).
  const suit = suitOf(target);
  for (const aceHigh of [false, true]) {
    const byValue = new Map<number, PieceId>();
    for (const id of pool) {
      if (suitOf(id) !== suit) continue;
      const v = valueIn(id, aceHigh);
      if (!byValue.has(v) || handSet.has(id)) byValue.set(v, id);
    }
    const tv = valueIn(target, aceHigh);
    byValue.set(tv, target);

    // Maximal contiguous window around the target.
    let lo = tv;
    let hi = tv;
    while (byValue.has(lo - 1)) lo -= 1;
    while (byValue.has(hi + 1)) hi += 1;

    // `i` walks every window start at or before the target, `j` every
    // end at or after it — so every window considered contains it.
    for (let i = lo; i <= tv; i++) {
      for (let j = tv; j <= hi; j++) {
        if (j - i + 1 < MIN_MELD) continue;
        const window: PieceId[] = [];
        for (let v = i; v <= j; v++) window.push(byValue.get(v)!);
        if (!window.some((id) => id !== target && handSet.has(id))) continue;
        if (isRun(window)) return window;
      }
    }
  }

  return null;
}

/* ============================================================
   Melds on the board
   ============================================================ */

export interface Meld {
  id: number;
  /** Who laid it. Never changes, even as other seats hit it. */
  owner: SeatId;
  /** Append-only log — see `meldDisplayOrder`. */
  cards: PieceId[];
  /** Per-card contributor override for a card added by a non-owner. */
  hitBy: Record<PieceId, SeatId>;
}

/** Who a given card in a meld scores for. */
export function contributorOf(meld: Meld, card: PieceId): SeatId {
  return meld.hitBy[card] ?? meld.owner;
}

/** Hand sort for display — suit-grouped, ascending rank within a suit. */
export function handDisplayOrder(hand: readonly PieceId[]): PieceId[] {
  return [...hand].sort(
    (a, b) =>
      HAND_DISPLAY_SUIT_ORDER.indexOf(suitOf(a)) -
        HAND_DISPLAY_SUIT_ORDER.indexOf(suitOf(b)) ||
      RANKS.indexOf(rankOf(a)) - RANKS.indexOf(rankOf(b)),
  );
}
