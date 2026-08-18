/**
 * Pure queries over `RummyState`. No reducers, no events, no React.
 *
 * Split out from `rules.ts` for the same reason `spades/state.ts` is:
 * `bots.ts` needs most of this and `rules.ts` needs all of it, and a
 * single module holding both the questions and the transitions makes
 * that a cycle.
 */

import type { PieceId, SeatId } from "@/engine/types";
import { HERO } from "@/engine/types";
import { hashString } from "@/engine/rng";
import { HAND_DISPLAY_SUIT_ORDER, RANKS, parseCard } from "@/games/_shared/cards";
import {
  MIN_MELD,
  canExtend,
  cardsValue,
  contributorOf,
  findCompletion,
  handDisplayOrder,
  type Meld,
} from "./cards";
import type { RummyState } from "./types";

export const MIN_SEATS = 2;
export const MAX_SEATS = 6;
export const DEFAULT_TARGET = 250;
export const DECK_SIZE = 52;

export function seatsOf(state: RummyState): SeatId[] {
  return Array.from({ length: state.seats }, (_, i) => i);
}

export function nextSeat(state: RummyState, seat: SeatId): SeatId {
  return (seat + 1) % state.seats;
}

/* ============================================================
   Deal size — the dealer's own choice, every round
   ============================================================ */

/**
 * The largest hand the deck can serve every seat, rounded down to an
 * ODD count.
 *
 * Odd deliberately: a set is 3-4 and a run is 3+, and an even hand size
 * makes "pair everything off" a marginally better opening shape than it
 * should be. Odd removes that parity quirk without needing a rule about
 * it. 2 seats -> 25, 3 -> 17, 4 -> 13, 5 -> 9, 6 -> 7.
 */
export function maxDealSize(seats: number): number {
  const fits = Math.floor(DECK_SIZE / seats);
  return Math.max(1, fits % 2 === 1 ? fits : fits - 1);
}

export function validDealSizes(seats: number): number[] {
  const max = maxDealSize(seats);
  const sizes: number[] = [];
  for (let n = 1; n <= max; n += 2) sizes.push(n);
  return sizes;
}

/* ============================================================
   Scoring
   ============================================================ */

/** Points still stuck in a seat's hand, which count AGAINST them. */
export function handValue(state: RummyState, seat: SeatId): number {
  return cardsValue(state.hands[seat] ?? []);
}

/**
 * Points this seat put on the board — every card in every meld whose
 * contributor is them, whether they laid the meld or hit someone else's.
 * This is why `Placement.seat` on a board piece is the per-card
 * contributor rather than the meld's owner.
 */
export function contributedValue(state: RummyState, seat: SeatId): number {
  let total = 0;
  for (const meld of state.melds) {
    for (const card of meld.cards) {
      if (contributorOf(meld, card) === seat) total += cardsValue([card]);
    }
  }
  return total;
}

/* ============================================================
   Legality
   ============================================================ */

export function meldById(state: RummyState, meldId: number): Meld | undefined {
  return state.melds.find((m) => m.id === meldId);
}

/**
 * Which pickup depths are legal for this seat right now.
 *
 * `depth` counts from the TOP of the pile, so depth 1 is the top card
 * alone. Every depth — including 1 — must let the DEEPEST card taken
 * complete a brand-new meld using at least one real hand card (see
 * `findCompletion`'s doc for the exploit that requirement closes).
 * The cards riding along above the deepest one may help, since they join
 * the hand in the same motion.
 */
export function legalDrawDepths(state: RummyState, seat: SeatId): number[] {
  const hand = state.hands[seat] ?? [];
  const pile = state.discard;
  const depths: number[] = [];

  for (let depth = 1; depth <= pile.length; depth++) {
    const taken = pile.slice(pile.length - depth);
    const deepest = taken[0]!;
    const riding = taken.slice(1);
    if (findCompletion(deepest, hand, riding)) depths.push(depth);
  }
  return depths;
}

/**
 * The single meld a just-discarded card could extend, or null. Resolved
 * once, when the window opens.
 */
export function claimableMeld(state: RummyState, card: PieceId): Meld | null {
  return state.melds.find((m) => canExtend(m.cards, card)) ?? null;
}

/**
 * Every seat that could claim `card` — anyone but the discarder. Melds
 * are not owned for extension purposes, so capability is universal;
 * that is exactly why the winner among them must not be turn order
 * (see `claimReactions`).
 */
export function eligibleClaimSeats(state: RummyState, discarder: SeatId): SeatId[] {
  return seatsOf(state).filter((s) => s !== discarder);
}

/**
 * How long each eligible bot takes to spot a claim, soonest first.
 *
 * The whole point of the claim is that it is a RACE — the player and
 * every bot are looking at the same card at the same moment, and it goes
 * to whoever gets there first. So each bot draws a reaction time and the
 * fastest one wins, exactly as a table full of people would resolve it.
 *
 * Derived from a plain string hash rather than an `Rng` for the same
 * reason `claimPick` was: `reduce` is deliberately rng-free (only
 * `setup`, `startRound` and a bot's own `choose` ever receive real-world
 * inputs), and a claim arises inside `reduce`. Hashing data already in
 * hand keeps the whole engine replayable from its seed.
 *
 * `CLAIM_REACTION_MIN` is NOT the 500ms that first suggested itself. A
 * bot arriving at 0.5s is indistinguishable from the bug this feature was
 * fixed for once already — "literally as soon as I discarded it, a bot
 * claimed it" — because the button has to be *seen* before it can be
 * raced for. A second and a bit is the floor at which there is genuinely
 * something to react to.
 */
export const CLAIM_REACTION_MIN = 1100;
export const CLAIM_REACTION_MAX = 5500;

export function claimReactions(
  state: RummyState,
  card: PieceId,
  discarder: SeatId,
): Array<{ seat: SeatId; ms: number }> {
  const span = CLAIM_REACTION_MAX - CLAIM_REACTION_MIN;
  return eligibleClaimSeats(state, discarder)
    .filter((s) => s !== HERO)
    .map((seat) => ({
      seat,
      ms: CLAIM_REACTION_MIN + (hashString(`${card}|${state.round}|${discarder}|${seat}`) % span),
    }))
    .sort((a, b) => a.ms - b.ms || a.seat - b.seat);
}

/** Total cards held across every seat — the stalemate checkpoint's metric. */
export function totalHandCards(state: RummyState): number {
  return seatsOf(state).reduce((n, s) => n + (state.hands[s]?.length ?? 0), 0);
}

/**
 * Melds this seat could lay right now from their own hand, as card
 * lists. Used by bots and by the page's action bar; deliberately only
 * looks for minimal melds, since a bot laying 3 and hitting the 4th
 * next turn scores identically.
 */
export function layableMelds(hand: readonly PieceId[]): PieceId[][] {
  const found: PieceId[][] = [];
  const seen = new Set<string>();
  for (const card of hand) {
    const meld = findCompletion(card, hand);
    if (!meld || meld.length < MIN_MELD) continue;
    const key = [...meld].sort().join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(meld);
  }
  return found;
}

/**
 * Every meld this seat could lay that DISCHARGES a pickup obligation —
 * i.e. contains `card`.
 *
 * Seeded from a direct `findCompletion` on the obligation card as well
 * as the general scan, because the two can disagree: `layableMelds`
 * only keeps one answer per starting card, so a meld containing the
 * obligation card can be shadowed by a different meld found first. An
 * empty result here would livelock the runtime — a bot would be asked
 * for an action, have no legal one, return an illegal one, `reduce`
 * would no-op, and the same seat would be asked again forever — so it
 * is worth the belt-and-braces of asking twice.
 */
export function mandatoryMelds(hand: readonly PieceId[], card: PieceId): PieceId[][] {
  const out: PieceId[][] = [];
  const seen = new Set<string>();
  const add = (meld: PieceId[] | null) => {
    if (!meld || meld.length < MIN_MELD || !meld.includes(card)) return;
    const key = [...meld].sort().join(",");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(meld);
  };

  add(findCompletion(card, hand));
  for (const meld of layableMelds(hand)) add(meld);
  return out;
}

/** Every (meld, card) pair this seat could lay off onto the board. */
export function layoffs(
  state: RummyState,
  hand: readonly PieceId[],
): Array<{ meldId: number; card: PieceId }> {
  const out: Array<{ meldId: number; card: PieceId }> = [];
  for (const meld of state.melds) {
    for (const card of hand) {
      if (canExtend(meld.cards, card)) out.push({ meldId: meld.id, card });
    }
  }
  return out;
}

/** Does this seat still owe a mandatory meld from a discard pickup? */
export function owesMandatory(state: RummyState): boolean {
  return state.mandatory !== null;
}

/* ============================================================
   Hand sort — a view preference, never engine state
   ============================================================ */

export type HandSort = "smart" | "suit" | "rank" | "dealt";

export const HAND_SORTS: ReadonlyArray<{ id: HandSort; label: string; hint: string }> = [
  { id: "smart", label: "Smart", hint: "Groups melds and near-melds together" },
  { id: "suit", label: "By suit", hint: "Suit, then rank within it" },
  { id: "rank", label: "By rank", hint: "Rank, then suit within it" },
  { id: "dealt", label: "As dealt", hint: "The order the cards reached you" },
];

/**
 * Reorders a hand for DISPLAY. Never mutates, and never touches
 * `state.hands` — the engine's own order stays authoritative so replays
 * and bot behaviour are unaffected by how a player likes to hold cards.
 *
 * "Smart" pulls complete melds to the front, each kept contiguous, then
 * falls back to suit order for the rest. It is the one mode that reads
 * the cards' meaning rather than just their faces, which is why it is
 * offered as an explicit choice — it does surface something the player
 * could work out themselves.
 */
export function sortHand(hand: readonly PieceId[], mode: HandSort): PieceId[] {
  if (mode === "dealt") return [...hand];
  if (mode === "rank") {
    return [...hand].sort(
      (a, b) =>
        RANKS.indexOf(parseCard(a).rank) - RANKS.indexOf(parseCard(b).rank) ||
        HAND_DISPLAY_SUIT_ORDER.indexOf(parseCard(a).suit) -
          HAND_DISPLAY_SUIT_ORDER.indexOf(parseCard(b).suit),
    );
  }
  if (mode === "suit") return handDisplayOrder(hand);

  // Smart: peel off complete melds greedily, keeping each contiguous,
  // then lay the leftovers out in ordinary suit order.
  const remaining = [...hand];
  const grouped: PieceId[] = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const card of remaining) {
      const meld = findCompletion(card, remaining);
      if (!meld) continue;
      for (const id of meld) {
        const i = remaining.indexOf(id);
        if (i >= 0) remaining.splice(i, 1);
      }
      grouped.push(...meld);
      progress = true;
      break;
    }
  }
  return [...grouped, ...handDisplayOrder(remaining)];
}

/**
 * Is the hero the one being asked to decide right now? Used by the page
 * to decide whether to run its claim-window countdown.
 */
export function heroMustAnswerClaim(state: RummyState): boolean {
  return state.claimWindow !== null && state.claimWindow.discarder !== HERO;
}
