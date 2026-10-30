/**
 * Chromaly's bots.
 *
 * Three tiers, and what separates them is not only how well they play a
 * hand. The game's two races (jumping in, catching a last card) only exist
 * because a bot can MISS: one that always catches makes calling your last
 * card a ritual, and one that never does makes it free. So each tier is
 * partly a rate of noticing, and `bots.test.ts` measures that those rates
 * are reachable, not merely that they are ordered.
 *
 * A bot sees `playerView(state, seat)` and nothing else. What it can read
 * about an opponent is only what the whole table saw: how many cards they
 * hold, and `state.misses` - the colours they drew on, which means they had
 * none of that colour.
 *
 * Randomness splits in two. A choice of CARD uses the `rng` the session
 * hands in. A decision that has to hold still - did I notice the window,
 * did I remember to call - is a hashed roll keyed to the position, so it is
 * the same answer however many times the bot is asked, and a seed replays it.
 */

import { hashString, type Rng } from "@/engine/rng";
import type { BotDifficulty, BotStrategy, PieceId, SeatId } from "@/engine/types";
import { personality, stableRoll } from "@/games/_shared/botPersonality";
import {
  COLORS,
  identical,
  isWild,
  parseCard,
  points,
  type Color,
} from "./cards";
import {
  bestColor,
  canPlay,
  facingPenalty,
  legalDoubles,
  nextSeat,
  plusFourIsBluff,
  playableIds,
} from "./state";
import type { ChromalyAction, ChromalyState } from "./types";

interface Tier {
  /** Chance of NOT saying a last card ahead of the play. */
  forgets: number;
  /** Chance of noticing a seat on its last card in time to catch it. */
  catches: number;
  /** Chance of getting a card down in a window that has one to jump in on. */
  jumps: number;
  /** Chance, once caught out, of still saving itself inside the window. */
  recovers: number;
  /** Chance of playing a Wild +4 it holds a colour for, given another way to play. */
  bluffs: number;
  /** Chance of answering a penalty with a draw card it holds. */
  stacks: number;
  /** How much a challenge needs to look like a bluff before it is called. */
  doubt: number;
  /** Thinks about the table (leader, colours) or just plays. */
  reads: boolean;
}

const TIERS: Record<BotDifficulty, Tier> = {
  casual: { forgets: 0.3, catches: 0.5, jumps: 0.4, recovers: 0.6, bluffs: 0.3, stacks: 0.4, doubt: 0.0, reads: false },
  steady: { forgets: 0.16, catches: 0.68, jumps: 0.62, recovers: 0.85, bluffs: 0.04, stacks: 0.75, doubt: 0.1, reads: false },
  sharp: { forgets: 0.02, catches: 0.95, jumps: 0.95, recovers: 0.98, bluffs: 0.12, stacks: 0.95, doubt: 0.0, reads: true },
};

/** A roll that holds still for the same decision at the same position. */
function roll(state: ChromalyState, seat: SeatId, what: string): number {
  return stableRoll(`chromaly|${state.round}|${state.plays}|${state.windowCount}|${seat}|${what}`);
}

/** The seat after this one, and the player after that, as the table now runs. */
function upNext(state: ChromalyState, seat: SeatId): SeatId {
  return nextSeat(state, seat);
}

function handSize(state: ChromalyState, seat: SeatId): number {
  return (state.hands[seat] ?? []).length;
}

/** The seat holding the fewest cards other than this one. */
function leader(state: ChromalyState, seat: SeatId): SeatId {
  let best: SeatId = seat === 0 ? 1 : 0;
  for (let s = 0; s < state.seats; s++) {
    const other = s as SeatId;
    if (other === seat) continue;
    if (handSize(state, other) < handSize(state, best)) best = other;
  }
  return best;
}

/**
 * How likely a +4 was a bluff, from what this seat can see: the share of the
 * unseen cards that are the colour in question, over the offender's hand.
 * Cards in my hand and on the pile are known; everything else is in the draw
 * pile or in somebody's hand, and the offender's hand is a random sample.
 */
function bluffOdds(state: ChromalyState, seat: SeatId): number {
  const challenge = state.challenge;
  if (!challenge) return 0;
  const color = challenge.onColor;
  const known = new Set<PieceId>([...(state.hands[seat] ?? []), ...state.discard]);
  const inColor = (id: PieceId) => {
    const c = parseCard(id);
    return c !== null && !isWild(c) && c.color === color;
  };
  // 25 of a colour exist (a 0, then two each of 1-9 and the three actions).
  let unseenOfColor = 25;
  for (const id of known) if (inColor(id)) unseenOfColor -= 1;
  let unseen = state.drawPile.length;
  for (let s = 0; s < state.seats; s++) if (s !== seat) unseen += handSize(state, s as SeatId);
  const theirs = Math.max(1, handSize(state, challenge.offender));
  const p = Math.max(0, Math.min(1, unseenOfColor / Math.max(1, unseen)));
  let odds = 1 - Math.pow(1 - p, theirs);
  // They drew on this very colour not long ago: they had none then, and a
  // hand that has just run dry of it is less likely to have refilled.
  if ((state.misses[challenge.offender] ?? []).includes(color)) odds *= 0.5;
  return odds;
}

/* ------------------------------------------------------------- the window */

function answerWindow(state: ChromalyState, seat: SeatId, tier: Tier): ChromalyAction {
  const w = state.window!;
  if (w.offenders.length > 0) {
    // Saving yourself and catching somebody are one button, and which it is
    // depends only on who pressed it.
    const chance = w.offenders.includes(seat) ? tier.recovers : tier.catches;
    if (roll(state, seat, "call") < chance) return { t: "callLast", seat };
    return { t: "declineWindow", seat };
  }
  if (w.jumpers.includes(seat) && w.card !== null && roll(state, seat, "jump") < tier.jumps) {
    const top = parseCard(w.card);
    const mine = (state.hands[seat] ?? []).find((id) => {
      const c = parseCard(id);
      return c !== null && top !== null && identical(c, top);
    });
    if (mine !== undefined) {
      const jump: ChromalyAction = { t: "jumpIn", seat, card: mine };
      if (isSwap(state, seat, mine)) jump.swapWith = swapTarget(state, seat);
      return jump;
    }
  }
  return { t: "declineWindow", seat };
}

/* ------------------------------------------------------------ choosing a card */

function isSwap(state: ChromalyState, seat: SeatId, id: PieceId): boolean {
  const c = parseCard(id);
  return state.rules.sevenZero && c !== null && c.kind === "number" && c.value === 7 && handSize(state, seat) > 1;
}

/** Whom to swap with: whoever holds the fewest cards (the user's rule of thumb, and everyone's). */
function swapTarget(state: ChromalyState, seat: SeatId): SeatId {
  return leader(state, seat);
}

/** What a card is worth keeping: higher points are worse to be caught holding. */
function dumpValue(id: PieceId): number {
  return points(id);
}

/**
 * Weights for a card's score, lower being played first.
 *
 * Sharp's differ from the others', and the difference is measured rather than
 * guessed: `bots.test.ts` holds the tiers to winning matches in that order.
 * Staying in the colour you hold most counts for far more than shedding the
 * heavy cards (it was the other way round, and sharp was no better than
 * steady), while "play the card most likely to be stranded first" and
 * "leave the next seat in a colour it just failed to follow" looked sensible
 * and measured as nothing or worse. The edge is real and modest - about 54%
 * of Classic matches and 60% of Party ones against steady - which is what
 * skill is worth in a game this dependent on the draw.
 */
const WEIGHTS = {
  sharp: { points: 0.4, sameColour: 5, attack: 30 },
  other: { points: 1, sameColour: 2, attack: 0 },
};

/** Lower is better: the order in which a bot would shed. */
function score(state: ChromalyState, seat: SeatId, id: PieceId, tier: Tier): number {
  const c = parseCard(id)!;
  const hand = state.hands[seat] ?? [];
  const w = tier.reads ? WEIGHTS.sharp : WEIGHTS.other;
  let s = -dumpValue(id) * w.points;

  // Keep wilds back: they are the cards that rescue a bad hand later.
  if (isWild(c)) s += 60;
  // A colour I hold plenty of is one worth staying in.
  if (!isWild(c) && c.color) {
    const same = hand.filter((h) => {
      const x = parseCard(h);
      return h !== id && x !== null && !isWild(x) && x.color === c.color;
    }).length;
    s -= same * w.sameColour;
  }

  if (w.attack !== 0) {
    const theirs = handSize(state, upNext(state, seat));
    // Aim the cards that hurt at somebody about to go out.
    if (c.kind === "skip" || c.kind === "draw2" || c.kind === "reverse") {
      if (theirs <= 2) s -= w.attack;
      if (theirs >= 6) s += 10;
    }
  }
  return s;
}

function chooseColor(state: ChromalyState, seat: SeatId, except: PieceId, tier: Tier, rng: Rng): Color {
  const hand = state.hands[seat] ?? [];
  if (!tier.reads && tier === TIERS.casual) {
    // A casual player names whatever comes to mind.
    return COLORS[rng.int(COLORS.length)]!;
  }
  const mine = bestColor(hand, except);
  if (!tier.reads) return mine;
  // A sharp player prefers a colour the next seat has failed to follow - but
  // only when it costs nothing: its own best colour comes first, and the
  // other is chosen only if it holds as many of it. Naming a colour it has
  // one card of, to hurt somebody, was worse than just staying in its own.
  const count = (c: Color) =>
    hand.filter((id) => {
      const x = parseCard(id);
      return id !== except && x !== null && !isWild(x) && x.color === c;
    }).length;
  const next = upNext(state, seat);
  const lacked = (state.misses[next] ?? []).filter((c) => count(c) >= count(mine));
  return lacked.length > 0 ? lacked[lacked.length - 1]! : mine;
}

/** Sets of two or more same-numbered cards in hand that could be played together. */
function doublesOptions(state: ChromalyState, seat: SeatId): PieceId[][] {
  if (!state.rules.doubles || state.drawn !== null || facingPenalty(state)) return [];
  const byValue = new Map<number, PieceId[]>();
  for (const id of state.hands[seat] ?? []) {
    const c = parseCard(id);
    if (c?.kind !== "number") continue;
    byValue.set(c.value!, [...(byValue.get(c.value!) ?? []), id]);
  }
  const out: PieceId[][] = [];
  for (const group of byValue.values()) {
    if (group.length < 2) continue;
    // The pair, then the biggest dump; the last named is the top.
    for (const size of new Set([2, group.length])) {
      const picked = group.slice(0, size);
      if (legalDoubles(state, seat, picked)) out.push(picked);
    }
  }
  return out;
}

function chooseTurn(state: ChromalyState, seat: SeatId, tier: Tier, rng: Rng, kind: BotDifficulty): ChromalyAction {
  const hand = state.hands[seat] ?? [];

  // A penalty on the table: answer it with a draw card, challenge it, or take it.
  if (facingPenalty(state)) {
    if (state.challenge) {
      const amount = state.challenge.amount;
      const threshold = 2 / (amount + 2) + tier.doubt;
      const odds = kind === "casual" ? 0.5 : bluffOdds(state, seat);
      const stack = playableIds(state, seat)[0];
      // Stacking a +4 sends the problem on and voids the challenge; a bot that
      // has the card and likes the idea does it, otherwise it weighs the call.
      if (stack !== undefined && roll(state, seat, "stack") < tier.stacks) {
        return play(state, seat, stack, tier, rng);
      }
      if (odds > threshold && roll(state, seat, "doubt") < 0.97) return { t: "challenge" };
      return { t: "acceptPenalty" };
    }
    const stack = playableIds(state, seat)[0];
    if (stack !== undefined && roll(state, seat, "stack") < tier.stacks) {
      return play(state, seat, stack, tier, rng);
    }
    return { t: "acceptPenalty" };
  }

  // A card just drawn: play it, or keep it if there is something better to do.
  if (state.drawn !== null) {
    const drawn = state.drawn;
    const mustPlay = state.rules.forcePlay && canPlay(state, seat, drawn);
    const c = parseCard(drawn);
    const holdWild = !mustPlay && c !== null && isWild(c) && kind !== "casual" && hand.length > 3;
    if (holdWild) return { t: "keep" };
    return play(state, seat, drawn, tier, rng);
  }

  let options = playableIds(state, seat);
  // A +4 that would be a bluff is only played now and then.
  options = options.filter((id) => {
    const c = parseCard(id);
    if (c?.kind !== "wild4" || !plusFourIsBluff(state, seat, id)) return true;
    return options.length === 1 || roll(state, seat, "bluff") < tier.bluffs * personality("chromaly", seat).bluff;
  });
  if (options.length === 0) return { t: "draw" };

  // Several cards at once, where the rules allow it.
  const groups = doublesOptions(state, seat);
  if (groups.length > 0 && kind !== "casual" && hand.length > 3) {
    const biggest = groups.reduce((a, b) => (b.length > a.length ? b : a));
    return doublePlay(state, seat, biggest, tier);
  }

  // Rank by score, then take the best. A small per-seat jitter breaks ties,
  // so two bots at one table with the same hand are not the same player.
  const jitter = (id: PieceId) => (hashString(`${id}|${seat}`) % 100) / 100;
  const ranked = [...options].sort(
    (a, b) => score(state, seat, a, tier) + jitter(a) - (score(state, seat, b, tier) + jitter(b)),
  );
  const pick = kind === "casual" ? options[rng.int(options.length)]! : ranked[0]!;
  return play(state, seat, pick, tier, rng);
}

function withCall(state: ChromalyState, seat: SeatId, left: number, tier: Tier): boolean {
  return left === 1 && roll(state, seat, "precall") >= tier.forgets;
}

function play(state: ChromalyState, seat: SeatId, id: PieceId, tier: Tier, rng: Rng): ChromalyAction {
  const c = parseCard(id)!;
  const action: ChromalyAction & { t: "play" } = { t: "play", cards: [id] };
  if (isWild(c)) action.color = chooseColor(state, seat, id, tier, rng);
  if (isSwap(state, seat, id)) action.swapWith = swapTarget(state, seat);
  if (withCall(state, seat, handSize(state, seat) - 1, tier)) action.call = true;
  return action;
}

function doublePlay(state: ChromalyState, seat: SeatId, cards: PieceId[], tier: Tier): ChromalyAction {
  const action: ChromalyAction & { t: "play" } = { t: "play", cards };
  if (withCall(state, seat, handSize(state, seat) - cards.length, tier)) action.call = true;
  return action;
}

/* ------------------------------------------------------------- the strategy */

function strategy(kind: BotDifficulty): BotStrategy<ChromalyState, ChromalyAction> {
  const tier = TIERS[kind];
  return {
    id: `chromaly-${kind}`,
    choose(state, seat, rng) {
      if (state.window) return answerWindow(state, seat, tier);
      return chooseTurn(state, seat, tier, rng, kind);
    },
    thinkMs(state, _seat, rng) {
      // A window is answered after the bot's reaction time, which the
      // session waits out before it asks (`turnHold`): thinking as well
      // would be the same wait twice.
      if (state.window) return 80;
      return 600 + rng.int(600);
    },
  };
}

export const chromalyBots: Record<BotDifficulty, BotStrategy<ChromalyState, ChromalyAction>> = {
  casual: strategy("casual"),
  steady: strategy("steady"),
  sharp: strategy("sharp"),
};

// Exported for the tests, which measure these rates rather than assume them.
export { TIERS };
