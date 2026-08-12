/**
 * Dominoes (Block & Draw) — GameDefinition.
 *
 * Rules verified against pagat.com's Draw and Block game pages before
 * writing this. The details worth knowing, because most casual sources
 * get them wrong:
 *
 *  - Hands are 7/7/6 for 2/3/4 players from a double-six set.
 *  - **The last two boneyard tiles are never drawn.** A player who
 *    cannot play draws until they can or until the boneyard is down to
 *    two, and only then passes. This is also what caps the line at 26
 *    tiles, which the board layout is sized for.
 *  - Scoring is ONE formula for both endings: the winner takes the
 *    losers' pips minus their own. Going out just makes their own zero.
 *  - A blocked round goes to the lowest pip count; tied, to the lightest
 *    single tile; still tied, nobody scores.
 *  - Doubles are laid crosswise and are NOT spinners — the line never
 *    branches, which is what keeps it a two-ended chain.
 *
 * One deliberate departure: pagat permits drawing while you still hold a
 * playable tile. We do not. It makes the hero's Draw button mean exactly
 * one thing ("I am stuck"), and it removes a decision that is nearly
 * always wrong to take anyway.
 *
 * Where the tiles physically GO is board.ts — this file only decides
 * what is legal and what it scores.
 */

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
import { HERO } from "@/engine/types";
import type { Rng } from "@/engine/rng";
import { botName } from "@/games/_shared/botIdentity";
import { doubleSixSet } from "@/games/_shared/tiles";
import { initialArms, placeTile } from "./board";
import { dominoBots } from "./bots";
import {
  BONEYARD_FLOOR,
  HIDDEN_TILE,
  canPlay,
  defaultTarget,
  drawableTiles,
  handSize,
  nextSeat,
  openingSeat,
  playableEnds,
  playableTiles,
  pipsInHand,
  lightestTile,
} from "./state";
import type { ChainEnd, DomAction, DomState, PlacedTile } from "./types";

export const MIN_SEATS = 2;
export const MAX_SEATS = 4;

function seatName(seat: SeatId): string {
  return seat === HERO ? "You" : botName(seat);
}

/* ============================================================
   Setup and dealing
   ============================================================ */

/**
 * Returns an UNDEALT round: every tile still in the boneyard. The deal
 * itself is `startRound`'s job, which is what makes it animate — `setup`
 * can only return state, so a game that deals here has its tiles simply
 * appear on the table.
 */
export function makeSetup(target?: number) {
  return function setup(opts: SetupOptions): DomState {
    const scores: Record<SeatId, number> = {};
    const hands: Record<SeatId, PieceId[]> = {};
    for (let seat = 0; seat < opts.seats; seat++) {
      scores[seat] = 0;
      hands[seat] = [];
    }
    return {
      seats: opts.seats,
      target: target ?? defaultTarget(opts.seats),
      round: 0,
      scores,
      hands,
      boneyard: doubleSixSet(),
      chain: [],
      arms: initialArms(),
      turn: HERO,
      passes: 0,
      opener: HERO,
      result: null,
      winner: null,
      dealt: false,
    };
  };
}

export function startRound(state: DomState, rng: Rng): ReduceResult<DomState> {
  const tiles = rng.shuffle(doubleSixSet());
  const per = handSize(state.seats);
  const hands: Record<SeatId, PieceId[]> = {};
  for (let seat = 0; seat < state.seats; seat++) hands[seat] = [];

  // Round 2+ inherits a full chain AND every seat's leftover hand from
  // the round that just ended — `endRound` clears neither, since the
  // ROUND summary still needs the board visible exactly as it finished.
  // A "domino" round leaves other seats holding real hands; a "blocked"
  // round leaves EVERY seat holding one. Sweeping only the chain (the
  // first version of this) left those hand tiles untouched by any
  // event — with nothing moving them, they either sat on screen still
  // "in" a hand that no longer existed until the final reconcile popped
  // them without warning, or — worse — happened to be redealt to
  // somewhere and so played a full, ordinary DEAL flight, reading as
  // "it's taking tiles out of my hand" for what should have been an
  // instant, unremarkable gather.
  //
  // One `sweep` event, not one `move` per tile: this is a single
  // gesture — gather everything face down — not a series of individual
  // placements, and `sweep`'s own choreography (see presets.ts) is
  // built to stay fast regardless of how many tiles are in it, entirely
  // independent of `deal`'s pace right after it. `chain: []` and fresh
  // `hands` in the returned state below are what make it permanent;
  // this event is only what SHOWS that happening. A no-op on round 1:
  // both are already empty.
  const leftover = [
    ...state.chain.map((tile) => tile.id),
    ...Object.values(state.hands).flat(),
  ];
  const events: GameEvent[] =
    leftover.length > 0 ? [{ t: "sweep", pieces: leftover, to: "boneyard" }] : [];
  events.push({ t: "shuffle", seed: rng.seed });

  // Dealt round by round rather than hand by hand, so the deal reads as
  // one going round the table instead of four separate handfuls.
  let cursor = 0;
  for (let i = 0; i < per; i++) {
    for (let seat = 0; seat < state.seats; seat++) {
      const id = tiles[cursor++]!;
      hands[seat]!.push(id);
      events.push({ t: "deal", piece: id, to: seat, faceUp: seat === HERO });
    }
  }

  const round = state.round + 1;
  // Round one is decided by the tiles; after that the previous winner
  // leads, which `state.opener` already holds.
  const opener = round === 1 ? openingSeat(hands, state.seats) : state.opener;

  events.push({ t: "phase", phase: `round-${round}` });
  events.push({
    t: "announce",
    seat: opener,
    text: opener === HERO ? "You lead" : `${botName(opener)} leads`,
    tone: "info",
  });

  return {
    state: {
      ...state,
      round,
      hands,
      boneyard: tiles.slice(cursor),
      chain: [],
      arms: initialArms(),
      turn: opener,
      passes: 0,
      opener,
      result: null,
      dealt: true,
    },
    events,
  };
}

/* ============================================================
   reduce
   ============================================================ */

export function reduce(state: DomState, action: DomAction): ReduceResult<DomState> {
  const seat = state.turn;
  const events: GameEvent[] = [];

  // "Draw until you can play, or until the boneyard is down to two, and
  // only THEN pass" is one rule, so an action that would dig past the
  // floor resolves to the pass it should have been rather than stalling
  // the turn. Nothing legal ever reaches this — `legalActions` and every
  // bot check the floor first — but a turn that silently produced no
  // events would hang the runtime, which is a bad way to find out.
  if (action.t === "draw" && drawableTiles(state) <= 0) {
    return reduce(state, { t: "pass" });
  }

  if (action.t === "draw") {
    const id = state.boneyard[0]!;
    const hands = { ...state.hands, [seat]: [...(state.hands[seat] ?? []), id] };
    events.push({
      t: "draw",
      piece: id,
      from: "boneyard",
      to: seat,
      faceUp: seat === HERO,
    });
    if (seat !== HERO) {
      events.push({ t: "announce", seat, text: `${botName(seat)} draws`, tone: "info" });
    }
    // The turn does not move — they still have to play or draw again.
    return {
      state: { ...state, hands, boneyard: state.boneyard.slice(1), passes: 0 },
      events,
    };
  }

  if (action.t === "pass") {
    const passes = state.passes + 1;
    events.push({
      t: "announce",
      seat,
      text: `${seatName(seat)} ${seat === HERO ? "pass" : "passes"}`,
      tone: seat === HERO ? "bad" : "info",
    });
    // Everyone in succession — nobody can move, so the round is blocked.
    if (passes >= state.seats) {
      return endRound({ ...state, passes }, "blocked", null, events);
    }
    return {
      state: { ...state, passes, turn: nextSeat(state, seat) },
      events,
    };
  }

  const placed = placeTile(state.chain, state.arms[action.end], action.end, action.tile);
  const chain =
    action.end === "left"
      ? [placed.tile, ...state.chain]
      : [...state.chain, placed.tile];
  const hands = {
    ...state.hands,
    [seat]: (state.hands[seat] ?? []).filter((id) => id !== action.tile),
  };

  events.push({
    t: "move",
    piece: action.tile,
    // A `move` carrying a full Placement, not a `play`: the tile's board
    // cell and rotation ARE its position, and applyEvent's `play` path
    // knows nothing about either — it would land the tile unrotated at
    // the end of the bucket and then snap it straight at the next
    // reconcile. LRC does the same thing for chips, for the same reason.
    to: linePlacement(placed.tile, action.end === "left" ? -1 : state.chain.length),
  });
  if (seat !== HERO) {
    events.push({
      t: "announce",
      seat,
      text: `${botName(seat)} plays ${action.tile.replace("-", "–")}`,
      tone: "info",
    });
  }

  const next: DomState = {
    ...state,
    chain,
    arms: { ...state.arms, [action.end]: placed.arm },
    hands,
    passes: 0,
  };

  if ((hands[seat] ?? []).length === 0) {
    return endRound(next, "domino", seat, events);
  }

  return { state: { ...next, turn: nextSeat(state, seat) }, events };
}

/**
 * A tile's placement on the line. `index` only has to SORT correctly —
 * position comes from `cell` — so a left-end play passes -1 to sort
 * ahead of everything already down, and reindex renumbers from there.
 * The flags are set explicitly because applyEvent's `move` merges over
 * the previous placement, and a tile arriving from the hand is usually
 * carrying a selection highlight.
 */
function linePlacement(tile: PlacedTile, index: number): Placement {
  return {
    zone: "line",
    index,
    count: 1,
    faceUp: true,
    cell: { x: tile.x, y: tile.y, rot: tile.rot },
    selected: false,
    highlighted: false,
    dimmed: false,
  };
}

/* ============================================================
   Round and match scoring
   ============================================================ */

function endRound(
  state: DomState,
  kind: "domino" | "blocked",
  wentOut: SeatId | null,
  events: GameEvent[],
): ReduceResult<DomState> {
  const pips: Record<SeatId, number> = {};
  for (let s = 0; s < state.seats; s++) pips[s] = pipsInHand(state, s);

  const winner = kind === "domino" ? wentOut : blockedWinner(state, pips);
  // One formula for both endings: the losers' pips, less your own. Going
  // out simply makes your own zero.
  let points = 0;
  if (winner !== null) {
    for (let s = 0; s < state.seats; s++) if (s !== winner) points += pips[s] ?? 0;
    points -= pips[winner] ?? 0;
  }

  const scores = { ...state.scores };
  if (winner !== null) scores[winner] = (scores[winner] ?? 0) + points;

  const deltas: Record<SeatId, number> = {};
  for (let s = 0; s < state.seats; s++) deltas[s] = s === winner ? points : 0;

  events.push({
    t: "announce",
    seat: winner ?? undefined,
    text:
      winner === null
        ? "Blocked — tied, nobody scores"
        : kind === "domino"
          ? `${seatName(winner)} ${winner === HERO ? "go out" : "goes out"} — ${points}`
          : `Blocked — ${seatName(winner)} ${winner === HERO ? "win" : "wins"} ${points}`,
    tone: winner === HERO ? "good" : "info",
  });
  events.push({ t: "score", deltas });
  events.push({ t: "roundEnd", round: state.round });

  const matchWinner =
    winner !== null && (scores[winner] ?? 0) >= state.target ? winner : null;
  if (matchWinner !== null) {
    events.push({ t: "gameEnd", winner: matchWinner });
  }

  return {
    state: {
      ...state,
      scores,
      result: { kind, winner, pips, points },
      winner: matchWinner,
      // A tie leaves nobody to lead, so the lead simply moves round.
      opener: winner ?? nextSeat(state, state.opener),
    },
    events,
  };
}

/** Lowest pips; tied, the lightest single tile; still tied, nobody. */
function blockedWinner(state: DomState, pips: Record<SeatId, number>): SeatId | null {
  let best: SeatId[] = [];
  let bestPips = Infinity;
  for (let s = 0; s < state.seats; s++) {
    const p = pips[s] ?? 0;
    if (p < bestPips) {
      bestPips = p;
      best = [s];
    } else if (p === bestPips) {
      best.push(s);
    }
  }
  if (best.length === 1) return best[0]!;

  let tied: SeatId[] = [];
  let bestTile = Infinity;
  for (const s of best) {
    const t = lightestTile(state, s);
    if (t < bestTile) {
      bestTile = t;
      tied = [s];
    } else if (t === bestTile) {
      tied.push(s);
    }
  }
  return tied.length === 1 ? tied[0]! : null;
}

/* ============================================================
   GameDefinition surface
   ============================================================ */

export function legalActions(state: DomState, seat: SeatId): DomAction[] {
  if (state.winner !== null || state.result !== null || state.turn !== seat) return [];
  const out: DomAction[] = [];
  for (const { tile, ends } of playableTiles(state, seat)) {
    for (const end of ends) out.push({ t: "play", tile, end });
  }
  if (out.length > 0) return out;
  return drawableTiles(state) > 0 ? [{ t: "draw" }] : [{ t: "pass" }];
}

export function pieces(): Record<PieceId, PieceMeta> {
  const out: Record<PieceId, PieceMeta> = {};
  for (const id of doubleSixSet()) out[id] = { kind: "tile", face: id };
  return out;
}

export function placements(state: DomState, viewer: SeatId): PlacementMap {
  const out: PlacementMap = {};

  state.chain.forEach((tile, i) => {
    out[tile.id] = {
      zone: "line",
      index: i,
      count: state.chain.length,
      faceUp: true,
      cell: { x: tile.x, y: tile.y, rot: tile.rot },
    };
  });

  // Marking the viewer's own playable tiles belongs here rather than in
  // the play screen: `placements` is the full visual truth a reconcile
  // restores, and a reconcile always lands immediately BEFORE the hero's
  // turn begins — so this survives it instead of being wiped by it.
  //
  // Dims the tiles that CAN'T be played rather than decorating the ones
  // that can. A hand is already showing every piece in full — unlike a
  // pile where picking the eligible few out from a stack is the whole
  // problem a highlight solves — so the busier "add a glow to some of
  // these" reads worse than the plainer "the ones you can't use fall
  // back." A legal tile is left completely undecorated: normal opacity,
  // a normal pointer cursor, nothing added.
  const isMyTurn = currentSeat(state) === viewer;
  const mine = isMyTurn ? playableTiles(state, viewer) : [];
  const playable = new Set(mine.map((p) => p.tile));

  for (let seat = 0; seat < state.seats; seat++) {
    const hand = state.hands[seat] ?? [];
    const isViewerHand = seat === viewer;
    hand.forEach((id, i) => {
      out[id] = {
        zone: "hand",
        seat,
        index: i,
        count: hand.length,
        faceUp: isViewerHand,
        dimmed: (isViewerHand && isMyTurn && !playable.has(id)) || undefined,
      };
    });
  }

  state.boneyard.forEach((id, i) => {
    out[id] = {
      zone: "boneyard",
      index: i,
      count: state.boneyard.length,
      faceUp: false,
    };
  });

  return out;
}

/**
 * Everything except the viewer's own hand is face down on a real table,
 * so it is face down here too. Other seats' tiles and the whole boneyard
 * become same-length runs of `HIDDEN_TILE`: a bot still knows exactly
 * how many tiles each opponent holds and how deep the boneyard is —
 * both public facts — without being handed their contents.
 *
 * The runtime feeds this, not the raw state, to every bot.
 */
export function playerView(state: DomState, viewer: SeatId): DomState {
  const hands: Record<SeatId, PieceId[]> = {};
  for (let seat = 0; seat < state.seats; seat++) {
    const hand = state.hands[seat] ?? [];
    hands[seat] = seat === viewer ? hand : hand.map(() => HIDDEN_TILE);
  }
  return {
    ...state,
    hands,
    boneyard: state.boneyard.map(() => HIDDEN_TILE),
  };
}

export function currentSeat(state: DomState): SeatId | null {
  if (!state.dealt || state.result !== null || state.winner !== null) return null;
  return state.turn;
}

export function isRoundOver(state: DomState): boolean {
  return state.result !== null;
}

export function isOver(state: DomState): boolean {
  return state.winner !== null;
}

export function createDominoes(target?: number): GameDefinition<DomState, DomAction> {
  return {
    id: "dominoes",
    name: "Dominoes",
    minSeats: MIN_SEATS,
    maxSeats: MAX_SEATS,
    setup: makeSetup(target),
    reduce,
    legalActions,
    pieces,
    placements,
    playerView,
    currentSeat,
    isOver,
    startRound,
    isRoundOver,
    bots: dominoBots,
  };
}

export const dominoes = createDominoes();

// Re-exported so callers do not have to reach into three modules to ask
// simple questions about a position.
export { BONEYARD_FLOOR, canPlay, drawableTiles, playableEnds, playableTiles };
export type { ChainEnd };
