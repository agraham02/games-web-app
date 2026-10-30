/**
 * Chromaly: match the colour or the number, and be first to empty your hand.
 *
 * Read the rest of this file with two things in mind.
 *
 * The official game is small and every house rule is a switch on top of it
 * (`ChromalyRules`). Defaults are Mattel's 2018/2022 rules; each ruling where
 * the rulebooks disagree or say nothing is a named test in `rules.test.ts`.
 *
 * And the beat after a play is a RACE, as BS's challenge is. A seat may jump
 * in on a play, or catch a seat that reached its last card without calling
 * it, and either way more than one seat is entitled at once. That means the
 * same three things BS already provides for:
 *
 *  - `legalActions` is the turn gate, not `currentSeat`. `currentSeat` only
 *    names the one PACING waits on.
 *  - `deadline` is how a table parked on a person keeps moving, because a
 *    client-side timer cannot be the mechanism (a backgrounded tab's timers
 *    are throttled to about one a minute).
 *  - `turnHold` is how a bot waits out its reaction time BEFORE it answers.
 *
 * Unlike BS the window is not opened after every play. It opens only when
 * there is something to do in it - a seat with the twin of the card that
 * just went down, or a seat on its last card - so most turns cost nothing.
 */

import { createRng, hashString, type Rng } from "@/engine/rng";
import type {
  GameDefinition,
  GameEvent,
  PieceId,
  PieceMeta,
  Placement,
  PlacementMap,
  ReduceResult,
  SeatId,
  SetupOptions,
} from "@/engine/types";
import {
  COLORS,
  cardLabel,
  deckIds,
  handDisplayOrder,
  identical,
  isDraw,
  isWild,
  parseCard,
  points,
  type Color,
  type ParsedCard,
} from "./cards";
import { chromalyBots } from "./bots";
import {
  CALL_PENALTY,
  DEFAULT_RULES,
  FAILED_CHALLENGE_EXTRA,
  HAND_SIZE,
  MAX_SEATS,
  MIN_SEATS,
  PLAY_LIMIT,
  WINDOW_BEAT_MS,
  WINDOW_GRACE_MS,
  WINDOW_MS_MAX,
  WINDOW_MS_MIN,
  TARGET_MAX,
  TARGET_MIN,
  bestColor,
  canPlay,
  entitledToWindow,
  facingPenalty,
  jumpersFor,
  legalDoubles,
  nextSeat,
  offendersOf,
  pendingFor,
  playableIds,
  plusFourIsBluff,
  stepSeat,
} from "./state";
import type { ChromalyAction, ChromalyRules, ChromalyState, RoundResult } from "./types";

/** The one placeholder `playerView` collapses a concealed card to. */
export const HIDDEN_CARD: PieceId = "??";

/** The newest discards left showing; deeper ones fade out in place. */
const VISIBLE_DISCARDS = 3;

/** Colours a seat's misses remember: enough to read a habit, not a history. */
const MISS_MEMORY = 6;

/* ------------------------------------------------------------------ rules */

function clampRules(rules: Partial<ChromalyRules>): ChromalyRules {
  const merged = { ...DEFAULT_RULES, ...rules };
  const int = (v: number, min: number, max: number, fallback: number) =>
    Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
  return {
    ...merged,
    target: int(merged.target, TARGET_MIN, TARGET_MAX, DEFAULT_RULES.target),
    windowMs: int(merged.windowMs, WINDOW_MS_MIN, WINDOW_MS_MAX, DEFAULT_RULES.windowMs),
    stacking: ["off", "same", "upward"].includes(merged.stacking) ? merged.stacking : "off",
    plusFour: ["challenge", "free", "honest"].includes(merged.plusFour) ? merged.plusFour : "challenge",
  };
}

/* ------------------------------------------------------------------ setup */

function makeSetup(rules: ChromalyRules) {
  return ({ seats, rng }: SetupOptions): ChromalyState => {
    const clamped = Math.min(MAX_SEATS, Math.max(MIN_SEATS, seats));
    const hands: Record<SeatId, PieceId[]> = {};
    const scores: Record<SeatId, number> = {};
    const misses: Record<SeatId, Color[]> = {};
    for (let s = 0; s < clamped; s++) {
      hands[s as SeatId] = [];
      scores[s as SeatId] = 0;
      misses[s as SeatId] = [];
    }
    // Undealt on purpose, as BS: `startRound` deals, which is what makes the
    // opening deal an ANIMATION, and `placements` parks the whole deck in the
    // draw pile until then so every `deal` has a stack to fly out of.
    return {
      seats: clamped,
      rules,
      round: 0,
      dealer: rng.int(clamped) as SeatId,
      dealt: false,
      secret: rng.int(0x7fffffff),
      reshuffles: 0,
      turn: 0,
      direction: 1,
      color: "R",
      hands,
      drawPile: deckIds(rules.shuffleHands),
      discard: [],
      drawn: null,
      pendingDraw: null,
      challenge: null,
      window: null,
      swapping: null,
      windowCount: 0,
      calls: {},
      scores,
      plays: 0,
      misses,
      result: null,
      winner: null,
    };
  };
}

/** A copy safe to mutate: `reduce` builds the next state on one. */
function draft(state: ChromalyState): ChromalyState {
  const hands: Record<SeatId, PieceId[]> = {};
  const misses: Record<SeatId, Color[]> = {};
  for (let s = 0; s < state.seats; s++) {
    hands[s as SeatId] = [...(state.hands[s as SeatId] ?? [])];
    misses[s as SeatId] = [...(state.misses[s as SeatId] ?? [])];
  }
  return {
    ...state,
    hands,
    misses,
    drawPile: [...state.drawPile],
    discard: [...state.discard],
    calls: { ...state.calls },
    scores: { ...state.scores },
    named: { ...(state.named ?? {}) },
  };
}

export function startRound(state: ChromalyState, rng: Rng): ReduceResult<ChromalyState> {
  const round = state.round + 1;
  // Round one keeps setup's random dealer; after that the deal rotates.
  const dealer = round === 1 ? state.dealer : nextSeat({ ...state, direction: 1 }, state.dealer);

  const hands: Record<SeatId, PieceId[]> = {};
  const misses: Record<SeatId, Color[]> = {};
  for (let s = 0; s < state.seats; s++) {
    hands[s as SeatId] = [];
    misses[s as SeatId] = [];
  }

  // Everything still out from the round that just ended goes back to the
  // draw pile first, as ONE gesture; empty on the very first deal, where
  // `placements` has already parked the whole deck there.
  const leftover = [...Object.values(state.hands).flat(), ...state.discard];
  const events: GameEvent[] =
    leftover.length > 0 ? [{ t: "sweep", pieces: leftover, to: "deck" }] : [];
  events.push({ t: "shuffle", seed: rng.seed });

  const pile = rng.shuffle(deckIds(state.rules.shuffleHands));
  let seat = nextSeat({ ...state, direction: 1 }, dealer);
  for (let i = 0; i < HAND_SIZE * state.seats; i++) {
    const card = pile.pop()!;
    hands[seat]!.push(card);
    // `faceUp` is corrected per viewer against `placements` by `projectEvents`.
    events.push({ t: "deal", piece: card, to: seat, faceUp: false });
    seat = stepSeat(state.seats, seat, 1);
  }

  // The card that starts the pile is the first NUMBER card: Mattel's 2022
  // sheet turns up the next card when an action or a wild shows, and taking
  // the first number out of the pile is the same thing without a burying.
  const at = findLastIndex(pile, (id) => parseCard(id)?.kind === "number");
  const starter = pile.splice(at, 1)[0]!;
  const color = parseCard(starter)!.color!;
  events.push({
    t: "move",
    piece: starter,
    to: { zone: "discard", index: 0, count: 1, faceUp: true },
  });

  return {
    state: {
      ...state,
      round,
      dealer,
      dealt: true,
      reshuffles: 0,
      turn: nextSeat({ ...state, direction: 1 }, dealer),
      direction: 1,
      color,
      hands,
      drawPile: pile,
      discard: [starter],
      drawn: null,
      pendingDraw: null,
      challenge: null,
      window: null,
      swapping: null,
      calls: {},
      plays: 0,
      misses,
      named: {},
      result: null,
    },
    events,
  };
}

function findLastIndex<T>(items: readonly T[], test: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i]!)) return i;
  return items.length - 1;
}

/* ---------------------------------------------------------------- drawing */

/**
 * Rebuilds the draw pile from the discard, keeping the top card showing.
 *
 * Seeded from `secret`, which no viewer is ever sent: `reduce` takes no rng,
 * and seeding from the public discard alone would let any client work out
 * the order of every card still to be drawn.
 */
function reshuffle(d: ChromalyState, events: GameEvent[]): boolean {
  if (d.discard.length <= 1) return false;
  const top = d.discard[d.discard.length - 1]!;
  const rest = d.discard.slice(0, -1);
  d.reshuffles += 1;
  const rng = createRng(hashString(`chromaly|${d.secret}|${d.round}|${d.reshuffles}`));
  d.drawPile = rng.shuffle(rest);
  d.discard = [top];
  const kept = d.named?.[top];
  d.named = kept === undefined ? {} : { [top]: kept };
  events.push({ t: "sweep", pieces: rest, to: "deck" }, { t: "shuffle", seed: d.reshuffles });
  return true;
}

/**
 * Deals `n` cards from the draw pile into a hand, rebuilding the pile if it
 * runs out. Returns what it got, which may be fewer than asked when every
 * card in the game is already in a hand.
 */
function drawCards(d: ChromalyState, seat: SeatId, n: number, events: GameEvent[]): PieceId[] {
  const got: PieceId[] = [];
  for (let i = 0; i < n; i++) {
    if (d.drawPile.length === 0 && !reshuffle(d, events)) break;
    const card = d.drawPile.pop()!;
    d.hands[seat]!.push(card);
    got.push(card);
    events.push({ t: "draw", piece: card, from: "deck", to: seat, faceUp: false });
  }
  return got;
}

/** A seat that could not follow the colour in force, for the bots to read. */
function noteMiss(d: ChromalyState, seat: SeatId): void {
  const list = d.misses[seat] ?? [];
  list.push(d.color);
  d.misses[seat] = list.slice(-MISS_MEMORY);
}

/** Forget a call that no longer means anything. */
function normalizeCalls(d: ChromalyState): void {
  for (let s = 0; s < d.seats; s++) {
    const seat = s as SeatId;
    const call = d.calls[seat];
    if (call === undefined) continue;
    const n = d.hands[seat]!.length;
    if (n === 0 || n > 2 || (n === 2 && call === "passed")) delete d.calls[seat];
  }
}

/* ----------------------------------------------------------------- reduce */

export function reduce(state: ChromalyState, action: ChromalyAction): ReduceResult<ChromalyState> {
  if (state.winner !== null || state.result !== null || !state.dealt) {
    return { state, events: [{ t: "pause" }] };
  }
  const d = draft(state);
  const events: GameEvent[] = [];
  switch (action.t) {
    case "play":
      reducePlay(d, d.turn, action.cards, action, false, events);
      break;
    case "draw":
      reduceDraw(d, events);
      break;
    case "keep":
      reduceKeep(d, events);
      break;
    case "acceptPenalty":
      reduceAccept(d, events);
      break;
    case "challenge":
      reduceChallenge(d, events);
      break;
    case "callLast":
      reduceCall(d, action.seat, events);
      break;
    case "jumpIn":
      reduceJump(d, action.seat, action.card, action.swapWith, events);
      break;
    case "declineWindow":
      reduceDecline(d, action.seat, events);
      break;
    case "chooseSwap":
      reduceChooseSwap(d, action.with, events);
      break;
    case "closeWindow":
      closeWindow(d);
      break;
  }
  normalizeCalls(d);
  takeUnanswerable(d, events);
  normalizeCalls(d);
  // `validate` refuses everything that would change nothing, so an empty
  // batch here is an internal caller getting it wrong. A `pause` rather than
  // nothing, because a driver paced off animation still needs something to
  // settle.
  return { state: d, events: events.length > 0 ? events : [{ t: "pause" }] };
}

/** An announcement of something a person did that the table should read. */
function say(
  seat: SeatId,
  text: string,
  selfText: string,
  tone: "info" | "good" | "bad" = "info",
  selfTone?: "info" | "good" | "bad",
): GameEvent {
  return { t: "announce", actor: seat, text, selfText, tone, selfTone };
}

/**
 * One play, by the seat on turn or by a jump-in.
 *
 * `seat` is the player: for an ordinary play it is `d.turn`, for a jump-in it
 * is whoever jumped, and play carries on from THEM. That is the whole of what
 * a jump-in is - an ordinary play from a different place at the table - and
 * it is why the original card's effects stand rather than being cancelled
 * (a +2 already given is given; see the rulings in `rules.test.ts`).
 */
function reducePlay(
  d: ChromalyState,
  seat: SeatId,
  cards: readonly PieceId[],
  opts: { color?: Color; swapWith?: SeatId; call?: boolean },
  jump: boolean,
  events: GameEvent[],
): void {
  const start = events.length;
  playCards(d, seat, cards, opts, jump, events);
  holdConsequences(events, start);
}

/**
 * Everything a play CAUSED waits until the play itself has landed and been
 * seen: the cards a +2 deals, the colour a wild turns, a skip's stamp, a
 * hand changing seats. The standing rule (the user, about LRC and again
 * about Chromaly, 2026-10-30), and the hold is a `settle` in front of the
 * first consequence - none at all when nothing follows but toasts.
 */
function holdConsequences(events: GameEvent[], start: number): void {
  let lastPlay = -1;
  for (let i = events.length - 1; i >= start; i--) {
    if (events[i]!.t === "play") {
      lastPlay = i;
      break;
    }
  }
  if (lastPlay < 0) return;
  const follows = events
    .slice(lastPlay + 1)
    .some((e) => e.t !== "announce" && e.t !== "score" && e.t !== "roundEnd" && e.t !== "gameEnd");
  if (!follows) return;
  const slam = events.slice(start, lastPlay).find((e) => e.t === "slam");
  const after = slam?.t !== "slam" ? "play" : slam.final ? "slamFinal" : "slam";
  events.splice(lastPlay + 1, 0, { t: "settle", after });
}

function playCards(
  d: ChromalyState,
  seat: SeatId,
  cards: readonly PieceId[],
  opts: { color?: Color; swapWith?: SeatId; call?: boolean },
  jump: boolean,
  events: GameEvent[],
): void {
  const last = cards[cards.length - 1]!;
  const lastCard = parseCard(last)!;
  const parsed = cards.map((id) => parseCard(id)!);

  // Whether a +4 is a bluff is a fact about the hand it came from, so it is
  // settled before the card leaves it and then never looked at again.
  const bluff = lastCard.kind === "wild4" && cards.length === 1 && plusFourIsBluff(d, seat, last);
  const colorBefore = d.color;

  const gone = new Set(cards);
  d.hands[seat] = d.hands[seat]!.filter((id) => !gone.has(id));
  const out = d.hands[seat]!.length === 0;

  // A slam for the cards that hit hard: a draw card, a jump-in, and the card
  // that ends a round (louder). Rides immediately before the play it belongs
  // to, as Caribbean dominoes' does, so the two read as one gesture.
  if (out || jump || isDraw(lastCard)) {
    events.push({ t: "slam", piece: last, shake: [], final: out });
  }
  if (jump) events.push({ t: "cue", kind: "jump", seat });
  for (const id of cards) {
    events.push({ t: "play", piece: id, from: seat, to: "discard", faceUp: true });
    d.discard.push(id);
  }

  d.drawn = null;
  d.plays += 1;
  d.color = isWild(lastCard) ? (opts.color ?? bestColor(d.hands[seat]!)) : lastCard.color!;
  if (isWild(lastCard)) {
    d.named = { ...(d.named ?? {}), [last]: d.color };
    events.push({ t: "cue", kind: "colour", seat, colour: d.color });
  }
  if (opts.call && d.hands[seat]!.length === 1) d.calls[seat] = "called";

  const next = (n = 1) => nextSeat(d, seat, n);

  if (out) {
    // The last card still does its worst: Mattel's rule is that a final +2
    // or +4 is drawn, and counts toward the score.
    if (isDraw(lastCard)) {
      const victim = next();
      const amount = (d.pendingDraw?.amount ?? 0) + (lastCard.kind === "wild4" ? 4 : 2);
      events.push({ t: "cue", kind: "draw", seat: victim, amount });
      drawCards(d, victim, amount, events);
    }
    d.pendingDraw = null;
    d.challenge = null;
    d.window = null;
    endRound(d, seat, false, events);
    return;
  }

  // What the card does to the turn. Several write `d.turn` themselves; the
  // rest fall through to the next seat on.
  d.turn = next();
  if (cards.length >= 2) {
    if (lastCard.kind === "skip") {
      // Several Skips: one player skipped per card (the user, 2026-10-30).
      applySkip(d, seat, events, cards.length);
    } else if (lastCard.kind === "reverse") {
      // Several Reverses: the way round turns once per card, so an even
      // number leaves it where it was.
      applyReverse(d, seat, events, cards.length);
    } else if (cards.length === 2 && !d.rules.plainPairs) {
      // The family rule (the user, 2026-10-24): exactly two of a number is
      // a Skip if their colours match and a Reverse if they differ; three
      // or more is just a way to shed cards, with no effect, so a bigger
      // dump buys nothing but speed. Under `plainPairs` a pair is too.
      if (parsed[0]!.color === parsed[1]!.color) applySkip(d, seat, events);
      else applyReverse(d, seat, events);
    }
  } else {
    applySingle(d, seat, lastCard, opts, { bluff, colorBefore, jump }, events);
    // A jumped-in 7 still choosing whom to swap with: the swap, and the
    // window after it, wait for the choice (`reduceChooseSwap`).
    if (d.swapping) return;
  }

  normalizeCalls(d);
  const jumpable = d.rules.jumpIn && cards.length === 1 && !isWild(lastCard);
  openWindow(d, seat, last, jumpable);
  if (d.window === null && d.plays >= PLAY_LIMIT) endRound(d, null, true, events);
}

/**
 * Skips `n` players. Never more than everybody else: a Skip cannot skip the
 * player who laid it, so once the whole table is skipped they simply go again.
 */
function applySkip(d: ChromalyState, seat: SeatId, events: GameEvent[], n = 1): void {
  const skipped = Math.min(n, d.seats - 1);
  for (let i = 1; i <= skipped; i++) events.push({ t: "cue", kind: "skip", seat: nextSeat(d, seat, i) });
  d.turn = nextSeat(d, seat, skipped + 1);
}

/** Turns play round `n` times: an even number leaves the direction as it was. */
function applyReverse(d: ChromalyState, seat: SeatId, events: GameEvent[], n = 1): void {
  if (n % 2 === 1) d.direction = d.direction === 1 ? -1 : 1;
  events.push({ t: "cue", kind: "reverse", seat, dir: d.direction, amount: n > 1 ? n : undefined });
  // With two players a Reverse is a Skip: the other player has nowhere to be
  // reversed to, so you simply go again (Mattel, 2001).
  if (d.seats === 2) {
    events.push({ t: "cue", kind: "skip", seat: nextSeat(d, seat) });
    d.turn = seat;
  } else {
    d.turn = nextSeat(d, seat);
  }
}

function applySingle(
  d: ChromalyState,
  seat: SeatId,
  card: ParsedCard,
  opts: { color?: Color; swapWith?: SeatId },
  how: { bluff: boolean; colorBefore: Color; jump: boolean },
  events: GameEvent[],
): void {
  switch (card.kind) {
    case "skip":
      applySkip(d, seat, events);
      return;
    case "reverse":
      applyReverse(d, seat, events);
      return;
    case "draw2":
      penalise(d, seat, 2, "draw2", how, events);
      return;
    case "wild4":
      penalise(d, seat, 4, "wild4", how, events);
      return;
    case "shuffle":
      shuffleHands(d, seat, events);
      return;
    case "number":
      if (d.rules.sevenZero && card.value === 7) {
        // Jumped in with, and the seat not named yet: it is chosen next.
        if (how.jump && opts.swapWith === undefined) {
          d.swapping = { seat, card: d.discard[d.discard.length - 1]! };
          return;
        }
        swapHands(d, seat, opts.swapWith ?? nextSeat(d, seat), events);
      } else if (d.rules.sevenZero && card.value === 0) {
        passHands(d, events);
      }
      return;
    case "wild":
      return;
  }
}

/**
 * A +2 or +4 lands. With stacking it becomes a penalty for the next seat to
 * answer or take; without, the next seat takes it at once and is skipped -
 * except a +4 under the official challenge rule, which the victim gets to
 * call first.
 */
function penalise(
  d: ChromalyState,
  seat: SeatId,
  amount: number,
  kind: "draw2" | "wild4",
  wild4: { bluff: boolean; colorBefore: Color },
  events: GameEvent[],
): void {
  const victim = nextSeat(d, seat);
  const total = (d.pendingDraw?.amount ?? 0) + amount;
  const stacking = d.rules.stacking !== "off";
  // Answering a +4 with another voids the challenge on the first: only the
  // last +4 in a chain can be called.
  d.challenge = null;

  if (kind === "wild4" && d.rules.plusFour === "challenge") {
    d.challenge = { offender: seat, onColor: wild4.colorBefore, amount: total, guilty: wild4.bluff };
    d.pendingDraw = stacking ? { amount: total, kind } : null;
    d.turn = victim;
    events.push({ t: "cue", kind: "stack", seat: victim, amount: total });
    return;
  }
  if (stacking) {
    d.pendingDraw = { amount: total, kind };
    d.turn = victim;
    events.push({ t: "cue", kind: "stack", seat: victim, amount: total });
    return;
  }
  d.pendingDraw = null;
  events.push({ t: "cue", kind: "draw", seat: victim, amount: total });
  drawCards(d, victim, total, events);
  d.turn = nextSeat(d, seat, 2);
}

/** Two seats trade hands. */
function swapHands(d: ChromalyState, a: SeatId, b: SeatId, events: GameEvent[]): void {
  if (a === b) return;
  events.push({ t: "cue", kind: "swap", seat: a });
  const handA = d.hands[a]!;
  const handB = d.hands[b]!;
  d.hands[a] = handB;
  d.hands[b] = handA;
  // `deal` rather than `move`: it is corrected per viewer, so the cards a
  // seat receives turn face up for it and the ones it gave go face down,
  // which a `move`'s literal `faceUp` cannot do for more than one viewer.
  handOver(events, [a, b], [
    ...handB.map((id) => ({ id, to: a })),
    ...handA.map((id) => ({ id, to: b })),
  ]);
}

/**
 * Whole hands change seats the way a person would hand one over (the user,
 * 2026-10-30): each hand closes into a stack, the stacks travel, and they
 * fan out where they land.
 */
function handOver(
  events: GameEvent[],
  seats: readonly SeatId[],
  cards: ReadonlyArray<{ id: PieceId; to: SeatId }>,
): void {
  for (const seat of seats) events.push({ t: "gather", seat });
  events.push({ t: "settle", after: "play" });
  for (const { id, to } of cards) events.push({ t: "deal", piece: id, to, faceUp: false, together: true });
  events.push({ t: "settle", after: "deal" });
  for (const seat of seats) events.push({ t: "spread", seat });
}

/** Every hand moves one seat along, the way play is going. */
function passHands(d: ChromalyState, events: GameEvent[]): void {
  events.push({ t: "cue", kind: "pass", dir: d.direction });
  const old: Record<SeatId, PieceId[]> = {};
  for (let s = 0; s < d.seats; s++) old[s as SeatId] = d.hands[s as SeatId]!;
  const seats: SeatId[] = [];
  const cards: Array<{ id: PieceId; to: SeatId }> = [];
  for (let s = 0; s < d.seats; s++) {
    const seat = s as SeatId;
    // The hand at `seat` goes to the next seat on, so a seat receives the one
    // behind it.
    const from = stepSeat(d.seats, seat, d.direction, -1);
    d.hands[seat] = old[from]!;
    seats.push(seat);
    for (const id of old[from]!) cards.push({ id, to: seat });
  }
  handOver(events, seats, cards);
}

/**
 * Wild Shuffle Hands: every card in every hand is gathered, shuffled and
 * dealt out again from the left of whoever played it. Counts may change.
 *
 * Gathered into the draw pile and dealt from it, as a round is, so redaction
 * has one path for it: what a viewer knew about their own hand is swapped
 * for stand-ins at the shuffle, and they are told nothing about where their
 * old cards went.
 */
function shuffleHands(d: ChromalyState, seat: SeatId, events: GameEvent[]): void {
  events.push({ t: "cue", kind: "shuffleHands", seat });
  const all: PieceId[] = [];
  for (let s = 0; s < d.seats; s++) all.push(...d.hands[s as SeatId]!);
  events.push({ t: "sweep", pieces: all, to: "deck" }, { t: "shuffle", seed: d.plays });
  d.reshuffles += 1;
  const rng = createRng(hashString(`chromaly|${d.secret}|${d.round}|${d.reshuffles}|hands`));
  const pile = rng.shuffle(all);
  for (let s = 0; s < d.seats; s++) d.hands[s as SeatId] = [];
  let to = nextSeat(d, seat);
  for (const id of pile) {
    d.hands[to]!.push(id);
    events.push({ t: "deal", piece: id, to, faceUp: false });
    to = nextSeat(d, to);
  }
}

/* ---------------------------------------------------------- draw / keep etc */

/** Is the card playable for this seat now, were it in hand? Used for a draw. */
function playableNow(d: ChromalyState, seat: SeatId, id: PieceId): boolean {
  return canPlay(d, seat, id);
}

function reduceDraw(d: ChromalyState, events: GameEvent[]): void {
  const seat = d.turn;
  // A seat drawing while holding nothing it could play is a read on its hand
  // for everyone who saw it: it has no card of the colour in force.
  if (playableIds(d, seat).length === 0) noteMiss(d, seat);

  events.push({ t: "cue", kind: "draw", seat, amount: 1 });
  let playable: PieceId | null = null;
  const tries = d.rules.drawToMatch ? Number.POSITIVE_INFINITY : 1;
  for (let i = 0; i < tries; i++) {
    // One at a time (the user, 2026-10-30): each card lands, and is seen,
    // before the next leaves the pile.
    if (i > 0) events.push({ t: "pause" });
    const [card] = drawCards(d, seat, 1, events);
    if (card === undefined) break;
    if (playableNow(d, seat, card)) {
      playable = card;
      break;
    }
  }

  if (playable === null) {
    d.drawn = null;
    d.turn = nextSeat(d, seat);
    return;
  }
  // Playable: the seat now chooses between playing it and keeping it - or,
  // under Force Play, has no choice at all.
  d.drawn = playable;
  if (playsItself(d, seat, playable)) {
    events.push({ t: "settle", after: "play" });
    reducePlay(d, seat, [playable], {}, false, events);
  }
}

/**
 * Under Force Play a drawn card that can go must go, so it goes by itself
 * (the user, 2026-10-30: having to press "play the card I drew" when there is
 * nothing else to do is a chore). Not when the play still has a choice in it:
 * a wild's colour, a 7's swap, or the last-card call a seat on two cards
 * would otherwise lose the chance to make.
 */
function playsItself(d: ChromalyState, seat: SeatId, id: PieceId): boolean {
  if (!d.rules.forcePlay) return false;
  const card = parseCard(id)!;
  if (isWild(card)) return false;
  if (d.rules.sevenZero && card.kind === "number" && card.value === 7) return false;
  // "passed" is a call that lapsed on the way up to two (see `normalizeCalls`).
  if (d.hands[seat]!.length === 2 && d.calls[seat] !== "called") return false;
  return true;
}

/**
 * A penalty on the table that the seat on turn can only take: nothing in
 * hand answers it, and no +4 to call a bluff on. Taken for them (the user,
 * 2026-10-30: "if that was my only option, why do I have to confirm?"),
 * once whatever put it there has been seen. Never while a window is open:
 * a jump-in can still add to the stack, and a last card can still be caught.
 */
function takeUnanswerable(d: ChromalyState, events: GameEvent[]): void {
  if (d.result !== null || d.winner !== null || d.window !== null) return;
  if (d.pendingDraw === null || d.challenge !== null) return;
  if (playableIds(d, d.turn).length > 0) return;
  events.push({ t: "settle", after: "play" });
  reduceAccept(d, events);
}

function reduceKeep(d: ChromalyState, events: GameEvent[]): void {
  events.push({ t: "pause" });
  d.drawn = null;
  d.turn = nextSeat(d, d.turn);
}

function reduceAccept(d: ChromalyState, events: GameEvent[]): void {
  const victim = d.turn;
  const amount = d.challenge?.amount ?? d.pendingDraw?.amount ?? 0;
  d.challenge = null;
  d.pendingDraw = null;
  events.push({ t: "cue", kind: "draw", seat: victim, amount });
  drawCards(d, victim, amount, events);
  d.turn = nextSeat(d, victim);
}

/**
 * The victim calls the +4 a bluff. The verdict is about the hand the card
 * came out of, and has two outcomes - Mattel, 2018:
 *
 *  - guilty: the player draws the penalty instead, and the victim plays on
 *  - clean: the victim draws it AND two more, and loses their turn
 *
 * The colour the +4 named stands either way.
 */
function reduceChallenge(d: ChromalyState, events: GameEvent[]): void {
  const challenge = d.challenge!;
  const victim = d.turn;
  const { offender, amount, guilty } = challenge;
  d.challenge = null;
  d.pendingDraw = null;

  events.push(say(victim, "called a bluff", "called a bluff"));
  if (guilty) {
    events.push({ t: "cue", kind: "bluff", seat: offender });
    events.push(say(offender, "was bluffing", "were bluffing", "info", "bad"));
    events.push({ t: "settle", after: "play" });
    events.push({ t: "cue", kind: "draw", seat: offender, amount });
    drawCards(d, offender, amount, events);
    // Turn stays with the victim: the +4 never happened to them.
  } else {
    events.push({ t: "cue", kind: "clean", seat: offender });
    events.push(say(offender, "played it straight", "played it straight", "info", "good"));
    const total = amount + FAILED_CHALLENGE_EXTRA;
    events.push({ t: "settle", after: "play" });
    events.push({ t: "cue", kind: "draw", seat: victim, amount: total });
    drawCards(d, victim, total, events);
    d.turn = nextSeat(d, victim);
  }
}

/* ----------------------------------------------------------------- window */

/**
 * Opens the beat after a play if there is anything to do in it.
 *
 * Offenders come from the position - a seat on exactly one card that has not
 * called it and has not already got away with it - so a swap or a shuffle
 * that leaves someone on a last card opens one too (the 2022 sheet's wording
 * is reaching one card, not playing a second-to-last).
 */
function openWindow(d: ChromalyState, by: SeatId, card: PieceId | null, jumpable: boolean): void {
  d.window = null;
  const offenders = offendersOf(d);
  const jumpers = jumpable && card !== null ? jumpersFor(d, by, card) : [];
  if (offenders.length === 0 && jumpers.length === 0) return;

  d.windowCount += 1;
  const id = d.windowCount;
  // Everybody races to catch (or save); only the twin holders race to jump.
  const involved: SeatId[] =
    offenders.length > 0
      ? Array.from({ length: d.seats }, (_, s) => s as SeatId)
      : jumpers;
  d.window = {
    id,
    by,
    card: jumpers.length > 0 ? card : null,
    jumpers,
    offenders,
    pending: pendingFor(d, id, involved),
  };
}

/** The window is over: whoever was on a last card and got away with it is safe. */
function closeWindow(d: ChromalyState): void {
  const w = d.window;
  if (!w) return;
  for (const seat of w.offenders) d.calls[seat] = "passed";
  d.window = null;
}

function reduceDecline(d: ChromalyState, seat: SeatId, _events: GameEvent[]): void {
  const w = d.window;
  if (!w) return;
  const answered = w.pending.find((p) => p.seat === seat)?.ms ?? 0;
  const pending = w.pending.filter((p) => p.seat !== seat);
  if (pending.length === 0) {
    closeWindow(d);
    return;
  }
  // Deliberately no events: letting a play go looks like nothing because it
  // IS nothing, and both drivers handle an empty batch.
  d.window = { ...w, pending, elapsed: Math.max(w.elapsed ?? 0, answered) };
}

/** Called "last card": to save yourself, to catch whoever is on one, or ahead of time. */
function reduceCall(d: ChromalyState, seat: SeatId, events: GameEvent[]): void {
  const w = d.window;
  if (!w || w.offenders.length === 0) {
    // On two cards, ahead of the play.
    d.calls[seat] = "called";
    events.push({ t: "cue", kind: "called", seat });
    events.push(say(seat, "called last card", "called last card"));
    return;
  }

  let offenders = w.offenders;
  if (offenders.includes(seat)) {
    d.calls[seat] = "called";
    offenders = offenders.filter((s) => s !== seat);
    events.push({ t: "cue", kind: "called", seat });
    events.push(say(seat, "called last card", "called last card"));
  } else {
    const caught = offenders[0]!;
    offenders = offenders.slice(1);
    events.push({ t: "cue", kind: "caught", seat: caught });
    events.push(
      say(caught, "was caught on a last card", "were caught on a last card", "info", "bad"),
      { t: "settle", after: "play" },
      { t: "cue", kind: "draw", seat: caught, amount: CALL_PENALTY },
    );
    drawCards(d, caught, CALL_PENALTY, events);
  }

  // The caller has answered. With nobody left to catch, the seats that were
  // only there as catchers are done; the jumpers, if any, still have their
  // window.
  const pending = w.pending.filter((p) => p.seat !== seat);
  if (offenders.length === 0) {
    const jumpers = w.jumpers.filter((s) => pending.some((p) => p.seat === s));
    if (jumpers.length === 0) {
      d.window = null;
    } else {
      d.window = { ...w, offenders, pending: pending.filter((p) => jumpers.includes(p.seat)) };
    }
    return;
  }
  // Everyone has answered and there is still somebody on a last card (two
  // seats at once - a swap or a pass can leave two): the window is over, and
  // whoever got away with it is safe. Left open with nobody pending, the table
  // would be parked on nobody at all.
  if (pending.length === 0) {
    d.window = { ...w, offenders, pending };
    closeWindow(d);
    return;
  }
  d.window = { ...w, offenders, pending };
}

function reduceJump(
  d: ChromalyState,
  seat: SeatId,
  card: PieceId,
  swapWith: SeatId | undefined,
  events: GameEvent[],
): void {
  d.window = null;
  events.push(say(seat, "jumped in", "jumped in"));
  reducePlay(d, seat, [card], { swapWith }, true, events);
}

/**
 * The seat a jumped-in 7 swaps with, chosen after the 7 went down. Then
 * everything a 7 played in one go would have done next: the swap, and a
 * window if the swap left somebody on a last card.
 */
function reduceChooseSwap(d: ChromalyState, target: SeatId, events: GameEvent[]): void {
  const pending = d.swapping;
  if (!pending) return;
  d.swapping = null;
  swapHands(d, pending.seat, target, events);
  normalizeCalls(d);
  openWindow(d, pending.seat, pending.card, false);
  if (d.window === null && d.plays >= PLAY_LIMIT) endRound(d, null, true, events);
}

/* ------------------------------------------------------------------ rounds */

function endRound(
  d: ChromalyState,
  wentOut: SeatId | null,
  blocked: boolean,
  events: GameEvent[],
): void {
  const cardsLeft: Record<SeatId, number> = {};
  let total = 0;
  for (let s = 0; s < d.seats; s++) {
    const seat = s as SeatId;
    cardsLeft[seat] = d.hands[seat]!.length;
    total += d.hands[seat]!.reduce((n, id) => n + points(id), 0);
  }
  const winner = wentOut ?? fewestCards(cardsLeft, d.seats);

  // The round is worth the cards left in everyone else's hands. A stuck round
  // scores nothing: nobody earned it.
  const earned = blocked ? 0 : total;
  const deltas: Record<SeatId, number> = {};
  for (let s = 0; s < d.seats; s++) deltas[s as SeatId] = s === winner ? earned : 0;
  d.scores[winner] = (d.scores[winner] ?? 0) + earned;

  const result: RoundResult = { deltas, cardsLeft, wentOut, blocked, winner };
  const matchWinner = (d.scores[winner] ?? 0) >= d.rules.target ? winner : null;

  d.result = result;
  d.winner = matchWinner;
  d.window = null;
  d.pendingDraw = null;
  d.challenge = null;
  d.drawn = null;

  events.push(
    {
      t: "announce",
      actor: winner,
      text: blocked ? "had the fewest cards left" : "went out",
      selfText: blocked ? "had the fewest cards left" : "went out",
      tone: "info",
      selfTone: "good",
    },
    { t: "score", deltas },
    { t: "roundEnd", round: d.round },
  );
  if (matchWinner !== null) events.push({ t: "gameEnd", winner: matchWinner });
}

function fewestCards(cardsLeft: Record<SeatId, number>, seats: number): SeatId {
  let best: SeatId = 0;
  for (let s = 1; s < seats; s++) {
    if ((cardsLeft[s as SeatId] ?? 0) < (cardsLeft[best] ?? 0)) best = s as SeatId;
  }
  return best;
}

/* ------------------------------------------------------------------ turns */

export function currentSeat(state: ChromalyState): SeatId | null {
  if (state.winner !== null || state.result !== null || !state.dealt) return null;
  // During a window this names the soonest reactor, which is who the PACING
  // waits on. It is NOT the only seat allowed to act: see `legalActions`.
  if (state.window) return state.window.pending[0]?.seat ?? null;
  // A jumped-in 7 waiting on its swap: the table waits on its player.
  if (state.swapping) return state.swapping.seat;
  return state.turn;
}

/** The other seat holding the fewest cards: the obvious one to swap with. */
function fewestHeld(state: ChromalyState, seat: SeatId): SeatId {
  const targets = swapTargets(state, seat);
  return targets.reduce((a, b) => ((state.hands[b]?.length ?? 0) < (state.hands[a]?.length ?? 0) ? b : a));
}

/** Who a seat may swap hands with: anybody else, the next seat on first. */
function swapTargets(state: ChromalyState, seat: SeatId): SeatId[] {
  const out: SeatId[] = [];
  for (let i = 1; i < state.seats; i++) out.push(nextSeat(state, seat, i));
  return out;
}

export function isRoundOver(state: ChromalyState): boolean {
  return state.result !== null;
}

export function isOver(state: ChromalyState): boolean {
  return state.winner !== null;
}

/** A play the actions list publishes for a card: one representative, not every variant. */
function representative(state: ChromalyState, seat: SeatId, id: PieceId): ChromalyAction {
  const card = parseCard(id)!;
  const hand = state.hands[seat] ?? [];
  const play: ChromalyAction & { t: "play" } = { t: "play", cards: [id] };
  if (isWild(card)) play.color = bestColor(hand, id);
  if (card.kind === "number" && state.rules.sevenZero && card.value === 7 && hand.length > 1) {
    play.swapWith = nextSeat(state, seat);
  }
  return play;
}

export function legalActions(state: ChromalyState, seat: SeatId): ChromalyAction[] {
  if (state.winner !== null || state.result !== null || !state.dealt) return [];
  const hand = state.hands[seat] ?? [];
  const out: ChromalyAction[] = [];

  if (state.swapping) {
    if (seat !== state.swapping.seat) return [];
    return swapTargets(state, seat).map((target) => ({ t: "chooseSwap", seat, with: target }));
  }

  if (state.window) {
    if (!entitledToWindow(state, seat)) return [];
    out.push({ t: "declineWindow", seat });
    if (state.window.offenders.length > 0) out.push({ t: "callLast", seat });
    if (state.window.jumpers.includes(seat) && state.window.card !== null) {
      const card = state.window.card;
      const mine = hand.find((id) => {
        const c = parseCard(id);
        const top = parseCard(card);
        return c !== null && top !== null && identical(c, top);
      });
      if (mine !== undefined) {
        const jump: ChromalyAction & { t: "jumpIn" } = { t: "jumpIn", seat, card: mine };
        const c = parseCard(mine)!;
        if (state.rules.sevenZero && c.kind === "number" && c.value === 7 && hand.length > 1) {
          jump.swapWith = nextSeat(state, seat);
        }
        out.push(jump);
      }
    }
    return out;
  }

  if (seat !== state.turn) return out;

  // On two cards the seat on turn may say so ahead of the play. Only on its
  // own turn: offered to everyone it would make every seat on two cards
  // entitled to act at all times, and "who may act" is the question the
  // session's turn gate asks. A seat that drops to one card on somebody
  // else's play is covered by the window, where it can still save itself.
  if (hand.length === 2 && state.calls[seat] === undefined) out.push({ t: "callLast", seat });

  if (state.challenge) out.push({ t: "challenge" });
  if (facingPenalty(state)) out.push({ t: "acceptPenalty" });

  for (const id of playableIds(state, seat)) out.push(representative(state, seat, id));

  if (state.drawn !== null) {
    // The card just drawn: play it, or keep it unless the rules say it must go.
    const mustPlay = state.rules.forcePlay && canPlay(state, seat, state.drawn);
    if (!mustPlay) out.push({ t: "keep" });
  } else if (!facingPenalty(state)) {
    // Allowed even holding a playable card: Mattel's rule, and a real choice.
    out.push({ t: "draw" });
  }
  return out;
}

/**
 * The second gate. `legalActions` answers WHO may act; this answers whether
 * what arrived is something they may do.
 *
 * Hand-rolled rather than `validateByEnumeration`, for the reason BS's is:
 * `legalActions` publishes one representative per card, but a play is also
 * any legal set of doubles, a colour of the player's choosing and a seat to
 * swap with, so set membership would refuse everything but the
 * representatives. The SHAPE of a legal play is the thing to check.
 *
 * Everything below is reachable from a socket by a player whose turn it
 * genuinely is: cards sitting in somebody else's hand (ids are guessable),
 * the same card named twice, a colour on a card that takes none.
 */
export function validate(state: ChromalyState, seat: SeatId, action: ChromalyAction): string | null {
  // The action is arbitrary JSON off a socket; `{"t":"action"}` arrives here
  // as `undefined`, and a TypeError out of `validate` is the one exception
  // path a seated player could walk at will.
  if (!action || typeof action !== "object") return "that is not an action";
  if (state.winner !== null) return "the match is over";
  if (state.result !== null) return "the round is over";
  if (!state.dealt) return "the round has not been dealt";
  const hand = state.hands[seat] ?? [];

  const validSeat = (v: unknown): v is SeatId =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v < state.seats;
  const wantsSwap = (id: PieceId) => {
    const c = parseCard(id);
    return c !== null && c.kind === "number" && c.value === 7 && state.rules.sevenZero && hand.length > 1;
  };
  const swapProblem = (id: PieceId, swapWith: unknown, later = false): string | null => {
    if (!wantsSwap(id)) return swapWith === undefined ? null : "there is nothing to swap";
    // A jump-in may leave the seat to be chosen after (`swapping`).
    if (later && swapWith === undefined) return null;
    if (!validSeat(swapWith) || swapWith === seat) return "choose another seat to swap hands with";
    return null;
  };

  if (state.swapping) {
    if (action.t !== "chooseSwap") return "waiting for a seat to swap hands with";
    if (seat !== state.swapping.seat) return "not this seat's swap";
    if (!validSeat(action.with) || action.with === seat) return "choose another seat to swap hands with";
    return null;
  }

  switch (action.t) {
    case "play": {
      if (state.window !== null) return "the last play can still be answered";
      if (seat !== state.turn) return "not this seat's turn to play";
      const cards: unknown = action.cards;
      if (!Array.isArray(cards)) return "cards must be an array";
      if (cards.length < 1 || cards.length > hand.length) return "that is not a play";
      if (cards.some((id) => typeof id !== "string")) return "card ids must be strings";
      if (new Set(cards).size !== cards.length) return "the same card twice";
      if (cards.some((id) => !hand.includes(id as PieceId))) return "a card this seat does not hold";
      const ids = cards as PieceId[];
      const top = parseCard(ids[ids.length - 1]!)!;
      if (isWild(top)) {
        if (!COLORS.includes(action.color as Color)) return "name a colour for a wild";
      } else if (action.color !== undefined) {
        return "only a wild names a colour";
      }
      if (ids.length > 1) {
        if (!legalDoubles(state, seat, ids)) return "those cards cannot be played together";
        return action.swapWith === undefined ? null : "there is nothing to swap";
      }
      if (state.drawn !== null && ids[0] !== state.drawn) return "only the card just drawn may be played";
      if (!canPlay(state, seat, ids[0]!)) return "that card cannot be played now";
      return swapProblem(ids[0]!, action.swapWith);
    }

    case "draw":
      if (state.window !== null) return "the last play can still be answered";
      if (seat !== state.turn) return "not this seat's turn";
      if (facingPenalty(state)) return "there is a penalty to answer first";
      if (state.drawn !== null) return "a card has already been drawn";
      return null;

    case "keep":
      if (state.window !== null || seat !== state.turn) return "not this seat's turn";
      if (state.drawn === null) return "there is no drawn card to keep";
      if (state.rules.forcePlay && canPlay(state, seat, state.drawn)) return "a drawn card that can be played must be";
      return null;

    case "acceptPenalty":
      if (state.window !== null || seat !== state.turn) return "not this seat's turn";
      return facingPenalty(state) ? null : "there is no penalty to take";

    case "challenge":
      if (state.window !== null || seat !== state.turn) return "not this seat's turn";
      return state.challenge ? null : "there is nothing to challenge";

    case "callLast": {
      if (state.window) {
        if (!entitledToWindow(state, seat)) return "this seat is not in the window";
        return state.window.offenders.length > 0 ? null : "nobody is on a last card";
      }
      if (seat !== state.turn) return "a last card is called on your own turn";
      if (hand.length !== 2) return "a last card is called on two cards";
      return state.calls[seat] === undefined ? null : "already called";
    }

    case "jumpIn": {
      const w = state.window;
      if (!w || !w.jumpers.includes(seat) || !entitledToWindow(state, seat)) return "there is nothing to jump in on";
      if (typeof action.card !== "string" || !hand.includes(action.card)) return "a card this seat does not hold";
      const mine = parseCard(action.card);
      const top = w.card === null ? null : parseCard(w.card);
      if (!mine || !top || !identical(mine, top)) return "only an identical card may jump in";
      return swapProblem(action.card, action.swapWith, true);
    }

    case "chooseSwap":
      return "there is no swap to choose";

    case "declineWindow":
      return entitledToWindow(state, seat) ? null : "this seat is not in the window";

    case "closeWindow":
      return entitledToWindow(state, seat) ? null : "this seat is not in the window";

    default:
      return "unknown action";
  }
}

/**
 * Stamps the acting seat onto the actions that name one. A window cannot be
 * identified by whose turn it is, because it is several seats' turn at once -
 * so the seat the session knows submitted replaces whatever the client said.
 */
export function completeAction(_state: ChromalyState, action: ChromalyAction, seat: SeatId): ChromalyAction {
  if (action.t === "callLast" || action.t === "jumpIn" || action.t === "declineWindow" || action.t === "chooseSwap") {
    return { ...action, seat };
  }
  return action;
}

/**
 * A seat that does not answer a window. Silence is declining, so it acts FOR
 * the player, never against them - and for everyone at once, because the
 * clock everybody was shown is the same clock. A person at the front of the
 * queue starves the bots behind them for exactly that long, which is the
 * price of not giving each seat its own full window in turn.
 */
export function deadline(
  state: ChromalyState,
  seat: SeatId,
): { ms: number; action: ChromalyAction; key?: string } | null {
  const w = state.window;
  if (!w || !entitledToWindow(state, seat)) return null;
  return {
    // Counted from the window opening, not from when this seat's turn at it
    // came round: the seats ahead have already used some of the clock.
    ms: Math.max(0, state.rules.windowMs + WINDOW_GRACE_MS - (w.elapsed ?? 0)),
    action: { t: "closeWindow" },
    key: `${state.round}:${w.id}`,
  };
}

/**
 * See `GameDefinition.turnHold`. In a window a bot waits out the rest of its
 * reaction time here, BEFORE it answers - the lesson Rummy and BS both paid
 * for (online-games-debug.md).
 */
export function turnHold(state: ChromalyState, seat?: SeatId): number | undefined {
  const w = state.window;
  if (!w) return undefined;
  const mine = w.pending.find((p) => p.seat === seat);
  if (!mine) return WINDOW_BEAT_MS;
  // Never less than the beat, so each seat's pod still lights on its own.
  return Math.max(WINDOW_BEAT_MS, mine.ms - (w.elapsed ?? 0));
}

/**
 * What to play for a person whose turn timer ran out: a plain card if they
 * have one, else the cautious reading of the position. Never a wild - those
 * are the cards that rescue a hand and name a colour for the whole table, so
 * spending one for somebody who is not there is the one thing that could cost
 * them the game. Taking a penalty or drawing is always legal, and two timeouts
 * in a row put a bot in the seat (`markIdle`), who plays for real.
 *
 * It has to play SOME card. A table of people all away must still finish: the
 * suite that leaves every seat silent ends only if each decision has a move
 * that gets rid of a card.
 */
export function timeoutAction(state: ChromalyState, seat: SeatId): ChromalyAction | null {
  // A jump-in already made stands; only whom to swap with is left, and the
  // seat with the fewest cards is the choice anybody would make.
  if (state.swapping) {
    if (seat !== state.swapping.seat) return null;
    return { t: "chooseSwap", seat, with: fewestHeld(state, seat) };
  }
  if (state.window || seat !== state.turn) return null;
  if (facingPenalty(state)) return { t: "acceptPenalty" };

  const plain = playableIds(state, seat)
    .filter((id) => !isWild(parseCard(id)!))
    // The heaviest first: it is the one most worth being rid of.
    .sort((a, b) => points(b) - points(a));
  if (plain.length > 0) return representative(state, seat, plain[0]!);

  if (state.drawn !== null) {
    // A wild just drawn, and the rules say it must go: that is the one case
    // where a wild is played for somebody who is not there.
    if (state.rules.forcePlay && canPlay(state, seat, state.drawn)) {
      return representative(state, seat, state.drawn);
    }
    return { t: "keep" };
  }
  return { t: "draw" };
}

/**
 * A move that is no choice (see `GameDefinition.forcedMove`): drawing, when
 * nothing in the hand can be played. Making it says the same thing whether the
 * seat or the clock does - the table is told they drew - which is what lets it
 * be made for somebody who has not moved.
 */
export function forcedMove(state: ChromalyState, seat: SeatId): ChromalyAction | null {
  if (state.window !== null || state.drawn !== null || facingPenalty(state)) return null;
  if (seat !== state.turn) return null;
  const legal = legalActions(state, seat);
  return legal.length === 1 && legal[0]!.t === "draw" ? legal[0]! : null;
}

/* ------------------------------------------------------------------ table */

export function pieces(state: ChromalyState): Record<PieceId, PieceMeta> {
  const out: Record<PieceId, PieceMeta> = {};
  for (const id of deckIds(state.rules.shuffleHands)) out[id] = { kind: "chroma", face: id };
  return out;
}

export function placements(state: ChromalyState, viewer: SeatId): PlacementMap {
  const out: PlacementMap = {};

  // Everything undealt or drawn from sits on one pile; the two are never
  // both in use at once, so they share the draw pile's own index run.
  state.drawPile.forEach((id, index) => {
    out[id] = { zone: "deck", index, count: state.drawPile.length, faceUp: false };
  });

  const jumping = state.window?.jumpers.includes(viewer) ?? false;
  // Hints (a setting, off by default) dim what the viewer cannot play. Only
  // on their own turn, and never inside a window, where what matters is not
  // the turn's rules at all.
  const deciding =
    viewer === state.turn && state.window === null && state.result === null && state.dealt;
  const playable = new Set(deciding ? playableIds(state, viewer) : []);
  for (let s = 0; s < state.seats; s++) {
    const seat = s as SeatId;
    const hand = state.hands[seat] ?? [];
    const own = seat === viewer;
    const ordered = own ? handDisplayOrder(hand) : hand;
    ordered.forEach((id, index) => {
      const place: Placement = { zone: "hand", seat, index, count: ordered.length, faceUp: own, fanned: own };
      // A tap only picks a card for a set of doubles, or answers a window -
      // nothing is committed yet - so the touch preview-then-confirm gate
      // would cost a jump-in its three seconds.
      if (own && (state.rules.doubles || jumping)) place.instantAct = true;
      if (own && deciding && !playable.has(id)) place.dimmed = true;
      out[id] = place;
    });
  }

  // Only the newest few discards are drawn; the rest fade out where they lie
  // rather than leaving the map, which keeps "cards never reparent".
  const shown = state.discard.length - VISIBLE_DISCARDS;
  state.discard.forEach((id, index) => {
    out[id] = {
      zone: "discard",
      index,
      count: state.discard.length,
      faceUp: true,
      hidden: index < shown ? true : undefined,
      tint: state.named?.[id],
    };
  });

  return out;
}

/**
 * What one seat is allowed to KNOW, as distinct from what `placements` lets
 * them see.
 *
 * Other hands are the obvious half. The draw pile is the half easy to miss
 * and worth far more: it is every card still to come, in order, so shipping
 * it intact would hand a client the answer to every draw (the leak Poker
 * had with `deck` and Rummy with `stock`). `secret` goes too - it seeds the
 * shuffles made inside `reduce`, and with it the pile could be rebuilt.
 *
 * And the parts of the window and a challenge that are a read on a hand:
 * who holds the twin of the card on the pile, and whether a +4 was a bluff.
 * A viewer keeps their own entry in `pending` and `jumpers`, which is all
 * their own screen needs; `currentSeat` reaches the table from the server.
 */
export function playerView(state: ChromalyState, viewer: SeatId): ChromalyState {
  const hands: Record<SeatId, PieceId[]> = {};
  for (let s = 0; s < state.seats; s++) {
    const seat = s as SeatId;
    const hand = state.hands[seat] ?? [];
    hands[seat] = seat === viewer ? [...hand] : hand.map(() => HIDDEN_CARD);
  }
  const w = state.window;
  const window = w
    ? {
        ...w,
        jumpers: w.jumpers.filter((s) => s === viewer),
        // With offenders everyone is in the race, which gives nothing away;
        // otherwise `pending` IS the list of twin holders.
        pending: w.offenders.length > 0 ? w.pending : w.pending.filter((p) => p.seat === viewer),
      }
    : null;
  return {
    ...state,
    secret: 0,
    hands,
    drawPile: state.drawPile.map(() => HIDDEN_CARD),
    drawn: state.drawn === null ? null : state.turn === viewer ? state.drawn : HIDDEN_CARD,
    challenge: state.challenge ? { ...state.challenge, guilty: false } : null,
    window,
  };
}

/* ----------------------------------------------------------------- exports */

export function createChromaly(
  rules: Partial<ChromalyRules> = {},
): GameDefinition<ChromalyState, ChromalyAction> {
  const resolved = clampRules(rules);
  return {
    id: "chromaly",
    name: "Chromaly",
    minSeats: MIN_SEATS,
    maxSeats: MAX_SEATS,
    setup: makeSetup(resolved),
    reduce,
    legalActions,
    validate,
    completeAction,
    // Everything but an ordinary play depends on cards nobody has shown (a
    // draw), on a race somebody else may win (a call, a jump), or on a
    // verdict about a hand (a challenge). A play is predicted unless a
    // jump-in could open a window on it, which depends on hands the mover
    // cannot see.
    unpredictable: (state, _seat, action) =>
      action.t !== "play" ||
      state.rules.jumpIn ||
      // Whether the victim can answer a draw card decides if it is taken for
      // them at once, and that is their hand.
      (state.rules.stacking !== "off" && endsOnDrawCard(action.cards)),
    deadline,
    turnHold,
    timeoutAction,
    forcedMove,
    pieces,
    placements,
    playerView,
    currentSeat,
    isOver,
    startRound,
    isRoundOver,
    bots: chromalyBots,
  };
}

function endsOnDrawCard(cards: readonly PieceId[]): boolean {
  const top = cards.length > 0 ? parseCard(cards[cards.length - 1]!) : null;
  return top !== null && isDraw(top);
}

export const chromaly = createChromaly();

export { cardLabel };
