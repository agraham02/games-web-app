/**
 * Poker bots.
 *
 * Not claimed optimal — the same spirit as Spades' `estimateTricks` and
 * Rummy's `LAYOFF_ATTENTION`: specific, tunable heuristic thresholds
 * good enough to make a decision feel considered rather than random,
 * built on `hand.ts`'s real evaluator rather than guessing at strength.
 *
 * Deliberately does NOT import from `./rules` — `rules.ts` imports
 * `pokerBots` from here, so the reverse would cycle. Every "how many
 * legal choices are there" question a bot needs is answered from
 * `./state` directly (`betRange`, `amountToCall`), the same way Spades'
 * bots read `legalPlays` from its own `state.ts` rather than from
 * `rules.ts`.
 */

import type { BotDifficulty, BotStrategy, SeatId } from "@/engine/types";
import type { Rng } from "@/engine/rng";
import { parseCard, type Card } from "@/games/_shared/cards";
import { bestOfSeven, pokerRank } from "./hand";
import { amountToCall, betRange, potTotal, seatHoleCards } from "./state";
import type { PokerAction, PokerState } from "./types";

/* ============================================================
   Hand-strength reads
   ============================================================ */

/**
 * A compact starting-hand strength score, 0..1 — pair rank,
 * suited/connected, high-card strength. Not a lookup table of all 169
 * starting combos; a simplified Chen-formula-style heuristic in the
 * same spirit as `estimateTricks`.
 *
 * The first version of this scored `(hi + lo) / 28` as its baseline —
 * a live playtest caught the real bug that comes from that: the term
 * alone puts almost every non-trash hand (K9o scores 0.79 on that term
 * ALONE) within a hair of `RAISE_THRESHOLD`/the `sizeBet` shove cutoff,
 * so bots raised and re-raised nearly every hand and went all-in
 * preflop constantly — "rarely see the flop" was the exact symptom
 * reported. This version weights the TOP card far more than the
 * second (unpaired hand strength is mostly about the high card) and
 * scales pairs on their own curve, so AA lands near 0.95, a bare
 * offsuit gap hand like 72o lands near 0.15-0.2, and the broad middle
 * of real starting hands actually sits in the middle of the range
 * instead of bunched near the top.
 */
function preflopStrength(hole: readonly Card[]): number {
  const [a, b] = hole;
  if (!a || !b) return 0;
  const hi = Math.max(pokerRank(a.rank), pokerRank(b.rank));
  const lo = Math.min(pokerRank(a.rank), pokerRank(b.rank));
  const paired = a.rank === b.rank;
  const suited = a.suit === b.suit;
  const gap = hi - lo;

  if (paired) {
    // 22 (weak but playable) to AA (~0.95), roughly linear.
    return 0.3 + ((hi - 2) / 12) * 0.65;
  }

  // Unpaired: the top card carries most of the weight (2..14 -> 0..0.55),
  // the second card a little (2..14 -> 0..0.15).
  let score = ((hi - 2) / 12) * 0.55 + ((lo - 2) / 12) * 0.15;
  if (suited) score += 0.08;
  // Connectivity: real straight/flush potential falls off fast past a
  // 1-2 gap, and a big unconnected gap is a genuine weakness, not a
  // neutral, hence the rare negative term.
  if (gap === 1) score += 0.1;
  else if (gap === 2) score += 0.06;
  else if (gap === 3) score += 0.03;
  else if (gap >= 4) score -= 0.05;

  return Math.max(0, Math.min(1, score));
}

/** A cheap draw-outs bonus: an evident 4-to-a-flush or 4-to-a-straight
 * is worth accounting for even before the MADE-hand category shows it —
 * `sharp` alone weighs this (see `USES_DRAW_OUTS`). */
function drawBonus(all: readonly Card[]): number {
  const bySuit = new Map<string, number>();
  for (const c of all) bySuit.set(c.suit, (bySuit.get(c.suit) ?? 0) + 1);
  const flushDraw = [...bySuit.values()].some((n) => n === 4) ? 0.5 : 0;

  const ranks = [...new Set(all.map((c) => pokerRank(c.rank)))].sort((x, y) => x - y);
  let straightDraw = 0;
  for (let i = 0; i + 3 < ranks.length; i++) {
    if (ranks[i + 3]! - ranks[i]! === 3) straightDraw = 0.4;
  }
  return Math.min(1, flushDraw + straightDraw);
}

const USES_DRAW_OUTS: Record<BotDifficulty, boolean> = {
  casual: false,
  steady: false,
  sharp: true,
};

function handStrength(state: PokerState, seat: SeatId, tier: BotDifficulty): number {
  const hole = seatHoleCards(state, seat).map(parseCard);
  const community = state.communityOrder.map(parseCard);
  if (community.length === 0) return preflopStrength(hole);

  const value = bestOfSeven([...hole, ...community]);
  let score = value.category / 8;
  if (USES_DRAW_OUTS[tier] && community.length < 5) {
    score += drawBonus([...hole, ...community]) * 0.15;
  }
  return Math.max(0, Math.min(1, score));
}

/* ============================================================
   Betting decision
   ============================================================ */

/**
 * How much made-hand strength each tier needs to voluntarily continue
 * facing a bet, before pot odds (if the tier even weighs them). Casual's
 * floor is deliberately low — it "rarely folds a made pair" — and
 * doesn't move for preflop vs. postflop; steady/sharp tighten preflop
 * specifically, matching real ranges being narrower before the flop
 * than a made postflop hand needs to be.
 */
const PREFLOP_FLOOR: Record<BotDifficulty, number> = { casual: 0.16, steady: 0.34, sharp: 0.4 };
const POSTFLOP_FLOOR: Record<BotDifficulty, number> = { casual: 0.1, steady: 0.18, sharp: 0.18 };
const USES_POT_ODDS: Record<BotDifficulty, boolean> = { casual: false, steady: true, sharp: true };
/** Rare, deliberately small bluff/semi-bluff rates — this app's own
 * `LAYOFF_ATTENTION` doc makes the same case for keeping an oversight
 * rate small: a bluff is meant to be a moment, not a habit. */
const BLUFF_CHANCE: Record<BotDifficulty, number> = { casual: 0.02, steady: 0.05, sharp: 0.15 };
const RAISE_THRESHOLD: Record<BotDifficulty, number> = { casual: 0.8, steady: 0.62, sharp: 0.55 };

function chooseBettingAction(
  state: PokerState,
  seat: SeatId,
  rng: Rng,
  tier: BotDifficulty,
): PokerAction {
  const toCall = amountToCall(state, seat);
  const strength = handStrength(state, seat, tier);
  const bluffing = rng.next() < BLUFF_CHANCE[tier];
  // A bluff plays its cards as though they were strong for the purposes
  // of THIS decision only — hand.ts's real evaluation is never touched.
  const effective = bluffing ? Math.max(strength, 0.75) : strength;

  const floor = (state.communityOrder.length === 0 ? PREFLOP_FLOOR : POSTFLOP_FLOOR)[tier];
  if (toCall > 0) {
    const pot = potTotal(state);
    const potOdds = toCall / (pot + toCall);
    const required = USES_POT_ODDS[tier] ? Math.max(floor, potOdds) : floor;
    if (effective < required) return { t: "fold" };
  }

  const range = betRange(state, seat);
  const canRaise = !state.raiseCapped && range.max > (state.streetCommitted[seat] ?? 0);
  if (canRaise && (effective >= RAISE_THRESHOLD[tier] || bluffing)) {
    const to = sizeBet(state, seat, range, tier, rng, effective);
    // "bet" vs "raise" is decided by whether ANYONE has bet this street
    // yet — not by whether THIS seat owes a call. Those disagree exactly
    // once: the big blind's own free preflop option, where `toCall` is 0
    // (they already match the highest) but a bet (their own blind)
    // already exists on the table, so raising it is still a "raise".
    // `legalActions` (rules.ts) uses the identical highest-committed
    // check — this has to match it exactly or a bot can emit an action
    // type `legalActions` never offered.
    const highest = Math.max(0, ...Object.values(state.streetCommitted));
    return highest === 0 ? { t: "bet", to } : { t: "raise", to };
  }

  return toCall === 0 ? { t: "check" } : { t: "call" };
}

function sizeBet(
  state: PokerState,
  seat: SeatId,
  range: { min: number; max: number },
  tier: BotDifficulty,
  rng: Rng,
  strength: number,
): number {
  // Shove with the nuts, or when there's no real room to size finely.
  if (strength >= 0.92 || range.max - range.min < state.bigBlind) return range.max;

  const already = state.streetCommitted[seat] ?? 0;
  let target: number;
  if (tier === "casual") {
    target = range.min + rng.int(Math.max(1, range.max - range.min));
  } else {
    // A standard fraction of the pot — sharp varies the fraction widely
    // so a value bet and a bluff aren't distinguishable by size alone;
    // steady keeps a tighter, more "textbook" band.
    const frac = tier === "sharp" ? 0.5 + rng.next() * 0.5 : 0.5 + rng.next() * 0.25;
    target = already + Math.round(potTotal(state) * frac);
  }
  return Math.max(range.min, Math.min(range.max, target));
}

/* ============================================================
   Show or muck
   ============================================================ */

/** Casual essentially never shows a loser; steady/sharp show often
 * enough for table-image flavor to actually be reachable in ordinary
 * bot-vs-bot play, not just on the rare hand the hero personally loses
 * a showdown — the same "instrument reachability" lesson this app's own
 * claim-window bug taught (see `rules.test.ts`). */
const SHOW_CHANCE: Record<BotDifficulty, number> = { casual: 0.02, steady: 0.1, sharp: 0.15 };

function chooseShowOrMuck(rng: Rng, tier: BotDifficulty): PokerAction {
  return rng.next() < SHOW_CHANCE[tier] ? { t: "show" } : { t: "muck" };
}

/* ============================================================
   Pacing and assembly
   ============================================================ */

const PACE: Record<BotDifficulty, (rng: Rng) => number> = {
  casual: (rng) => 350 + rng.int(300),
  steady: (rng) => 600 + rng.int(400),
  sharp: (rng) => 800 + rng.int(500),
};

function makeBot(tier: BotDifficulty): BotStrategy<PokerState, PokerAction> {
  return {
    id: tier,
    choose(state, seat, rng) {
      if (state.pendingShowdown) return chooseShowOrMuck(rng, tier);
      return chooseBettingAction(state, seat, rng, tier);
    },
    thinkMs(_state, _seat, rng) {
      return PACE[tier](rng);
    },
  };
}

export const pokerBots: Record<BotDifficulty, BotStrategy<PokerState, PokerAction>> = {
  casual: makeBot("casual"),
  steady: makeBot("steady"),
  sharp: makeBot("sharp"),
};
