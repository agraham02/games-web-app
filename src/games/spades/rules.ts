/**
 * Spades — GameDefinition.
 *
 * Bidding is not a separate mini-game bolted onto play — it is driven
 * through the exact same `currentSeat` -> `legalActions` -> `reduce` turn
 * loop as trick play. `state.phase` just tells `reduce` which family of
 * actions is currently legal, the same way Dominoes branches on
 * `result`/`dealt`. `state.exchange`, when set, overrides `currentSeat`
 * regardless of `phase` — the Blind Nil card exchange is its own
 * sub-sequence layered on top, not a third phase.
 *
 * Blind-bid timing, worth getting right: the rule ("After everyone has
 * bid and before the first lead, the [Blind Nil] bidder may exchange two
 * cards with partner") places the exchange AFTER ALL FOUR bids are in,
 * not immediately after the blind bid itself — so `phase` stays "bid"
 * through the whole exchange sub-sequence and only flips to "play" once
 * it resolves (or never happened). A Blind NUMERIC bid has no exchange
 * mechanic and reveals the bidder's hand the instant it's locked in —
 * the whole point of "blind" was not seeing the hand BEFORE deciding the
 * number, and nothing in the rule keeps it hidden any longer than that.
 * A Blind Nil bidder's hand, by contrast, stays hidden until the
 * exchange resolves (skipped or completed).
 *
 * One thing that looked at first like it would need special handling and
 * turns out not to: does executing the "take" half of the exchange
 * force-reveal the TAKER's hand? Only if the taker could still be
 * genuinely hidden at that point — but the taker is always the giver's
 * partner, and the only way to stay hidden through the full bidding
 * round is to bid Blind Nil yourself, which the team minimum-4 rule
 * already makes double-Nil (and so double-Blind-Nil) on one team
 * unreachable (see state.ts's `minLegalBid`). A partner who also went
 * blind must have bid a blind NUMBER instead — which reveals immediately
 * on locking in, per above. So the taker's hand is always already
 * visible by the time the exchange happens, by construction; no extra
 * reveal step is needed here at all.
 */

import type {
  GameDefinition,
  GameEvent,
  PieceId,
  PieceMeta,
  PlacementMap,
  ReduceResult,
  SeatId,
} from "@/engine/types";
import { HERO } from "@/engine/types";
import type { Rng } from "@/engine/rng";
import { botName } from "@/games/_shared/botIdentity";
import { resolveTrick } from "@/games/_shared/trickTaking";
import {
  cardStrength,
  effectiveSuit,
  isTrump,
  shuffledSpadesDeck,
  spadesCardLabel,
  spadesDeck,
  type SpadesRules,
} from "./cards";
import { spadesBots } from "./bots";
import {
  HIDDEN_CARD,
  isBlindEligible,
  isHiddenFromSelf,
  legalPlays,
  minLegalBid,
  nextSeat,
  partnerOf,
  teamOf,
  teammates,
} from "./state";
import { AUTO_LOSS_SCORE, scoreRound, TARGET_SCORE } from "./scoring";
import type { Bid, RoundResult, SpadesAction, SpadesState } from "./types";

export const MIN_SEATS = 4;
export const MAX_SEATS = 4;

const SEATS: readonly SeatId[] = [0, 1, 2, 3];

function leadAnnounce(seat: SeatId): GameEvent {
  return {
    t: "announce",
    seat,
    text: seat === HERO ? "You lead" : `${botName(seat)} leads`,
    tone: "info",
  };
}

function describeBid(bid: Bid): string {
  if (bid.nil) return bid.blind ? "blind nil" : "nil";
  return bid.blind ? `${bid.tricks} blind` : `${bid.tricks}`;
}

function combinations2<T>(items: readonly T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) out.push([items[i]!, items[j]!]);
  }
  return out;
}

/* ============================================================
   Setup and dealing
   ============================================================ */

/**
 * Returns an UNDEALT state: every card still notionally "in the deck".
 * The deal itself is `startRound`'s job, which is what makes it animate.
 */
function makeSetup(rules: SpadesRules) {
  // Spades is always exactly 4 fixed-partnership seats — nothing in
  // SetupOptions (seats/rng/difficulty) affects the initial state here,
  // unlike Dominoes' variable-seat-count setup.
  return function setup(): SpadesState {
    const num = (): Record<SeatId, number> => ({ 0: 0, 1: 0, 2: 0, 3: 0 });
    const bool = (v: boolean): Record<SeatId, boolean> => ({ 0: v, 1: v, 2: v, 3: v });
    const arr = (): Record<SeatId, PieceId[]> => ({ 0: [], 1: [], 2: [], 3: [] });
    return {
      rules,
      target: TARGET_SCORE,
      autoLoss: AUTO_LOSS_SCORE,
      round: 0,
      // Sentinel so round 1 computes dealer=3, leader/first-bidder=seat 0.
      dealer: 3,
      phase: "bid",
      turn: HERO,
      hands: arr(),
      handRevealed: bool(true),
      blindEligible: bool(false),
      bids: { 0: null, 1: null, 2: null, 3: null },
      exchange: null,
      trick: [],
      ledSuit: null,
      trumpBroken: false,
      leader: HERO,
      tricksWon: num(),
      won: arr(),
      scores: num(),
      bags: num(),
      nilsAttempted: num(),
      nilsMade: num(),
      result: null,
      winningSeats: null,
      winner: null,
      dealt: false,
    };
  };
}

export function startRound(state: SpadesState, rng: Rng): ReduceResult<SpadesState> {
  const round = state.round + 1;
  // Round one is decided by the setup sentinel; after that, deal rotates.
  const dealer = round === 1 ? state.dealer : nextSeat(state.dealer);
  const leader = nextSeat(dealer);

  // Round 2+ inherits every seat's WON pile from the round that just
  // ended (a full round always empties every hand, so nothing is ever
  // left there — this is defensive, matching Dominoes' own leftover
  // sweep). One `sweep` event, not one `move` per card: "clear the
  // table" is a single gesture, and sweep's own choreography stays fast
  // regardless of how many cards are in it — see presets.ts.
  const leftover = [...Object.values(state.hands).flat(), ...Object.values(state.won).flat()];
  const events: GameEvent[] = leftover.length > 0 ? [{ t: "sweep", pieces: leftover, to: "deck" }] : [];

  const deck = shuffledSpadesDeck(rng, state.rules);
  events.push({ t: "shuffle", seed: rng.seed });

  // Frozen from the scores ENTERING this round — a team's blind option
  // for the round is decided before a single card is dealt, and stays
  // fixed even if the round's own outcome would have changed the answer.
  const blindEligible: Record<SeatId, boolean> = {
    0: isBlindEligible(state.scores, 0),
    1: isBlindEligible(state.scores, 1),
    2: isBlindEligible(state.scores, 2),
    3: isBlindEligible(state.scores, 3),
  };
  const handRevealed: Record<SeatId, boolean> = {
    0: !blindEligible[0],
    1: !blindEligible[1],
    2: !blindEligible[2],
    3: !blindEligible[3],
  };

  const hands: Record<SeatId, PieceId[]> = { 0: [], 1: [], 2: [], 3: [] };
  // Dealt round by round, not hand by hand, so the deal reads as one
  // pass around the table instead of four separate handfuls.
  let cursor = 0;
  for (let i = 0; i < 13; i++) {
    for (const seat of SEATS) {
      const id = deck[cursor++]!;
      hands[seat]!.push(id);
      // The one departure from "hero always deals face up": a
      // blind-eligible hero's own hand stays hidden through the deal,
      // pending their look-or-go-blind choice. A no-op in the ordinary
      // case (handRevealed[HERO] is true whenever the hero isn't
      // currently trailing by 100+).
      events.push({ t: "deal", piece: id, to: seat, faceUp: seat === HERO ? handRevealed[HERO] : false });
    }
  }

  events.push({ t: "phase", phase: `round-${round}` });
  events.push({
    t: "announce",
    seat: leader,
    text: leader === HERO ? "Your bid" : `${botName(leader)} bids first`,
    tone: "info",
  });

  return {
    state: {
      ...state,
      round,
      dealer,
      phase: "bid",
      turn: leader,
      hands,
      handRevealed,
      blindEligible,
      bids: { 0: null, 1: null, 2: null, 3: null },
      exchange: null,
      trick: [],
      ledSuit: null,
      trumpBroken: false,
      leader,
      tricksWon: { 0: 0, 1: 0, 2: 0, 3: 0 },
      won: { 0: [], 1: [], 2: [], 3: [] },
      result: null,
      dealt: true,
    },
    events,
  };
}

/* ============================================================
   reduce
   ============================================================ */

export function reduce(state: SpadesState, action: SpadesAction): ReduceResult<SpadesState> {
  switch (action.t) {
    case "look":
      return reduceLook(state);
    case "bid":
      return reduceBid(state, { tricks: action.tricks, nil: action.nil, blind: false });
    case "blindNil":
      return reduceBid(state, { tricks: 0, nil: true, blind: true });
    case "blindBid":
      return reduceBid(state, { tricks: action.tricks, nil: false, blind: true });
    case "skipExchange":
      return reduceSkipExchange(state);
    case "exchangeGive":
      return reduceExchangeGive(state, action.cards);
    case "exchangeTake":
      return reduceExchangeTake(state, action.cards);
    case "play":
      return reducePlay(state, action.card);
  }
}

function reduceLook(state: SpadesState): ReduceResult<SpadesState> {
  const seat = currentSeat(state);
  if (seat === null) return { state, events: [] };
  const hand = state.hands[seat] ?? [];
  const events: GameEvent[] = hand.map((id) => ({ t: "flip", piece: id, faceUp: true }));
  return {
    state: { ...state, handRevealed: { ...state.handRevealed, [seat]: true } },
    events,
  };
}

function reduceBid(state: SpadesState, bid: Bid): ReduceResult<SpadesState> {
  const seat = currentSeat(state);
  if (seat === null) return { state, events: [] };

  const bids = { ...state.bids, [seat]: bid };
  const events: GameEvent[] = [];

  // A blind NUMERIC bid reveals the instant it's locked in — there is no
  // exchange mechanic for it, so nothing keeps the hand hidden any
  // longer than "before the bid was decided". Blind NIL is different:
  // it stays hidden through the post-bidding exchange (see reduceBid's
  // caller doc and reduceSkipExchange/reduceExchangeTake below).
  let handRevealed = state.handRevealed;
  if (bid.blind && !bid.nil) {
    handRevealed = { ...handRevealed, [seat]: true };
    for (const id of state.hands[seat] ?? []) events.push({ t: "flip", piece: id, faceUp: true });
  }

  if (seat !== HERO) {
    events.push({ t: "announce", seat, text: `${botName(seat)} bids ${describeBid(bid)}`, tone: "info" });
  }

  let next: SpadesState = { ...state, bids, handRevealed };

  const allBid = SEATS.every((s) => bids[s] != null);
  if (!allBid) {
    return { state: { ...next, turn: nextSeat(seat) }, events };
  }

  // All four bids are in. Per the rule, a pending Blind Nil exchange
  // happens now, before the first lead — `phase` stays "bid" through it;
  // reduceSkipExchange/reduceExchangeTake are what actually flip to "play".
  const blindNilSeat = SEATS.find((s) => {
    const b = bids[s];
    return b != null && b.nil && b.blind;
  });

  if (blindNilSeat !== undefined) {
    next = {
      ...next,
      turn: next.leader,
      exchange: { giver: blindNilSeat, taker: partnerOf(blindNilSeat), stage: "give" },
    };
  } else {
    next = { ...next, phase: "play", turn: next.leader };
    events.push(leadAnnounce(next.leader));
  }

  return { state: next, events };
}

function reduceSkipExchange(state: SpadesState): ReduceResult<SpadesState> {
  const ex = state.exchange;
  if (!ex) return { state, events: [] };
  const events: GameEvent[] = [];
  const handRevealed = { ...state.handRevealed, [ex.giver]: true };
  for (const id of state.hands[ex.giver] ?? []) events.push({ t: "flip", piece: id, faceUp: true });
  events.push(leadAnnounce(state.leader));
  return { state: { ...state, phase: "play", exchange: null, handRevealed }, events };
}

function reduceExchangeGive(state: SpadesState, cards: [PieceId, PieceId]): ReduceResult<SpadesState> {
  const ex = state.exchange;
  if (!ex || ex.stage !== "give") return { state, events: [] };
  const giverHand = (state.hands[ex.giver] ?? []).filter((id) => !cards.includes(id));
  const hands = { ...state.hands, [ex.giver]: giverHand };
  // Rendered face up in the discard zone once given — the taker (who is
  // always already able to see their own hand by this point, see the
  // file-top doc) needs to see what's on offer to choose what to send
  // back; a real table passes them as a face-down PACKET across to the
  // partner only in the sense that other opponents don't get to see them
  // first, not that the partner never does.
  const events: GameEvent[] = cards.map((id) => ({ t: "play", piece: id, from: ex.giver, to: "discard" }));
  return {
    state: { ...state, hands, exchange: { ...ex, stage: "take", given: cards } },
    events,
  };
}

function reduceExchangeTake(state: SpadesState, cards: [PieceId, PieceId]): ReduceResult<SpadesState> {
  const ex = state.exchange;
  if (!ex || ex.stage !== "take" || !ex.given) return { state, events: [] };
  const given = ex.given;
  const takerHand = [...(state.hands[ex.taker] ?? []).filter((id) => !cards.includes(id)), ...given];
  const giverHand = [...(state.hands[ex.giver] ?? []), ...cards];
  const hands = { ...state.hands, [ex.taker]: takerHand, [ex.giver]: giverHand };

  const events: GameEvent[] = [
    ...given.map((id) => ({ t: "draw" as const, piece: id, from: "discard" as const, to: ex.taker, faceUp: true })),
    // Still face down: the giver hasn't seen ANY of their hand yet, old
    // or new — the flip loop below reveals the whole 13-card hand as one
    // uniform moment, rather than these 2 popping face up a beat early.
    ...cards.map((id) => ({ t: "draw" as const, piece: id, from: "hand" as const, to: ex.giver, faceUp: false })),
  ];

  const handRevealed = { ...state.handRevealed, [ex.giver]: true };
  for (const id of giverHand) events.push({ t: "flip", piece: id, faceUp: true });
  events.push(leadAnnounce(state.leader));

  return { state: { ...state, phase: "play", hands, handRevealed, exchange: null }, events };
}

function reducePlay(state: SpadesState, card: PieceId): ReduceResult<SpadesState> {
  const seat = currentSeat(state);
  if (seat === null) return { state, events: [] };

  const hands = { ...state.hands, [seat]: (state.hands[seat] ?? []).filter((id) => id !== card) };
  const trick = [...state.trick, { seat, card }];
  const ledSuit = state.trick.length === 0 ? effectiveSuit(card) : state.ledSuit;
  // Any spade (or joker) appearing on the table breaks spades for future
  // leads — led OR sluffed, not led-only.
  const trumpBroken = state.trumpBroken || isTrump(card);

  const events: GameEvent[] = [{ t: "play", piece: card, from: seat, to: "trick" }];
  if (seat !== HERO) {
    events.push({ t: "announce", seat, text: `${botName(seat)} plays ${spadesCardLabel(card)}`, tone: "info" });
  }

  let next: SpadesState = { ...state, hands, trick, ledSuit, trumpBroken };

  if (trick.length < 4) {
    return { state: { ...next, turn: nextSeat(seat) }, events };
  }

  const winner = resolveTrick(
    trick.map((p) => ({
      seat: p.seat,
      card: { id: p.card, suit: effectiveSuit(p.card), isTrump: isTrump(p.card) },
    })),
    ledSuit,
    (id) => cardStrength(id, state.rules),
  );

  events.push({ t: "collect", pieces: trick.map((p) => p.card), to: winner });
  events.push({
    t: "announce",
    seat: winner,
    text: winner === HERO ? "You take the trick" : `${botName(winner)} takes the trick`,
    tone: winner === HERO ? "good" : "info",
  });

  const tricksWon = { ...state.tricksWon, [winner]: (state.tricksWon[winner] ?? 0) + 1 };
  const won = { ...state.won, [winner]: [...(state.won[winner] ?? []), ...trick.map((p) => p.card)] };
  next = { ...next, tricksWon, won, trick: [], ledSuit: null, leader: winner, turn: winner };

  const roundOver = SEATS.every((s) => (next.hands[s] ?? []).length === 0);
  if (!roundOver) return { state: next, events };

  return endRound(next, events);
}

/* ============================================================
   Round and match scoring
   ============================================================ */

function matchWinnerTeam(scores: Record<SeatId, number>, target: number, autoLoss: number): 0 | 1 | null {
  const t0 = scores[0] ?? 0;
  const t1 = scores[1] ?? 0;
  const t0Reached = t0 >= target;
  const t1Reached = t1 >= target;
  if (t0Reached || t1Reached) {
    // Both reaching target in the same deal is a near-impossible edge
    // case; the higher score wins, and an exact tie falls to team 0
    // arbitrarily but harmlessly.
    if (t0Reached && t1Reached) return t1 > t0 ? 1 : 0;
    return t0Reached ? 0 : 1;
  }
  if (t0 <= autoLoss) return 1;
  if (t1 <= autoLoss) return 0;
  return null;
}

function endRound(state: SpadesState, events: GameEvent[]): ReduceResult<SpadesState> {
  const bids: Record<SeatId, Bid> = {
    0: state.bids[0]!,
    1: state.bids[1]!,
    2: state.bids[2]!,
    3: state.bids[3]!,
  };
  const { deltas, bags, bagPenalty } = scoreRound(bids, state.tricksWon, state.bags);

  const scores: Record<SeatId, number> = {};
  const nilsAttempted = { ...state.nilsAttempted };
  const nilsMade = { ...state.nilsMade };
  for (const seat of SEATS) {
    scores[seat] = (state.scores[seat] ?? 0) + (deltas[seat] ?? 0);
    if (bids[seat]!.nil) {
      nilsAttempted[seat] = (nilsAttempted[seat] ?? 0) + 1;
      if ((state.tricksWon[seat] ?? 0) === 0) nilsMade[seat] = (nilsMade[seat] ?? 0) + 1;
    }
  }

  const result: RoundResult = { bids, tricksWon: { ...state.tricksWon }, deltas, bags, bagPenalty };
  events.push({ t: "score", deltas });
  events.push({ t: "roundEnd", round: state.round });

  const winningTeam = matchWinnerTeam(scores, state.target, state.autoLoss);
  let winningSeats: SeatId[] | null = null;
  let winner: SeatId | null = null;
  if (winningTeam !== null) {
    winningSeats = teammates(winningTeam);
    winner = winningSeats.includes(HERO) ? HERO : Math.min(...winningSeats);
    events.push({ t: "gameEnd", winner });
  }

  return {
    state: { ...state, scores, bags, nilsAttempted, nilsMade, result, winningSeats, winner },
    events,
  };
}

/* ============================================================
   GameDefinition surface
   ============================================================ */

export function currentSeat(state: SpadesState): SeatId | null {
  if (!state.dealt || state.result !== null || state.winner !== null) return null;
  if (state.exchange) {
    return state.exchange.stage === "give" ? state.exchange.giver : state.exchange.taker;
  }
  return state.turn;
}

export function isRoundOver(state: SpadesState): boolean {
  return state.result !== null;
}

export function isOver(state: SpadesState): boolean {
  return state.winner !== null;
}

export function legalActions(state: SpadesState, seat: SeatId): SpadesAction[] {
  if (currentSeat(state) !== seat) return [];

  if (state.exchange) {
    const ex = state.exchange;
    if (ex.stage === "give") {
      const hand = state.hands[ex.giver] ?? [];
      return [
        { t: "skipExchange" },
        ...combinations2(hand).map(([a, b]): SpadesAction => ({ t: "exchangeGive", cards: [a, b] })),
      ];
    }
    const hand = state.hands[ex.taker] ?? [];
    return combinations2(hand).map(([a, b]): SpadesAction => ({ t: "exchangeTake", cards: [a, b] }));
  }

  if (state.phase === "bid") {
    if (isHiddenFromSelf(state, seat)) {
      const out: SpadesAction[] = [{ t: "look" }];
      if (minLegalBid(state, seat) === 0) out.push({ t: "blindNil" });
      // A blind numeric bid's minimum of 6 is never blocked by the Board
      // rule (6 always exceeds minLegalBid's ceiling of 4), so every
      // number from 6 to 13 is always offered.
      for (let tricks = 6; tricks <= 13; tricks++) out.push({ t: "blindBid", tricks });
      return out;
    }
    const out: SpadesAction[] = [];
    const floor = minLegalBid(state, seat);
    if (floor === 0) out.push({ t: "bid", tricks: 0, nil: true });
    for (let tricks = Math.max(1, floor); tricks <= 13; tricks++) out.push({ t: "bid", tricks, nil: false });
    return out;
  }

  return legalPlays(state, seat).map((card): SpadesAction => ({ t: "play", card }));
}

export function pieces(state: SpadesState): Record<PieceId, PieceMeta> {
  const out: Record<PieceId, PieceMeta> = {};
  for (const id of spadesDeck(state.rules)) out[id] = { kind: "card", face: id };
  return out;
}

export function placements(state: SpadesState, viewer: SeatId): PlacementMap {
  const out: PlacementMap = {};

  const active = currentSeat(state);
  const legalCardIds =
    active === viewer && !state.exchange && state.phase === "play"
      ? new Set(legalPlays(state, viewer))
      : null;

  for (const seat of SEATS) {
    const hand = state.hands[seat] ?? [];
    const isViewerHand = seat === viewer;
    const faceUp = isViewerHand && Boolean(state.handRevealed[seat]);
    hand.forEach((id, i) => {
      out[id] = {
        zone: "hand",
        seat,
        index: i,
        count: hand.length,
        faceUp,
        dimmed: isViewerHand && legalCardIds && !legalCardIds.has(id) ? true : undefined,
      };
    });
  }

  state.trick.forEach((play, i) => {
    out[play.card] = { zone: "trick", seat: play.seat, index: i, count: state.trick.length, faceUp: true };
  });

  for (const seat of SEATS) {
    const wonCards = state.won[seat] ?? [];
    wonCards.forEach((id, i) => {
      out[id] = { zone: "collected", seat, index: i, count: wonCards.length, faceUp: false };
    });
  }

  if (state.exchange?.given) {
    const [a, b] = state.exchange.given;
    out[a] = { zone: "discard", index: 0, count: 2, faceUp: true, fanned: true };
    out[b] = { zone: "discard", index: 1, count: 2, faceUp: true, fanned: true };
  }

  return out;
}

/**
 * Everything except the viewer's own hand is face down on a real table.
 * The viewer's own hand redacts too, exactly like any other, WHILE it is
 * hidden from the viewer themself (`isHiddenFromSelf`) — this single
 * rule is what makes a bot's blind-vs-look decision honest for free:
 * `useGameRuntime.revealBotTurn` always calls this before `bot.choose`,
 * so a bot forced through this path literally cannot see its own cards
 * until it resolves that, with no extra bot-side discipline required.
 */
export function playerView(state: SpadesState, viewer: SeatId): SpadesState {
  const hands: Record<SeatId, PieceId[]> = { 0: [], 1: [], 2: [], 3: [] };
  for (const seat of SEATS) {
    const hand = state.hands[seat] ?? [];
    const visible = seat === viewer && !isHiddenFromSelf(state, seat);
    hands[seat] = visible ? hand : hand.map(() => HIDDEN_CARD);
  }
  return { ...state, hands };
}

export function createSpades(
  rules: SpadesRules = { jokers: false, twoOfSpadesHigh: false },
): GameDefinition<SpadesState, SpadesAction> {
  return {
    id: "spades",
    name: "Spades",
    minSeats: MIN_SEATS,
    maxSeats: MAX_SEATS,
    setup: makeSetup(rules),
    reduce,
    legalActions,
    pieces,
    placements,
    playerView,
    currentSeat,
    isOver,
    startRound,
    isRoundOver,
    bots: spadesBots,
  };
}

export const spades = createSpades();

// Re-exported so callers do not have to reach into three modules to ask
// simple questions about a position. `HIDDEN_CARD` stays internal — only
// `playerView` needs it. The play screen defines its own local
// `seatName` from `botName` directly, matching Dominoes' page.tsx.
export { isBlindEligible, isHiddenFromSelf, legalPlays, minLegalBid, partnerOf, teamOf, teammates };
