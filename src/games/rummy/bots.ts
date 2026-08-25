/**
 * Rummy 500 bots — casual / steady / sharp.
 *
 * Heuristic, not optimal, and not claiming to be: the point is three
 * opponents who feel meaningfully different across a match, in the same
 * spirit as Spades' `estimateTricks`.
 *
 * Every method here receives `playerView(state, seat)`, guaranteed by
 * `useGameRuntime.revealBotTurn` — so a bot literally cannot read
 * another hand, and none of this needs bot-side discipline to stay
 * honest. Other seats' cards arrive as `HIDDEN_CARD` placeholders,
 * which is why nothing below ever inspects `state.hands` for a seat
 * other than its own.
 */

import type { BotDifficulty, BotStrategy, PieceId, SeatId } from "@/engine/types";
import type { Rng } from "@/engine/rng";
import { canExtend, cardValue, findCompletion, rankOf, suitOf } from "./cards";
import {
  layableMelds,
  layoffs,
  legalDrawDepths,
  mandatoryMelds,
  validDealSizes,
} from "./state";
import type { RummyAction, RummyState } from "./types";

type Tier = BotDifficulty;

function bestOf<T>(items: readonly T[], score: (item: T) => number, rng: Rng): T | null {
  if (items.length === 0) return null;
  let best = -Infinity;
  let winners: T[] = [];
  for (const item of items) {
    const s = score(item);
    if (s > best) {
      best = s;
      winners = [item];
    } else if (s === best) {
      winners.push(item);
    }
  }
  return rng.pick(winners);
}

/**
 * How useful a card looks in this hand — a rough "is it going anywhere"
 * score, deliberately cheap. Counts same-rank company and same-suit
 * neighbours, which between them cover both meld shapes.
 */
function usefulness(card: PieceId, hand: readonly PieceId[]): number {
  const rank = rankOf(card);
  const suit = suitOf(card);
  let score = 0;
  for (const other of hand) {
    if (other === card) continue;
    if (rankOf(other) === rank) score += 2;
    if (suitOf(other) === suit) {
      // Adjacency matters far more than sharing a suit at all.
      const near = Math.abs(rankIndex(other) - rankIndex(card));
      if (near === 1) score += 2;
      else if (near === 2) score += 1;
    }
  }
  // A card that already completes something outright is not deadwood.
  if (findCompletion(card, hand)) score += 6;
  return score;
}

function rankIndex(card: PieceId): number {
  const order = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  return order.indexOf(rankOf(card));
}

/* ============================================================
   Decisions
   ============================================================ */

function chooseDealSize(state: RummyState, rng: Rng): RummyAction {
  const sizes = validDealSizes(state.seats);
  const lo = Math.floor(sizes.length * 0.35);
  const hi = Math.max(lo, Math.floor(sizes.length * 0.75));
  const band = sizes.slice(lo, hi + 1);
  return { t: "chooseDealSize", size: band.length ? rng.pick(band) : sizes[sizes.length - 1]! };
}

function chooseDraw(state: RummyState, seat: SeatId, rng: Rng, tier: Tier): RummyAction {
  const depths = legalDrawDepths(state, seat);
  if (depths.length === 0) return { t: "drawStock" };

  if (tier === "casual") {
    // Casual plays it safe and mostly stays out of the pile — legal but
    // not clever, which is the whole brief.
    return rng.next() < 0.25 ? { t: "drawDiscard", depth: depths[0]! } : { t: "drawStock" };
  }

  const hand = state.hands[seat] ?? [];
  const pile = state.discard;

  // Weigh what a pickup actually buys against what it costs. Every
  // pickup forces a brand-new meld, so the deepest card is spoken for;
  // the real question is whether the cards riding along are worth
  // adding to a hand you then have to get rid of again.
  const scored = depths.map((depth) => {
    const taken = pile.slice(pile.length - depth);
    const deepest = taken[0]!;
    const meld = findCompletion(deepest, hand, taken.slice(1)) ?? [];
    const melded = new Set(meld);
    // Points that go straight to the board are pure gain...
    const gain = meld.reduce((n, id) => n + cardValue(id), 0);
    // ...while anything picked up that ISN'T melded is dead weight you
    // now hold, and holding is what loses rounds.
    const drag = taken
      .filter((id) => !melded.has(id))
      .reduce((n, id) => n + cardValue(id) * (usefulness(id, hand) > 3 ? 0.3 : 1), 0);
    return { depth, score: gain - drag };
  });

  const threshold = tier === "sharp" ? 0 : 5;
  const best = bestOf(scored, (s) => s.score, rng);
  if (best && best.score > threshold) return { t: "drawDiscard", depth: best.depth };
  return { t: "drawStock" };
}

/**
 * How reliably each tier notices that a card in hand fits a meld already
 * on the table.
 *
 * Not flavour — load-bearing. Every tier used to lay off EVERY available
 * card before discarding, and the consequence was invisible until
 * playtest: a bot's discard could then never extend a live meld, so
 * `claimableMeld` was always null on it, so **the hero's claim window
 * could never open at all.** The whole "Rummy!" interaction was
 * unreachable, and reported twice as a missing button.
 *
 * Missing a lay-off is also just what players do — you do not re-read the
 * whole board every turn. `sharp` still never misses one, and keeps its
 * own guard against discarding a card that feeds a meld, so the player's
 * chance to pounce comes from the weaker seats. That is the right place
 * for it to come from.
 *
 * The rates are OVERSIGHT rates, and they are deliberately small. The
 * first pass ran 55%/20% and made the claim common, which was the wrong
 * read of the problem: the bug was that it could never happen, not that
 * it was rare. A claim is meant to be a moment, and a bot that overlooks
 * a lay-off one turn in seven is already careless — one that does it
 * every other turn is not playing the game.
 */
const LAYOFF_ATTENTION: Record<Tier, number> = {
  casual: 0.85,
  steady: 0.95,
  sharp: 1,
};

function chooseMeld(state: RummyState, seat: SeatId, rng: Rng, tier: Tier): RummyAction {
  const hand = state.hands[seat] ?? [];
  // Rolled once per turn, before either lay-off branch below, so a bot
  // that "didn't look at the board" this turn is consistent about it
  // rather than spotting a lay-off only in the fallback path.
  const spotsLayoffs = rng.next() < LAYOFF_ATTENTION[tier];

  // An outstanding pickup obligation is the only legal move there is —
  // and `mandatoryMelds` is the same list `legalActions` builds, so the
  // two can never disagree about what is available.
  if (state.mandatory) {
    const candidates = mandatoryMelds(hand, state.mandatory.card);
    const pick = bestOf(candidates, (m) => m.reduce((n, id) => n + cardValue(id), 0), rng);
    if (pick) return { t: "layNewMeld", cards: pick };
    // Only reachable via the same livelock guard `legalActions`
    // documents; discarding is genuinely legal at that point.
    return chooseDiscard(state, seat, rng, tier);
  }

  // Laying off first: points on the board can't be caught holding.
  if (tier !== "casual" && spotsLayoffs) {
    const offs = layoffs(state, hand);
    const off = bestOf(offs, (o) => cardValue(o.card), rng);
    if (off) return { t: "extendMeld", meldId: off.meldId, card: off.card };
  }

  const melds = layableMelds(hand);
  const meld = bestOf(melds, (m) => m.reduce((n, id) => n + cardValue(id), 0), rng);
  if (meld) return { t: "layNewMeld", cards: meld };

  // Casual would rather start something of its own than tidy up someone
  // else's meld, so its lay-off is the fallback rather than the opener —
  // and it only gets here if it looked at the board at all.
  if (tier === "casual" && spotsLayoffs) {
    const offs = layoffs(state, hand);
    const off = bestOf(offs, (o) => cardValue(o.card), rng);
    if (off) return { t: "extendMeld", meldId: off.meldId, card: off.card };
  }

  return chooseDiscard(state, seat, rng, tier);
}

function chooseDiscard(state: RummyState, seat: SeatId, rng: Rng, tier: Tier): RummyAction {
  const hand = state.hands[seat] ?? [];
  if (hand.length === 0) return { t: "discard", card: "" };

  if (tier === "casual") {
    // Dump the most expensive thing that isn't obviously going anywhere.
    const card = bestOf(hand, (c) => cardValue(c) - usefulness(c, hand), rng);
    return { t: "discard", card: card ?? hand[0]! };
  }

  // Steady/sharp: least likely to complete anything, breaking ties
  // toward the higher-value card so a bad round costs less.
  const card = bestOf(hand, (c) => -usefulness(c, hand) * 4 + cardValue(c) * 0.5, rng);

  if (tier === "sharp" && card) {
    // Don't hand the table a card that instantly extends a live meld if
    // there is anything else nearly as dead.
    const feeds = state.melds.some((m) => canExtend(m.cards, card));
    if (feeds) {
      const safe = hand.filter((c) => !state.melds.some((m) => canExtend(m.cards, c)));
      const alt = bestOf(safe, (c) => -usefulness(c, hand) * 4 + cardValue(c) * 0.5, rng);
      if (alt) return { t: "discard", card: alt };
    }
  }

  return { t: "discard", card: card ?? hand[0]! };
}

/**
 * Whether to take a card the window is offering.
 *
 * Always, and that is not laziness. A claim costs nothing — the card
 * goes straight onto the board, its value counts toward the claimer's
 * contribution, and the turn order is undisturbed — so declining one is
 * strictly worse than taking it. The interesting decision was never
 * whether to claim; it is whether the bot NOTICED the card was
 * claimable, and that is already modelled, at the other end, by
 * `LAYOFF_ATTENTION` deciding whether a discard feeds a live meld at all.
 *
 * The `passClaim` branch exists because the window can outlive the meld
 * that made it claimable — a seat ahead in the race may have extended
 * the same meld into deadness — and a bot with no legal claim must still
 * answer, or the window never closes.
 */
function chooseClaim(state: RummyState, seat: SeatId): RummyAction {
  const window = state.claimWindow;
  if (!window) return { t: "passClaim", seat };
  const meld = state.melds.find((m) => m.id === window.meldId);
  if (!meld || !canExtend(meld.cards, window.discard)) return { t: "passClaim", seat };
  return { t: "claim", seat };
}

/* ============================================================
   Strategy objects
   ============================================================ */

function makeBot(
  id: string,
  tier: Tier,
  pace: (rng: Rng) => number,
): BotStrategy<RummyState, RummyAction> {
  return {
    id,
    choose(state, seat, rng) {
      // A claim window is now a real turn for a bot, not something that
      // resolved inline inside `reduce`. It has to come first: a window
      // seizes the turn regardless of `phase`, so reading `phase` here
      // would answer a question nobody asked.
      if (state.claimWindow !== null) return chooseClaim(state, seat);
      if (state.dealSizePending !== null) return chooseDealSize(state, rng);
      if (state.phase === "draw") return chooseDraw(state, seat, rng, tier);
      return chooseMeld(state, seat, rng, tier);
    },
    thinkMs(state, seat, rng) {
      // A claim's beat is not this bot's pace — it is the reaction time
      // drawn for this seat when the window opened, which is the number
      // the race is actually run on. Spending anything else here would
      // let a bot arrive at a different moment than the one every other
      // seat is racing against.
      const claiming = state.claimWindow?.pending.find((p) => p.seat === seat);
      if (claiming) return claiming.ms;

      const beat = pace(rng);
      // Drawing with no pile option, or melding under an obligation, is
      // not a real decision — don't make the player watch one.
      const forced =
        (state.phase === "draw" && legalDrawDepths(state, seat).length === 0) ||
        state.mandatory !== null;
      return forced ? Math.round(beat * 0.35) : beat;
    },
  };
}

export const rummyBots: Record<BotDifficulty, BotStrategy<RummyState, RummyAction>> = {
  casual: makeBot("casual", "casual", (rng) => 400 + rng.int(350)),
  steady: makeBot("steady", "steady", (rng) => 650 + rng.int(450)),
  sharp: makeBot("sharp", "sharp", (rng) => 850 + rng.int(500)),
};
