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
 * decision: stacks/bets/pot are all HUD text (the authoritative numbers,
 * moved via the ordinary `{t:"score"}` event every game uses) — no chip
 * pieces at all, no per-seat piles, no proportional bet-to-chip-count
 * choreography, no dedicated chip GameEvents. An earlier version placed
 * a single decorative fanned pile of chip pieces in `zone: "pot"` (its
 * own mini-scale zone, not LRC's table-scaled `"center"` — see
 * engine/types.ts's `ZoneId` doc), sized off the pot total; a live
 * playtest reported it visually overlapping the community row above it
 * on an ordinary pot, so it was dropped for a plain pot-total badge (the
 * page reads the same `"pot"` zone box directly off table geometry,
 * outside `placements()`, since there's no piece involved). `pieces()`
 * therefore declares only the standard deck now, no chip pool.
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

/**
 * A card this viewer may not identify, as `playerView` names it. A masked
 * hand is not REMOVED from the view — it keeps its owner, under
 * placeholder ids — so anything reading a seat's cards off a view has to
 * ask this before trusting them.
 */
export function isHiddenCard(id: PieceId): boolean {
  return id.startsWith(HIDDEN_CARD_PREFIX);
}

const STREET_AFTER: Record<Exclude<PokerStreet, "river">, PokerStreet> = {
  preflop: "flop",
  flop: "turn",
  turn: "river",
};


/* ============================================================
   Setup and the deal
   ============================================================ */

export function makeSetup(startingStack: number, bigBlind: number) {
  return function setup(opts: SetupOptions): PokerState {
    const seats = Math.min(MAX_SEATS, Math.max(MIN_SEATS, opts.seats));
    const stacks: Record<SeatId, number> = {};
    for (let s = 0; s < seats; s++) stacks[s] = startingStack;
    // The whole deck, parked face down in the stub before anything is
    // dealt — so the first deal has a pile to fly FROM. It placed nothing
    // at all, and `moveTo` does nothing to a piece the table is not
    // tracking: hand one's cards simply appeared, offline and online both.
    // The order is not the shuffle (that happens in `startRound`) and is
    // never sent anywhere readable: face-down cards go out as stand-ins.
    const deck = standardDeck().map((c) => c.id);
    const cardOwner: PokerState["cardOwner"] = {};
    for (const id of deck) cardOwner[id] = "deck";
    return {
      seats,
      smallBlind: Math.max(1, Math.round(bigBlind / 2)),
      bigBlind,
      hand: 0,
      button: 0,
      stacks,
      winner: null,
      cardOwner,
      deck,
      communityOrder: [],
      folded: {},
      streetCommitted: {},
      totalCommitted: {},
      lastRaiseSize: bigBlind,
      raisesThisStreet: 0,
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
    raisesThisStreet: 0,
    raiseCapped: false,
    toAct: [],
    pendingShowdown: null,
    result: null,
  };
  next = { ...next, toAct: preflopOrder(next) };

  events.push({ t: "phase", phase: "preflop" });
  events.push({
    t: "announce",
    seat: sb,
    actor: sb,
    text: `posts the $${state.smallBlind} small blind`,
    selfText: `post the $${state.smallBlind} small blind`,
    tone: "info",
  });
  events.push({
    t: "announce",
    seat: bb,
    actor: bb,
    text: `posts the $${state.bigBlind} big blind`,
    selfText: `post the $${state.bigBlind} big blind`,
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
  const events: GameEvent[] = [
    { t: "announce", seat, actor: seat, text: "folds", selfText: "fold", tone: "info" },
  ];
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
  let text = "checks";
  let selfText = "check";

  if (isCall) {
    const toCall = Math.min(amountToCall(state, seat), stacks[seat] ?? 0);
    if (toCall > 0) {
      stacks[seat] = (stacks[seat] ?? 0) - toCall;
      streetCommitted[seat] = (streetCommitted[seat] ?? 0) + toCall;
      totalCommitted[seat] = (totalCommitted[seat] ?? 0) + toCall;
      const allIn = stacks[seat] === 0 ? " — all in" : "";
      text = `calls $${toCall}${allIn}`;
      selfText = `call $${toCall}${allIn}`;
    }
  }

  const events: GameEvent[] = [{ t: "announce", seat, actor: seat, text, selfText, tone: "info" }];
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
  let raisesThisStreet = state.raisesThisStreet;
  // Explicit `boolean` annotation: the early-return guard above narrows
  // `state.raiseCapped` to the literal `false` from this point on, which
  // would otherwise infer this variable's type as `false` too and reject
  // the `raiseCapped = true` assignment below.
  let raiseCapped: boolean = state.raiseCapped;

  if (isFullRaise) {
    lastRaiseSize = increment;
    raisesThisStreet += 1;
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
      seat,
      actor: seat,
      text: `${highestBefore === 0 ? "bets" : "raises to"} $${clamped}${isAllInShove ? " — all in" : ""}`,
      selfText: `${highestBefore === 0 ? "bet" : "raise to"} $${clamped}${isAllInShove ? " — all in" : ""}`,
      tone: "info",
    },
  ];

  const next: PokerState = {
    ...state,
    stacks,
    streetCommitted,
    totalCommitted,
    lastRaiseSize,
    raisesThisStreet,
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
    events.push({ t: "announce", seat, actor: seat, text: "shows", selfText: "show", tone: "info" });
  } else {
    // Piggybacks the same `folded`-driven hide `placements()` already
    // gives a real fold — payout is already fixed in
    // `pending.pendingDeltas`, so this has no effect beyond the visual.
    folded = { ...state.folded, [seat]: true };
    // Said out loud: a hand quietly ending with somebody's cards still
    // face down read as though they had folded, or never been there.
    events.push({
      t: "announce",
      seat,
      actor: seat,
      text: "doesn't show — their hand lost",
      selfText: "don't show — your hand lost",
      tone: "info",
    });
  }

  const order = pending.order.slice(1);
  let next: PokerState = { ...state, folded, pendingShowdown: { ...pending, order } };
  if (order.length === 0) {
    next = finalizeHand(next, pending.winningSeats, pending.pendingDeltas, events, pending.contested);
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
 * outright.
 *
 * One step at a time, with a `pause` between each: the burn lands, then
 * each card lands, turns over, and is seen before the next one leaves.
 * Without them every step started at once — the burn was barely visible,
 * and a flop's three cards flew and flipped together. Poker is a slow
 * game; its board is dealt card by card. */
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
  events.push({ t: "pause" });

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
    events.push({ t: "pause" });
    events.push({ t: "flip", piece: card, faceUp: true });
    events.push({ t: "pause" });
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
    raisesThisStreet: 0,
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
    return { state: finalizeHand(state, winningSeats, deltas, events, []), events };
  }
  const contested = contestingSeats(state);

  // Winners are auto-revealed — you don't get to hide that you won.
  for (const seat of winningSeats) {
    for (const card of seatHoleCards(state, seat)) events.push({ t: "flip", piece: card, faceUp: true });
  }

  const order = seatOrderAfter(state.button, state.seats).filter(
    (s) => contested.includes(s) && !winningSeats.includes(s),
  );
  if (order.length === 0) {
    return { state: finalizeHand(state, winningSeats, deltas, events, contested), events };
  }

  const next: PokerState = {
    ...state,
    pendingShowdown: { winningSeats, order, pendingDeltas: deltas, contested },
  };
  return { state: next, events };
}

function finalizeHand(
  state: PokerState,
  winningSeats: SeatId[],
  deltas: Record<SeatId, number>,
  events: GameEvent[],
  showdownSeats: SeatId[],
): PokerState {
  const stacks = { ...state.stacks };
  for (const [seat, delta] of Object.entries(deltas)) {
    stacks[Number(seat)] = (stacks[Number(seat)] ?? 0) + delta;
  }

  const net: Record<SeatId, number> = {};
  for (const seat of Object.keys(state.folded).map(Number)) {
    net[seat] = (deltas[seat] ?? 0) - (state.totalCommitted[seat] ?? 0);
  }

  events.push({ t: "score", deltas });
  events.push(
    winningSeats.length === 1
      ? {
          t: "announce",
          seat: winningSeats[0]!,
          actor: winningSeats[0]!,
          text: "takes the pot",
          selfText: "take the pot",
          tone: "info",
          selfTone: "good",
        }
      : { t: "announce", text: "The pot is split", tone: "info" },
  );
  events.push({ t: "roundEnd", round: state.hand });

  const stillIn = liveMatchSeats({ seats: state.seats, stacks });
  const winner = stillIn.length <= 1 ? (stillIn[0] ?? null) : null;
  if (winner !== null) events.push({ t: "gameEnd", winner });

  return {
    ...state,
    stacks,
    pendingShowdown: null,
    result: { showdown: showdownSeats.length > 0, winningSeats, deltas, net, showdownSeats },
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

/**
 * Poker cannot validate by enumeration, so it does it by hand.
 *
 * `legalActions` offers `{t:"bet", to: range.min}` — ONE representative
 * of a continuous range, because an action bar needs a starting number
 * and a slider does the rest. Membership testing would therefore refuse
 * every bet but the minimum, which is why the other four games share
 * `validateByEnumeration` and this one does not.
 *
 * The case that made it necessary: `to` arrives off a socket as arbitrary
 * JSON. `Math.round("abc")` is `NaN`; `Math.max(min, Math.min(max, NaN))`
 * is `NaN`; and `if (added <= 0)` is FALSE for `NaN` — so `reduceBetOrRaise`
 * ran on through and wrote `NaN` into `stacks`, `streetCommitted` and
 * `totalCommitted`. One malformed bet turned the whole table's money into
 * `NaN` for the rest of the match. Clamping happens downstream and is not
 * a defence, because a non-number survives clamping.
 */
export function validate(state: PokerState, seat: SeatId, action: PokerAction): string | null {
  const offered = legalActions(state, seat);
  if (offered.length === 0) return "not-your-turn";

  const kinds = new Set(offered.map((a) => a.t));
  if (!action || typeof action !== "object" || !kinds.has(action.t)) return "illegal-action";

  if (action.t === "bet" || action.t === "raise") {
    // `Number.isFinite` is the whole guard, and it has to come first:
    // it rejects NaN, both infinities, and every non-number, which
    // `>=`/`<=` comparisons silently pass through as false.
    if (typeof action.to !== "number" || !Number.isFinite(action.to)) return "illegal-action";
    const range = betRange(state, seat);
    // Rounded before comparing, matching what `reduceBetOrRaise` will do
    // with it — otherwise a fractional bet inside the range is accepted
    // here and lands on a different number than the one validated.
    const to = Math.round(action.to);
    if (to < range.min || to > range.max) return "illegal-action";
  }

  return null;
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

// No `state` param: the piece SET is entirely fixed (a standard deck)
// regardless of seat count or match state — same "fewer params than the
// declared type" idiom LRC's own no-viewer `placements` uses, which TS's
// structural typing allows.
export function pieces(): Record<PieceId, PieceMeta> {
  const out: Record<PieceId, PieceMeta> = {};
  for (const card of standardDeck()) out[card.id] = { kind: "card", face: card.id };
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

  return out;
}

/**
 * Can this viewer legitimately put a NAME to this card?
 *
 * The question `playerView` turns on, and it is asked of the owner rather
 * than the card because ownership is what decides visibility in Hold'em:
 *
 *  - the board is face-up in front of everybody
 *  - your own hole cards are yours to read
 *  - an opponent's are theirs until a showdown reveals them
 *  - the stub and the burn cards are nobody's, and stay that way
 *
 * That last line is the one that was missing, and it cost more than it
 * looks: `cardOwner` is keyed by card id, so leaving the stub in the
 * clear published the identity of every undealt card. Heads-up that is
 * the whole game — the two ids a player CANNOT name are, by elimination,
 * exactly their opponent's hand. Masking `state.deck` (which carries the
 * order) did nothing about it, because the set was never in `deck` at
 * all; it was in the keys of this map.
 */
function isIdentifiable(
  state: PokerState,
  owner: PokerState["cardOwner"][PieceId],
  viewer: SeatId,
): boolean {
  if (owner === "community") return true;
  if (owner === "deck" || owner === "burnt") return false;
  return owner === viewer || isHoleCardsRevealed(state, owner);
}

/**
 * The state as one seat is allowed to read it.
 *
 * Every card the viewer may not identify — an opponent's hole cards, the
 * undealt stub, the burns — has its id replaced by an anonymous
 * placeholder, in both `cardOwner` and `deck`. What survives is
 * everything the redaction is not about: how many cards are where, who
 * owns them, and what the pile depths are. A stub of 37 is public; WHICH
 * 37 is not.
 *
 * The same placeholder is used for a card in both places, so the view
 * stays internally consistent — `placements` reads the stub off `deck`
 * and the burns off `cardOwner`, and a view whose two halves disagreed
 * about a card's id would be a trap for whoever called it next.
 *
 * Nothing downstream reads these ids: `reduce` deals from the true state
 * on the server, bots pick their own hole cards out by owner, and the
 * table keys placements by whatever this returns.
 */
export function playerView(state: PokerState, viewer: SeatId): PokerState {
  let hidden = 0;
  const masked = new Map<PieceId, PieceId>();
  const nameFor = (id: PieceId, owner: PokerState["cardOwner"][PieceId]): PieceId => {
    if (isIdentifiable(state, owner, viewer)) return id;
    const existing = masked.get(id);
    if (existing !== undefined) return existing;
    const stand = `${HIDDEN_CARD_PREFIX}${hidden++}`;
    masked.set(id, stand);
    return stand;
  };

  const cardOwner: PokerState["cardOwner"] = {};
  for (const [id, owner] of Object.entries(state.cardOwner)) {
    cardOwner[nameFor(id, owner)] = owner;
  }
  const deck = state.deck.map((id) => nameFor(id, state.cardOwner[id] ?? "deck"));

  return { ...state, cardOwner, deck };
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
    validate,
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
