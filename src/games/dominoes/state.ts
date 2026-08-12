/**
 * Pure queries over DomState.
 *
 * Split out from rules.ts so bots.ts, the play screen and rules.ts can
 * all share them without a cycle — the same reason lrc/state.ts exists.
 */

import type { PieceId, SeatId } from "@/engine/types";
import { isDouble, otherHalf, parseTile, tileHas, tilePips } from "@/games/_shared/tiles";
import type { ChainEnd, DomState } from "./types";

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

/** Tiles dealt per player. Draw-game sizes, per pagat.com. */
export function handSize(seats: number): number {
  return seats >= 4 ? 6 : 7;
}

/** Default match target: 100 heads-up, 61 at three or four. */
export function defaultTarget(seats: number): number {
  return seats >= 3 ? 61 : 100;
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
 * Who opens round one: the holder of the highest double, falling back to
 * the heaviest tile if nobody was dealt one. A deterministic stand-in
 * for the physical "draw for the lead".
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
