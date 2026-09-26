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
import { isJokerId, parseCard, cardId, type Suit } from "@/games/_shared/cards";
import { resolveTrick } from "@/games/_shared/trickTaking";
import { cardStrength, effectiveSuit, isTrump, spadesDeck, type SpadesRules } from "./cards";
import { blindVoteOpen, isHiddenFromSelf, legalPlays, minLegalBid, partnerOf } from "./state";
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
function estimateTricks(
  hand: readonly PieceId[],
  rules: SpadesRules,
  tier: BotDifficulty = "steady",
): number {
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

  // Short-suit trump control, which only `sharp` counts. A void is only
  // worth tricks if there is trump left to ruff WITH, hence the gate on
  // spade length — a void with one small spade wins nothing. This is
  // the first thing that made sharp's bid differ from steady's at all:
  // before it, every branch of the bidding path was shared code and the
  // two tiers produced literally identical bids.
  if (tier === "sharp" && spadeCount >= 3) {
    for (const suit of ["H", "D", "C"] as const) {
      const n = bySuit[suit].length;
      if (n === 0) total += 0.6;
      else if (n === 1) total += 0.3;
    }
  }

  // Calibration. Everything above counts only PREMIUM winners — high
  // spades, aces, supported kings — and that systematically underbids:
  // thirteen tricks are shared between four seats, so a seat wins about
  // 3.25 on average, while the raw sum averages about 2. Measured over
  // whole matches, the uncorrected estimate left every team roughly 3
  // bags a round, which is both unrealistic and expensive (a bag is
  // worth 1 point and costs 100 every tenth one, whereas a trick you
  // actually bid is worth 10).
  //
  // A MULTIPLIER rather than an added constant, deliberately: a hand
  // worth nothing still scores zero, which is what keeps `estimate ===
  // 0` — and therefore Nil — reachable at all.
  const BID_CALIBRATION = 1.35;
  return Math.max(0, Math.min(13, Math.round(total * BID_CALIBRATION)));
}

/**
 * How likely this hand is to be FORCED to win a trick — the actual
 * question a Nil bid asks. Lower is safer.
 *
 * Nil used to be decided by `estimateTricks(hand) === 0`, which is a
 * different question: "will this hand win tricks if I try to". Almost
 * no hand scores a flat zero there, so the bots essentially never bid
 * Nil at all — measured across twenty whole matches, seat 0 attempted
 * exactly one. A signature Spades bid was shipped unreachable, the same
 * way Rummy's claim window once was, and for the same reason: the
 * feature was gated on a proxy rather than on its own question.
 *
 * What actually breaks a Nil is a card you cannot duck under: a joker,
 * a high spade, a bare ace. Length matters too — a long suit runs out
 * of small cards to hide behind — while a void is harmless, since a
 * seat that cannot follow may simply discard.
 */
function nilDanger(hand: readonly PieceId[], rules: SpadesRules): number {
  let danger = 0;
  const bySuit: Record<Suit, PieceId[]> = { S: [], H: [], D: [], C: [] };
  for (const id of hand) {
    if (isJokerId(id)) {
      danger += 5;
      continue;
    }
    bySuit[parseCard(id).suit].push(id);
  }

  const queenOfSpades = cardStrength(cardId("S", "Q"), rules);
  const nineOfSpades = cardStrength(cardId("S", "9"), rules);
  for (const id of bySuit.S) {
    const power = cardStrength(id, rules);
    danger += power >= queenOfSpades ? 2.5 : power >= nineOfSpades ? 1 : 0.35;
  }

  for (const suit of ["H", "D", "C"] as const) {
    const cards = bySuit[suit];
    const long = cards.length;
    for (const id of cards) {
      const { rank } = parseCard(id);
      // A high card is survivable when there are small cards in the
      // same suit to play instead; bare, it is a trick you must take.
      if (rank === "A") danger += long >= 4 ? 1.6 : 2.4;
      else if (rank === "K") danger += long >= 4 ? 0.8 : long >= 3 ? 1.2 : 2;
      else if (rank === "Q") danger += long >= 4 ? 0.2 : long >= 3 ? 0.5 : 1;
    }
    // A long suit eventually runs out of low cards to hide behind.
    if (long >= 6) danger += 1;
  }

  return danger;
}

/**
 * How much danger a tier will accept on a Nil.
 *
 * Sharp's tolerance is the LOWER one, which is worth stating because
 * the obvious guess is the opposite ("it reads better, so it can take
 * on more"). Measured, that guess is wrong: at a looser threshold sharp
 * attempted 43 Nils per 100 rounds and made only 41% of them, while
 * steady made 52% of far fewer. A Nil is +100 made and -100 failed, so
 * anything under half is actively losing points — the sharper read is
 * knowing which hands NOT to try. At these values sharp makes 63% and
 * steady 52%.
 *
 * Casual is 0, which no real hand reaches: casual bids on the random
 * path and never goes for Nil at all, exactly as before.
 */
const NIL_TOLERANCE: Record<BotDifficulty, number> = { casual: 0, steady: 2.8, sharp: 2.2 };

/* ============================================================
   Reading the table
   ============================================================ */

/**
 * The team's outstanding contract: tricks still needed to make the bid.
 * Zero or less means everything from here is an overtrick — a bag —
 * which is worth -100 every tenth one and was simply not modelled
 * before: `state.bags` was never read outside the blind-bid deficit, so
 * a bot would happily bag its own team into a penalty.
 *
 * Mirrors `scoring.ts`'s own team-blind-bid handling: a team blind bid
 * puts the SAME `Bid` object on both seats, so it counts once, not
 * twice.
 */
function tricksStillNeeded(state: SpadesState, seat: SeatId): number {
  const partner = partnerOf(seat);
  const mine = state.bids[seat] ?? null;
  const theirs = state.bids[partner] ?? null;
  const numeric = (mine === theirs ? [mine] : [mine, theirs]).filter(
    (bid) => bid !== null && !bid.nil,
  );
  const target = numeric.reduce((sum, bid) => sum + (bid?.tricks ?? 0), 0);
  const won = (state.tricksWon[seat] ?? 0) + (state.tricksWon[partner] ?? 0);
  return target - won;
}

/** Bags the team is on course to finish the round with. */
function projectedBags(state: SpadesState, seat: SeatId): number {
  return (state.bags[seat] ?? 0) + Math.max(0, -tricksStillNeeded(state, seat));
}

/** Close enough to the next ten-bag, hundred-point penalty that one
 * more overtrick is a real cost rather than a free point. */
function bagDanger(state: SpadesState, seat: SeatId): boolean {
  return projectedBags(state, seat) % 10 >= 7;
}

/**
 * Whether ducking is actually safe — i.e. whether the trick handed over
 * becomes an OPPONENT'S bag rather than a trick they still needed.
 *
 * This distinction is the whole difference between bag avoidance being
 * a gain and a loss. A bag costs on average ten points (a hundred every
 * tenth one); a trick given to an opponent who is still short of their
 * contract is worth ten points TO THEM and gives up the chance to set
 * them, which is worth their whole bid. Ducking without this check made
 * `sharp` lose team matches to `steady` outright — it was politely
 * helping the other side make every contract.
 */
function opponentsAlreadyMade(state: SpadesState, seat: SeatId): boolean {
  return tricksStillNeeded(state, ((seat + 1) % 4) as SeatId) <= 0;
}

/**
 * Every card already accounted for: played this round, sitting in the
 * live trick, or in this seat's own hand. Anything else is still out
 * there somewhere.
 *
 * `state.won` is a flat pile per seat with no record of who played
 * what, which is exactly why void inference needs `state.voids` on the
 * state — but for "has this card appeared yet", a flat pile is all the
 * question needs.
 */
function accountedFor(state: SpadesState, seat: SeatId): Set<PieceId> {
  const seen = new Set<PieceId>();
  for (const pile of Object.values(state.won)) for (const id of pile) seen.add(id);
  for (const play of state.trick) seen.add(play.card);
  for (const id of state.hands[seat] ?? []) seen.add(id);
  return seen;
}

/** Nothing higher in this card's suit is still unaccounted for — so it
 * cannot be beaten except by a ruff. */
function isBoss(card: PieceId, state: SpadesState, seen: Set<PieceId>): boolean {
  const suit = effectiveSuit(card);
  const mine = cardStrength(card, state.rules);
  return !spadesDeck(state.rules).some(
    (id) =>
      !seen.has(id) && effectiveSuit(id) === suit && cardStrength(id, state.rules) > mine,
  );
}

/** Has an opponent shown out of this suit, and so may ruff it? */
function opponentVoidIn(state: SpadesState, seat: SeatId, suit: Suit): boolean {
  const partner = partnerOf(seat);
  return ([0, 1, 2, 3] as SeatId[])
    .filter((s) => s !== seat && s !== partner)
    .some((s) => (state.voids[s] ?? []).includes(suit));
}

function chooseBidTurn(state: SpadesState, seat: SeatId, rng: Rng, tier: BotDifficulty): SpadesAction {
  if (blindVoteOpen(state, seat)) {
    // Always a deferring vote: a bot never overrules a person on its team
    // (see `reduceBlindVote`). What it would PREFER still matters, because
    // with a bot for a partner too, the first bidder's vote decides.
    //
    // Casual never goes blind — a cautious player who always looks first.
    // Steady/sharp weigh it purely against the score deficit, since the
    // hand is redacted at this point: there is nothing else TO weigh,
    // which is the whole point.
    //
    // Only the first bidder's preference can ever count — beside a person
    // a bot's vote defers, and beside another bot the first bidder decides
    // — so the partner draws nothing for a vote that cannot matter.
    if (state.turn !== seat) return { t: "blindVote", seat, blind: false, defer: true };
    const deficit = (state.scores[((seat + 1) % 4) as SeatId] ?? 0) - (state.scores[seat] ?? 0);
    const boldness = tier === "sharp" ? 0.6 : 0.3;
    const blind = tier !== "casual" && deficit >= 100 && rng.next() < boldness;
    return { t: "blindVote", seat, blind, defer: true };
  }
  if (isHiddenFromSelf(state, seat)) {
    // Past the vote and still hidden: the team went blind, so the only
    // question left is which blind bid.
    if (minLegalBid(state, seat) === 0 && rng.next() < 0.4) return { t: "blindNil" };
    return { t: "blindBid", tricks: 6 };
  }

  const floor = minLegalBid(state, seat);

  if (tier === "casual") {
    // Never counts what's in hand — bids a plausible-looking number
    // near the Board floor and moves on.
    return { t: "bid", tricks: Math.min(13, Math.max(1, floor) + rng.int(4)), nil: false };
  }

  const hand = state.hands[seat] ?? [];
  const estimate = estimateTricks(hand, state.rules, tier);
  if (floor === 0 && nilDanger(hand, state.rules) <= NIL_TOLERANCE[tier]) {
    return { t: "bid", tricks: 0, nil: true };
  }
  return { t: "bid", tricks: Math.min(13, Math.max(1, floor, estimate)), nil: false };
}

function chooseExchange(state: SpadesState, tier: BotDifficulty): SpadesAction {
  const ex = state.exchange!;
  if (ex.stage === "give") {
    // Casual skips the optional exchange entirely. Steady and sharp
    // both take it — it can only help, there's no real downside — but
    // the GIVER still hasn't seen their own hand (that's the whole
    // point of Blind Nil), so which two cards go is a genuinely blind
    // pick, not a judged one. `hand` here is `state.hands[ex.giver]`
    // from the REDACTED view this bot was handed — i.e. HIDDEN_CARD
    // placeholders, not real ids, since this seat's own hand is hidden
    // from itself. rules.ts's `reduceExchangeGive` is what actually
    // resolves that into 2 real cards (its own first two, in whatever
    // arbitrary order they sit in the true hand) — this function has no
    // real ids to give it even in principle.
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

/**
 * Leading a trick. The old version returned `lowest(legal)` at every
 * tier above casual — a bot that has bid six tricks and holds the ace
 * of hearts would lead its two instead, and never take the trick it
 * literally contracted to win.
 */
function chooseLead(
  state: SpadesState,
  seat: SeatId,
  rng: Rng,
  tier: BotDifficulty,
  opts: { needed: number; protectingNil: boolean; bagCareful: boolean },
): PieceId {
  const legal = legalPlays(state, seat);
  const strength = (id: PieceId) => cardStrength(id, state.rules);
  const lowest = (ids: readonly PieceId[]) => bestOf(ids, (id) => -strength(id), rng);
  const highest = (ids: readonly PieceId[]) => bestOf(ids, (id) => strength(id), rng);

  // Trying NOT to win: a live nil of its own, or a contract already
  // made with a bag penalty looming.
  if (opts.protectingNil || opts.bagCareful) return lowest(legal);

  if (opts.needed > 0) {
    const seen = accountedFor(state, seat);
    let boss = legal.filter((id) => isBoss(id, state, seen));
    // A guaranteed winner is only guaranteed while nobody can ruff it.
    // This is the whole practical use of `state.voids`: the same ace is
    // a trick against a table that still follows and a gift against one
    // that does not.
    if (tier === "sharp") {
      const safe = boss.filter((id) => isTrump(id) || !opponentVoidIn(state, seat, effectiveSuit(id)));
      if (safe.length > 0) boss = safe;
    }
    if (boss.length > 0) {
      // Cash side-suit winners first and keep trump back for control.
      const offTrump = boss.filter((id) => !isTrump(id));
      return highest(offTrump.length > 0 ? offTrump : boss);
    }
  }

  // Nothing worth cashing: lead low, and out of a side suit rather than
  // spending trump.
  const offTrump = legal.filter((id) => !isTrump(id));
  return lowest(offTrump.length > 0 ? offTrump : legal);
}

function choosePlay(state: SpadesState, seat: SeatId, rng: Rng, tier: BotDifficulty): PieceId {
  const legal = legalPlays(state, seat);
  if (legal.length === 1) return legal[0]!;
  if (tier === "casual") return rng.pick(legal);

  const strength = (id: PieceId) => cardStrength(id, state.rules);
  const lowest = (ids: readonly PieceId[]) => bestOf(ids, (id) => -strength(id), rng);

  const partner = partnerOf(seat);
  const ownBid = state.bids[seat];
  const partnerBid = state.bids[partner];
  const protectingNil = Boolean(ownBid?.nil) && (state.tricksWon[seat] ?? 0) === 0;
  const coveringNil = Boolean(partnerBid?.nil) && (state.tricksWon[partner] ?? 0) === 0;

  const needed = tricksStillNeeded(state, seat);
  // Bag discipline is sharp's alone: steady plays its contract straight
  // and lets the overtricks fall where they may. Note the opponents'
  // contract in the condition — ducking is only a saving once THEY are
  // past their bid too (see `opponentsAlreadyMade`).
  const bagCareful =
    tier === "sharp" &&
    needed <= 0 &&
    bagDanger(state, seat) &&
    opponentsAlreadyMade(state, seat);

  if (state.trick.length === 0) {
    return chooseLead(state, seat, rng, tier, { needed, protectingNil, bagCareful });
  }

  const winners = legal.filter((id) => wouldWin(id, seat, state));
  const losers = legal.filter((id) => !winners.includes(id));
  const leader = currentTrickLeader(state);
  const partnerLeading = leader !== null && partner === leader;

  // 1. Its own live Nil outranks everything — the bid is worth 100.
  if (protectingNil && losers.length > 0) return lowest(losers);

  // 2. Partner is on a live Nil and has not played yet: taking the
  //    trick is what stops them being forced to win it. Previously a
  //    partner's nil was invisible to this file — only the bot's OWN
  //    nil was ever read — so a bot would duck and hand its partner the
  //    trick that broke the bid.
  if (
    tier === "sharp" &&
    coveringNil &&
    !state.trick.some((play) => play.seat === partner) &&
    winners.length > 0
  ) {
    return lowest(winners);
  }

  // 3. Don't spend a winner overtaking a partner who already has it.
  if (partnerLeading && losers.length > 0) return lowest(losers);

  // 4. Contract made and the bag penalty is close: stop collecting.
  if (bagCareful && losers.length > 0) return lowest(losers);

  // 5. Win as cheaply as possible when it can; duck with the lowest
  //    card otherwise.
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
