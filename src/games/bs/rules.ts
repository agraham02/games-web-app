/**
 * BS (Cheat, I Doubt It).
 *
 * Play 1-4 cards face down, claim them as the rank the cycle has reached,
 * and lie as much as you like. Anybody else may call BS, which turns the
 * cards over: a lie sends the whole pile to the liar, a true claim sends
 * it to whoever doubted it. Empty your hand and the round is yours.
 *
 * The one thing to read the rest of this file with in mind: the challenge
 * is a RACE, and this game runs one after every single play. That means
 * three things a game with a single actor per beat never has to think
 * about, all of them already provided for:
 *
 *  - `legalActions` is the turn gate, not `currentSeat`. Several seats are
 *    entitled at once; `currentSeat` only names the one PACING waits on.
 *  - `deadline` is how a table parked on several seats keeps moving. A
 *    client-side timer cannot be the mechanism, because a backgrounded tab
 *    has its timers throttled to about one a minute.
 *  - `turnHold` is how the answers of the seats nobody is sitting in stay
 *    a flicker rather than three seconds of blank table each.
 */

import type { Rng } from "@/engine/rng";
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
import { shuffledDeck, standardDeck } from "@/games/_shared/cards";
import { countWord, handDisplayOrder, nextRank, rankOf, rankPlural } from "./cards";
import {
  CHALLENGE_GRACE_MS,
  CHALLENGE_MS_SOLO,
  DECK_SIZE,
  DEFAULT_TARGET,
  MAX_PER_PLAY,
  MAX_SEATS,
  MIN_SEATS,
  NO_PROGRESS_LIMIT,
  REVEAL_HOLD_MS,
  TAKE_BEAT_MS,
  WINDOW_BEAT_MS,
  challengeReactions,
  entitledToCall,
  handTotalOf,
  nextSeat,
  pileCardsOf,
} from "./state";
import type { BsAction, BsState, PilePlay, Reveal, RoundResult } from "./types";
import { bsBots } from "./bots";

export interface BsRules {
  /** Round wins needed to take the match. */
  target: number;
  /** How long a person gets to answer a challenge window, in ms. */
  windowMs: number;
}

export const DEFAULT_RULES: BsRules = {
  target: DEFAULT_TARGET,
  windowMs: CHALLENGE_MS_SOLO,
};

/** The one placeholder `playerView` collapses a concealed card to. */
const HIDDEN_CARD: PieceId = "??";

const ALL_IDS: PieceId[] = standardDeck().map((c) => c.id);

/* ------------------------------------------------------------------ setup */

function makeSetup(rules: BsRules) {
  return ({ seats, rng }: SetupOptions): BsState => {
    const clamped = Math.min(MAX_SEATS, Math.max(MIN_SEATS, seats));
    const hands: Record<SeatId, PieceId[]> = {};
    const scores: Record<SeatId, number> = {};
    for (let s = 0; s < clamped; s++) {
      hands[s as SeatId] = [];
      scores[s as SeatId] = 0;
    }
    // Undealt on purpose. `startRound` does the dealing, which is what
    // makes an opening deal an ANIMATION rather than a hand that is simply
    // already there — and `placements` parks the whole deck on the pile
    // until then, so every `deal` event has a stack to fly out of. Poker
    // is the one game that skipped this and its first deal has nothing to
    // come from, offline or on.
    return {
      seats: clamped,
      target: Math.max(1, Math.round(rules.target)),
      windowMs: Math.max(1000, Math.round(rules.windowMs)),
      // Zero, because `startRound` owns the counter — it increments on
      // every deal, so round one is the first deal rather than a state
      // anybody is ever shown.
      round: 0,
      dealer: rng.int(clamped) as SeatId,
      turn: 0,
      dealt: false,
      rank: "A",
      hands,
      plays: [],
      window: null,
      reveal: null,
      pendingTake: null,
      scores,
      handTotalFloor: DECK_SIZE,
      noProgressStreak: 0,
      result: null,
      winner: null,
    };
  };
}

export function startRound(state: BsState, rng: Rng): ReduceResult<BsState> {
  const round = state.round + 1;
  // Round one keeps setup's random dealer; after that the deal rotates.
  const dealer = round === 1 ? state.dealer : nextSeat(state.seats, state.dealer);

  const hands: Record<SeatId, PieceId[]> = {};
  for (let s = 0; s < state.seats; s++) hands[s as SeatId] = [];

  // Everything still out from the round that just ended goes back to the
  // pile first, as ONE gesture rather than a card at a time — otherwise the
  // deal that follows flies out of the losing hands it is replacing, which
  // reads as cards changing owners rather than as a fresh shuffle. Empty on
  // the very first deal, where `placements` has already parked the whole
  // deck there.
  const leftover = [...Object.values(state.hands).flat(), ...pileCardsOf(state.plays)];
  const events: GameEvent[] =
    leftover.length > 0 ? [{ t: "sweep", pieces: leftover, to: "pile" }] : [];
  events.push({ t: "shuffle", seed: rng.seed });

  // The whole deck, round-robin from the dealer's left. It does not divide
  // evenly for 3, 5 or 6 seats, and that is simply how BS is dealt: the
  // early seats get one more card than the late ones.
  let seat = nextSeat(state.seats, dealer);
  for (const card of shuffledDeck(rng)) {
    hands[seat]!.push(card.id);
    // `faceUp` is corrected per viewer against `placements` by
    // `projectEvents`, so one value here is right for everybody.
    events.push({ t: "deal", piece: card.id, to: seat, faceUp: false });
    seat = nextSeat(state.seats, seat);
  }

  return {
    state: {
      ...state,
      round,
      dealer,
      dealt: true,
      hands,
      plays: [],
      window: null,
      reveal: null,
      pendingTake: null,
      rank: "A",
      turn: nextSeat(state.seats, dealer),
      handTotalFloor: DECK_SIZE,
      noProgressStreak: 0,
      result: null,
    },
    events,
  };
}

/* ----------------------------------------------------------------- reduce */

export function reduce(state: BsState, action: BsAction): ReduceResult<BsState> {
  switch (action.t) {
    case "play":
      return reducePlay(state, action.cards);
    case "callBs":
      return reduceCall(state, action.seat);
    case "declineBs":
      return reduceDecline(state, action.seat);
    case "takePile":
      return reduceTake(state, action.seat);
  }
}

function reducePlay(state: BsState, cards: readonly PieceId[]): ReduceResult<BsState> {
  // `validate` refuses a play into an open window; see `legalActions`.
  if (state.window !== null) return { state, events: [{ t: "pause" }] };
  const seat = state.turn;
  const hand = state.hands[seat] ?? [];
  const held = new Set(hand);
  const playing = cards.filter((id) => held.has(id)).slice(0, MAX_PER_PLAY);
  // `validate` refuses everything this would catch, so reaching here means
  // an internal caller got it wrong. A `pause` rather than an empty batch,
  // because a driver paced off animation still needs something to settle.
  if (playing.length === 0) return { state, events: [{ t: "pause" }] };

  const claimed = state.rank;
  const play: PilePlay = { seat, claimed, cards: playing };
  const plays = [...state.plays, play];
  const gone = new Set(playing);
  const hands = { ...state.hands, [seat]: hand.filter((id) => !gone.has(id)) };

  const total = handTotalOf(hands, state.seats);
  const progressed = total < state.handTotalFloor;

  const events: GameEvent[] = [
    {
      t: "announce",
      actor: seat,
      text: "claims " + countWord(playing.length) + " " + rankPlural(claimed),
      selfText: "claim " + countWord(playing.length) + " " + rankPlural(claimed),
      tone: "info",
    },
  ];

  // No slam on a play. It is Dominoes' flourish, and the user wants it to
  // stay that game's alone (2026-09-25); BS keeps one, for a caught liar
  // (see `reduceTake`).

  for (const id of playing) {
    // Face down: the whole game is that nobody may see what was put in.
    events.push({ t: "play", piece: id, from: seat, to: "pile", faceUp: false });
  }

  const next: BsState = {
    ...state,
    hands,
    plays,
    // The cycle advances on every play, challenged or not: a rank consumed
    // by a lie is still consumed.
    rank: nextRank(claimed),
    // Advanced now, so a challenge is an interruption rather than a reset —
    // whoever was next to play is still next to play afterwards.
    turn: nextSeat(state.seats, seat),
    window: {
      play: plays.length - 1,
      pending: challengeReactions(state, seat, play, plays.length - 1),
    },
    reveal: null,
    pendingTake: null,
    handTotalFloor: Math.min(state.handTotalFloor, total),
    noProgressStreak: progressed ? 0 : state.noProgressStreak + 1,
  };

  // A one-seat table cannot happen (`MIN_SEATS`), so an empty window here
  // would be a bug — closing it immediately is the safe reading, rather
  // than parking the table on nobody forever.
  if (next.window!.pending.length === 0) {
    const closed = closeWindow({ ...next, window: null });
    return { state: closed.state, events: [...events, ...closed.events] };
  }
  return { state: next, events };
}

function reduceCall(state: BsState, caller: SeatId): ReduceResult<BsState> {
  const window = state.window;
  const play = window ? state.plays[window.play] : undefined;
  if (!window || !play) return { state, events: [{ t: "pause" }] };

  // The one comparison in this game that decides money. Through `rankOf`
  // rather than `parseCard` directly, because `parseCard` does not reject a
  // redacted stand-in — it reads "??" as rank "?" — and a verdict is not the
  // place to find that out.
  const truthful = play.cards.every((id) => rankOf(id) === play.claimed);
  const loser = truthful ? caller : play.seat;
  const reveal: Reveal = {
    cards: play.cards,
    claimed: play.claimed,
    caller,
    claimer: play.seat,
    truthful,
    loser,
    pile: pileCardsOf(state.plays).length,
  };

  const events: GameEvent[] = [
    { t: "announce", actor: caller, text: "called BS", selfText: "called BS", tone: "info" },
  ];
  // Off the top of the pile and face up in a row, so all of them are
  // legible at once. A real `move` rather than a flip in place: the lift is
  // the gesture, and the row is the only place four cards do not overlap.
  play.cards.forEach((id, index) => {
    events.push({
      t: "move",
      piece: id,
      to: { zone: "reveal", index, count: play.cards.length, faceUp: true },
    });
  });
  events.push({ t: "pause" });
  events.push({
    t: "announce",
    actor: loser,
    text: truthful ? "called it wrong" : "was bluffing",
    selfText: truthful ? "called it wrong" : "were bluffing",
    tone: "info",
    selfTone: "bad",
  });

  return { state: { ...state, window: null, reveal, pendingTake: loser }, events };
}

function reduceDecline(state: BsState, seat: SeatId): ReduceResult<BsState> {
  const window = state.window;
  if (!window) return { state, events: [] };

  const pending = window.pending.filter((p) => p.seat !== seat);
  if (pending.length > 0) {
    // Deliberately no events. Letting a play go looks like nothing because
    // it IS nothing; the seat's pod lit as its turn came round and that is
    // the whole of what there is to show. Both drivers handle an empty
    // batch.
    const answered = window.pending.find((p) => p.seat === seat)?.ms ?? 0;
    const elapsed = Math.max(window.elapsed ?? 0, answered);
    return { state: { ...state, window: { ...window, pending, elapsed } }, events: [] };
  }
  return closeWindow({ ...state, window: null });
}

function reduceTake(state: BsState, seat: SeatId): ReduceResult<BsState> {
  if (state.pendingTake === null || state.pendingTake !== seat) {
    return { state, events: [] };
  }

  const pile = pileCardsOf(state.plays);
  const hands = { ...state.hands, [seat]: [...(state.hands[seat] ?? []), ...pile] };

  const events: GameEvent[] = [];
  if (state.reveal && !state.reveal.truthful) {
    // A caught liar gets the table's reaction: the one slam BS keeps, by
    // the user's choice (2026-09-25). `final: false` keeps it short,
    // because `collect` brings its own 900ms hold in right behind.
    events.push({ t: "slam", piece: state.reveal.cards[0]!, shake: [], final: false });
  }
  events.push({ t: "collect", pieces: pile, to: seat });

  // `reveal` goes with `pendingTake`, and forgetting it was a real leak.
  //
  // A reveal is public only WHILE the cards are face up in the middle of the
  // table, which is exactly the span `pendingTake` marks. The moment they are
  // swept into somebody's hand they are hidden again - and `placements` knew
  // that (it gates on `pendingTake`), so the table drew them face down while
  // `playerView` went on shipping `state.reveal.cards` under their real ids.
  // Everyone at the table could therefore name up to four cards in a named
  // opponent's hand after every resolved challenge.
  //
  // The blunt rule has no exceptions: a piece the viewer may not SEE is a
  // piece whose identity they do not get.
  const base: BsState = { ...state, hands, plays: [], pendingTake: null, reveal: null };

  // The only way a hand is empty here is a call that FAILED against a
  // player who had just put their last cards down: they were telling the
  // truth, the doubter swallowed the pile, and the round is theirs.
  const claimer = state.reveal?.claimer;
  if (claimer !== undefined && (hands[claimer] ?? []).length === 0) {
    return endRound(base, claimer, false, events);
  }
  if (base.noProgressStreak >= NO_PROGRESS_LIMIT) {
    return endRound(base, null, true, events);
  }
  return { state: base, events };
}

/** Nobody doubted it. The play stands, and may have won the round. */
function closeWindow(state: BsState): ReduceResult<BsState> {
  const last = state.plays[state.plays.length - 1];
  if (last && (state.hands[last.seat] ?? []).length === 0) {
    return endRound(state, last.seat, false);
  }
  if (state.noProgressStreak >= NO_PROGRESS_LIMIT) {
    return endRound(state, null, true);
  }
  return { state, events: [] };
}

function endRound(
  state: BsState,
  wentOut: SeatId | null,
  blocked: boolean,
  before: GameEvent[] = [],
): ReduceResult<BsState> {
  const cardsLeft: Record<SeatId, number> = {};
  for (let s = 0; s < state.seats; s++) {
    cardsLeft[s as SeatId] = (state.hands[s as SeatId] ?? []).length;
  }

  const winner = wentOut ?? fewestCards(cardsLeft, state.seats);
  const deltas: Record<SeatId, number> = {};
  for (let s = 0; s < state.seats; s++) deltas[s as SeatId] = s === winner ? 1 : 0;

  const scores = { ...state.scores };
  scores[winner] = (scores[winner] ?? 0) + 1;

  const result: RoundResult = { deltas, cardsLeft, wentOut, blocked, winner };
  const matchWinner = (scores[winner] ?? 0) >= state.target ? winner : null;

  const events: GameEvent[] = [
    ...before,
    {
      t: "announce",
      actor: winner,
      text: blocked ? "had the fewest cards left" : "went out",
      selfText: blocked ? "had the fewest cards left" : "went out",
      tone: "info",
      selfTone: "good",
    },
    { t: "score", deltas },
    { t: "roundEnd", round: state.round },
  ];
  if (matchWinner !== null) events.push({ t: "gameEnd", winner: matchWinner });

  return {
    state: { ...state, window: null, pendingTake: null, result, scores, winner: matchWinner },
    events,
  };
}

function fewestCards(cardsLeft: Record<SeatId, number>, seats: number): SeatId {
  let best: SeatId = 0;
  for (let s = 1; s < seats; s++) {
    const seat = s as SeatId;
    if ((cardsLeft[seat] ?? 0) < (cardsLeft[best] ?? 0)) best = seat;
  }
  return best;
}


/* ------------------------------------------------------------------ turns */

export function currentSeat(state: BsState): SeatId | null {
  if (state.winner !== null) return null;
  if (state.result !== null) return null;
  if (!state.dealt) return null;
  // The verdict is in and somebody has to pick the pile up before anything
  // else can happen. Parked on that seat whoever is in it, rather than
  // resolved inline for "the bots" — see `types.ts`.
  if (state.pendingTake !== null) return state.pendingTake;
  // During a window this names the soonest reactor, which is who the
  // PACING waits on. It is NOT the only seat allowed to act: see
  // `legalActions`.
  if (state.window) return state.window.pending[0]?.seat ?? null;
  return state.turn;
}

export function isRoundOver(state: BsState): boolean {
  return state.result !== null;
}

export function isOver(state: BsState): boolean {
  return state.winner !== null;
}

export function legalActions(state: BsState, seat: SeatId): BsAction[] {
  if (state.winner !== null || state.result !== null || !state.dealt) return [];

  if (state.pendingTake !== null) {
    return state.pendingTake === seat ? [{ t: "takePile", seat }] : [];
  }

  const out: BsAction[] = [];
  if (entitledToCall(state, seat)) {
    out.push({ t: "callBs", seat }, { t: "declineBs", seat });
  }

  // Nobody plays while a window is open. The user's rule (2026-09-25):
  // while a play is open to challenge, the only things anyone may do are
  // call BS or let it go. The seat on turn used to
  // be allowed to play over the top of an open window, and in a playtest
  // that read as somebody playing while the buttons were still up.
  if (seat === state.turn && state.window === null) {
    const hand = state.hands[seat] ?? [];
    const most = Math.min(MAX_PER_PLAY, hand.length);
    // ONE representative per count, not every subset. See `validate`.
    for (let n = 1; n <= most; n++) out.push({ t: "play", cards: hand.slice(0, n) });
  }
  return out;
}

/**
 * The second gate. `legalActions` answers WHO may act; this answers
 * whether what arrived is something they may do.
 *
 * Hand-rolled rather than `validateByEnumeration`, for exactly the reason
 * poker's is: a play is any 1-to-4 card subset of a hand — 1,092 of them
 * for thirteen cards — so `legalActions` publishes one representative per
 * count, and set membership would refuse every play but those four. The
 * SHAPE of a legal play is the thing to check, not its presence in a list.
 *
 * Everything below is reachable from a socket by a player whose turn it
 * genuinely is: five cards at once, a card sitting in somebody else's hand
 * (ids are suit+rank and entirely guessable), the same card named twice to
 * claim a pair it does not hold, or a bare string where an array belongs.
 */
export function validate(state: BsState, seat: SeatId, action: BsAction): string | null {
  // The action is arbitrary JSON off a socket, and the wire hands `action`
  // through untouched - so `{"t":"action"}` arrives here as `undefined` and
  // `switch (action.t)` throws. A TypeError out of `validate` is caught far
  // upstream by the router, which turns it into a generic `bad-message` and
  // a log line per attempt: the one exception path a seated player can walk
  // at will. Poker guards this; BS did not.
  if (!action || typeof action !== "object") return "that is not an action";

  if (state.winner !== null) return "the match is over";
  if (state.result !== null) return "the round is over";
  if (!state.dealt) return "the round has not been dealt";

  switch (action.t) {
    case "takePile":
      if (state.pendingTake !== seat) return "no pile is waiting on this seat";
      return null;

    case "callBs":
    case "declineBs":
      if (state.pendingTake !== null) return "that challenge is already resolved";
      if (!entitledToCall(state, seat)) return "this seat is not in the challenge window";
      return null;

    case "play": {
      if (state.pendingTake !== null) return "the pile has not been picked up yet";
      if (seat !== state.turn) return "not this seat's turn to play";
      if (state.window !== null) return "the last play can still be challenged";
      const cards: unknown = action.cards;
      if (!Array.isArray(cards)) return "cards must be an array";
      if (cards.length < 1 || cards.length > MAX_PER_PLAY) {
        return "a play is 1 to " + MAX_PER_PLAY + " cards";
      }
      if (cards.some((id) => typeof id !== "string")) return "card ids must be strings";
      if (new Set(cards).size !== cards.length) return "the same card twice";
      const hand = new Set(state.hands[seat] ?? []);
      if (cards.some((id) => !hand.has(id as PieceId))) {
        return "a card this seat does not hold";
      }
      return null;
    }

    default:
      return "unknown action";
  }
}

/**
 * A seat that does not answer. Both cases act FOR the player rather than
 * against them: silence on a window means you let it go, and nobody has a
 * decision to make about picking up a pile they have already lost.
 */
export function deadline(
  state: BsState,
  seat: SeatId,
): { ms: number; action: BsAction; key?: string } | null {
  if (state.pendingTake === seat) {
    return { ms: REVEAL_HOLD_MS, action: { t: "takePile", seat } };
  }
  if (entitledToCall(state, seat)) {
    return {
      ms: state.windowMs + CHALLENGE_GRACE_MS,
      action: { t: "declineBs", seat },
      // This seat's turn at this window, counted from when it began.
      //
      // Per SEAT as well as per window, deliberately: a seat's wait is
      // not capped by the seats ahead of it in the queue, because by the
      // time you are asked they have already had their own turn (see
      // `ChallengeWindow.pending`). What the key stops is the same seat's
      // own wait being handed back to it - a deadline is re-armed on
      // every settle, so a reconnect, or any frame that arrives while you
      // are the one being waited on, used to start your ten seconds over.
      // Refreshing was a free extension.
      key: `${state.round}:${state.plays.length}:${seat}`,
    };
  }
  return null;
}

/**
 * See `GameDefinition.turnHold`, and `WINDOW_BEAT_MS` for the numbers.
 *
 * In a window, a bot waits out the rest of its reaction time here, BEFORE
 * it answers. It used to answer after `WINDOW_BEAT_MS` and spend its
 * reaction time as a `think` inside its own frame, which plays after the
 * answer is made: a call was already in on the server while its pod still
 * looked like it was deciding, and a person pressing BS in that gap lost.
 * Rummy's claim race had the same flaw (online-games-debug.md).
 */
export function turnHold(state: BsState, seat?: SeatId): number | undefined {
  if (state.pendingTake !== null) return TAKE_BEAT_MS;
  if (state.window !== null) {
    const mine = state.window.pending.find((p) => p.seat === seat);
    if (!mine) return WINDOW_BEAT_MS;
    // Never less than the beat, so each seat's pod still lights on its own.
    return Math.max(WINDOW_BEAT_MS, mine.ms - (state.window.elapsed ?? 0));
  }
  return undefined;
}

/**
 * Stamps the acting seat onto the three actions that name one. A call on a
 * window cannot be identified by whose turn it is, because a window is
 * several seats' turn at once — so the seat the session knows submitted
 * replaces whatever the client said, and a spoofed one calls for the
 * spoofer or not at all.
 */
export function completeAction(state: BsState, action: BsAction, seat: SeatId): BsAction {
  if (action.t === "play") return action;
  return { ...action, seat };
}

/* ------------------------------------------------------------------ table */

export function pieces(): Record<PieceId, PieceMeta> {
  const out: Record<PieceId, PieceMeta> = {};
  for (const card of standardDeck()) out[card.id] = { kind: "card", face: card.id };
  return out;
}

export function placements(state: BsState, viewer: SeatId): PlacementMap {
  const out: PlacementMap = {};

  // Face up only to its owner — and `viewer` is -1 for a spectator, so a
  // watched table shows no hand at all, which is correct and is the one
  // case worth checking by eye rather than only by unit test.
  for (let s = 0; s < state.seats; s++) {
    const seat = s as SeatId;
    const hand = state.hands[seat] ?? [];
    const own = seat === viewer;
    const ordered = own ? handDisplayOrder(hand) : hand;
    ordered.forEach((id, index) => {
      out[id] = {
        zone: "hand",
        seat,
        index,
        count: ordered.length,
        faceUp: own,
        fanned: own,
      };
    });
  }

  // Face up to EVERYBODY while the verdict is on screen. This is what makes
  // a reveal work at all: `placements` is the authority for facing, so if
  // the settled position said these were face down the redaction layer
  // would quite correctly send them out as anonymous backs and a challenge
  // would turn over four blank cards.
  const revealing = state.reveal !== null && state.pendingTake !== null;
  const revealed = revealing ? state.reveal!.cards : [];
  const revealedSet = new Set(revealed);
  revealed.forEach((id, index) => {
    out[id] = { zone: "reveal", index, count: revealed.length, faceUp: true };
  });

  // The pile, with the live play marked so it steps clear of the stack
  // instead of vanishing into it. Everything still undealt goes on the same
  // stack — that is the pile a `deal` event needs to fly OUT of — and the
  // two are never both non-empty, since nothing is undealt once a round has
  // started, so they share one index run without fighting over it.
  const live = state.window ? state.plays[state.window.play] : undefined;
  const liveSet = new Set(live?.cards ?? []);
  const onPile = pileCardsOf(state.plays).filter((id) => !revealedSet.has(id));
  const placed = new Set([...Object.keys(out), ...onPile]);
  const stack = [...ALL_IDS.filter((id) => !placed.has(id)), ...onPile];
  stack.forEach((id, index) => {
    out[id] = {
      zone: "pile",
      index,
      count: stack.length,
      faceUp: false,
      highlighted: liveSet.has(id) ? true : undefined,
    };
  });

  return out;
}

/**
 * What one seat is allowed to KNOW, as distinct from what `placements`
 * lets them see.
 *
 * Two collections have to be stripped here, not one. Other hands are the
 * obvious half. The pile is the half easy to miss and worth far more: it is
 * a list of every card played so far, in order, so shipping it intact would
 * hand a client the answer to every claim still standing. That is the same
 * leak poker had with `deck` and Rummy with `stock`, both unnoticed because
 * single-player never sends a view anywhere.
 *
 * The pile goes in full, INCLUDING the viewer's own contributions. Letting a
 * player keep the identities of cards they put in themselves is safe in the
 * narrow sense — they already know them, and it can never tell them anything
 * about anybody else — but the rule here is deliberately blunt on purpose:
 * a piece that is face down is a piece whose identity the viewer does not
 * get, with no per-game exceptions, because a subtle rule is one that
 * eventually gets got wrong. `redact.test.ts` enforces exactly that and
 * caught this on the first run.
 *
 * It costs nothing real either way. What is worth remembering about the pile
 * is how much of it is yours, and that is a COUNT — derivable from the claim
 * history, which is public because it was announced out loud.
 *
 * What survives: every play's seat, claimed rank and size, and whatever a
 * challenge has already turned face up for the whole table.
 */
export function playerView(state: BsState, viewer: SeatId): BsState {
  const hands: Record<SeatId, PieceId[]> = {};
  for (let s = 0; s < state.seats; s++) {
    const seat = s as SeatId;
    const hand = state.hands[seat] ?? [];
    hands[seat] = seat === viewer ? [...hand] : hand.map(() => HIDDEN_CARD);
  }

  const revealing = state.reveal !== null && state.pendingTake !== null;
  const revealed = new Set(revealing ? state.reveal!.cards : []);
  const plays = state.plays.map((play) => ({
    ...play,
    cards: play.cards.map((id) => (revealed.has(id) ? id : HIDDEN_CARD)),
  }));

  return { ...state, hands, plays };
}

/* ----------------------------------------------------------------- exports */

export function createBs(rules: Partial<BsRules> = {}): GameDefinition<BsState, BsAction> {
  const resolved: BsRules = { ...DEFAULT_RULES, ...rules };
  return {
    id: "bs",
    name: "BS",
    minSeats: MIN_SEATS,
    maxSeats: MAX_SEATS,
    setup: makeSetup(resolved),
    reduce,
    legalActions,
    validate,
    completeAction,
    deadline,
    turnHold,
    pieces,
    placements,
    playerView,
    currentSeat,
    isOver,
    startRound,
    isRoundOver,
    bots: bsBots,
  };
}

export const bs = createBs();

// Re-exported so a caller does not have to reach into two modules to ask
// simple questions about a position.
export {
  MAX_PER_PLAY,
  challengeDeadlineMs,
  entitledToCall,
  inChallengeWindow,
  livePlay,
  nearestRivalCount,
  pileCardsOf,
  pileSize,
} from "./state";
export { HIDDEN_CARD };
