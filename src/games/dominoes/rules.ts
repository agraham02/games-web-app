/**
 * Dominoes — GameDefinition. Two rulesets share this file.
 *
 * ## Caribbean (`mode: "caribbean"`)
 *
 * Verified against pagat.com's Caribbean Dominoes page and gamerules.com's
 * partner and cut-throat pages. Exactly four players, all 28 tiles dealt
 * seven apiece, **no boneyard**, and a player who cannot go simply
 * passes. Playable cut-throat or 2v2 with partners across.
 *
 *  - The double-six holder opens the first round; after that the
 *    previous round's winner opens. A round that ended tied hands the
 *    lead back to the double-six.
 *  - Each round won is worth ONE game, not a pile of pips. First side to
 *    the target takes the match.
 *  - A blocked round goes to the lowest pip count — and unlike the
 *    classic game there is no second tiebreak: tied on count is simply a
 *    tie, which scores nobody and redeals. In team mode two partners
 *    tied at the lowest count is not a tie at all; their side has the
 *    lowest count twice and wins it.
 *  - Optional: the key-tile bonus, and six love. See `DomRules`.
 *
 * **The no-boneyard rule needed almost no code.** `drawableTiles` is
 * `boneyard.length - BONEYARD_FLOOR` floored at zero, and `legalActions`
 * already ends with "draw if you can, else pass" — so dealing the whole
 * set leaves an empty boneyard and passing falls out on its own.
 * `legalActions`, `reduce`'s draw branch and the bots' `forced()` are
 * untouched by this mode.
 *
 * ## Classic Block & Draw (`mode: "classic"`)
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
  CARIBBEAN_SEATS,
  HIDDEN_TILE,
  canPlay,
  defaultTarget,
  drawableTiles,
  handSize,
  isKeyTile,
  nextSeat,
  openEnds,
  openingSeat,
  playableEnds,
  playableTiles,
  pipsInHand,
  lightestTile,
  rollsSlam,
  sameSide,
  sideOf,
} from "./state";
import type { ChainEnd, DomAction, DomRules, DomState, PlacedTile } from "./types";
import { validateByEnumeration } from "../_shared/validate";

export const MIN_SEATS = 2;
export const MAX_SEATS = 4;

export const DEFAULT_RULES: DomRules = {
  mode: "classic",
  teams: false,
  keyTileBonus: false,
  sixLove: false,
};

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
export function makeSetup(rules: DomRules, target?: number) {
  return function setup(opts: SetupOptions): DomState {
    // Caribbean is four-handed by definition — partners across need it,
    // and the whole set only divides seven ways four times. Forced here
    // rather than trusted from the caller so a bad `seats` cannot deal a
    // short hand and silently leave tiles unaccounted for.
    const seats = rules.mode === "caribbean" ? CARIBBEAN_SEATS : opts.seats;
    const scores: Record<SeatId, number> = {};
    const hands: Record<SeatId, PieceId[]> = {};
    for (let seat = 0; seat < seats; seat++) {
      scores[seat] = 0;
      hands[seat] = [];
    }
    return {
      seats,
      rules,
      seed: opts.rng.seed,
      target: target ?? defaultTarget(seats, rules),
      round: 0,
      scores,
      hands,
      boneyard: doubleSixSet(),
      chain: [],
      arms: initialArms(),
      turn: HERO,
      passes: 0,
      passedEnds: {},
      opener: HERO,
      lastRoundWinner: null,
      result: null,
      winner: null,
      winningSeats: null,
      dealt: false,
    };
  };
}

export function startRound(state: DomState, rng: Rng): ReduceResult<DomState> {
  const tiles = rng.shuffle(doubleSixSet());
  // Caribbean deals all 28, so `boneyard` below comes out empty and the
  // "draw if you can, else pass" branch in `legalActions` resolves to
  // pass on its own — that is the entire implementation of "no boneyard".
  const per = handSize(state.seats, state.rules.mode);
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
  //
  // Caribbean adds one case: a round that ended with NOBODY winning
  // (blocked and tied on count) hands the lead back to the double-six,
  // exactly as at the start of a match. Gated on the mode so classic —
  // where a tied block simply moves the lead round the table — keeps the
  // behaviour it has always had.
  const reopen =
    round === 1 ||
    (state.rules.mode === "caribbean" && (state.result?.winner ?? null) === null);
  const opener = reopen ? openingSeat(hands, state.seats) : state.opener;

  events.push({ t: "phase", phase: `round-${round}` });
  events.push({
    t: "announce",
    seat: opener,
    actor: opener,
    text: "leads",
    selfText: "lead",
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
      passedEnds: {},
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
      events.push({ t: "announce", seat, actor: seat, text: "drew", tone: "info" });
    }
    // The turn does not move — they still have to play or draw again.
    return {
      state: { ...state, hands, boneyard: state.boneyard.slice(1), passes: 0 },
      events,
    };
  }

  if (action.t === "pass") {
    const passes = state.passes + 1;
    // A pass is a permanent, public statement about this seat's hand:
    // it holds neither open end. Recorded for the rest of the round
    // (never cleared by a later play, unlike `passes` itself) because
    // that is exactly how long the fact stays true.
    const ends = openEnds(state);
    const shown = new Set(state.passedEnds[seat] ?? []);
    for (const n of [ends.left, ends.right]) if (n !== null) shown.add(n);
    const passedEnds = { ...state.passedEnds, [seat]: [...shown].sort((a, b) => a - b) };
    events.push({
      t: "announce",
      seat,
      actor: seat,
      text: "passes",
      selfText: "pass",
      tone: "info",
      selfTone: "bad",
    });
    // Everyone in succession — nobody can move, so the round is blocked.
    if (passes >= state.seats) {
      return endRound({ ...state, passes, passedEnds }, "blocked", null, events);
    }
    return {
      state: { ...state, passes, passedEnds, turn: nextSeat(state, seat) },
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
  const goingOut = (hands[seat] ?? []).length === 0;

  // Both of these are questions about the board AS IT WAS — `state`, not
  // `next`. The key tile is a fact about what could still have been
  // played before this one went down, and the shake ripples through the
  // tiles already on the line, never through the one arriving (and never
  // through a hand: `state.chain` cannot contain one).
  const keyTile = goingOut && isKeyTile(state, action.tile);
  if (rollsSlam(state, seat, action.tile, goingOut)) {
    events.push({
      t: "slam",
      piece: action.tile,
      shake: state.chain.map((t) => t.id),
      final: goingOut,
    });
  }

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
      actor: seat,
      text: `plays ${action.tile.replace("-", "–")}`,
      selfText: `play ${action.tile.replace("-", "–")}`,
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

  if (goingOut) {
    return endRound(next, "domino", seat, events, keyTile);
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
  keyTile = false,
): ReduceResult<DomState> {
  const caribbean = state.rules.mode === "caribbean";
  const pips: Record<SeatId, number> = {};
  for (let s = 0; s < state.seats; s++) pips[s] = pipsInHand(state, s);

  const winner = kind === "domino" ? wentOut : blockedWinner(state, pips);
  // Whoever laid the last tile wins it for their whole SIDE — the same
  // one seat in cut-throat, both partners in team mode.
  const winningSeats = winner !== null ? sideOf(state, winner) : null;
  const bonus = caribbean && keyTile && state.rules.keyTileBonus;

  let points = 0;
  if (winner !== null) {
    if (caribbean) {
      // A round is worth one game, whether you went out or simply held
      // the lightest hand when it blocked. Two on the key tile.
      points = bonus ? 2 : 1;
    } else {
      // Classic: one formula for both endings — the losers' pips, less
      // your own. Going out simply makes your own zero.
      for (let s = 0; s < state.seats; s++) if (s !== winner) points += pips[s] ?? 0;
      points -= pips[winner] ?? 0;
    }
  }

  const scores = { ...state.scores };
  if (winningSeats) {
    for (const s of winningSeats) scores[s] = (scores[s] ?? 0) + points;
    // Six love: taking a round sends the other side back to nothing, so
    // the match has to be won on an unbroken streak. Team-only — see
    // `defaultTarget` for why four-way it does not terminate.
    if (caribbean && state.rules.sixLove) {
      for (let s = 0; s < state.seats; s++) {
        if (!winningSeats.includes(s)) scores[s] = 0;
      }
    }
  }

  // Read off the real change rather than assuming only the winner moved:
  // six love drops the losing side too, and that is a swing worth
  // animating. Identical to the old `s === winner ? points : 0` for
  // every game that does not reset anyone.
  const deltas: Record<SeatId, number> = {};
  for (let s = 0; s < state.seats; s++) {
    deltas[s] = (scores[s] ?? 0) - (state.scores[s] ?? 0);
  }

  events.push({
    t: "announce",
    seat: winner ?? undefined,
    text: roundAnnouncement(state, kind, winner, points, bonus),
    tone: winningSeats?.includes(HERO) ? "good" : "info",
  });
  events.push({ t: "score", deltas });
  events.push({ t: "roundEnd", round: state.round });

  // Scores mirror within a side, so asking the representative seat is
  // asking the side.
  const matchWinner =
    winner !== null && (scores[winner] ?? 0) >= state.target ? winner : null;
  if (matchWinner !== null) {
    events.push({ t: "gameEnd", winner: matchWinner });
  }

  return {
    state: {
      ...state,
      scores,
      result: { kind, winner, winningSeats, pips, points, bonus },
      winner: matchWinner,
      winningSeats: matchWinner !== null ? winningSeats : null,
      lastRoundWinner: winner ?? state.lastRoundWinner,
      // A tie leaves nobody to lead, so the lead simply moves round. In
      // Caribbean `startRound` overrides this anyway and hands the lead
      // back to the double-six holder.
      opener: winner ?? nextSeat(state, state.opener),
    },
    events,
  };
}

function roundAnnouncement(
  state: DomState,
  kind: "domino" | "blocked",
  winner: SeatId | null,
  points: number,
  bonus: boolean,
): string {
  if (winner === null) {
    return state.rules.mode === "caribbean"
      ? "Blocked — tied on count, redeal"
      : "Blocked — tied, nobody scores";
  }
  const name = seatName(winner);
  const won = winner === HERO ? "win" : "wins";
  if (state.rules.mode === "caribbean") {
    if (kind === "blocked") return `Blocked — ${name} ${won} on count`;
    const out = winner === HERO ? "go out" : "goes out";
    return bonus ? `${name} ${out} on the key tile — 2` : `${name} ${out}`;
  }
  return kind === "domino"
    ? `${name} ${winner === HERO ? "go out" : "goes out"} — ${points}`
    : `Blocked — ${name} ${won} ${points}`;
}

/**
 * Lowest pips. Classic then breaks a tie on the lightest single tile and
 * only gives up after that; Caribbean has no such second tiebreak —
 * level on count is simply a tie, and a tie redeals.
 *
 * The one wrinkle is team mode: two PARTNERS tied at the lowest count is
 * not a tie at all. Their side holds the lowest count twice over, so it
 * wins, and either partner represents it.
 */
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

  if (state.rules.mode === "caribbean") {
    return best.every((s) => sameSide(state, s, best[0]!)) ? best[0]! : null;
  }

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

export interface DominoesOptions extends Partial<DomRules> {
  /** Points in classic, games won in Caribbean. Defaults per mode. */
  target?: number;
}

export function createDominoes(
  opts: DominoesOptions = {},
): GameDefinition<DomState, DomAction> {
  const { target, ...rest } = opts;
  const rules: DomRules = { ...DEFAULT_RULES, ...rest };
  const caribbean = rules.mode === "caribbean";
  return {
    id: "dominoes",
    name: caribbean ? "Caribbean Dominoes" : "Dominoes",
    minSeats: caribbean ? CARIBBEAN_SEATS : MIN_SEATS,
    maxSeats: caribbean ? CARIBBEAN_SEATS : MAX_SEATS,
    setup: makeSetup(rules, target),
    reduce,
    legalActions,
    validate: validateByEnumeration(legalActions),
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
