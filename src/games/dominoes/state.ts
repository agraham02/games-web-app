/**
 * Pure queries over DomState.
 *
 * Split out from rules.ts so bots.ts, the play screen and rules.ts can
 * all share them without a cycle — the same reason lrc/state.ts exists.
 */

import type { PieceId, SeatId } from "@/engine/types";
import { hashString } from "@/engine/rng";
import { teamOf, teammates } from "@/games/_shared/partnership";
import {
  doubleSixSet,
  isDouble,
  otherHalf,
  parseTile,
  tileHas,
  tilePips,
} from "@/games/_shared/tiles";
import type { ChainEnd, DomMode, DomRules, DomState } from "./types";

/**
 * The last two tiles of the boneyard are never drawn — that is the
 * printed rule, and it is also what caps the board at 26 tiles.
 */
export const BONEYARD_FLOOR = 2;

/**
 * Stands in for a tile the viewer is not allowed to see. `playerView`
 * fills other seats' hands and the boneyard with these, so a bot still
 * knows how many tiles everyone holds without knowing which.
 */
export const HIDDEN_TILE: PieceId = "?";

export function isHidden(id: PieceId): boolean {
  return id === HIDDEN_TILE;
}

/** Caribbean is a four-handed game — no more, no less. */
export const CARIBBEAN_SEATS = 4;
export const CARIBBEAN_TARGET_MIN = 1;
export const CARIBBEAN_TARGET_MAX = 20;
export const CARIBBEAN_DEFAULT_TARGET = 10;

/**
 * Six love resets your score whenever the other side scores, so the
 * match is won on a STREAK of `target` rounds. Between two teams that is
 * roughly 2^target rounds — about 60 at six, which is precisely why the
 * game is called *six* love. Anything much higher stops finishing, so
 * turning the rule on moves the default target here rather than leaving
 * it at the 10 a plain first-to-N match uses.
 */
export const SIX_LOVE_DEFAULT_TARGET = 6;

/**
 * Tiles dealt per player. Classic uses the draw-game sizes per
 * pagat.com; Caribbean deals the whole set, 7 each to exactly four
 * players, which is what leaves no boneyard behind.
 */
export function handSize(seats: number, mode: DomMode): number {
  if (mode === "caribbean") return 7;
  return seats >= 4 ? 6 : 7;
}

/** Classic: 100 heads-up, 61 at three or four. Caribbean: games won. */
export function defaultTarget(seats: number, rules: DomRules): number {
  if (rules.mode === "caribbean") {
    return rules.sixLove ? SIX_LOVE_DEFAULT_TARGET : CARIBBEAN_DEFAULT_TARGET;
  }
  return seats >= 3 ? 61 : 100;
}

/**
 * Every seat that scores together with `seat` — both partners in team
 * mode, just the seat itself otherwise. Scoring, the slam's
 * winning-streak odds and the blocked-round tiebreak all reason about a
 * SIDE, so routing them all through this keeps cut-throat and teams one
 * code path instead of two.
 */
export function sideOf(state: DomState, seat: SeatId): SeatId[] {
  if (!state.rules.teams) return [seat];
  return [...teammates(teamOf(seat))];
}

/** True when both seats score together. Cut-throat: only if identical. */
export function sameSide(state: DomState, a: SeatId, b: SeatId): boolean {
  return state.rules.teams ? teamOf(a) === teamOf(b) : a === b;
}

/** Open pip at each end, or null before the first tile is laid. */
export function openEnds(state: DomState): Record<ChainEnd, number | null> {
  const first = state.chain[0];
  const last = state.chain[state.chain.length - 1];
  if (!first || !last) return { left: null, right: null };
  return { left: first.a, right: last.b };
}

/** Pips a seat is still holding. Redacted tiles count as nothing. */
export function pipsInHand(state: DomState, seat: SeatId): number {
  let n = 0;
  for (const id of state.hands[seat] ?? []) {
    if (!isHidden(id)) n += tilePips(id);
  }
  return n;
}

/** Lightest single tile held — pagat's tie-break on a blocked round. */
export function lightestTile(state: DomState, seat: SeatId): number {
  let best = Infinity;
  for (const id of state.hands[seat] ?? []) {
    if (!isHidden(id)) best = Math.min(best, tilePips(id));
  }
  return best;
}

/** How many tiles may still be drawn before hitting the floor. */
export function drawableTiles(state: DomState): number {
  return Math.max(0, state.boneyard.length - BONEYARD_FLOOR);
}

/**
 * Ends `tile` may legally be joined to. An empty chain has exactly one
 * placement (the opening tile), not two — the ends only diverge once
 * there is something between them.
 */
export function playableEnds(state: DomState, tile: PieceId): ChainEnd[] {
  if (state.chain.length === 0) return ["right"];
  const ends = openEnds(state);
  const out: ChainEnd[] = [];
  if (ends.left !== null && tileHas(tile, ends.left)) out.push("left");
  if (ends.right !== null && tileHas(tile, ends.right)) out.push("right");
  return out;
}

export interface PlayOption {
  tile: PieceId;
  ends: ChainEnd[];
}

/** Every tile in `seat`'s hand that can go somewhere, and where. */
export function playableTiles(state: DomState, seat: SeatId): PlayOption[] {
  const out: PlayOption[] = [];
  for (const tile of state.hands[seat] ?? []) {
    if (isHidden(tile)) continue;
    const ends = playableEnds(state, tile);
    if (ends.length > 0) out.push({ tile, ends });
  }
  return out;
}

export function canPlay(state: DomState, seat: SeatId): boolean {
  return playableTiles(state, seat).length > 0;
}

/**
 * The pips left open if `tile` goes on `end`. The far end is untouched,
 * so this needs no board geometry — handy for bots weighing a move.
 */
export function endsAfter(
  state: DomState,
  tile: PieceId,
  end: ChainEnd,
): Record<ChainEnd, number> {
  const ends = openEnds(state);
  const meeting = end === "left" ? ends.left : ends.right;
  if (meeting === null) {
    // Opening tile: its own two halves become the two open ends.
    const [hi, lo] = parseTile(tile);
    return { left: lo, right: hi };
  }
  const facing = otherHalf(tile, meeting);
  return end === "left"
    ? { left: facing, right: ends.right ?? facing }
    : { left: ends.left ?? facing, right: facing };
}

/** Turn order runs anticlockwise, matching seat numbering. */
export function nextSeat(state: DomState, from: SeatId): SeatId {
  return (from + 1) % state.seats;
}

/**
 * The "key tile": with the two open ends showing DIFFERENT pips, exactly
 * one tile in the whole set can still legally be played. Going out on it
 * is worth an extra game in Caribbean — unless it is a double, which the
 * rule explicitly excludes.
 *
 * Asked of the state BEFORE the play, since the point is what the board
 * looked like when the tile went down. "Unplayed" means every tile not
 * already on the chain — the physical set minus the line, which is the
 * right question regardless of whose hand holds what, and so is
 * unaffected by `playerView`'s redaction.
 */
export function isKeyTile(state: DomState, tile: PieceId): boolean {
  if (isDouble(tile)) return false;
  const ends = openEnds(state);
  if (ends.left === null || ends.right === null) return false;
  if (ends.left === ends.right) return false;

  const onBoard = new Set(state.chain.map((t) => t.id));
  let only: PieceId | null = null;
  for (const id of doubleSixSet()) {
    if (onBoard.has(id)) continue;
    if (playableEnds(state, id).length === 0) continue;
    if (only !== null) return false; // More than one — no key tile.
    only = id;
  }
  return only === tile;
}

/* ============================================================
   The slam
   ============================================================ */

/**
 * How often a played tile is slammed down rather than laid. Per play,
 * per seat — a Caribbean table is loud, and a player on a run is louder.
 * The going-out figure is deliberately near-certain: the tile that wins
 * the round is the one that gets slammed in real life.
 */
export const SLAM_CHANCE = {
  base: 0.12,
  lastWinner: 0.35,
  goingOut: 0.8,
} as const;

export function slamChance(state: DomState, seat: SeatId, goingOut: boolean): number {
  if (goingOut) return SLAM_CHANCE.goingOut;
  // In team mode a win belongs to the SIDE, so both partners swagger.
  const won =
    state.lastRoundWinner !== null && sameSide(state, state.lastRoundWinner, seat);
  return won ? SLAM_CHANCE.lastWinner : SLAM_CHANCE.base;
}

/**
 * Whether this play is slammed. A pure function of the position — no
 * `Rng`, because `reduce` has none and a slam has to survive a replay
 * exactly like the deal does. See `hashString`.
 *
 * `chain.length` is in the key so the same seat playing the same tile at
 * two different moments of a round can differ, and `seed` is in it so
 * two matches do not slam in identical places.
 */
export function rollsSlam(
  state: DomState,
  seat: SeatId,
  tile: PieceId,
  goingOut: boolean,
): boolean {
  if (state.rules.mode !== "caribbean") return false;
  const key = `slam|${state.seed}|${state.round}|${state.chain.length}|${seat}|${tile}`;
  return hashString(key) % 1000 < slamChance(state, seat, goingOut) * 1000;
}

/**
 * Who opens round one: the holder of the highest double, falling back to
 * the heaviest tile if nobody was dealt one. A deterministic stand-in
 * for the physical "draw for the lead".
 *
 * In Caribbean this IS the printed rule rather than a stand-in: with all
 * 28 tiles dealt somebody always holds the 6-6, and the highest double
 * is always it.
 */
export function openingSeat(
  hands: Record<SeatId, PieceId[]>,
  seats: number,
): SeatId {
  let bestSeat = 0;
  let bestRank = -1;
  for (let seat = 0; seat < seats; seat++) {
    for (const id of hands[seat] ?? []) {
      // Any double outranks any non-double.
      const rank = (isDouble(id) ? 100 : 0) + tilePips(id);
      if (rank > bestRank) {
        bestRank = rank;
        bestSeat = seat;
      }
    }
  }
  return bestSeat;
}
