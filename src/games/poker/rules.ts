/**
 * Poker (No-Limit Texas Hold'em) — GameDefinition.
 *
 * A match is a sit-and-go: chip stacks persist hand to hand, a seat that
 * busts to 0 chips is out for the rest of the match (`liveMatchSeats`),
 * and the match ends the moment only one seat still has chips — the same
 * shape LRC's elimination-by-derivation match end uses, not a
 * score-target match like Dominoes/Spades. Fixed blinds all match; no
 * escalation, no antes, no rebuys.
 *
 * One sub-decision sits OUTSIDE the ordinary toAct-driven betting loop,
 * modeled directly on Rummy's `claimWindow` (see
 * `src/games/rummy/types.ts`): `pendingShowdown` seizes `currentSeat`
 * regardless of whose turn it would otherwise be. It differs from
 * Rummy's window in one real way — EVERY seat there (bot or hero) takes
 * a genuine turn through the normal `currentSeat`/`legalActions`/bot-
 * `choose()` pipeline, rather than bots resolving inline inside
 * `reduce`. That is deliberate: `reduce` has no visibility into bot
 * difficulty (that lives in `GameRuntimeOptions`, outside engine state),
 * so a tier-differentiated "does this bot show a beaten hand for table
 * image" decision can only be made from inside a `BotStrategy.choose()`
 * call, which does know its own tier and gets a real `rng`. Routing it
 * as an ordinary turn costs nothing — `useGameRuntime`'s existing
 * `revealBotTurn`/`onIdle` machinery paces it exactly like a fold.
 *
 * Chip visuals are deliberately simple, per this build's own product
 * decision: stacks/bets/pot are HUD text (the authoritative numbers,
 * moved via the ordinary `{t:"score"}` event every game uses), and a
 * SINGLE plain pile of decorative chip pieces sits in `zone: "pot"` (its
 * own mini-scale zone, not LRC's table-scaled `"center"` — see
 * engine/types.ts's `ZoneId` doc), sized straight off the pot total in
 * `placements()` — no per-seat piles, no proportional bet-to-chip-count
 * choreography, no dedicated chip GameEvents at all. A piece's position
 * is driven by React/Motion off whatever `placements()` returns after
 * every batch regardless of whether an explicit event named it, so the
 * pile still visibly grows and shrinks with the pot; it just isn't
 * individually choreographed the way a card's flight is.
 */

import type {
  BotDifficulty,
  GameDefinition,
  GameEvent,
  PieceId,
  PieceMeta,
  PlacementMap,
  ReduceResult,
  SeatId,
  SetupOptions,
} from "@/engine/types";
import { HERO } from "@/engine/types";
import type { Rng } from "@/engine/rng";
import { botName } from "@/games/_shared/botIdentity";
import { parseCard, shuffledDeck, standardDeck } from "@/games/_shared/cards";
import { bestOfSeven } from "./hand";
import {
  MAX_SEATS,
  MIN_SEATS,
  actableSeats,
  amountToCall,
  awardPots,
  betRange,
  bigBlindOf,
  computePots,
  contestingSeats,
  dealtSeats,
  deriveStreet,
  liveMatchSeats,
  nextButton,
  postflopOrder,
  potTotal,
  preflopOrder,
  seatHoleCards,
  seatOrderAfter,
  smallBlindOf,
} from "./state";
import { pokerBots } from "./bots";
import type { PokerAction, PokerState, PokerStreet } from "./types";

export { MIN_SEATS, MAX_SEATS };

/** No printed convention to anchor these on — LRC's own "first to 5
 * rounds" default has the identical status. 100 big blinds is the
 * standard "deep stack" cash-game convention; both are adjustable on the
 * setup screen. */
export const DEFAULT_BIG_BLIND = 20;
export const DEFAULT_STARTING_STACK = DEFAULT_BIG_BLIND * 100;
export const MIN_BIG_BLIND = 2;
export const MAX_BIG_BLIND = 200;
export const MIN_STARTING_STACK = 200;
export const MAX_STARTING_STACK = 20000;

/** Placeholder id for a redacted opponent hole card — same "??" prefix
 * convention as Rummy/Spades' own `HIDDEN_CARD`, suffixed to stay unique
 * per hidden card since this is a Record key, not an array slot. */
const HIDDEN_CARD_PREFIX = "??";

// Purely decorative — the real pot total is always the HUD text, never
// this pile's count (see this file's own header doc). Kept deliberately
// small and SQRT-scaled rather than linear in `pot / bigBlind`: a live
// playtest showed the pile maxing out (6 rows, in a 5-column grid) at a
// completely ordinary pot size and visually swallowing the community
// row above it. sqrt growth still visibly grows the pile for a small
// pot but only reaches the (now much smaller) cap on a genuinely huge
// multi-way pot, so it reads as "a real pile" without ever dominating
// the felt.
const POT_CHIP_POOL = 12;
function potChipId(i: number): PieceId {
  return `pchip-${i}`;
}

const STREET_AFTER: Record<Exclude<PokerStreet, "river">, PokerStreet> = {
  preflop: "flop",
  flop: "turn",
  turn: "river",
};

function seatLabel(seat: SeatId): string {
  return seat === HERO ? "You" : botName(seat);
}

/* ============================================================
   Setup and the deal
   ============================================================ */

export function makeSetup(startingStack: number, bigBlind: number) {
  return function setup(opts: SetupOptions): PokerState {
    const seats = Math.min(MAX_SEATS, Math.max(MIN_SEATS, opts.seats));
    const stacks: Record<SeatId, number> = {};
    for (let s = 0; s < seats; s++) stacks[s] = startingStack;
    return {
      seats,
      smallBlind: Math.max(1, Math.round(bigBlind / 2)),
      bigBlind,
      hand: 0,
      button: 0,
      stacks,
      winner: null,
      cardOwner: {},
      deck: [],
      communityOrder: [],
      folded: {},
      streetCommitted: {},
      totalCommitted: {},
      lastRaiseSize: bigBlind,
      raiseCapped: false,
      toAct: [],
      pendingShowdown: null,
      result: null,
    };
  };
}

/** Deals (or redeals) a hand: posts blinds, shuffles, deals hole cards,
 * and rotates the button. Returns straight through `afterStreetCloses`
 * so a preflop hand where a blind post already leaves ≤1 seat able to
 * act (an all-in blind, heads-up) runs straight out to showdown instead
 * of stalling on a turn nobody can take. */
export function startRound(state: PokerState, rng: Rng): ReduceResult<PokerState> {
  const events: GameEvent[] = [];

  const dealt = liveMatchSeats(state);
  if (dealt.length < 2) return { state, events }; // Defensive — `isOver` already gates this.

  // Sweep whatever the last hand left on the felt. A no-op on hand 1:
  // every card is already "deck".
  const toSweep = Object.keys(state.cardOwner).filter((id) => state.cardOwner[id] !== "deck");
  if (toSweep.length > 0) events.push({ t: "sweep", pieces: toSweep, to: "stub" });

  // Hand 1's button is a real random cut, not a hardcoded seat — the
  // same fix Spades/Rummy's own round-1 dealer got. Every hand after
  // that rotates from wherever it last sat, skipping busted seats.
  const button = state.hand === 0 ? rng.pick(dealt) : nextButton(state, state.button);

  const folded: Record<SeatId, boolean> = {};
  for (const s of dealt) folded[s] = false;

  const sb = smallBlindOf(button, dealt, state.seats);
  const bb = bigBlindOf(button, dealt, state.seats);

  const shuffled = shuffledDeck(rng);
  const cardOwner: PokerState["cardOwner"] = {};
  for (const card of shuffled) cardOwner[card.id] = "deck";

  let cursor = 0;
  const dealOrder = seatOrderAfter(button, state.seats).filter((s) => dealt.includes(s));
  for (let round = 0; round < 2; round++) {
    for (const seat of dealOrder) {
      const card = shuffled[cursor++]!;
      cardOwner[card.id] = seat;
      events.push({ t: "deal", piece: card.id, to: seat, faceUp: seat === HERO });
    }
  }
  const deck = shuffled.slice(cursor).map((c) => c.id);

  const stacks = { ...state.stacks };
  const streetCommitted: Record<SeatId, number> = {};
  const totalCommitted: Record<SeatId, number> = {};
  for (const s of dealt) {
    streetCommitted[s] = 0;
    totalCommitted[s] = 0;
  }
  const postBlind = (seat: SeatId, amount: number) => {
    const posted = Math.min(amount, stacks[seat] ?? 0);
    stacks[seat] = (stacks[seat] ?? 0) - posted;
    streetCommitted[seat] = posted;
    totalCommitted[seat] = posted;
  };
  postBlind(sb, state.smallBlind);
  postBlind(bb, state.bigBlind);

  let next: PokerState = {
    ...state,
    hand: state.hand + 1,
    button,
    stacks,
    cardOwner,
    deck,
    communityOrder: [],
    folded,
    streetCommitted,
    totalCommitted,
    lastRaiseSize: state.bigBlind,
    raiseCapped: false,
    toAct: [],
    pendingShowdown: null,
    result: null,
  };
  next = { ...next, toAct: preflopOrder(next) };

  events.push({ t: "phase", phase: "preflop" });
  events.push({
    t: "announce",
    text: `${seatLabel(sb)} posts ${state.smallBlind} · ${seatLabel(bb)} posts ${state.bigBlind}`,
    tone: "info",
  });

  return afterStreetCloses(next, events);
}

/* ============================================================
   The betting state machine
   ============================================================ */

export function reduce(state: PokerState, action: PokerAction): ReduceResult<PokerState> {
  switch (action.t) {
    case "fold":
      return reduceFold(state);
    case "check":
      return reduceCheckOrCall(state, false);
    case "call":
      return reduceCheckOrCall(state, true);
    case "bet":
    case "raise":
      return reduceBetOrRaise(state, action.to);
    case "show":
      return reduceShowOrMuck(state, true);
    case "muck":
      return reduceShowOrMuck(state, false);
  }
}

function reduceFold(state: PokerState): ReduceResult<PokerState> {
  const seat = state.toAct[0];
  if (seat === undefined) return { state, events: [] };
  const events: GameEvent[] = [{ t: "announce", text: `${seatLabel(seat)} folds`, tone: "info" }];
  const folded = { ...state.folded, [seat]: true };
  const next: PokerState = { ...state, folded, toAct: state.toAct.slice(1) };
  return afterStreetCloses(next, events);
}

function reduceCheckOrCall(state: PokerState, isCall: boolean): ReduceResult<PokerState> {
  const seat = state.toAct[0];
  if (seat === undefined) return { state, events: [] };

  const stacks = { ...state.stacks };
  const streetCommitted = { ...state.streetCommitted };
  const totalCommitted = { ...state.totalCommitted };
  let text = `${seatLabel(seat)} checks`;

  if (isCall) {
    const toCall = Math.min(amountToCall(state, seat), stacks[seat] ?? 0);
    if (toCall > 0) {
      stacks[seat] = (stacks[seat] ?? 0) - toCall;
      streetCommitted[seat] = (streetCommitted[seat] ?? 0) + toCall;
      totalCommitted[seat] = (totalCommitted[seat] ?? 0) + toCall;
      text = `${seatLabel(seat)} calls${stacks[seat] === 0 ? " — all in" : ""}`;
    }
  }

  const events: GameEvent[] = [{ t: "announce", text, tone: "info" }];
  const next: PokerState = {
    ...state,
    stacks,
    streetCommitted,
    totalCommitted,
    toAct: state.toAct.slice(1),
  };
  return afterStreetCloses(next, events);
}

function reduceBetOrRaise(state: PokerState, to: number): ReduceResult<PokerState> {
  const seat = state.toAct[0];
  if (seat === undefined || state.raiseCapped) return { state, events: [] };

  const range = betRange(state, seat);
  const clamped = Math.max(range.min, Math.min(range.max, Math.round(to)));
  const already = state.streetCommitted[seat] ?? 0;
  const added = clamped - already;
  if (added <= 0) return { state, events: [] };

  const stacks = { ...state.stacks, [seat]: (state.stacks[seat] ?? 0) - added };
  const streetCommitted = { ...state.streetCommitted, [seat]: clamped };
  const totalCommitted = {
    ...state.totalCommitted,
    [seat]: (state.totalCommitted[seat] ?? 0) + added,
  };

  const highestBefore = Math.max(0, ...Object.values(state.streetCommitted));
  const increment = clamped - highestBefore;
  const isFullRaise = highestBefore === 0 || increment >= state.lastRaiseSize;
  const isAllInShove = clamped === range.max;

  let toAct: SeatId[];
  let lastRaiseSize = state.lastRaiseSize;
  // Explicit `boolean` annotation: the early-return guard above narrows
  // `state.raiseCapped` to the literal `false` from this point on, which
  // would otherwise infer this variable's type as `false` too and reject
  // the `raiseCapped = true` assignment below.
  let raiseCapped: boolean = state.raiseCapped;

  if (isFullRaise) {
    lastRaiseSize = increment;
    const eligible = new Set(actableSeats(state).filter((s) => s !== seat));
    toAct = seatOrderAfter(seat, state.seats).filter((s) => eligible.has(s));
  } else {
    // An incomplete all-in raise — only reachable when `clamped ===
    // range.max` for a seat too short to make a full raise, since
    // `betRange`'s own `min` is always a full raise otherwise. See
    // `PokerState.raiseCapped`'s doc for why this closes betting for
    // the rest of the street entirely, rather than tracking per-seat
    // reopen eligibility.
    raiseCapped = true;
    const eligible = new Set(
      actableSeats(state).filter((s) => s !== seat && (streetCommitted[s] ?? 0) < clamped),
    );
    toAct = seatOrderAfter(seat, state.seats).filter((s) => eligible.has(s));
  }

  const events: GameEvent[] = [
    {
      t: "announce",
      text: `${seatLabel(seat)} ${highestBefore === 0 ? "bets" : "raises to"} ${clamped}${
        isAllInShove ? " — all in" : ""
      }`,
      tone: "info",
    },
  ];

  const next: PokerState = {
    ...state,
    stacks,
    streetCommitted,
    totalCommitted,
    lastRaiseSize,
    raiseCapped,
    toAct,
  };
  return afterStreetCloses(next, events);
}

function reduceShowOrMuck(state: PokerState, show: boolean): ReduceResult<PokerState> {
  const pending = state.pendingShowdown;
  const seat = pending?.order[0];
  if (!pending || seat === undefined) return { state, events: [] };

  const events: GameEvent[] = [];
  let folded = state.folded;
  if (show) {
    for (const card of seatHoleCards(state, seat)) {
      events.push({ t: "flip", piece: card, faceUp: true });
    }
    events.push({ t: "announce", text: `${seatLabel(seat)} shows`, tone: "info" });
  } else {
    // Piggybacks the same `folded`-driven hide `placements()` already
    // gives a real fold — payout is already fixed in
    // `pending.pendingDeltas`, so this has no effect beyond the visual.
    folded = { ...state.folded, [seat]: true };
  }

  const order = pending.order.slice(1);
  let next: PokerState = { ...state, folded, pendingShowdown: { ...pending, order } };
  if (order.length === 0) {
    next = finalizeHand(next, pending.winningSeats, pending.pendingDeltas, events, true);
  }
  return { state: next, events };
}

/**
 * The single place every betting/street-advance path funnels through
 * once `toAct` might have just emptied. A no-op if there is still a real
 * decision pending. Otherwise: ends the hand by fold if only one
 * contesting seat is left; ends it at showdown if the street that just
 * closed was the river; otherwise burns and deals the next street and
 * loops — which is what makes an all-in runout "just work": if the
 * freshly rebuilt `toAct` is ALSO empty (everyone left is all-in), the
 * loop keeps advancing straight through to the river without ever
 * waiting for input. No "run it twice" — always resolves once.
 */
function afterStreetCloses(state: PokerState, events: GameEvent[]): ReduceResult<PokerState> {
  let s = state;
  for (;;) {
    if (s.toAct.length > 0) return { state: s, events };
    const contesting = contestingSeats(s);
    if (contesting.length <= 1) return settleHand(s, events, false);
    if (deriveStreet(s) === "river") return settleHand(s, events, true);
    s = advanceStreet(s, events);
  }
}

/** Burns one card face-down, then deals the next street's community
 * card(s) — arriving face-down and flipping face-up as two chained
 * events, so the reveal reads as a real turn-over. `PieceLayer`'s
 * `Flipper` already does a genuine 3D flip keyed off `flip`; this is
 * just making sure poker actually emits it instead of dealing face-up
 * outright. */
function advanceStreet(state: PokerState, events: GameEvent[]): PokerState {
  const street = deriveStreet(state);
  const nextStreet = STREET_AFTER[street as Exclude<PokerStreet, "river">];
  const dealCount = nextStreet === "flop" ? 3 : 1;

  let deck = state.deck;
  const cardOwner = { ...state.cardOwner };

  const burn = deck[0]!;
  deck = deck.slice(1);
  cardOwner[burn] = "burnt";
  const burntCount = Object.values(cardOwner).filter((o) => o === "burnt").length;
  events.push({
    t: "move",
    piece: burn,
    to: { zone: "burnt", index: burntCount - 1, count: burntCount, faceUp: false },
  });

  const communityOrder = [...state.communityOrder];
  for (let i = 0; i < dealCount; i++) {
    const card = deck[0]!;
    deck = deck.slice(1);
    cardOwner[card] = "community";
    communityOrder.push(card);
    events.push({
      t: "move",
      piece: card,
      to: { zone: "community", index: communityOrder.length - 1, count: 5, faceUp: false },
    });
    events.push({ t: "flip", piece: card, faceUp: true });
  }

  const streetCommitted: Record<SeatId, number> = {};
  for (const s of dealtSeats(state)) streetCommitted[s] = 0;

  let next: PokerState = {
    ...state,
    deck,
    cardOwner,
    communityOrder,
    streetCommitted,
    lastRaiseSize: state.bigBlind,
    raiseCapped: false,
    toAct: [],
  };
  next = { ...next, toAct: postflopOrder(next) };

  events.push({ t: "phase", phase: nextStreet });
  return next;
}

/**
 * Resolves the pot(s) and either finalizes the hand immediately
 * (everyone-but-one folded — mucked by construction, nothing to
 * reveal, matching real convention that a walkover win never has to
 * show) or opens the show-or-muck sequence for a genuine showdown.
 */
function settleHand(
  state: PokerState,
  events: GameEvent[],
  isShowdown: boolean,
): ReduceResult<PokerState> {
  const layers = computePots(state.totalCommitted, state.folded);
  const bestHand = (seat: SeatId) =>
    bestOfSeven([...seatHoleCards(state, seat), ...state.communityOrder].map(parseCard));
  const { deltas, winningSeats } = awardPots(layers, bestHand, state.button, state.seats);

  if (!isShowdown) {
    return { state: finalizeHand(state, winningSeats, deltas, events, false), events };
  }

  // Winners are auto-revealed — you don't get to hide that you won.
  for (const seat of winningSeats) {
    for (const card of seatHoleCards(state, seat)) events.push({ t: "flip", piece: card, faceUp: true });
  }

  const order = seatOrderAfter(state.button, state.seats).filter(
    (s) => contestingSeats(state).includes(s) && !winningSeats.includes(s),
  );
  if (order.length === 0) {
    return { state: finalizeHand(state, winningSeats, deltas, events, true), events };
  }

  const next: PokerState = { ...state, pendingShowdown: { winningSeats, order, pendingDeltas: deltas } };
  return { state: next, events };
}

function finalizeHand(
  state: PokerState,
  winningSeats: SeatId[],
  deltas: Record<SeatId, number>,
  events: GameEvent[],
  showdown: boolean,
): PokerState {
  const stacks = { ...state.stacks };
  for (const [seat, delta] of Object.entries(deltas)) {
    stacks[Number(seat)] = (stacks[Number(seat)] ?? 0) + delta;
  }

  events.push({ t: "score", deltas });
  events.push({
    t: "announce",
    text:
      winningSeats.length === 1
        ? `${seatLabel(winningSeats[0]!)} takes the pot`
        : `${winningSeats.map(seatLabel).join(" & ")} split the pot`,
    tone: winningSeats.includes(HERO) ? "good" : "info",
  });
  events.push({ t: "roundEnd", round: state.hand });

  const stillIn = liveMatchSeats({ seats: state.seats, stacks });
  const winner = stillIn.length <= 1 ? (stillIn[0] ?? null) : null;
  if (winner !== null) events.push({ t: "gameEnd", winner });

  return {
    ...state,
    stacks,
    pendingShowdown: null,
    result: { showdown, winningSeats, deltas },
    winner,
  };
}

/* ============================================================
   Definition surface
   ============================================================ */

export function legalActions(state: PokerState, seat: SeatId): PokerAction[] {
  if (currentSeat(state) !== seat) return [];

  if (state.pendingShowdown) return [{ t: "show" }, { t: "muck" }];

  const toCall = amountToCall(state, seat);
  const out: PokerAction[] = [];
  // No free-choice fold: folding when a check is free is never a real
  // tradeoff in this app — the same reasoning that dropped Rummy's claim
  // bar's "Pass" button (see [[no-free-choice-buttons]]).
  if (toCall === 0) {
    out.push({ t: "check" });
  } else {
    out.push({ t: "fold" });
    out.push({ t: "call" });
  }

  if (!state.raiseCapped) {
    const range = betRange(state, seat);
    if (range.max > (state.streetCommitted[seat] ?? 0)) {
      const highest = Math.max(0, ...Object.values(state.streetCommitted));
      out.push(highest === 0 ? { t: "bet", to: range.min } : { t: "raise", to: range.min });
    }
  }

  return out;
}

export function currentSeat(state: PokerState): SeatId | null {
  if (state.winner !== null) return null;
  if (state.pendingShowdown && state.pendingShowdown.order.length > 0) {
    return state.pendingShowdown.order[0]!;
  }
  if (state.result !== null) return null; // Hand settled; waiting on nextRound.
  return state.toAct[0] ?? null;
}

export function isOver(state: PokerState): boolean {
  return state.winner !== null;
}

export function isRoundOver(state: PokerState): boolean {
  return state.result !== null;
}

// No `state` param: the piece SET is entirely fixed (a standard deck
// plus the decorative chip pool) regardless of seat count or match
// state — same "fewer params than the declared type" idiom LRC's own
// no-viewer `placements` uses, which TS's structural typing allows.
export function pieces(): Record<PieceId, PieceMeta> {
  const out: Record<PieceId, PieceMeta> = {};
  for (const card of standardDeck()) out[card.id] = { kind: "card", face: card.id };
  for (let i = 0; i < POT_CHIP_POOL; i++) out[potChipId(i)] = { kind: "chip", face: "gold" };
  return out;
}

/** Whether a seat's hole cards are currently known to the table — auto-
 * true for an auto-shown winner or a seat that chose to show, false for
 * any folded (or mucked — see `reduceShowOrMuck`) seat, and false for
 * anyone still deciding. A hand that ended by everyone-but-one folding
 * never sets this for anyone, including the winner — matching real
 * convention that a walkover win is never forced to prove itself. */
function isHoleCardsRevealed(state: PokerState, seat: SeatId): boolean {
  if (state.folded[seat]) return false;
  if (state.pendingShowdown) {
    return (
      state.pendingShowdown.winningSeats.includes(seat) ||
      !state.pendingShowdown.order.includes(seat)
    );
  }
  return state.result?.showdown === true;
}

export function placements(state: PokerState, viewer: SeatId): PlacementMap {
  const out: PlacementMap = {};

  state.deck.forEach((id, i) => {
    out[id] = { zone: "stub", index: i, count: state.deck.length, faceUp: false };
  });

  const burnt = Object.entries(state.cardOwner)
    .filter(([, o]) => o === "burnt")
    .map(([id]) => id);
  burnt.forEach((id, i) => {
    out[id] = { zone: "burnt", index: i, count: burnt.length, faceUp: false };
  });

  state.communityOrder.forEach((id, i) => {
    out[id] = { zone: "community", index: i, count: 5, faceUp: true };
  });

  for (const seat of dealtSeats(state)) {
    const hole = seatHoleCards(state, seat);
    const faceUp = seat === viewer || isHoleCardsRevealed(state, seat);
    hole.forEach((id, i) => {
      out[id] = { zone: "hand", seat, index: i, count: hole.length, faceUp };
    });
  }

  const pot = potTotal(state);
  const potChips = Math.max(
    0,
    Math.min(POT_CHIP_POOL, Math.round(Math.sqrt(Math.max(0, pot) / state.bigBlind))),
  );
  for (let i = 0; i < POT_CHIP_POOL; i++) {
    const id = potChipId(i);
    out[id] =
      i < potChips
        ? { zone: "pot", index: i, count: potChips, faceUp: true, fanned: true }
        : { zone: "boneyard", index: i - potChips, count: POT_CHIP_POOL - potChips, faceUp: true };
  }

  return out;
}

/** Redacts every OTHER seat's still-hidden hole cards, the same
 * contractual guarantee Rummy/Spades enforce for their own concealed
 * hands ("bots for seat N only ever see view(N)") — poker is this app's
 * first game where that guarantee is load-bearing on every single turn,
 * not just an occasional blind-bid exchange. */
export function playerView(state: PokerState, viewer: SeatId): PokerState {
  const cardOwner: PokerState["cardOwner"] = {};
  let hidden = 0;
  for (const [id, owner] of Object.entries(state.cardOwner)) {
    const isOpponentHole = typeof owner === "number" && owner !== viewer;
    const revealed = typeof owner === "number" && isHoleCardsRevealed(state, owner);
    cardOwner[isOpponentHole && !revealed ? `${HIDDEN_CARD_PREFIX}${hidden++}` : id] = owner;
  }
  return { ...state, cardOwner };
}

export function createPoker(
  startingStack: number = DEFAULT_STARTING_STACK,
  bigBlind: number = DEFAULT_BIG_BLIND,
): GameDefinition<PokerState, PokerAction> {
  return {
    id: "poker",
    name: "Poker",
    minSeats: MIN_SEATS,
    maxSeats: MAX_SEATS,
    setup: makeSetup(startingStack, bigBlind),
    reduce,
    legalActions,
    pieces,
    placements,
    playerView,
    currentSeat,
    isOver,
    startRound,
    isRoundOver,
    bots: pokerBots,
  };
}

export const poker = createPoker();

// Re-exported so bots.ts can be authored without importing rules.ts back
// (which would cycle) while still sharing the difficulty type name.
export type { BotDifficulty };
