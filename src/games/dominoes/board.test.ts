import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import { isDouble, parseTile } from "@/games/_shared/tiles";
import { ARM_REACH, ROW_PITCH, halfExtent, placeTile, tileRect } from "./board";
import { createDominoes } from "./rules";
import type { ArmState, ChainEnd, DomAction, PlacedTile } from "./types";

/**
 * The layout engine's guarantees, checked by playing real matches rather
 * than by trusting the geometry argument in board.ts.
 *
 * Every one of these is something the player can SEE, and each has a
 * specific way it could silently break:
 *
 *  - two tiles overlapping is the failure mode of "a placed tile never
 *    moves" — there is no later reflow to rescue a bad position;
 *  - a pair that does not touch, or whose meeting pips differ, is the
 *    failure mode of positioning by index instead of by real extents,
 *    which is exactly what a double breaks (it is half the run length of
 *    every other tile);
 *  - a double lying along its run instead of across it is the rule every
 *    domino player checks first;
 *  - an arm crossing into the other arm's half-plane is what makes a
 *    collision possible at all, so it is asserted directly rather than
 *    left to the overlap check to catch after the fact.
 *
 * All four run inside ONE simulation per (seed, seat count): the checks
 * are per-play and incremental, so a whole match costs about what a
 * single naive full-board sweep would.
 */

const EPS = 1e-9;

interface Rect {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  return w > EPS && h > EPS;
}

/** Share a border of positive length without overlapping — "end to end". */
function touches(a: Rect, b: Rect): boolean {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  return (Math.abs(w) < EPS && h > EPS) || (Math.abs(h) < EPS && w > EPS);
}

/** True when the tile's long side runs horizontally. */
function longIsHorizontal(tile: PlacedTile): boolean {
  return halfExtent(tile.rot, true) === 1;
}

interface Failure {
  what: string;
  detail: string;
}

/**
 * Plays one whole match with bots in every seat, auditing the board
 * after each individual play so a bad placement is reported at the
 * moment it is made rather than 40 tiles later.
 */
function auditMatch(seed: number, seats: number): Failure[] {
  const rng = createRng(seed);
  const def = createDominoes(61);
  let state = def.setup({ seats, rng });
  ({ state } = def.startRound!(state, rng));

  const tiers = ["casual", "steady", "sharp"] as const;
  const failures: Failure[] = [];
  const where = `seed ${seed}, ${seats} seats`;
  // Which arm each tile was laid on, so the half-plane rule can be
  // checked directly. Cleared with the chain at every new round.
  let arm = new Map<string, ChainEnd>();
  let guard = 0;

  const audit = (action: DomAction) => {
    if (action.t !== "play") return;
    const chain = state.chain;
    const end: ChainEnd = action.end;
    const at = end === "left" ? 0 : chain.length - 1;
    const laid = chain[at]!;
    arm.set(laid.id, chain.length === 1 ? end : end);

    // 1. Nothing it landed on. Only the new tile can newly overlap, so
    //    this stays O(n) per play instead of O(n^2).
    const rect = tileRect(laid);
    for (const other of chain) {
      if (other === laid) continue;
      if (overlaps(rect, tileRect(other))) {
        failures.push({
          what: "overlap",
          detail: `${where}: ${laid.id} overlaps ${other.id}`,
        });
      }
    }

    // 2. It abuts its neighbour, and the pips that meet are equal.
    const neighbour = end === "left" ? chain[1] : chain[chain.length - 2];
    if (neighbour) {
      const [a, b] = end === "left" ? [laid, neighbour] : [neighbour, laid];
      if (a.b !== b.a) {
        failures.push({
          what: "pip mismatch",
          detail: `${where}: ${a.id}(${a.b}) meets ${b.id}(${b.a})`,
        });
      }
      if (!touches(tileRect(a), tileRect(b))) {
        failures.push({
          what: "gap",
          detail: `${where}: ${a.id} does not touch ${b.id}`,
        });
      }

      // 3. A double lies ACROSS the direction it was played in.
      if (isDouble(laid.id)) {
        const travelHorizontal =
          Math.abs(laid.x - neighbour.x) > Math.abs(laid.y - neighbour.y);
        if (longIsHorizontal(laid) !== !travelHorizontal) {
          failures.push({
            what: "double not crosswise",
            detail: `${where}: ${laid.id} at rot ${laid.rot}`,
          });
        }
      }
    }

    // 4. Arms stay on their own side of the opening row, and inside the
    //    reach the camera is sized for.
    const side = arm.get(laid.id);
    if (side === "right" && laid.y < -EPS) {
      failures.push({ what: "arm crossed", detail: `${where}: right arm at y ${laid.y}` });
    }
    if (side === "left" && laid.y > EPS) {
      failures.push({ what: "arm crossed", detail: `${where}: left arm at y ${laid.y}` });
    }
    if (Math.abs(laid.x) > ARM_REACH + ROW_PITCH) {
      failures.push({ what: "out of reach", detail: `${where}: x ${laid.x}` });
    }
  };

  while (!def.isOver(state) && guard++ < 4000) {
    if (def.isRoundOver!(state)) {
      ({ state } = def.startRound!(state, rng));
      arm = new Map();
      continue;
    }
    const seat = def.currentSeat(state)!;
    const bot = def.bots[tiers[seat % tiers.length]!];
    const action = bot.choose(def.playerView(state, seat), seat, rng);
    ({ state } = def.reduce(state, action));
    audit(action);
  }

  if (guard >= 4000) failures.push({ what: "no progress", detail: where });
  return failures;
}

const SEEDS = Array.from({ length: 30 }, (_, i) => 1000 + i * 7919);

describe("domino chain — the layout engine", () => {
  it(
    "lays every tile end to end, pips matching, doubles crosswise, never overlapping",
    () => {
      const failures: Failure[] = [];
      for (const seats of [2, 3, 4]) {
        for (const seed of SEEDS) failures.push(...auditMatch(seed, seats));
      }
      expect(failures.map((f) => f.detail)).toEqual([]);
    },
    30_000,
  );
});

describe("domino chain — corner centring", () => {
  /**
   * The bug this regression-tests: `cornerContact`'s "along the old run"
   * offset used to be derived from the INCOMING tile's own half-extent
   * on that axis. That happened to equal 0.5 — and so happened to look
   * right — for every ordinary tile, because an ordinary tile's
   * cross-extent on the axis it is leaving is always 0.5. It broke the
   * moment the tile making the turn was itself a double: a double's
   * extent on that axis is 1, not 0.5, which pulled the whole tile half
   * a unit off the join. The fix anchors "along" to the tile it is
   * joining instead — a domino's cell is always 0.5 short of its own
   * centre, independent of what comes next.
   */
  it("centres a double that turns the corner on its neighbour's forward cell, not its own shape", () => {
    // A normal tile laid along a rightward run, right at the edge of
    // the arm's reach — so the very next tile is forced to turn.
    const anchor: PlacedTile = { id: "6-5", x: ARM_REACH - 1, y: 0, rot: 90, a: 5, b: 6 };
    const arm: ArmState = { heading: "R", horiz: "R", rowY: 0, turning: false };

    const { tile } = placeTile([anchor], arm, "right", "6-6");

    // Forced onto the perpendicular (the reach was exceeded).
    expect(tile.y).not.toBe(anchor.y);
    // The join is centred on the anchor's forward cell: half its own
    // extent short of its full length, same as every other tile — a
    // double's shape on the axis it is LEAVING never enters into it.
    const expectedAlong = halfExtent(anchor.rot, true) - 0.5;
    expect(tile.x).toBeCloseTo(anchor.x + expectedAlong, 9);
  });
});

describe("domino chain — orientation", () => {
  it("keeps each tile's two halves faithful to its id", () => {
    // A tile drawn at rot 0 shows its HIGH half at the top, and every
    // rotation is a quarter turn clockwise from there. If that drifts,
    // matching pips still touch but the wrong numbers face each other —
    // which the pip check above would catch, while this pins down why.
    const rng = createRng(4242);
    const def = createDominoes(61);
    let state = def.setup({ seats: 2, rng });
    ({ state } = def.startRound!(state, rng));

    let guard = 0;
    while (!def.isRoundOver!(state) && guard++ < 400) {
      const seat = def.currentSeat(state)!;
      const action = def.bots.steady.choose(def.playerView(state, seat), seat, rng);
      ({ state } = def.reduce(state, action));
    }

    expect(state.chain.length).toBeGreaterThan(4);
    for (const tile of state.chain) {
      const [hi, lo] = parseTile(tile.id);
      expect([tile.a, tile.b].slice().sort()).toEqual([lo, hi].slice().sort());
    }
  });
});
