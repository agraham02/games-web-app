/**
 * Chromaly constants and pure queries over a position. No `reduce` here.
 */

import { hashString } from "@/engine/rng";
import type { PieceId, SeatId } from "@/engine/types";
import {
  COLORS,
  drawAmount,
  identical,
  isDraw,
  isWild,
  matches,
  parseCard,
  type Color,
  type ParsedCard,
  type Top,
} from "./cards";
import type { ChromalyRules, ChromalyState, Window } from "./types";

export const MIN_SEATS = 2;
/**
 * Ten, like Poker and Left Right Center. Seven cards each leaves the pile
 * 38 deep at ten seats, and a round at that size is a free-for-all rather
 * than a card game, which is what a big family table wants.
 */
export const MAX_SEATS = 10;
export const DEFAULT_SEATS = 4;
export const HAND_SIZE = 7;

/** Points to win the match: Mattel's 500, and what the setup may ask for. */
export const DEFAULT_TARGET = 500;
export const TARGET_MIN = 100;
export const TARGET_MAX = 1000;

/**
 * How long a person gets to answer a window, in ms: the user's three
 * seconds (2026-10-24). Adjustable in a room, as BS's is.
 */
export const DEFAULT_WINDOW_MS = 3000;
export const WINDOW_MS_MIN = 2000;
export const WINDOW_MS_MAX = 6000;

/**
 * How much longer the DRIVER waits than the ring a player is watching - the
 * same allowance BS gives its window, for the same reason: the client's own
 * countdown should resolve an ordinary window, and the driver's timer is a
 * backstop for a throttled tab. They are deliberately not tuned to fire
 * together.
 */
export const WINDOW_GRACE_MS = 900;

/**
 * The beat between one seat's answer to a window and the next seat's.
 * Small, and handed to the driver through `turnHold`: a seat that lets a
 * play go emits no events, so at the driver's flat 900ms every declining
 * seat would show nothing for most of a second.
 */
export const WINDOW_BEAT_MS = 120;

/** A bot never answers a window sooner than this, in ms from it opening. */
export const REACTION_MIN = 700;
/** ...nor later than this, or than the window less `REACTION_TAIL_MS`. */
export const REACTION_MAX = 2600;
export const REACTION_TAIL_MS = 600;

/** The penalty for being caught on a last card without having called it. */
export const CALL_PENALTY = 2;
/** What a failed challenge costs on top of the +4: the official six. */
export const FAILED_CHALLENGE_EXTRA = 2;

/**
 * Plays in one round before it is declared stuck. A round always ends in
 * practice, but a table of bots that all hold the wrong colour can cycle,
 * and a loop with no exit is not a thing a server may contain.
 */
export const PLAY_LIMIT = 800;

export const DEFAULT_RULES: ChromalyRules = {
  target: DEFAULT_TARGET,
  drawToMatch: false,
  forcePlay: false,
  stacking: "off",
  plusFour: "challenge",
  jumpIn: false,
  sevenZero: false,
  doubles: false,
  plainPairs: false,
  shuffleHands: false,
  windowMs: DEFAULT_WINDOW_MS,
};

/** The seat `n` places on from `from`, in a direction. */
export function stepSeat(seats: number, from: SeatId, direction: 1 | -1, n = 1): SeatId {
  return ((((from + direction * n) % seats) + seats) % seats) as SeatId;
}

export function nextSeat(state: ChromalyState, from: SeatId, n = 1): SeatId {
  return stepSeat(state.seats, from, state.direction, n);
}

/** The card on top of the pile and the colour in force, or null before a deal. */
export function topOf(state: ChromalyState): Top | null {
  const id = state.discard[state.discard.length - 1];
  const card = id === undefined ? null : parseCard(id);
  return card ? { card, color: state.color } : null;
}

export function holdsColor(state: ChromalyState, seat: SeatId, color: Color, except?: PieceId): boolean {
  return (state.hands[seat] ?? []).some((id) => {
    if (id === except) return false;
    const c = parseCard(id);
    return c !== null && !isWild(c) && c.color === color;
  });
}

/**
 * Would playing this Wild +4 be a bluff? Official rule (2018 sheet): it is
 * legal only with no card of the colour in force. Wilds and numbers that
 * happen to match do not count.
 */
export function plusFourIsBluff(state: ChromalyState, seat: SeatId, id: PieceId): boolean {
  return holdsColor(state, seat, state.color, id);
}

/**
 * May this draw card answer the penalty on the table? Only under stacking,
 * and only as far as the rule allows: `same` is a +2 on a +2 or a +4 on a +4,
 * `upward` also lets a +4 go on a +2.
 */
export function answersPenalty(state: ChromalyState, card: ParsedCard): boolean {
  if (state.rules.stacking === "off" || !isDraw(card)) return false;
  const last = state.pendingDraw?.kind ?? (state.challenge ? "wild4" : null);
  if (last === null) return false;
  if (state.rules.stacking === "same") return card.kind === last;
  return card.kind === "wild4" || last === "draw2";
}

/** Is there a penalty the seat on turn must answer or take? */
export function facingPenalty(state: ChromalyState): boolean {
  return state.pendingDraw !== null || state.challenge !== null;
}

/**
 * May this card be played by `seat` as an ordinary play on its turn?
 *
 * Facing a penalty, only a stacking answer. A Wild +4 under the `honest`
 * rule is also refused while the seat holds the colour, since it is the
 * only rule where it is not a bluff to be challenged but a play to be
 * refused.
 */
export function canPlay(state: ChromalyState, seat: SeatId, id: PieceId): boolean {
  const card = parseCard(id);
  const top = topOf(state);
  if (!card || !top) return false;
  if (!(state.hands[seat] ?? []).includes(id)) return false;
  if (facingPenalty(state)) {
    if (!answersPenalty(state, card)) return false;
  } else if (!matches(card, top)) {
    return false;
  }
  if (card.kind === "wild4" && state.rules.plusFour === "honest" && plusFourIsBluff(state, seat, id)) {
    return false;
  }
  return true;
}

/** Every card in the seat's hand it may play right now, in hand order. */
export function playableIds(state: ChromalyState, seat: SeatId): PieceId[] {
  if (state.drawn !== null) return canPlay(state, seat, state.drawn) ? [state.drawn] : [];
  return (state.hands[seat] ?? []).filter((id) => canPlay(state, seat, id));
}

/**
 * Is this a legal play of several cards under `doubles`?
 *
 * Two or more cards of one kind, in any colours, at least one of which could
 * go on the pile: NUMBER cards of one number, or Skips, or Reverses (the
 * user, 2026-10-30). The last named is the top and so sets the colour. Not
 * while a penalty is pending, and not for the card just drawn, which is
 * played alone.
 */
export function legalDoubles(state: ChromalyState, seat: SeatId, cards: readonly PieceId[]): boolean {
  if (!state.rules.doubles || cards.length < 2) return false;
  if (facingPenalty(state) || state.drawn !== null) return false;
  if (new Set(cards).size !== cards.length) return false;
  const top = topOf(state);
  if (!top) return false;
  const hand = new Set(state.hands[seat] ?? []);
  const parsed: ParsedCard[] = [];
  for (const id of cards) {
    const card = hand.has(id) ? parseCard(id) : null;
    if (!card || !groupable(card)) return false;
    parsed.push(card);
  }
  if (parsed.some((c) => !sameGroup(c, parsed[0]!))) return false;
  return parsed.some((c) => matches(c, top));
}

/** May this card be one of several played at once? */
export function groupable(card: ParsedCard): boolean {
  return card.kind === "number" || card.kind === "skip" || card.kind === "reverse";
}

/** Could these two go down together: one number, or both Skips, or both Reverses? */
export function sameGroup(a: ParsedCard, b: ParsedCard): boolean {
  if (a.kind !== b.kind || !groupable(a)) return false;
  return a.kind !== "number" || a.value === b.value;
}

/** Seats other than `by` holding a card identical to `id`, in seat order. */
export function jumpersFor(state: ChromalyState, by: SeatId, id: PieceId): SeatId[] {
  const played = parseCard(id);
  if (!played || isWild(played)) return [];
  const out: SeatId[] = [];
  for (let s = 0; s < state.seats; s++) {
    const seat = s as SeatId;
    if (seat === by) continue;
    if ((state.hands[seat] ?? []).some((h) => {
      const c = parseCard(h);
      return c !== null && identical(c, played);
    })) {
      out.push(seat);
    }
  }
  return out;
}

/** Seats on their last card that have not called it and have not got away with it. */
export function offendersOf(state: ChromalyState): SeatId[] {
  const out: SeatId[] = [];
  for (let s = 0; s < state.seats; s++) {
    const seat = s as SeatId;
    if ((state.hands[seat] ?? []).length === 1 && state.calls[seat] === undefined) out.push(seat);
  }
  return out;
}

/**
 * A seat's reaction time to a window, in ms from it opening.
 *
 * Hashed from the position rather than drawn from an `Rng`, because
 * `reduce(state, action)` receives none by design; the key names everything
 * that makes this window unique, so a seed replays a match's races exactly
 * as it replays its deals.
 */
export function reactionMs(state: ChromalyState, windowId: number, seat: SeatId): number {
  const hi = Math.max(REACTION_MIN + 1, Math.min(REACTION_MAX, state.rules.windowMs - REACTION_TAIL_MS));
  const span = hi - REACTION_MIN + 1;
  return REACTION_MIN + (hashString(`chromaly|${state.round}|${windowId}|${seat}`) % span);
}

/** Sorted soonest first, ties broken by seat so the order is total. */
export function pendingFor(
  state: ChromalyState,
  windowId: number,
  seats: readonly SeatId[],
): Array<{ seat: SeatId; ms: number }> {
  return seats
    .map((seat) => ({ seat, ms: reactionMs(state, windowId, seat) }))
    .sort((a, b) => a.ms - b.ms || a.seat - b.seat);
}

export function entitledToWindow(state: ChromalyState, seat: SeatId): boolean {
  return state.window?.pending.some((p) => p.seat === seat) ?? false;
}

export function windowCard(window: Window | null): PieceId | null {
  return window?.card ?? null;
}

export function handTotal(state: ChromalyState): number {
  let n = 0;
  for (let s = 0; s < state.seats; s++) n += (state.hands[s as SeatId] ?? []).length;
  return n;
}

/** The colour a seat holds most of — what a Wild should name. */
export function bestColor(hand: readonly PieceId[], except?: PieceId): Color {
  const counts = new Map<Color, number>();
  for (const id of hand) {
    if (id === except) continue;
    const c = parseCard(id);
    if (c && !isWild(c) && c.color) counts.set(c.color, (counts.get(c.color) ?? 0) + 1);
  }
  let best: Color = COLORS[0];
  let most = -1;
  for (const color of COLORS) {
    const n = counts.get(color) ?? 0;
    if (n > most) {
      best = color;
      most = n;
    }
  }
  return best;
}

/**
 * Why a tap on this card did nothing, in plain words - or null when it can be
 * played. Feedback AFTER an attempt, never a hint before one: it is only asked
 * once the player has tried the card.
 */
export function whyNotPlayable(state: ChromalyState, seat: SeatId, id: PieceId): string | null {
  if (!(state.hands[seat] ?? []).includes(id)) return "That card is not in your hand";
  if (state.drawn !== null && id !== state.drawn) return "Only the card you just drew can be played";
  if (canPlay(state, seat, id)) return null;
  const card = parseCard(id);
  if (facingPenalty(state)) {
    return state.rules.stacking === "off"
      ? "Take the penalty first"
      : "That does not answer the penalty";
  }
  if (card?.kind === "wild4" && state.rules.plusFour === "honest") {
    return "A Wild +4 needs a hand with none of the colour in play";
  }
  return "That does not match the pile";
}

/** The seat's cards in hand that are draw cards, for a stack. */
export function penaltyOf(card: ParsedCard): number {
  return drawAmount(card);
}
