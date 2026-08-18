/**
 * Pure queries over SpadesState.
 *
 * Split out from rules.ts so bots.ts, the play screen and rules.ts itself
 * can all share them without a cycle — the same reason dominoes/state.ts
 * and lrc/state.ts exist.
 */

import type { PieceId, SeatId } from "@/engine/types";
import { partnerOf, teamOf, teammates } from "@/games/_shared/partnership";
import { canLeadTrump, legalFollows, type TrickCard } from "@/games/_shared/trickTaking";
import { effectiveSuit, isTrump } from "./cards";
import type { Bid, SpadesState } from "./types";

/** Stands in for a card the viewer isn't allowed to see — same
 * same-length-run discipline as Dominoes' HIDDEN_TILE, so a bot still
 * knows how many cards a hand holds without knowing which. Never
 * collides with a real card id (`${suit}${rank}`) or a joker id
 * ("XB"/"XL"). */
export const HIDDEN_CARD: PieceId = "??";

export function isHidden(id: PieceId): boolean {
  return id === HIDDEN_CARD;
}

/** Partnership seat arithmetic now lives in `_shared/partnership.ts` —
 * Caribbean dominoes seats its partners identically, and there is no
 * Spades in `(seat + 2) % 4`. Re-exported here so the dozen call sites
 * across this game keep reading from the module they already know. */
export { partnerOf, teamOf, teammates };

/** Turn order runs seat -> seat+1, matching every other game in this app. */
export function nextSeat(seat: SeatId): SeatId {
  return (seat + 1) % 4;
}

/** Points this bid promises toward its team's numeric trick target, and
 * toward "the Board" (the team minimum-4 rule) — Nil and Blind Nil both
 * contribute 0 to either, since neither promises any particular number
 * of tricks. */
export function bidContribution(bid: Bid | null): number {
  if (!bid || bid.nil) return 0;
  return bid.tricks;
}

export function isSecondBidder(state: SpadesState, seat: SeatId): boolean {
  return state.bids[partnerOf(seat)] != null;
}

/**
 * The lowest numeric bid this seat may make right now — 0 unless this is
 * the team's SECOND bidder, in which case it's whatever brings the
 * pair's combined numeric bid up to 4 (never negative, since 13 is
 * always enough room). Nil is legal exactly when this is 0 — a first
 * bidder always has it available; a second bidder only if their partner
 * already contributed >= 4 alone.
 */
export function minLegalBid(state: SpadesState, seat: SeatId): number {
  if (!isSecondBidder(state, seat)) return 0;
  const partnerBid = state.bids[partnerOf(seat)] ?? null;
  return Math.max(0, 4 - bidContribution(partnerBid));
}

/** A team trailing the other by >= 100 points may bid blind this round.
 * `(seat + 1) % 4` always lands on an opposing seat regardless of which
 * seat is asking (teams alternate every seat), and scores are mirrored
 * within a team, so this is symmetric by construction — a seat and its
 * partner always agree on their own eligibility. */
export function isBlindEligible(scores: Record<SeatId, number>, seat: SeatId): boolean {
  const opponent = (seat + 1) % 4;
  return (scores[opponent] ?? 0) - (scores[seat] ?? 0) >= 100;
}

/** True while a blind-eligible seat hasn't yet chosen to look at its
 * hand or locked in a blind bid — the condition that keeps a seat's OWN
 * hand rendered face-down to itself. */
export function isHiddenFromSelf(state: SpadesState, seat: SeatId): boolean {
  return Boolean(state.blindEligible[seat]) && !state.handRevealed[seat];
}

/**
 * True once this seat's PARTNER has already committed the team to
 * bidding blind — the synchronized team rule: whoever bids first for a
 * blind-eligible team decides for both partners, so a seat whose
 * partner already went blind no longer has "look at my hand" as an
 * option; they must also bid blind (their own choice of nil vs numeric,
 * and their own number, but never "look"). The other direction — a
 * partner who already LOOKED — doesn't need a query here at all: their
 * hand-revealed flip is applied directly in `reduceBid` (see its
 * doc), so `isHiddenFromSelf` above already answers false for them by
 * the time it matters.
 */
export function mustBidBlind(state: SpadesState, seat: SeatId): boolean {
  return Boolean(state.bids[partnerOf(seat)]?.blind);
}

function trickCard(id: PieceId): TrickCard {
  return { id, suit: effectiveSuit(id), isTrump: isTrump(id) };
}

/**
 * Cards `seat` may legally play right now: follow suit if able, and
 * honour the spades-broken lead restriction when leading.
 */
export function legalPlays(state: SpadesState, seat: SeatId): PieceId[] {
  const hand = (state.hands[seat] ?? []).filter((id) => !isHidden(id));
  const cards = hand.map(trickCard);

  if (state.trick.length === 0) {
    const canTrump = canLeadTrump(cards, state.trumpBroken);
    const legal = canTrump ? cards : cards.filter((c) => !c.isTrump);
    // Defensive: canLeadTrump already allows an all-trump hand to lead
    // trump even unbroken, so `legal` empties out only if the hand
    // itself is empty — never leave zero plays on the table regardless.
    return (legal.length > 0 ? legal : cards).map((c) => c.id);
  }

  return legalFollows(cards, state.ledSuit).map((c) => c.id);
}
