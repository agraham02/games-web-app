/**
 * Rummy 500 — the GameDefinition.
 *
 * Turn loop: `"draw"` (exactly one action resolves it) then `"meld"`
 * (any number of lays and extends, ended by a discard — or, if the hand
 * has run empty, ended on the spot, there being nothing to discard).
 *
 * GOING OUT MEANS DISCARDING YOUR LAST CARD, never melding it. A player
 * who lays their last card stays in the round: play carries on round
 * the table, and each time it reaches them they draw one from stock and
 * choose again — lay it and wait another lap, or discard it and finish.
 * The round ends when someone discards their last card, or when play
 * returns to an empty-handed seat and the stock has nothing left to
 * deal them. See `endTurnIfEmpty` and `advanceTurn`.
 *
 * The one structural thing worth knowing before reading further: THE
 * DEAL-SIZE CHOICE IS AN ORDINARY ACTION, not a runtime gate. When the
 * dealer is a human, `startRound` returns an UNDEALT state carrying
 * `dealSizePending`, and `chooseDealSize` is the action that actually
 * deals and emits every `deal` event. A bot dealer's choice resolves
 * inline inside `startRound` and deals in the same call.
 *
 * That is what lets round 1 and round N take the identical path — the
 * dealer gets a real choice every single round, including the first —
 * without `useGameRuntime` needing to learn a new "wait before the
 * opening deal" mode. The runtime calls `startRound` exactly as it does
 * for Spades and Dominoes; whether cards fly on that call or on the
 * next action is entirely this file's business.
 *
 * `reduce` is rng-free and contains no wall-clock. A bot's claim is
 * resolved synchronously here, and the visible pacing comes from a real
 * `think` event in the returned batch — the same event every other bot
 * decision in this app uses — not from a timer.
 */

import type {
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
import { createRng, hashString, type Rng } from "@/engine/rng";
import { botColour, botName } from "@/games/_shared/botIdentity";
import {
  MIN_MELD,
  canExtend,
  cardsValue,
  contributorOf,
  handDisplayOrder,
  isValidMeld,
  meldLabel,
  rummyDeck,
  shuffledRummyDeck,
  type Meld,
} from "./cards";
import {
  DEFAULT_TARGET,
  MAX_SEATS,
  MIN_SEATS,
  claimReactions,
  claimableMeld,
  contributedValue,
  handValue,
  layableMelds,
  layoffs,
  legalDrawDepths,
  mandatoryMelds,
  maxDealSize,
  meldById,
  nextSeat,
  seatsOf,
  totalHandCards,
  validDealSizes,
} from "./state";
import type { RoundResult, RummyAction, RummyState } from "./types";
import { rummyBots } from "./bots";

/** Hidden-card sentinel for `playerView`, mirroring Spades' own. */
export const HIDDEN_CARD: PieceId = "??";

/**
 * How many consecutive turns of nothing happening end the round, per
 * seat. Several full laps — well past ordinary variance, and far short
 * of the endless cycling a mandatory-meld-on-every-pickup rule makes
 * genuinely reachable.
 */
const NO_PROGRESS_LAPS = 20;

/**
 * The beat before a claim that the RACE did not already supply.
 *
 * When the hero was offered the window, the page has already spent the
 * winning bot's reaction time in real time waiting for it, so the engine
 * only needs enough of a pause that the claim does not land in the same
 * frame as the pass. When the hero DISCARDED the card there was no window
 * and no page timer, so the bot's own reaction time becomes the beat —
 * which is what makes it look like the bot noticed rather than knew.
 */
const CLAIM_SETTLE_MS = 220;

/* ============================================================
   Setup and the deal
   ============================================================ */

export function makeSetup(target: number) {
  return function setup(opts: SetupOptions): RummyState {
    const seats = Math.min(MAX_SEATS, Math.max(MIN_SEATS, opts.seats));
    const all = Array.from({ length: seats }, (_, i) => i);
    const hands: Record<SeatId, PieceId[]> = {};
    const scores: Record<SeatId, number> = {};
    for (const s of all) {
      hands[s] = [];
      scores[s] = 0;
    }

    // The very first dealer is a genuine random cut. Every dealer after
    // is a plain rotation (see `startRound`) — never re-randomised, so
    // the button walks the table exactly as it would in life.
    const dealer = opts.rng.pick(all);

    return {
      seats,
      target,
      round: 0,
      dealer,
      turn: (dealer + 1) % seats,
      phase: "draw",
      dealt: false,
      dealSize: 0,
      dealSizePending: null,
      hands,
      stock: [],
      discard: [],
      melds: [],
      nextMeldId: 1,
      mandatory: null,
      claimWindow: null,
      scores,
      handTotalCheckpoint: Infinity,
      noProgressStreak: 0,
      result: null,
      winner: null,
    };
  };
}

/**
 * Opens a round. Sweeps the previous one away, rotates the dealer, and
 * then either asks the dealer for a hand size (human) or picks one and
 * deals immediately (bot).
 */
export function startRound(state: RummyState, rng: Rng): ReduceResult<RummyState> {
  const events: GameEvent[] = [];
  const round = state.round + 1;
  const dealer = round === 1 ? state.dealer : nextSeat(state, state.dealer);

  // Everything from last round goes home before anything new arrives.
  const leftovers = [
    ...seatsOf(state).flatMap((s) => state.hands[s] ?? []),
    ...state.stock,
    ...state.discard,
    ...state.melds.flatMap((m) => m.cards),
  ];
  if (leftovers.length > 0) {
    events.push({ t: "sweep", pieces: leftovers, to: "deck" });
  }

  const hands: Record<SeatId, PieceId[]> = {};
  for (const s of seatsOf(state)) hands[s] = [];

  const cleared: RummyState = {
    ...state,
    round,
    dealer,
    turn: nextSeat(state, dealer),
    phase: "draw",
    dealt: false,
    dealSize: 0,
    dealSizePending: null,
    hands,
    stock: [],
    discard: [],
    melds: [],
    mandatory: null,
    claimWindow: null,
    handTotalCheckpoint: Infinity,
    noProgressStreak: 0,
    result: null,
  };

  events.push({ t: "phase", phase: `round-${round}` });

  if (dealer === HERO) {
    // A human dealer decides in their own time. `currentSeat` parks on
    // them, `legalActions` offers the sizes, and `chooseDealSize` is
    // what actually deals.
    return {
      state: { ...cleared, dealSizePending: HERO },
      events,
    };
  }

  // A bot dealer has no "turn" to spend on this, so it resolves inline
  // and the deal happens in this same call.
  const size = botDealSize(cleared, rng);
  const dealt = dealCards(cleared, size, rng, events);
  return { state: dealt, events };
}

function botDealSize(state: RummyState, rng: Rng): number {
  const sizes = validDealSizes(state.seats);
  // Middling hands make the best games — big enough to hold a plan,
  // small enough that the stock lasts. Bots pick from the middle band
  // rather than uniformly across a range whose ends are both dull.
  const lo = Math.floor(sizes.length * 0.35);
  const hi = Math.max(lo, Math.floor(sizes.length * 0.75));
  const band = sizes.slice(lo, hi + 1);
  return band.length > 0 ? rng.pick(band) : (sizes[sizes.length - 1] ?? 7);
}

/** Shuffles, deals `size` to each seat, turns one card up. Mutates `events`. */
function dealCards(
  state: RummyState,
  size: number,
  rng: Rng,
  events: GameEvent[],
): RummyState {
  const deck = shuffledRummyDeck(rng);
  events.push({ t: "shuffle", seed: rng.seed });

  const all = seatsOf(state);
  const hands: Record<SeatId, PieceId[]> = {};
  for (const s of all) hands[s] = [];

  let cursor = 0;
  // Round-robin, starting left of the dealer — the order a real deal
  // goes round, and the order the animation should read in.
  for (let n = 0; n < size; n++) {
    for (let i = 0; i < all.length; i++) {
      const seat = (state.dealer + 1 + i) % state.seats;
      const card = deck[cursor++]!;
      hands[seat]!.push(card);
      // `faceUp` is gated at the SOURCE, never left for the table layer
      // to work out — `applyEventToTable` applies events verbatim and
      // has no idea who is watching, so an ungated `true` here would
      // flash every opponent's hand on the hero's own screen.
      events.push({ t: "deal", piece: card, to: seat, faceUp: seat === HERO });
    }
  }

  const upcard = deck[cursor++]!;
  const stock = deck.slice(cursor);
  events.push({ t: "draw", piece: upcard, from: "deck", to: HERO, faceUp: true });
  events.push({ t: "move", piece: upcard, to: { zone: "discard", index: 0, count: 1, faceUp: true } });

  const next: RummyState = {
    ...state,
    dealt: true,
    dealSize: size,
    dealSizePending: null,
    hands,
    stock,
    discard: [upcard],
    turn: nextSeat(state, state.dealer),
    phase: "draw",
  };
  return { ...next, handTotalCheckpoint: totalHandCards(next), noProgressStreak: 0 };
}

/* ============================================================
   Reduce
   ============================================================ */

export function reduce(state: RummyState, action: RummyAction): ReduceResult<RummyState> {
  switch (action.t) {
    case "chooseDealSize":
      return reduceChooseDealSize(state, action.size);
    case "drawStock":
      return reduceDrawStock(state);
    case "drawDiscard":
      return reduceDrawDiscard(state, action.depth);
    case "layNewMeld":
      return reduceLayNewMeld(state, action.cards);
    case "extendMeld":
      return reduceExtendMeld(state, action.meldId, action.card);
    case "discard":
      return reduceDiscard(state, action.card);
    case "claim":
      return reduceClaim(state);
    case "passClaim":
      return reducePassClaim(state);
  }
}

function reduceChooseDealSize(state: RummyState, size: number): ReduceResult<RummyState> {
  if (state.dealSizePending === null) return { state, events: [] };
  if (!validDealSizes(state.seats).includes(size)) return { state, events: [] };

  // `dealCards` needs an rng for the shuffle, but `reduce` deliberately
  // receives none. Seeding the project's own `createRng` from data
  // already in state keeps this deal a pure function of (round, dealer,
  // size) — so a replay reproduces it exactly, which is the property
  // threading a live generator through here would have given up.
  const events: GameEvent[] = [];
  const rng = createRng(hashString(`deal|${state.round}|${state.dealer}|${size}`));
  const dealt = dealCards({ ...state, dealSizePending: null }, size, rng, events);
  return { state: dealt, events };
}

function reduceDrawStock(state: RummyState): ReduceResult<RummyState> {
  if (state.phase !== "draw" || state.claimWindow) return { state, events: [] };
  const seat = state.turn;

  // The stock never reshuffles from the discard pile. A seat facing an
  // empty stock simply skips drawing and melds/discards from what it
  // already holds — deliberate, with the stalemate backstop rather than
  // an endless pile as the thing that keeps a round moving.
  if (state.stock.length === 0) {
    return { state: { ...state, phase: "meld" }, events: [] };
  }

  const card = state.stock[state.stock.length - 1]!;
  const events: GameEvent[] = [
    { t: "draw", piece: card, from: "deck", to: seat, faceUp: seat === HERO },
  ];
  return {
    state: {
      ...state,
      phase: "meld",
      stock: state.stock.slice(0, -1),
      hands: { ...state.hands, [seat]: [...(state.hands[seat] ?? []), card] },
    },
    events,
  };
}

function reduceDrawDiscard(state: RummyState, depth: number): ReduceResult<RummyState> {
  if (state.phase !== "draw" || state.claimWindow) return { state, events: [] };
  if (!legalDrawDepths(state, state.turn).includes(depth)) return { state, events: [] };

  const seat = state.turn;
  const pile = state.discard;
  const taken = pile.slice(pile.length - depth);
  const deepest = taken[0]!;

  // One concurrent batch: `choreograph` gives every `draw` an offset of
  // 0, so the whole pickup plays as a single gesture rather than card
  // by card. (That only actually works because useChoreographer treats
  // `offset: 0` as "no wait" — see its own comment.)
  const events: GameEvent[] = taken.map((card) => ({
    t: "draw" as const,
    piece: card,
    from: "discard" as const,
    to: seat,
    faceUp: seat === HERO,
  }));

  return {
    state: {
      ...state,
      phase: "meld",
      discard: pile.slice(0, pile.length - depth),
      hands: { ...state.hands, [seat]: [...(state.hands[seat] ?? []), ...taken] },
      mandatory: { card: deepest, pool: taken.slice(1) },
    },
    events,
  };
}

function reduceLayNewMeld(state: RummyState, cards: readonly PieceId[]): ReduceResult<RummyState> {
  if (state.phase !== "meld" || state.claimWindow) return { state, events: [] };
  const seat = state.turn;
  const hand = state.hands[seat] ?? [];

  // Self-validated rather than trusting the caller matched
  // `legalActions` — the UI builds these from a live multi-select, and a
  // reducer that assumes its input was pre-checked is a reducer that
  // corrupts state the first time that assumption slips.
  if (cards.length < MIN_MELD) return { state, events: [] };
  if (new Set(cards).size !== cards.length) return { state, events: [] };
  if (!cards.every((c) => hand.includes(c))) return { state, events: [] };
  if (!isValidMeld(cards)) return { state, events: [] };

  // A pending pickup obligation must be discharged by THIS meld.
  if (state.mandatory && !cards.includes(state.mandatory.card)) {
    return { state, events: [] };
  }

  const meld: Meld = { id: state.nextMeldId, owner: seat, cards: [...cards], hitBy: {} };
  const events: GameEvent[] = cards.map((card) => ({
    t: "play" as const,
    piece: card,
    from: seat,
    to: "board" as const,
    group: meld.id,
  }));
  events.push({
    t: "announce",
    seat,
    actor: seat,
    text: `melded ${meldLabel(cards)}`,
    tone: seat === HERO ? "good" : "info",
  });

  const next: RummyState = {
    ...state,
    hands: { ...state.hands, [seat]: hand.filter((c) => !cards.includes(c)) },
    melds: [...state.melds, meld],
    nextMeldId: state.nextMeldId + 1,
    mandatory: null,
  };
  return endTurnIfEmpty(noteProgress(next), events);
}

function reduceExtendMeld(
  state: RummyState,
  meldId: number,
  card: PieceId,
): ReduceResult<RummyState> {
  if (state.phase !== "meld" || state.claimWindow) return { state, events: [] };
  const seat = state.turn;
  const hand = state.hands[seat] ?? [];
  // The pickup's own meld comes first — nothing else in "meld" phase is
  // legal while an outstanding obligation can still be discharged. The
  // "can still be" matters: blocking unconditionally would livelock a
  // seat holding an obligation it has no way to satisfy. See
  // `legalActions`' matching guard.
  if (state.mandatory && mandatoryMelds(hand, state.mandatory.card).length > 0) {
    return { state, events: [] };
  }
  if (!hand.includes(card)) return { state, events: [] };
  const meld = meldById(state, meldId);
  if (!meld || !canExtend(meld.cards, card)) return { state, events: [] };

  const next = applyExtend(state, meld, card, seat);
  const events: GameEvent[] = [
    { t: "play", piece: card, from: seat, to: "board", group: meld.id },
  ];
  return endTurnIfEmpty(noteProgress(next), events);
}

/**
 * Adds `card` to `meld` on behalf of `seat`. The meld's `owner` never
 * changes — melds are owned for SCORING attribution only, never for
 * permission to extend, so any seat may hit any meld and the hit card
 * simply carries its own contributor.
 */
function applyExtend(
  state: RummyState,
  meld: Meld,
  card: PieceId,
  seat: SeatId,
): RummyState {
  const updated: Meld = {
    ...meld,
    cards: [...meld.cards, card],
    hitBy: seat === meld.owner ? meld.hitBy : { ...meld.hitBy, [card]: seat },
  };
  return {
    ...state,
    hands: {
      ...state.hands,
      [seat]: (state.hands[seat] ?? []).filter((c) => c !== card),
    },
    melds: state.melds.map((m) => (m.id === meld.id ? updated : m)),
  };
}

function reduceDiscard(state: RummyState, card: PieceId): ReduceResult<RummyState> {
  if (state.phase !== "meld" || state.claimWindow) return { state, events: [] };
  const seat = state.turn;
  const hand = state.hands[seat] ?? [];
  // See `reduceExtendMeld` for why this is "can still be discharged"
  // rather than a flat block.
  if (state.mandatory && mandatoryMelds(hand, state.mandatory.card).length > 0) {
    return { state, events: [] };
  }
  if (!hand.includes(card)) return { state, events: [] };

  const events: GameEvent[] = [{ t: "play", piece: card, from: seat, to: "discard" }];
  const afterDiscard: RummyState = {
    ...state,
    hands: { ...state.hands, [seat]: hand.filter((c) => c !== card) },
    discard: [...state.discard, card],
  };

  // Discarding your last card ends the round then and there.
  if ((afterDiscard.hands[seat] ?? []).length === 0) {
    return endRound(afterDiscard, seat, false, events);
  }

  return openClaimWindow(afterDiscard, card, seat, events);
}

/**
 * Offers a just-discarded card to whoever can use it, then advances.
 *
 * The hero gets FIRST REFUSAL whenever they are eligible, even if a bot
 * is too. A real player should never feel sniped by a bot on a card they
 * were not given a chance to see.
 */
function openClaimWindow(
  state: RummyState,
  card: PieceId,
  discarder: SeatId,
  events: GameEvent[],
): ReduceResult<RummyState> {
  const meld = claimableMeld(state, card);
  if (!meld) return advanceTurn(state, events);

  const bots = claimReactions(state, card, discarder);

  if (discarder !== HERO) {
    // The hero is in the race, so the window opens and carries the bots'
    // clocks with it. The page runs the shortest of them against the
    // hero's own; whoever gets there first wins. The hero no longer has a
    // guaranteed refusal — that was a queue dressed up as a contest.
    return {
      state: {
        ...state,
        claimWindow: { discard: card, discarder, meldId: meld.id, bots },
      },
      events,
    };
  }

  // The hero discarded it, so there is nobody to open a window for and no
  // page timer to spend the wait. The winning bot's own reaction time
  // becomes the pause instead.
  return resolveBotClaim(state, card, discarder, events, bots);
}

/**
 * Resolves a claim among the bots. Called either because the hero was
 * not eligible, or because they declined.
 */
function resolveBotClaim(
  state: RummyState,
  card: PieceId,
  discarder: SeatId,
  events: GameEvent[],
  /** The race, when the caller has already run it. */
  reactions?: ReadonlyArray<{ seat: SeatId; ms: number }>,
): ReduceResult<RummyState> {
  const meld = claimableMeld(state, card);
  if (!meld) return advanceTurn(state, events);

  const bots = reactions ?? claimReactions(state, card, discarder);
  const winner = bots[0];
  if (!winner) return advanceTurn(state, events);
  const claimer = winner.seat;

  // A REAL beat before the claim plays out. The state transition below is
  // synchronous, and without a pause the claim lands in the same instant
  // as the discard that caused it — which reads as "the bot already knew
  // and grabbed it before I saw what happened", and was reported exactly
  // that way once.
  events.push({
    t: "think",
    seat: claimer,
    ms: reactions ? winner.ms : CLAIM_SETTLE_MS,
  });

  const pile = state.discard;
  const taken: RummyState = {
    ...state,
    discard: pile.slice(0, -1),
    hands: { ...state.hands, [claimer]: [...(state.hands[claimer] ?? []), card] },
  };
  events.push({ t: "draw", piece: card, from: "discard", to: claimer, faceUp: false });

  const next = applyExtend(taken, meld, card, claimer);
  events.push({ t: "play", piece: card, from: claimer, to: "board", group: meld.id });
  events.push({ t: "announce", seat: claimer, text: `claimed ${meldLabel([card])}`, tone: "info" });

  // A claim that empties the claimer's hand does not go out either —
  // same rule as any other lay-off. `advanceTurn` handles what happens
  // when play comes back round to them.
  return advanceTurn(noteProgress(next), events);
}

function reduceClaim(state: RummyState): ReduceResult<RummyState> {
  const window = state.claimWindow;
  if (!window) return { state, events: [] };
  const meld = meldById(state, window.meldId);
  if (!meld || !canExtend(meld.cards, window.discard)) {
    return reducePassClaim(state);
  }

  const events: GameEvent[] = [
    { t: "draw", piece: window.discard, from: "discard", to: HERO, faceUp: true },
  ];
  const taken: RummyState = {
    ...state,
    claimWindow: null,
    discard: state.discard.slice(0, -1),
    hands: { ...state.hands, [HERO]: [...(state.hands[HERO] ?? []), window.discard] },
  };
  const next = applyExtend(taken, meld, window.discard, HERO);
  events.push({ t: "play", piece: window.discard, from: HERO, to: "board", group: meld.id });

  return advanceTurn(noteProgress(next), events);
}

function reducePassClaim(state: RummyState): ReduceResult<RummyState> {
  const window = state.claimWindow;
  if (!window) return { state, events: [] };
  const cleared: RummyState = { ...state, claimWindow: null };
  // The hero lost the race (or declined it). The bots' clocks were fixed
  // when the window opened, so the winner is already decided — pass the
  // same list back rather than re-deriving it, and take the short settle
  // beat, since the page has already spent the real wait.
  return resolveBotClaim(cleared, window.discard, window.discarder, [], window.bots);
}

/* ============================================================
   Turn advance, stalemate, round end
   ============================================================ */

/**
 * Records that the total hand-card count fell, which is the only thing
 * that can actually happen when a meld is laid or extended. A plain
 * draw-then-discard nets zero, which is exactly why the checkpoint is a
 * meaningful progress signal and a turn counter alone would not be.
 */
function noteProgress(state: RummyState): RummyState {
  const total = totalHandCards(state);
  if (total < state.handTotalCheckpoint) {
    return { ...state, handTotalCheckpoint: total, noProgressStreak: 0 };
  }
  return state;
}

function advanceTurn(state: RummyState, events: GameEvent[]): ReduceResult<RummyState> {
  const streak = state.noProgressStreak + 1;
  const next: RummyState = {
    ...state,
    turn: nextSeat(state, state.turn),
    phase: "draw",
    mandatory: null,
    noProgressStreak: streak,
  };

  if (streak >= state.seats * NO_PROGRESS_LAPS) {
    return endRound(next, null, true, events);
  }

  // A seat that has already emptied its hand is still IN the round —
  // play keeps going round to them, and each time it does they draw one
  // and either lay it (and wait for another lap) or discard it (and go
  // out). They only stop when the stock can no longer deal them that
  // card, and that is what ends the round.
  //
  // See `endTurnIfEmpty` for the other half of this rule and for why it
  // is not the "empty hand ends the round immediately" the spec
  // originally described.
  if ((next.hands[next.turn] ?? []).length === 0 && next.stock.length === 0) {
    return endRound(next, next.turn, false, events);
  }
  return { state: next, events };
}

/**
 * Ends the TURN — not the round — when a lay or a lay-off leaves the
 * acting seat with nothing.
 *
 * Melding your last card does not go out. Going out means DISCARDING
 * your last card; laying it instead simply ends your turn with an empty
 * hand, and play carries on around the table. When it reaches you again
 * you draw one and face the same choice: lay it and wait another lap,
 * or discard it and finish.
 *
 * (`rummy.md` originally specified this as "the hand running empty
 * mid-meld ends the round". That was wrong, corrected from how the game
 * is actually played, and the spec has been amended.)
 */
function endTurnIfEmpty(state: RummyState, events: GameEvent[]): ReduceResult<RummyState> {
  const seat = state.turn;
  if ((state.hands[seat] ?? []).length === 0) {
    return advanceTurn(state, events);
  }
  return { state, events };
}

function scoreRound(state: RummyState): RoundResult {
  const deltas: Record<SeatId, number> = {};
  const contributed: Record<SeatId, number> = {};
  const handPenalty: Record<SeatId, number> = {};

  for (const seat of seatsOf(state)) {
    const on = contributedValue(state, seat);
    const held = handValue(state, seat);
    contributed[seat] = on;
    handPenalty[seat] = held;
    deltas[seat] = on - held;
  }

  let winner: SeatId = 0;
  for (const seat of seatsOf(state)) {
    if ((deltas[seat] ?? 0) > (deltas[winner] ?? 0)) winner = seat;
  }
  return { deltas, contributed, handPenalty, wentOut: null, blocked: false, winner };
}

function endRound(
  state: RummyState,
  wentOut: SeatId | null,
  blocked: boolean,
  events: GameEvent[],
): ReduceResult<RummyState> {
  const scored = { ...scoreRound(state), wentOut, blocked };
  const scores: Record<SeatId, number> = {};
  for (const seat of seatsOf(state)) {
    scores[seat] = (state.scores[seat] ?? 0) + (scored.deltas[seat] ?? 0);
  }

  events.push({ t: "score", deltas: scored.deltas });
  events.push({ t: "roundEnd", round: state.round });

  // Match winner: highest score at or above target once a round has
  // actually completed. Two seats crossing in the same round is the
  // near-impossible case, and the higher score simply takes it.
  let winner: SeatId | null = null;
  const contenders = seatsOf(state).filter((s) => (scores[s] ?? 0) >= state.target);
  if (contenders.length > 0) {
    winner = contenders.reduce((best, s) => ((scores[s] ?? 0) > (scores[best] ?? 0) ? s : best));
    events.push({ t: "gameEnd", winner });
  }

  return {
    state: {
      ...state,
      scores,
      dealt: false,
      claimWindow: null,
      mandatory: null,
      result: scored,
      winner,
    },
    events,
  };
}

/* ============================================================
   Definition surface
   ============================================================ */

export function currentSeat(state: RummyState): SeatId | null {
  if (state.result !== null || state.winner !== null) return null;
  // Both of these seize the turn regardless of `phase`, exactly the way
  // Spades' `exchange` does — they are sub-decisions layered over the
  // turn loop, not extra phases inside it.
  if (state.dealSizePending !== null) return state.dealSizePending;
  if (state.claimWindow !== null) return HERO;
  if (!state.dealt) return null;
  return state.turn;
}

export function isOver(state: RummyState): boolean {
  return state.winner !== null;
}

export function isRoundOver(state: RummyState): boolean {
  return state.result !== null;
}

export function legalActions(state: RummyState, seat: SeatId): RummyAction[] {
  if (currentSeat(state) !== seat) return [];

  if (state.dealSizePending !== null) {
    return validDealSizes(state.seats).map((size) => ({ t: "chooseDealSize", size }));
  }

  if (state.claimWindow !== null) {
    return [{ t: "claim" }, { t: "passClaim" }];
  }

  const hand = state.hands[seat] ?? [];

  if (state.phase === "draw") {
    const out: RummyAction[] = [{ t: "drawStock" }];
    for (const depth of legalDrawDepths(state, seat)) {
      out.push({ t: "drawDiscard", depth });
    }
    return out;
  }

  // "meld" phase. An outstanding pickup obligation blocks everything but
  // the meld that discharges it — including the discard that would
  // otherwise end the turn.
  if (state.mandatory) {
    const melds = mandatoryMelds(hand, state.mandatory.card);
    if (melds.length > 0) {
      return melds.map((cards) => ({ t: "layNewMeld", cards }));
    }
    // Unreachable by construction: `legalDrawDepths` only ever offers a
    // depth whose deepest card CAN complete a meld, and taking it puts
    // every card involved into this hand. Falling through to a discard
    // anyway is a livelock guard, not a rule — returning an empty list
    // here would leave a bot with no legal action, and the runtime would
    // ask the same seat forever.
    return hand.map((card) => ({ t: "discard", card }));
  }

  const out: RummyAction[] = [];
  for (const candidate of layableMelds(hand)) {
    out.push({ t: "layNewMeld", cards: candidate });
  }
  for (const { meldId, card } of layoffs(state, hand)) {
    out.push({ t: "extendMeld", meldId, card });
  }
  for (const card of hand) out.push({ t: "discard", card });
  return out;
}

/**
 * Two-letter initials for a seat's owner chip. Lives here rather than on
 * the page so `placements` — the single source of visual truth — carries
 * the whole answer, and any other surface showing a board card gets the
 * same tag without re-deriving it.
 */
export function seatTag(seat: SeatId): string {
  return seat === HERO ? "YOU" : botName(seat).slice(0, 2).toUpperCase();
}

export function seatColour(seat: SeatId): string {
  return seat === HERO ? "var(--color-brass-300)" : botColour(seat);
}

export function pieces(): Record<PieceId, PieceMeta> {
  const out: Record<PieceId, PieceMeta> = {};
  for (const id of rummyDeck()) out[id] = { kind: "card", face: id };
  return out;
}

export function placements(state: RummyState, viewer: SeatId): PlacementMap {
  const out: PlacementMap = {};

  const active = currentSeat(state);
  const drawing = active === viewer && state.phase === "draw" && !state.claimWindow;

  // --- hands
  for (const seat of seatsOf(state)) {
    const hand = state.hands[seat] ?? [];
    const isViewer = seat === viewer;
    // Display-sorted for the viewer only; `state.hands` is never
    // reordered, so nothing the engine or a bot reads is affected.
    const ordered = isViewer ? handDisplayOrder(hand) : hand;
    ordered.forEach((id, i) => {
      out[id] = {
        zone: "hand",
        seat,
        index: i,
        count: ordered.length,
        faceUp: isViewer,
        // A hand tap only toggles a reversible selection, so the touch
        // preview-then-confirm gate is wrong here — see
        // `Placement.instantAct`.
        instantAct: isViewer ? true : undefined,
      };
    });
  }

  // --- discard pile, bottom (index 0) to top
  state.discard.forEach((id, i) => {
    out[id] = {
      zone: "discard",
      index: i,
      count: state.discard.length,
      faceUp: true,
      fanned: true,
      // Every card is tappable while drawing — tapping stages a
      // cancelable preview, so exploring the pile is free.
      //
      // But NOTHING is lit. Marking the depths that happen to be legal
      // would answer, before the player has looked, the question the
      // game is actually asking them: is there something here I can
      // use? Working that out IS the play. The commit step validates;
      // the offer stays silent. (A hints mode may surface it later —
      // deliberately as an opt-in, not as the default.)
      tappable: drawing ? true : undefined,
    };
  });

  // --- board melds
  //
  // `hidden` on every one of them: a laid meld flies to the felt, is
  // visible for the beat its own animation takes, and then fades out in
  // place, leaving the felt to the piles and the board sheet to the
  // melds. `applyEvent`'s `moveTo` hard-clears `hidden` on the way in,
  // so the flight itself always plays; this reconcile is what fades it
  // afterwards. Same mechanism Spades' won-trick piles use.
  //
  // `seat` is the per-card CONTRIBUTOR, not the meld's owner — see
  // `Placement.seat`. `group` carries which meld it belongs to, so
  // scoring attribution and visual grouping stay free to disagree.
  //
  // Note these stay FACE UP even when the meld is dead. Turning a dead
  // meld over is a board-sheet job (see `useFlippedMelds`), and it has to
  // be: the only moment a board card is visible on the felt is the beat
  // its own flight takes, and the card that completes the set would then
  // arrive face-down — you would watch it fly with its back to you.
  state.melds.forEach((meld) => {
    meld.cards.forEach((id, i) => {
      const contributor = contributorOf(meld, id);
      out[id] = {
        zone: "board",
        seat: contributor,
        group: meld.id,
        index: i,
        count: meld.cards.length,
        faceUp: true,
        hidden: true,
        // Only when the card is NOT the meld owner's. Tagging every card
        // in your own meld with your own initials says nothing — the
        // group it sits under already said it. The chip earns its space
        // only where it contradicts that: a card someone else hit onto
        // this meld, which is the one case the grouping cannot show.
        ownerTag: contributor === meld.owner ? undefined : seatTag(contributor),
        accentColour: contributor === meld.owner ? undefined : seatColour(contributor),
      };
    });
  });

  // --- everything unaccounted for is the stock.
  //
  // REQUIRED, not tidiness: `applyEvent`'s `moveTo` bails on a piece id
  // it has never seen, so a card that is not in the placement map has
  // nothing for a `deal` or `draw` event to fly FROM and simply appears.
  //
  // Ordered so the real stock sits ON TOP of any not-yet-dealt
  // remainder, and the LAST entry is the card `drawStock` actually
  // takes. That matters for one thing only, but it is the thing the
  // player touches: the top of the pile is what gets lit and tapped, so
  // the card they aim at has to be the card they get.
  const accounted = new Set(Object.keys(out));
  const inStock = new Set(state.stock);
  const undealt = rummyDeck().filter((id) => !accounted.has(id) && !inStock.has(id));
  const deck = [...undealt, ...state.stock.filter((id) => !accounted.has(id))];
  const canDrawStock = drawing && state.stock.length > 0;
  deck.forEach((id, i) => {
    out[id] = {
      zone: "deck",
      index: i,
      count: deck.length,
      faceUp: false,
      // The whole pile is tappable so a stray tap anywhere on it still
      // draws, but only the top card is LIT — "you may interact with
      // this" versus "this is the one you will get".
      tappable: canDrawStock ? true : undefined,
      highlighted: canDrawStock && i === deck.length - 1 ? true : undefined,
    };
  });

  return out;
}

export function playerView(state: RummyState, viewer: SeatId): RummyState {
  const hands: Record<SeatId, PieceId[]> = {};
  for (const seat of seatsOf(state)) {
    const hand = state.hands[seat] ?? [];
    hands[seat] = seat === viewer ? [...hand] : hand.map(() => HIDDEN_CARD);
  }
  // The stock is every card still to be drawn, in the exact order it will
  // come out — strictly more valuable than seeing an opponent's hand, and
  // it was passing through untouched while the hands beside it were being
  // carefully masked.
  //
  // Unlike a hand, these placeholders have to be DISTINCT: `legalActions`
  // builds a `Set` from the stock, and collapsing every card to one id the
  // way hands do would shrink that set to a single element and misreport
  // how much stock is left. What is legitimately public is the depth, so
  // the count is preserved exactly.
  const stock = state.stock.map((_, i) => `${HIDDEN_CARD}s${i}`);
  return { ...state, hands, stock };
}

export function standingsOf(state: RummyState) {
  return seatsOf(state).map((seat) => ({ seat, total: state.scores[seat] ?? 0 }));
}

/* ============================================================
   Factory
   ============================================================ */

export function createRummy(
  opts: { target?: number } = {},
): GameDefinition<RummyState, RummyAction> {
  return {
    id: "rummy",
    name: "Rummy 500",
    minSeats: MIN_SEATS,
    maxSeats: MAX_SEATS,
    setup: makeSetup(opts.target ?? DEFAULT_TARGET),
    reduce,
    legalActions,
    pieces,
    placements,
    playerView,
    currentSeat,
    isOver,
    startRound,
    isRoundOver,
    bots: rummyBots,
  };
}

export const rummy = createRummy();

export { cardsValue, maxDealSize, validDealSizes };
