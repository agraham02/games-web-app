/**
 * Poker bots.
 *
 * Built on real showdown equity (`./equity`) rather than an invented
 * strength scale. That is the whole difference between this version and
 * the one before it, and it is worth stating plainly because the same
 * bug was reported twice.
 *
 * The old version scored a hand 0..1 on a made-up scale — a Chen-ish
 * formula preflop, `value.category / 8` postflop — and then compared
 * that number against pot odds. Pot odds are a probability and those
 * scores were not, so the comparison was between two different units.
 * The two scales also disagreed with each other: pocket aces preflop
 * scored 0.95 while a made full house scored 0.75, which is exactly
 * backwards and exactly why bots jammed before the flop and would not
 * bet a real hand after it. Retuning those constants was the first
 * attempted fix; it did not hold, because the units were the problem.
 *
 * Three rules now govern every betting decision, in order:
 *
 *   1. CONTINUE on `equity` vs `potOdds` — a real, like-for-like
 *      comparison, so "is this call profitable" is an actual question.
 *   2. RAISE on `edge` — equity above an even share of the pot
 *      (`1 / (opponents + 1)`). Normalising by field size is what lets
 *      one threshold work heads-up and six-handed, since raw equity
 *      falls as opponents are added while the hand has not got worse.
 *   3. SIZE without shoving unless a shove is genuinely correct.
 *
 * Rule 2 is also where the reported bug is actually fixed: the required
 * edge RISES with `state.raisesThisStreet`, and each tier caps how many
 * raises it will make in one street. Before, the raise test did not
 * depend on the action at all — and since preflop strength is a pure
 * function of two cards, it never changed within a street. Two bots
 * that both liked their hands therefore re-raised each other forever,
 * until `betRange`'s no-room-to-size branch turned it into an all-in.
 * That, not the opening raise, was the all-in engine.
 *
 * Deliberately does NOT import from `./rules` — `rules.ts` imports
 * `pokerBots` from here, so the reverse would cycle. Every "how many
 * legal choices are there" question is answered from `./state`
 * directly, the same way Spades' bots read `legalPlays` from its own
 * `state.ts`.
 */

import type { BotDifficulty, BotStrategy, SeatId } from "@/engine/types";
import type { Rng } from "@/engine/rng";
import { personality, stableRoll, type BotPersonality } from "@/games/_shared/botPersonality";
import { equityFor, MAX_MODELLED_OPPONENTS } from "./equity";
import { amountToCall, betRange, contestingSeats, potTotal, seatHoleCards } from "./state";
import type { PokerAction, PokerState } from "./types";

/* ============================================================
   Reading the spot
   ============================================================ */

interface Spot {
  equity: number;
  /** Equity above an even share of the pot. Field-size normalised, so
   * one threshold means the same thing heads-up and six-handed. */
  edge: number;
  toCall: number;
  pot: number;
  potOdds: number;
  opponents: number;
  stack: number;
  /** This seat's chips in the pot for the whole hand so far. */
  committed: number;
  highest: number;
  already: number;
  preflop: boolean;
}

/**
 * How much of its raw all-in equity a tier expects to actually realise.
 *
 * Monte Carlo runs every board to the river with no further betting,
 * which is exactly right for an all-in and optimistic everywhere else —
 * a draw that has to pay two more bets, and may fold to one of them,
 * does not collect its full share. Casual believes the raw number,
 * which is a real and characteristic mistake; the sharper tiers
 * discount it.
 */
const REALISATION: Record<BotDifficulty, number> = { casual: 1, steady: 0.95, sharp: 0.93 };

function readSpot(state: PokerState, seat: SeatId, tier: BotDifficulty): Spot {
  const hole = seatHoleCards(state, seat);
  const opponents = Math.max(1, contestingSeats(state).filter((s) => s !== seat).length);
  const modelled = Math.min(MAX_MODELLED_OPPONENTS, opponents);

  const raw = equityFor(hole, state.communityOrder, opponents);
  const complete = state.communityOrder.length === 5;
  const equity = complete ? raw : raw * REALISATION[tier];

  const toCall = amountToCall(state, seat);
  const pot = potTotal(state);
  const already = state.streetCommitted[seat] ?? 0;

  return {
    equity,
    edge: equity - 1 / (modelled + 1),
    toCall,
    pot,
    potOdds: toCall > 0 ? toCall / (pot + toCall) : 0,
    opponents,
    stack: state.stacks[seat] ?? 0,
    committed: state.totalCommitted[seat] ?? 0,
    highest: Math.max(0, ...Object.values(state.streetCommitted)),
    already,
    preflop: state.communityOrder.length === 0,
  };
}

/* ============================================================
   Tier tables
   ============================================================ */

/**
 * Edge over break-even pot odds a tier insists on before calling.
 * Negative is a losing call made anyway — which is what a casual player
 * does, and the honest way to express "rarely folds a made pair"
 * without hard-coding a hand category.
 */
const CALL_MARGIN: Record<BotDifficulty, number> = { casual: -0.1, steady: -0.01, sharp: 0.015 };

/**
 * Edge required to open the betting. Tuned so `steady` opens roughly a
 * fifth of starting hands at a six-handed table — an ordinary opening
 * range, which the tests measure directly rather than trusting.
 *
 * Casual's is the HIGHEST because casual is a calling station, not a
 * maniac: it puts money in by calling, rarely by raising.
 */
const RAISE_EDGE: Record<BotDifficulty, number> = { casual: 0.16, steady: 0.1, sharp: 0.085 };

/**
 * Added to `RAISE_EDGE` for every raise already made this street. This
 * is the fix for the reported all-in bug: re-raising has to require a
 * genuinely better hand than opening did, or two bots with static reads
 * ratchet each other to all-in every single time they both like their
 * cards.
 */
const AGGRESSION_STEP: Record<BotDifficulty, number> = { casual: 0.12, steady: 0.11, sharp: 0.09 };

/** A hard ceiling on raises per street, on top of the rising edge — a
 * belt-and-braces guarantee that the ladder terminates. */
const MAX_RAISES: Record<BotDifficulty, number> = { casual: 2, steady: 3, sharp: 4 };

/** Rare, deliberately small bluff rates — this app's own
 * `LAYOFF_ATTENTION` doc makes the same case for keeping an oversight
 * rate small: a bluff is meant to be a moment, not a habit. */
const BLUFF_CHANCE: Record<BotDifficulty, number> = { casual: 0.02, steady: 0.05, sharp: 0.08 };

/**
 * At or below this many big blinds, raising anything but all-in leaves
 * a stub too small to fold, so a shove is simply correct. This is the
 * ONLY routine path to an all-in now — the old `strength >= 0.92`
 * branch made every tier auto-jam pocket aces preflop, every time.
 */
const SHOVE_BB: Record<BotDifficulty, number> = { casual: 10, steady: 12, sharp: 14 };

/**
 * Equity at which a bot will commit its whole stack voluntarily.
 * Below it, a single raise may not exceed `MAX_RAISE_STACK_FRACTION` of
 * the stack, which is what stops one pot from busting a player who is
 * merely ahead rather than crushing.
 */
const COMMIT_EQUITY: Record<BotDifficulty, number> = { casual: 0.78, steady: 0.75, sharp: 0.7 };
const MAX_RAISE_STACK_FRACTION = 0.5;

/**
 * Whether a tier will call an unopened preflop pot — "limping".
 *
 * Calling for exactly one big blind when nobody has raised is dominated
 * play: the hand is either good enough to raise or not good enough to
 * play, and limping forfeits the chance to win the blinds outright.
 * Leaving it in produced a table where essentially every hand crawled
 * to a flop five-handed, which is not what real poker looks like.
 *
 * Casual limps on purpose — it is the most recognisable beginner habit
 * there is, and casual's whole character is putting money in by calling.
 * Completing the small blind is not limping and is always allowed: that
 * seat is getting a genuinely different price.
 */
const LIMPS_PREFLOP: Record<BotDifficulty, boolean> = {
  casual: true,
  steady: false,
  sharp: false,
};

/**
 * Edge required to complete the small blind into an unraised pot.
 *
 * Completing is not limping — half the bet is already posted, so the
 * price is genuinely different and a flat raise-or-fold rule would be
 * wrong. But it is not a free call either, and treating it as one is
 * what made almost every hand crawl to a flop blind-versus-blind: on
 * raw pot odds, completing heads-up is nearly always correct, so the
 * bots always did it.
 *
 * What the raw number cannot see is that the seat which completes then
 * plays every remaining street out of position. This threshold is that
 * missing cost, expressed as "bring a hand that is actually better than
 * a random one" (edge >= 0), which is the honest shape of it.
 *
 * Except on the button, where the cost does not exist — and heads-up
 * the small blind IS the button, so it acts LAST on every later street
 * rather than first. Charging it a positional penalty there is not a
 * small inaccuracy: it inverted the whole difficulty slider, because
 * the sharpest tier had the strictest bar and therefore folded the best
 * seat at the table most often. `sharp` lost heads-up matches to
 * `casual` until this branch existed.
 */
const COMPLETE_EDGE: Record<BotDifficulty, number> = { casual: -1, steady: 0, sharp: 0.02 };
const COMPLETE_EDGE_ON_BUTTON: Record<BotDifficulty, number> = {
  casual: -1,
  steady: -0.08,
  sharp: -0.1,
};

/** Casual essentially never shows a loser; steady/sharp show often
 * enough for table-image flavour to be reachable in ordinary bot-vs-bot
 * play, not just on the rare hand the hero personally loses. */
const SHOW_CHANCE: Record<BotDifficulty, number> = { casual: 0.02, steady: 0.1, sharp: 0.15 };

const PACE: Record<BotDifficulty, (rng: Rng) => number> = {
  casual: (rng) => 350 + rng.int(300),
  steady: (rng) => 600 + rng.int(400),
  sharp: (rng) => 800 + rng.int(500),
};

/* ============================================================
   Betting decision
   ============================================================ */

/**
 * A bluff is decided per STREET, not per decision. The old version
 * rolled `rng.next() < BLUFF_CHANCE` on every call into `choose`, so a
 * bot could bluff-raise the flop and then fold the same hand to the
 * min-raise back — incoherent, and unreadable as a bluff. Keying the
 * roll to the position makes it a line the bot commits to, and makes it
 * replay identically from a seed.
 */
function isBluffing(state: PokerState, seat: SeatId, tier: BotDifficulty, p: BotPersonality): boolean {
  const key = `bluff|${state.hand}|${state.communityOrder.length}|${seat}|${seatHoleCards(state, seat).join("")}`;
  return stableRoll(key) < BLUFF_CHANCE[tier] * p.bluff;
}

function chooseBettingAction(
  state: PokerState,
  seat: SeatId,
  rng: Rng,
  tier: BotDifficulty,
): PokerAction {
  const p = personality("poker", seat);
  const spot = readSpot(state, seat, tier);

  const range = betRange(state, seat);
  const canRaise = !state.raiseCapped && range.max > spot.already;
  const raisesLeft = state.raisesThisStreet < MAX_RAISES[tier];

  // A bluff needs somebody to fold. Against three or more opponents
  // somebody almost always has a hand, so the bluff is just a donation.
  //
  // It also has to be a bluff the bot can actually MAKE: requiring
  // `canRaise` here matters, because a bluff skips the fold check
  // below, and a bot that skipped it and then could not raise would
  // quietly call a bet with the worst hand at the table.
  const bluffing =
    canRaise &&
    raisesLeft &&
    isBluffing(state, seat, tier, p) &&
    spot.opponents <= 2 &&
    spot.toCall <= spot.pot * 0.6;

  /* ---- 1. Continue, or fold? ---------------------------------- */
  if (spot.toCall > 0 && !bluffing) {
    let required = spot.potOdds + CALL_MARGIN[tier] + p.tight;

    // Already deep in this pot with a real hand: the chips behind are
    // what is being decided, and folding a hand that is still ahead of
    // its price to protect an investment already made is the classic
    // beginner's fold in reverse. A modest discount, not a blank cheque.
    const share = spot.committed / Math.max(1, spot.committed + spot.stack);
    if (share > 0.35 && spot.edge > 0) required -= 0.05;

    if (spot.equity < required) return { t: "fold" };
  }

  /* ---- 2. Raise? ---------------------------------------------- */
  const required =
    RAISE_EDGE[tier] + AGGRESSION_STEP[tier] * state.raisesThisStreet - p.aggro + p.tight;
  const wantsRaise = raisesLeft && (spot.edge >= required || bluffing);

  if (canRaise && wantsRaise) {
    const to = sizeBet(state, seat, range, tier, rng, spot, bluffing);
    // "bet" vs "raise" is decided by whether ANYONE has bet this street
    // yet — not by whether THIS seat owes a call. Those disagree exactly
    // once: the big blind's own free preflop option, where `toCall` is 0
    // (they already match the highest) but a bet (their own blind)
    // already exists on the table, so raising it is still a "raise".
    // `legalActions` (rules.ts) uses the identical highest-committed
    // check — this has to match it exactly or a bot can emit an action
    // type `legalActions` never offered.
    return spot.highest === 0 ? { t: "bet", to } : { t: "raise", to };
  }

  /* ---- 3. Raise or fold, rather than limp --------------------- */
  // Reached only when the bot declined to raise. Preflop with the pot
  // unopened, a hand not worth raising is not worth one big blind
  // either (see `LIMPS_PREFLOP`). Completing the small blind is exempt.
  if (spot.preflop && !LIMPS_PREFLOP[tier] && state.raisesThisStreet === 0 && spot.toCall > 0) {
    const completingBlind = spot.toCall <= state.smallBlind;
    const bar =
      state.button === seat ? COMPLETE_EDGE_ON_BUTTON[tier] : COMPLETE_EDGE[tier];
    if (!completingBlind || spot.edge < bar) return { t: "fold" };
  }

  return spot.toCall === 0 ? { t: "check" } : { t: "call" };
}

/**
 * How much to bet or raise TO.
 *
 * The old version opened with `if (strength >= 0.92 ... ) return
 * range.max` — and `preflopStrength(AA)` is 0.95, so every tier shoved
 * pocket aces preflop every time it was dealt them. There is no
 * equivalent branch here: a shove has to be earned by the stack being
 * short, by the raise ceiling landing there anyway, or by `betRange`
 * genuinely offering no room.
 */
function sizeBet(
  state: PokerState,
  seat: SeatId,
  range: { min: number; max: number },
  tier: BotDifficulty,
  rng: Rng,
  spot: Spot,
  bluffing: boolean,
): number {
  // `betRange` clamps `min` down to `max` for a seat too short to make
  // a full raise: its only bet-shaped action is to shove for less.
  if (range.max <= range.min) return range.max;

  // A real short stack. Raising to anything less leaves a stub nobody
  // can fold, so the shove is correct play rather than recklessness.
  if (spot.stack <= SHOVE_BB[tier] * state.bigBlind) return range.max;

  let target: number;
  if (spot.preflop) {
    // Preflop is sized in blinds, the way real play does it — a 2-3x
    // open, a ~2.5x re-raise. Sizing preflop off the pot instead is
    // what produced the old min-raise ladder, since a pot fraction of a
    // 1.5bb pot is always below the minimum raise and clamps up to it.
    target =
      spot.highest === 0
        ? Math.round(state.bigBlind * (2.2 + rng.next() * 1.1))
        : Math.round(spot.highest * (2.2 + rng.next() * 0.9));
  } else {
    // A pot-sized raise is the call plus a fraction of the pot the call
    // would create. Sharp varies the fraction widely so a value bet and
    // a bluff are not distinguishable by size alone; steady keeps a
    // tighter, textbook band; casual is simply erratic.
    const frac =
      tier === "sharp"
        ? 0.45 + rng.next() * 0.5
        : tier === "steady"
          ? 0.5 + rng.next() * 0.2
          : 0.35 + rng.next() * 0.55;
    target = spot.highest + Math.round((spot.pot + spot.toCall) * frac);
  }

  // Unless the hand is worth the whole stack, no single raise may put
  // more than half of it in. This is what keeps an ordinary good hand
  // from turning into a bust-out, which is the other half of "players
  // go out too soon".
  const committing = !bluffing && spot.equity >= COMMIT_EQUITY[tier];
  if (!committing) {
    target = Math.min(target, spot.already + Math.round(spot.stack * MAX_RAISE_STACK_FRACTION));
  }

  // Leaving less than a big blind behind helps nobody — take the shove.
  if (target >= range.max - state.bigBlind) target = range.max;

  return Math.max(range.min, Math.min(range.max, target));
}

/* ============================================================
   Show or muck
   ============================================================ */

function chooseShowOrMuck(rng: Rng, tier: BotDifficulty): PokerAction {
  return rng.next() < SHOW_CHANCE[tier] ? { t: "show" } : { t: "muck" };
}

/* ============================================================
   Assembly
   ============================================================ */

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
