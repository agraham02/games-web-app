/**
 * The domino layout engine.
 *
 * Everything here is pure and screen-independent: it works in board
 * units (1 unit = a tile's short side, so a domino is 1x2) and knows
 * nothing about viewports. `boardCamera` in table/layout.ts is what
 * fits the result to whatever screen is showing it.
 *
 * Three properties this file exists to guarantee:
 *
 *  1. **Contact is exact.** Tiles are positioned from each other's real
 *     extents, so matching pips physically touch — the chain renders as
 *     [6|3][3|3][3|1], not as an evenly-pitched row that happens to be
 *     in the right order. This is why the walk cannot be done from an
 *     index: a double is laid crosswise and advances the run by one
 *     unit, everything else by two.
 *  2. **Doubles are always perpendicular** to the run they sit in, and a
 *     tile joined to a double meets its middle — the printed rule.
 *  3. **A placed tile never moves again.** Position is computed once and
 *     stored (see types.ts). Nothing here rewrites an earlier tile.
 *
 * The snake, and why it cannot collide with itself:
 *
 *      left arm's rows step UP            row −4   [..][..][..]
 *                                         row −2   [..][..][..][.]
 *      ───────── first tile ─────────     row  0 [..][..]●[..][..]
 *                                         row +2      [.][..][..][..]
 *      right arm's rows step DOWN         row +4   [..][..][..]
 *
 * The two arms turn in opposite directions, so after row 0 they occupy
 * opposite half-planes and can never meet. Within an arm, rows are at
 * least ROW_PITCH apart while no tile reaches more than 1 unit either
 * side of its row's centreline — so neighbouring rows may touch but
 * cannot overlap. board.test.ts asserts both over hundreds of full
 * games rather than trusting the argument.
 */

import type { PieceId } from "@/engine/types";
import { isDouble, otherHalf, parseTile } from "@/games/_shared/tiles";
import {
  HEADING_VEC,
  type ArmState,
  type ChainEnd,
  type Heading,
  type PlacedTile,
} from "./types";

/**
 * How far an arm runs from the origin before turning, in board units
 * (~3.5 tiles each way, so a full row is ~7 tiles). Together with
 * ROW_PITCH this is what sets the board's proportions: 26 playable tiles
 * land in roughly a 14x8 rectangle, which the camera then fits — upright
 * on a landscape screen, quarter-turned on a portrait one.
 */
export const ARM_REACH = 7;

/**
 * Minimum gap between the centrelines of two rows of the same arm. Two
 * units is exactly enough that a crosswise double in one row (reaching
 * 1 unit out) can touch, but never overlap, a double in the next.
 */
export const ROW_PITCH = 2;

/** Rotation that points a tile's HIGH half along each heading. */
const HIGH_TOWARD: Record<Heading, number> = { R: 90, D: 180, L: 270, U: 0 };

const OPPOSITE: Record<Heading, Heading> = { R: "L", L: "R", D: "U", U: "D" };

function isHorizontal(h: Heading): boolean {
  return h === "R" || h === "L";
}

/**
 * How far a tile laid at `rot` reaches from its centre along an axis.
 * 1 if its long side lies along that axis, 0.5 if across it — which is
 * the whole reason a double advances a run by half as much.
 */
export function halfExtent(rot: number, alongHorizontal: boolean): number {
  const longIsHorizontal = Math.round((((rot % 360) + 360) % 360) / 90) % 2 === 1;
  return longIsHorizontal === alongHorizontal ? 1 : 0.5;
}

/** The rotation a tile takes when laid along `heading`. */
function rotationFor(id: PieceId, heading: Heading, forwardPip: number): number {
  // A double sits across its run, so the run direction alone decides it
  // and both halves read the same either way.
  if (isDouble(id)) return isHorizontal(heading) ? 0 : 90;
  const [hi] = parseTile(id);
  const high = HIGH_TOWARD[heading];
  return forwardPip === hi ? high : (high + 180) % 360;
}

/** Straight continuation: B's near edge meets A's far edge exactly. */
function contact(
  anchor: PlacedTile,
  rot: number,
  heading: Heading,
): { x: number; y: number } {
  const v = HEADING_VEC[heading];
  const horiz = isHorizontal(heading);
  const d = halfExtent(anchor.rot, horiz) + halfExtent(rot, horiz);
  return { x: anchor.x + v.x * d, y: anchor.y + v.y * d };
}

/**
 * Turning a corner. B is laid along `to`, centred on A's forward CELL —
 * "a tile played to a double touches its middle" is the printed rule for
 * one case of this, but the join is really the same shape every time a
 * new tile's long axis differs from the one it is joining: a domino is
 * always two 1-unit cells about its own centre, so the cell nearest the
 * join sits exactly 0.5 short of the tile's own extent on that axis,
 * REGARDLESS of what tile comes next.
 */
function cornerContact(
  anchor: PlacedTile,
  rot: number,
  from: Heading,
  to: Heading,
): { x: number; y: number } {
  const dv = HEADING_VEC[from];
  const ev = HEADING_VEC[to];
  const fromHoriz = isHorizontal(from);
  const toHoriz = isHorizontal(to);
  // Along the old run: centred on A's forward cell, not on B's own
  // shape. Using B's half-extent here (the earlier, wrong version) only
  // happened to agree with this whenever B was an ordinary tile — B's
  // cross-extent on this axis is always exactly 0.5 in that case. It
  // disagreed the moment B was itself a double turning the corner (its
  // cross-extent there is 1, not 0.5), which pulled the join half a unit
  // off-centre: visually, the incoming tile sat noticeably high/left of
  // where its neighbour's forward pip actually was instead of centred
  // on it.
  const along = halfExtent(anchor.rot, fromHoriz) - 0.5;
  // Across it: plain contact.
  const across = halfExtent(anchor.rot, toHoriz) + halfExtent(rot, toHoriz);
  return {
    x: anchor.x + dv.x * along + ev.x * across,
    y: anchor.y + dv.y * along + ev.y * across,
  };
}

/** Which way an arm bends when it runs out of reach. */
function turnDirection(end: ChainEnd): Heading {
  return end === "right" ? "D" : "U";
}

export interface PlacementResult {
  tile: PlacedTile;
  arm: ArmState;
}

/** Both ends start on row 0, running away from each other. */
export function initialArm(end: ChainEnd): ArmState {
  const heading: Heading = end === "left" ? "L" : "R";
  return { heading, horiz: heading, rowY: 0, turning: false };
}

export function initialArms(): Record<ChainEnd, ArmState> {
  return { left: initialArm("left"), right: initialArm("right") };
}

/** The first tile of a round: laid at the origin, high half to the right. */
export function placeFirst(id: PieceId): PlacedTile {
  const [hi, lo] = parseTile(id);
  const double = isDouble(id);
  // A double still lies across its run, so the opening tile is upright
  // whenever it is one — the line starts as it means to go on.
  return { id, x: 0, y: 0, rot: double ? 0 : 90, a: double ? hi : lo, b: hi };
}

/**
 * Where `id` lands if it is joined to `end`, and what that leaves the
 * arm doing. Pure, and the ONLY implementation of this — `reduce` and
 * the hero's ghost previews both call it, so the ghost is exactly, not
 * approximately, where the tile will end up.
 */
export function placeTile(
  chain: readonly PlacedTile[],
  arm: ArmState,
  end: ChainEnd,
  id: PieceId,
): PlacementResult {
  const anchor = end === "left" ? chain[0] : chain[chain.length - 1];
  if (!anchor) return { tile: placeFirst(id), arm: initialArm(end) };

  // The pip that must meet the anchor, and the one left facing outward.
  const backPip = end === "left" ? anchor.a : anchor.b;
  const forwardPip = otherHalf(id, backPip);

  const straightRot = rotationFor(id, arm.heading, forwardPip);

  let rot = straightRot;
  let pos: { x: number; y: number };
  let next: ArmState = arm;

  if (arm.turning) {
    // Mid-corner, running perpendicular. Resume horizontally as soon as
    // doing so would clear a full row pitch — which is one tile if the
    // corner tile was ordinary, and two if it was a double (a double
    // only advances the run half as far, so turning back immediately
    // would put this row hard against the last one).
    const resume = OPPOSITE[arm.horiz];
    const resumeRot = rotationFor(id, resume, forwardPip);
    const candidate = cornerContact(anchor, resumeRot, arm.heading, resume);

    if (Math.abs(candidate.y - arm.rowY) >= ROW_PITCH) {
      rot = resumeRot;
      pos = candidate;
      next = { heading: resume, horiz: resume, rowY: candidate.y, turning: false };
    } else {
      pos = contact(anchor, straightRot, arm.heading);
    }
  } else {
    // Running along a row. Turn if this tile would take the arm past its
    // reach — measured on the tile's real outer edge, so a crosswise
    // double is judged by the 0.5 unit it actually occupies.
    const candidate = contact(anchor, straightRot, arm.heading);
    const sign = HEADING_VEC[arm.heading].x;
    const outer = candidate.x + sign * halfExtent(straightRot, true);

    if (Math.abs(outer) > ARM_REACH) {
      const turn = turnDirection(end);
      const turnRot = rotationFor(id, turn, forwardPip);
      rot = turnRot;
      pos = cornerContact(anchor, turnRot, arm.heading, turn);
      next = { heading: turn, horiz: arm.horiz, rowY: arm.rowY, turning: true };
    } else {
      pos = candidate;
    }
  }

  // `a` always faces the chain's left end and `b` its right, whichever
  // end was actually played on — that invariant is what lets the open
  // pips be read straight off chain[0].a and chain.at(-1)!.b.
  const [aPip, bPip] =
    end === "left" ? [forwardPip, backPip] : [backPip, forwardPip];

  return { tile: { id, x: pos.x, y: pos.y, rot, a: aPip, b: bPip }, arm: next };
}

/**
 * The point just outside an open end, where the next tile will join.
 * Used to park a "this end wants a 4" badge — the affordance that keeps
 * both live ends findable however far the chain has snaked.
 */
export function openEndAnchor(
  chain: readonly PlacedTile[],
  arm: ArmState,
  end: ChainEnd,
): { x: number; y: number } | null {
  const tile = end === "left" ? chain[0] : chain[chain.length - 1];
  if (!tile) return null;
  const v = HEADING_VEC[arm.heading];
  const reach = halfExtent(tile.rot, isHorizontal(arm.heading)) + 0.5;
  return { x: tile.x + v.x * reach, y: tile.y + v.y * reach };
}

/** Board-space rect a placed tile occupies — used for collision tests. */
export function tileRect(tile: PlacedTile) {
  const hw = halfExtent(tile.rot, true);
  const hh = halfExtent(tile.rot, false);
  return {
    minX: tile.x - hw,
    maxX: tile.x + hw,
    minY: tile.y - hh,
    maxY: tile.y + hh,
  };
}
