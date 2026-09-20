/**
 * BS bots.
 *
 * Two decisions, and the game only exists if both of them are FALLIBLE in
 * both directions:
 *
 *  - When to lie. A bot that only ever lies when it has to is a bot whose
 *    every claim you can trust, and calling BS becomes a solved problem.
 *  - When to call. A bot that always catches a provable lie makes bluffing
 *    pointless; one that never misses a bluff and never calls a truthful
 *    claim is not playing BS at all, it is auditing.
 *
 * This is the lesson Rummy's claim window taught the hard way: its race
 * shipped DEAD — zero windows in 453 rounds — because every bot played the
 * locally optimal move and the feature was simply unreachable. A
 * correctness suite cannot see that. `bots.test.ts` therefore asserts on
 * REACHABILITY: that lies get caught, that lies survive, and that a
 * truthful claim sometimes gets doubted, at a healthy rate per tier.
 *
 * Everything below reads `playerView`, so a bot's own hand is real and
 * every other hand — and the whole pile — is stand-ins. `rankOf` returns
 * null for one of those rather than throwing, so a slip is a wrong answer
 * instead of a crash. Nothing here parses a pile card.
 */

import type { Rng } from "@/engine/rng";
import type { BotDifficulty, BotStrategy, PieceId, SeatId } from "@/engine/types";
import type { Rank } from "@/games/_shared/cards";
import { countOfRank, rankOf, turnsUntil } from "./cards";
import {
  MAX_PER_PLAY,
  entitledToCall,
  livePlay,
  nearestRivalCount,
  pileSize,
} from "./state";
import type { BsAction, BsState } from "./types";

interface Nerve {
  /**
   * Idle suspicion: how often a claim gets doubted on nothing at all.
   *
   * Read the tier table below and this looks inverted — casual doubts more
   * often than sharp. It is not a mistake, it is what the difference between
   * the two actually IS. Suspicion with nothing behind it is right slightly
   * less than half the time (a bit under half of all claims are lies) and
   * losing the call costs the whole pile, so calling on a hunch is the
   * beginner's move. A sharp bot doubts rarely and for REASONS: proof from
   * its own hand, a claim fatter than the rank can plausibly supply, or a
   * rival about to go out.
   *
   * It also compounds. Every entitled seat rolls its own, so on a four-seat
   * table the chance a play gets doubted at all is 1-(1-base)^3, which is
   * roughly three times this number.
   */
  base: number;
  /** A claim this bot can PROVE is impossible from its own hand. */
  caught: number;
  /**
   * Weight on how far a claim overshoots what one rival could plausibly
   * hold. Four of a rank exist; this bot can see its own, so the rest are
   * spread across everyone else — a claim of three against an expected share
   * of one is the game's one piece of real deduction short of proof, and how
   * heavily a bot leans on it is most of what makes it good.
   *
   * There is deliberately no separate "it was a fat claim" term. A flat
   * adder for three-or-more measures the same thing this does and measures
   * it worse: three cards is unremarkable from a hand holding three of the
   * rank and very loud from one holding none, and only this knows which.
   */
  excess: number;
  /** Added when the claimer has just emptied their hand — call or lose. */
  goingOut: number;
  /**
   * What suspicion is MULTIPLIED by once the pile is big enough to hurt.
   * A factor rather than a subtraction, so it can never drive a tier with
   * low idle suspicion to never calling at all. Proof is never damped: a
   * provable lie on a big pile is the best moment in the game.
   */
  caution: number;
  /** How often a true claim gets padded out with junk it did not need to. */
  pad: number;
  /** How often a forced lie is a fat one rather than a single card. */
  bold: number;
  /**
   * The biggest claim this bot will make when ANY part of it is a lie — and
   * the real reason a sharp table is hard to beat.
   *
   * The arithmetic runs both ways, and it is about the total claimed, not
   * the fake part of it. A claim of four is beaten by any rival holding a
   * single one of that rank, and a claim of three by any rival holding two,
   * whether the claimer padded one real card or invented all of them. So a
   * fat bluff is not bold, it is an announcement.
   *
   * An honest claim is exempt, at any size: claiming exactly the four aces
   * you are holding cannot be disproved by anybody, because there is nothing
   * left for them to hold.
   */
  maxBluff: number;
  /**
   * How often the cap above is thrown away for a full-fat claim.
   *
   * It has to be non-zero, and finding out why was the whole point of
   * measuring this. With a hard cap, a bot's three- and four-card claims are
   * ALWAYS honest — so "they never bluff big" becomes a rule a person can
   * read off the table and play against for free, and, worse, the bots' own
   * suspicion of fat claims was then systematically aimed at truthful ones.
   * A bluff that is occasionally enormous is what keeps a big claim a
   * question rather than a tell.
   */
  reckless: number;
  /** Pile size at which this bot starts playing it safe. */
  cautionPile: number;
  /** False for the tier that sheds cards at random rather than by value. */
  reasons: boolean;
}

/**
 * `caught` is deliberately below 1 at every tier, sharp included. A bot
 * that never misses a provable lie would mean a hand with no cards of the
 * rank is a hand that cannot bluff, and the whole game would collapse to
 * "play honestly or lose the pile".
 */
const NERVE: Record<BotDifficulty, Nerve> = {
  casual: {
    base: 0.05,
    caught: 0.35,
    excess: 0.05,
    goingOut: 0.35,
    caution: 0.85,
    pad: 0.28,
    bold: 0.4,
    maxBluff: MAX_PER_PLAY,
    reckless: 0.3,
    cautionPile: 18,
    reasons: false,
  },
  steady: {
    base: 0.026,
    caught: 0.72,
    excess: 0.1,
    goingOut: 0.62,
    caution: 0.6,
    pad: 0.18,
    bold: 0.24,
    maxBluff: 2,
    reckless: 0.2,
    cautionPile: 14,
    reasons: true,
  },
  sharp: {
    base: 0.014,
    caught: 0.93,
    excess: 0.16,
    goingOut: 0.84,
    caution: 0.45,
    pad: 0.12,
    bold: 0.16,
    maxBluff: 2,
    reckless: 0.14,
    cautionPile: 11,
    reasons: true,
  },
};

/** The claim ceiling for a lie this turn — usually the cap, sometimes not. */
function bluffCeiling(nerve: Nerve, rng: Rng): number {
  return rng.next() < nerve.reckless ? MAX_PER_PLAY : nerve.maxBluff;
}

/** Play-turn pace. A window's pace comes from the race, not from here. */
const PACE: Record<BotDifficulty, { min: number; span: number }> = {
  casual: { min: 520, span: 520 },
  steady: { min: 450, span: 440 },
  sharp: { min: 360, span: 380 },
};

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Would this seat doubt the claim on the table?
 *
 * The one piece of real deduction available is arithmetic on the bot's own
 * hand: only four of a rank exist, so holding two sevens against a claim of
 * three is proof. Everything else is nerve.
 */
export function wouldCall(
  state: BsState,
  seat: SeatId,
  tier: BotDifficulty,
  rng: Rng,
): boolean {
  const play = livePlay(state);
  if (!play) return false;
  const nerve = NERVE[tier];

  const mine = countOfRank(state.hands[seat] ?? [], play.claimed);
  const provable = mine + play.cards.length > MAX_PER_PLAY;

  if (provable) return rng.next() < clamp01(nerve.caught);

  // Four of a rank exist and this bot can see its own, so `remaining` are
  // spread over everybody else and one rival's expected share is a fraction
  // of that. A claim above that share is suspicious in proportion to how
  // much of the remaining supply it demands — normalised BY that supply,
  // because "two more than expected" means something very different when
  // four are unaccounted for than when two are.
  const rivals = Math.max(1, state.seats - 1);
  const remaining = Math.max(1, MAX_PER_PLAY - mine);
  const over = (play.cards.length - remaining / rivals) / remaining;
  let chance = nerve.base + nerve.excess * Math.max(0, over);
  // Their hand is empty: let this stand and the round is over. Even a casual
  // bot mostly speaks up here, and it is what makes going out the hard part
  // of BS rather than a formality.
  if ((state.hands[play.seat] ?? []).length === 0) chance += nerve.goingOut;
  if (pileSize(state) >= nerve.cautionPile) chance *= nerve.caution;
  return rng.next() < clamp01(chance);
}

/**
 * Which cards to shed when there is no honest play available.
 *
 * Sorted by how long until that rank comes round again, longest first: a
 * card whose rank has just gone past is twelve plays of dead weight, and a
 * card you could claim honestly next turn is worth keeping. `casual` shuffles
 * instead, which is most of what separates the tiers over a whole round.
 */
function shedOrder(
  junk: readonly PieceId[],
  current: Rank,
  tier: BotDifficulty,
  rng: Rng,
): PieceId[] {
  if (!NERVE[tier].reasons) return rng.shuffle(junk);
  return [...junk].sort((a, b) => {
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra === null || rb === null) return 0;
    return turnsUntil(rb, current) - turnsUntil(ra, current);
  });
}

function choosePlay(
  state: BsState,
  seat: SeatId,
  tier: BotDifficulty,
  rng: Rng,
): BsAction {
  const nerve = NERVE[tier];
  const hand = state.hands[seat] ?? [];
  const rank = state.rank;
  const honest = hand.filter((id) => rankOf(id) === rank);
  const junk = shedOrder(hand.filter((id) => rankOf(id) !== rank), rank, tier, rng);
  const cautious = pileSize(state) >= nerve.cautionPile;

  if (honest.length === 0) {
    // No choice about lying, only about how big. A single card is far more
    // likely to survive; a fat one is a gamble worth taking while the pile
    // is still cheap, or when somebody else is about to go out anyway.
    const room = Math.min(bluffCeiling(nerve, rng), junk.length);
    // Somebody is nearly out, so sitting on a hand is the losing move — but
    // a nudge rather than an override. Forcing a fat lie whenever any rival
    // was short meant a whole late round of four-card claims, which is the
    // one thing that draws fire from every seat at the table at once.
    const pressed = nearestRivalCount(state, seat) <= 2 ? 0.3 : 0;
    const bold = !cautious && rng.next() < nerve.bold + pressed;
    const n = bold && room > 1 ? 1 + rng.int(room) : 1;
    return { t: "play", cards: junk.slice(0, Math.max(1, n)) };
  }

  const cards = [...honest.slice(0, MAX_PER_PLAY)];
  // Padding a true claim with junk is the move that makes this game, and it
  // is also the reason a bot has to do it sometimes when it did not need to:
  // if a fat claim only ever meant a bluff, the count alone would give every
  // bot away.
  // Padding runs into the same arithmetic as a bluff, and it is the TOTAL
  // that gives it away: two real sevens claimed as four is provable to any
  // rival holding one, exactly like inventing all four. So the cap is on
  // where the claim ENDS UP, which is why a bot holding two already has no
  // room to pad at all.
  const ceiling = bluffCeiling(nerve, rng);
  const room = Math.min(ceiling - cards.length, MAX_PER_PLAY - cards.length, junk.length);
  if (room > 0 && !cautious && rng.next() < nerve.pad) {
    cards.push(...junk.slice(0, 1 + rng.int(room)));
  }
  return { t: "play", cards: cards.slice(0, MAX_PER_PLAY) };
}

function makeBot(id: string, tier: BotDifficulty): BotStrategy<BsState, BsAction> {
  return {
    id,
    choose(state, seat, rng) {
      if (state.pendingTake === seat) return { t: "takePile", seat };
      if (entitledToCall(state, seat)) {
        return wouldCall(state, seat, tier, rng)
          ? { t: "callBs", seat }
          : { t: "declineBs", seat };
      }
      // A bot never uses the seat-on-turn interrupt (playing over the top of
      // a window it is also entitled to answer). Jumping its own queue would
      // gain it nothing, and the interrupt exists for people, who are the
      // only ones a generous window can hold up.
      return choosePlay(state, seat, tier, rng);
    },
    thinkMs(state, seat, rng) {
      if (state.pendingTake === seat) return 180 + rng.int(160);
      // In a window the think IS the reaction time, read back off the race
      // itself rather than drawn again here. The two have to be the same
      // number: the list decides who gets the first look, and the pause the
      // player watches is what makes that legible.
      const racing = state.window?.pending.find((p) => p.seat === seat);
      if (racing) return racing.ms;
      const pace = PACE[tier];
      return pace.min + rng.int(pace.span);
    },
  };
}

export const bsBots: Record<BotDifficulty, BotStrategy<BsState, BsAction>> = {
  casual: makeBot("bs-casual", "casual"),
  steady: makeBot("bs-steady", "steady"),
  sharp: makeBot("bs-sharp", "sharp"),
};
