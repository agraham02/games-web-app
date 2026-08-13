/**
 * Spades bots.
 *
 * Two decision points per round, unlike Dominoes' one: a bid (and,
 * before that, a blind-eligible seat's look-or-go-blind choice) and a
 * trick play. Every bot is handed `playerView(state, seat)` before
 * either — `useGameRuntime.revealBotTurn` guarantees this — so a
 * blind-eligible bot's own hand is genuinely redacted while it decides
 * whether to look, exactly like a hero's would be. That is what makes
 * "a blind bot's decision reads only the score deficit" true by
 * construction rather than a promise this file has to keep on its own.
 */

import type { BotDifficulty, BotStrategy, PieceId, SeatId } from "@/engine/types";
import type { Rng } from "@/engine/rng";
import { isJokerId, parseCard, cardId } from "@/games/_shared/cards";
import { resolveTrick } from "@/games/_shared/trickTaking";
import { cardStrength, effectiveSuit, isTrump, type SpadesRules } from "./cards";
import { isHiddenFromSelf, legalPlays, minLegalBid, partnerOf } from "./state";
import type { SpadesAction, SpadesState } from "./types";

function bestOf(items: readonly PieceId[], score: (id: PieceId) => number, rng: Rng): PieceId {
  let best = -Infinity;
  let tied: PieceId[] = [];
  for (const id of items) {
    const s = score(id);
    if (s > best) {
      best = s;
      tied = [id];
    } else if (s === best) {
      tied.push(id);
    }
  }
  return rng.pick(tied);
}

/**
 * A rough hand-strength estimate for bidding, in tricks. Not claimed
 * optimal — the same spirit as Dominoes' `judge()`: specific, tunable,
 * and good enough to make a bid feel considered rather than random.
 *
 *  - jokers are near-certain tricks;
 *  - spade LENGTH beyond a short holding wins tricks on its own, even
 *    with low cards, via trump control;
 *  - a high spade (Queen or better, honouring both house-rule toggles
 *    via `cardStrength` itself) is worth close to a full trick;
 *  - an off-suit ace is close to a sure trick; a lone king much less so,
 *    a supported one (2+ cards in the suit) more so.
 */
function estimateTricks(hand: readonly PieceId[], rules: SpadesRules): number {
  let jokers = 0;
  const bySuit: Record<"S" | "H" | "D" | "C", PieceId[]> = { S: [], H: [], D: [], C: [] };
  for (const id of hand) {
    if (isJokerId(id)) {
      jokers++;
      continue;
    }
    bySuit[parseCard(id).suit].push(id);
  }

  let total = jokers;
  const spadeCount = bySuit.S.length + jokers;
  total += Math.max(0, spadeCount - 2) * 0.4;

  const queenOfSpades = cardStrength(cardId("S", "Q"), rules);
  for (const id of bySuit.S) {
    if (cardStrength(id, rules) >= queenOfSpades) total += 0.75;
  }

  for (const suit of ["H", "D", "C"] as const) {
    const cards = bySuit[suit];
    for (const id of cards) {
      const { rank } = parseCard(id);
      if (rank === "A") total += 0.85;
      else if (rank === "K") total += cards.length >= 2 ? 0.5 : 0.2;
    }
  }

  return Math.max(0, Math.min(13, Math.round(total)));
}

function chooseBidTurn(state: SpadesState, seat: SeatId, rng: Rng, tier: BotDifficulty): SpadesAction {
  if (isHiddenFromSelf(state, seat)) {
    // Casual never goes blind — a cautious player who always looks
    // first. Steady/sharp weigh going blind purely against the score
    // deficit, since the hand is redacted at this point — there is
    // nothing else TO weigh, which is the whole point.
    if (tier === "casual") return { t: "look" };
    const deficit = (state.scores[((seat + 1) % 4) as SeatId] ?? 0) - (state.scores[seat] ?? 0);
    const boldness = tier === "sharp" ? 0.6 : 0.3;
    if (deficit < 100 || rng.next() >= boldness) return { t: "look" };
    if (minLegalBid(state, seat) === 0 && rng.next() < 0.4) return { t: "blindNil" };
    return { t: "blindBid", tricks: 6 };
  }

  const floor = minLegalBid(state, seat);

  if (tier === "casual") {
    // Never counts what's in hand — bids a plausible-looking number
    // near the Board floor and moves on.
    return { t: "bid", tricks: Math.min(13, Math.max(1, floor) + rng.int(4)), nil: false };
  }

  const estimate = estimateTricks(state.hands[seat] ?? [], state.rules);
  if (estimate === 0 && floor === 0) return { t: "bid", tricks: 0, nil: true };
  return { t: "bid", tricks: Math.min(13, Math.max(1, floor, estimate)), nil: false };
}

function chooseExchange(state: SpadesState, tier: BotDifficulty): SpadesAction {
  const ex = state.exchange!;
  if (ex.stage === "give") {
    // Casual skips the optional exchange entirely. Steady and sharp
    // both take it — it can only help, there's no real downside — but
    // the GIVER still hasn't seen their own hand (that's the whole
    // point of Blind Nil), so which two cards go is a genuinely blind
    // pick, not a judged one.
    if (tier === "casual") return { t: "skipExchange" };
    const hand = state.hands[ex.giver] ?? [];
    if (hand.length < 2) return { t: "skipExchange" };
    return { t: "exchangeGive", cards: [hand[0]!, hand[1]!] };
  }
  // Taking: the taker can already see their hand (see rules.ts's doc on
  // why) — send back its two weakest cards.
  const hand = [...(state.hands[ex.taker] ?? [])].sort(
    (a, b) => cardStrength(a, state.rules) - cardStrength(b, state.rules),
  );
  return { t: "exchangeTake", cards: [hand[0]!, hand[1]!] };
}

/** Who is currently winning the trick on the table right now (before
 * `seat`'s own card lands), reusing the same trick-resolution logic the
 * engine itself uses rather than re-deriving trump/led-suit rules here. */
function currentTrickLeader(state: SpadesState): SeatId | null {
  if (state.trick.length === 0) return null;
  const plays = state.trick.map((p) => ({
    seat: p.seat,
    card: { id: p.card, suit: effectiveSuit(p.card), isTrump: isTrump(p.card) },
  }));
  return resolveTrick(plays, state.ledSuit, (id) => cardStrength(id, state.rules));
}

/** Would `card` win the trick if `seat` played it right now? */
function wouldWin(card: PieceId, seat: SeatId, state: SpadesState): boolean {
  const plays = [...state.trick, { seat, card }].map((p) => ({
    seat: p.seat,
    card: { id: p.card, suit: effectiveSuit(p.card), isTrump: isTrump(p.card) },
  }));
  const ledSuit = state.trick.length === 0 ? effectiveSuit(card) : state.ledSuit;
  return resolveTrick(plays, ledSuit, (id) => cardStrength(id, state.rules)) === seat;
}

function choosePlay(state: SpadesState, seat: SeatId, rng: Rng, tier: BotDifficulty): PieceId {
  const legal = legalPlays(state, seat);
  if (legal.length === 1) return legal[0]!;
  if (tier === "casual") return rng.pick(legal);

  const strength = (id: PieceId) => cardStrength(id, state.rules);
  const lowest = (ids: readonly PieceId[]) => bestOf(ids, (id) => -strength(id), rng);

  if (state.trick.length === 0) {
    // Leading: play safe and low. Enough to punish a careless hand
    // without this file trying to model suit-establishment strategy.
    return lowest(legal);
  }

  const winners = legal.filter((id) => wouldWin(id, seat, state));

  if (tier === "sharp") {
    const ownBid = state.bids[seat];
    const protectingNil = Boolean(ownBid?.nil) && (state.tricksWon[seat] ?? 0) === 0;
    const leader = currentTrickLeader(state);
    const partnerLeading = leader !== null && partnerOf(seat) === leader;
    // Don't win a trick it doesn't need: protect its own live Nil, or
    // don't spend a winner overtaking a partner who already has it.
    if (protectingNil || partnerLeading) {
      const safe = legal.filter((id) => !winners.includes(id));
      if (safe.length > 0) return lowest(safe);
    }
  }

  // Win as cheaply as possible when it can; duck with the lowest card
  // otherwise. Steady's whole strategy; sharp's fallback once the cases
  // above don't apply.
  return winners.length > 0 ? lowest(winners) : lowest(legal);
}

function makeBot(
  id: string,
  tier: BotDifficulty,
  pace: (rng: Rng) => number,
): BotStrategy<SpadesState, SpadesAction> {
  return {
    id,
    choose(state, seat, rng) {
      if (state.exchange) return chooseExchange(state, tier);
      if (state.phase === "bid") return chooseBidTurn(state, seat, rng, tier);
      return { t: "play", card: choosePlay(state, seat, rng, tier) };
    },
    thinkMs(state, seat, rng) {
      const beat = pace(rng);
      // A single legal card is not a decision, the same way a forced
      // draw isn't in Dominoes.
      const forced =
        !state.exchange && state.phase === "play" && legalPlays(state, seat).length <= 1;
      return forced ? Math.round(beat * 0.3) : beat;
    },
  };
}

export const spadesBots: Record<BotDifficulty, BotStrategy<SpadesState, SpadesAction>> = {
  casual: makeBot("casual", "casual", (rng) => 350 + rng.int(300)),
  steady: makeBot("steady", "steady", (rng) => 600 + rng.int(400)),
  sharp: makeBot("sharp", "sharp", (rng) => 800 + rng.int(500)),
};
