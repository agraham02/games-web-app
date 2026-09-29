import { describe, expect, it } from "vitest";
import {
  cellHalfExtent,
  CORNER_CLEAR,
  TUCK_PEEK_FRACTION,
  discardMaxScroll,
  handFanMaxScroll,
  handHeaderHeight,
  podBox,
  resolveDensity,
  resolveTable,
  tileShortSide,
  statusLane,
  toastLane,
  type Box,
  type Density,
  type ZoneName,
} from "./geometry";
import {
  boardCamera,
  boardPieceSize,
  chipPileStacks,
  chipStackBadges,
  layoutPiece,
  projectCell,
  baseSize,
} from "./layout";
import type { Placement } from "@/engine/types";
import { createRng } from "@/engine/rng";
import { createDominoes } from "@/games/dominoes/rules";
import type { PlacedTile } from "@/games/dominoes/types";

/**
 * Chip piles (LRC's "collected" and "center") fan outward from a seat
 * or the table centre, and a seat pod is rarely far from a screen edge
 * on a phone. This caught two real bugs before it existed: a vertical
 * margin computed from the piece's WIDTH rather than its HEIGHT (a
 * card-shaped box is taller than wide, so that undershot by exactly
 * enough to clip a chip's top edge), and — before the clamp existed at
 * all — piles fanning straight off the side of the table for edge
 * seats. Covering every seat count and a generously large pile size is
 * what makes this a permanent guarantee rather than a fix for the one
 * case that happened to be visible in a screenshot.
 */

const VIEWPORTS = [
  { name: "phone portrait", w: 390, h: 844 },
  { name: "phone landscape", w: 844, h: 390 },
  { name: "desktop", w: 1440, h: 900 },
];
const SEAT_COUNTS = [2, 3, 4, 5, 6, 7, 8, 9, 10];
const DENSITIES: Density[] = ["compact", "regular", "wide"];

function pieceOnScreen(
  zone: "collected" | "center",
  seat: number | undefined,
  index: number,
  count: number,
  g: ReturnType<typeof resolveTable>,
) {
  const placement: Placement = { zone, seat, index, count, faceUp: true };
  // As a chip, so a pile big enough to become one stack is laid out as one.
  const t = layoutPiece(placement, g, { kind: "chip" });
  const base = baseSize(g);
  const onScreenW = base.w * t.scale;
  const onScreenH = base.h * t.scale;
  // t.x/t.y is the pre-scale top-left; the box scales around its own
  // centre (transformOrigin: center center), so the final on-screen
  // box is centred on the same point regardless of scale.
  const cx = t.x + base.w / 2;
  const cy = t.y + base.h / 2;
  return {
    left: cx - onScreenW / 2,
    right: cx + onScreenW / 2,
    top: cy - onScreenH / 2,
    bottom: cy + onScreenH / 2,
  };
}

describe("chip pile clamping — collected", () => {
  it("keeps up to 12 stacked chips fully on screen for every seat, every count, every density", () => {
    for (const vp of VIEWPORTS) {
      for (const seats of SEAT_COUNTS) {
        for (const density of DENSITIES) {
          const g = resolveTable({ seats, width: vp.w, height: vp.h, density });
          for (let seat = 1; seat < seats; seat++) {
            for (let index = 0; index < 12; index++) {
              const box = pieceOnScreen("collected", seat, index, 12, g);
              const label = `${vp.name}/${seats}seats/${density}/seat${seat}/chip${index}`;
              expect(box.left, label).toBeGreaterThanOrEqual(-0.5);
              expect(box.top, label).toBeGreaterThanOrEqual(-0.5);
              expect(box.right, label).toBeLessThanOrEqual(vp.w + 0.5);
              expect(box.bottom, label).toBeLessThanOrEqual(vp.h + 0.5);
            }
          }
        }
      }
    }
  });

  it("clears the pod by a comparable ABSOLUTE distance regardless of anchor", () => {
    // Clearance is derived from the pod's own footprint (`axisReach`
    // against POD_SIZE), not from how far that seat happens to sit from
    // table centre — an earlier version scaled with the latter (`len`)
    // on the assumption a wide table's TOP/BOTTOM seats sit further from
    // centre than LEFT/RIGHT ones, which is backwards: wide density's
    // real horizontal room means LEFT/RIGHT seats are the ones far from
    // centre, while a top seat sits close to it. That heuristic silently
    // changed the seats nobody complained about while leaving the actual
    // "too far from the pod" seats essentially untouched. Since
    // POD_SIZE is close to square at every density, every anchor should
    // now clear by roughly the same PX distance, independent of `len`.
    for (const density of DENSITIES) {
      const g = resolveTable({ seats: 4, width: 1440, height: 900, density });

      const clearanceOf = (seatId: number) => {
        const seat = g.seats.find((s) => s.seat === seatId)!;
        const box = pieceOnScreen("collected", seatId, 0, 1, g);
        const pileX = (box.left + box.right) / 2;
        const pileY = (box.top + box.bottom) / 2;
        return Math.hypot(seat.x - pileX, seat.y - pileY);
      };

      const topSeat = g.seats.find((s) => s.anchor === "top")!.seat;
      const sideSeat = g.seats.find((s) => s.anchor === "left" || s.anchor === "right")!.seat;
      const topClearance = clearanceOf(topSeat);
      const sideClearance = clearanceOf(sideSeat);

      const label = density;
      expect(topClearance, label).toBeGreaterThan(0);
      expect(sideClearance, label).toBeGreaterThan(0);
      // Within 20% of each other — comparable, not identical (the pod
      // isn't perfectly square), but nowhere near the several-times-off
      // gap the len-based version produced on a wide viewport.
      expect(Math.abs(topClearance - sideClearance), label).toBeLessThan(
        Math.max(topClearance, sideClearance) * 0.2,
      );
    }
  });
});

/* ============================================================
   The domino line's camera.
   ============================================================ */

/**
 * The chain is fitted to the screen by a camera rather than laid out
 * from index/count, so the guarantee is different in kind from the chip
 * piles above: it is not "this piece clamps back on screen" but "the
 * whole board is framed inside the zone reserved for it, at every length
 * a real game can reach". Two ways that breaks — the padding being too
 * thin for a rotated board, and the play area bleeding under a seat pod
 * — are both invisible until a chain happens to grow that far, which is
 * exactly the kind of bug this file exists for.
 */

/** Real chains, snapshotted after every play of a real round. */
function chainSnapshots(seats: number, seed: number): PlacedTile[][] {
  const rng = createRng(seed);
  const def = createDominoes({ target: 61 });
  let state = def.setup({ seats, rng });
  ({ state } = def.startRound!(state, rng));

  const snaps: PlacedTile[][] = [];
  let guard = 0;
  while (!def.isRoundOver!(state) && guard++ < 500) {
    const seat = def.currentSeat(state)!;
    const action = def.bots.steady.choose(def.playerView(state, seat), seat, rng);
    ({ state } = def.reduce(state, action));
    if (state.chain.length > 0) snaps.push(state.chain);
  }
  return snaps;
}

function boundsOf(chain: readonly PlacedTile[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of chain) {
    const { hw, hh } = cellHalfExtent(t.rot);
    minX = Math.min(minX, t.x - hw);
    minY = Math.min(minY, t.y - hh);
    maxX = Math.max(maxX, t.x + hw);
    maxY = Math.max(maxY, t.y + hh);
  }
  return { minX, minY, maxX, maxY };
}

function overlapsBox(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

describe("domino line — camera framing", () => {
  it("frames every chain length inside the line zone, clear of the seat pods", () => {
    for (const vp of VIEWPORTS) {
      for (const seats of [2, 3, 4]) {
        for (const density of DENSITIES) {
          const g = resolveTable({ seats, width: vp.w, height: vp.h, density });
          const zone = g.zones.line;
          const pods = g.seats.filter((s) => !s.isHero).map((s) => podBox(s, density));

          for (const chain of chainSnapshots(seats, 909 + seats)) {
            const cam = boardCamera(g, boundsOf(chain));
            const size = boardPieceSize(cam);

            for (const tile of chain) {
              const { cx, cy, rotate } = projectCell(
                { x: tile.x, y: tile.y, rot: tile.rot },
                cam,
              );
              // A quarter turn swaps which side is which on screen.
              const upright = Math.abs(rotate % 180) < 1;
              const w = upright ? size.short : size.long;
              const h = upright ? size.long : size.short;
              const rect: Box = { x: cx - w / 2, y: cy - h / 2, w, h };
              const label = `${vp.name}/${seats}seats/${density}/${chain.length} tiles/${tile.id}`;

              expect(rect.x, label).toBeGreaterThanOrEqual(zone.x - 0.5);
              expect(rect.y, label).toBeGreaterThanOrEqual(zone.y - 0.5);
              expect(rect.x + rect.w, label).toBeLessThanOrEqual(zone.x + zone.w + 0.5);
              expect(rect.y + rect.h, label).toBeLessThanOrEqual(zone.y + zone.h + 0.5);

              for (const pod of pods) {
                expect(overlapsBox(rect, pod), `${label} vs pod`).toBe(false);
              }
            }
          }
        }
      }
    }
  });

  it("holds a chain tile at or below the base box's tile", () => {
    // The clamp is what keeps the camera perfectly still for the opening
    // few tiles instead of blowing one domino up to fill the table. It is
    // the BASE BOX's tile rather than the table card's: a short chain is the
    // whole board, and it used to be drawn smaller than the tiles you hold
    // (docs/table-layout-rethink.md). The base box is what pieces render at
    // (the hand's own card on a phone, a little more on a laptop), so a
    // bigger tile would be an upscaled, blurred one.
    for (const vp of VIEWPORTS) {
      for (const density of DENSITIES) {
        const g = resolveTable({ seats: 3, width: vp.w, height: vp.h, density });
        const maxUnit = Math.min(g.pieceBox.w, g.pieceBox.h / 2);
        for (const chain of chainSnapshots(3, 1234)) {
          const cam = boardCamera(g, boundsOf(chain));
          expect(cam.unit).toBeLessThanOrEqual(maxUnit + 1e-9);
          expect(cam.unit).toBeGreaterThan(0);
        }
      }
    }
  });

  it("draws the opening tile as big as a tile in the hand wherever the line has room", () => {
    const g = resolveTable({ seats: 4, width: 390, height: 844 });
    const opening = boardCamera(g, { minX: -0.5, minY: -1, maxX: 0.5, maxY: 1 });
    expect(opening.unit).toBeCloseTo(Math.min(g.pieceBox.w, g.pieceBox.h / 2), 6);
  });

  it("never shrinks the board as the chain grows", () => {
    // The bounding box only ever grows, so the fit is monotonic. If this
    // ever fails the camera can oscillate, which reads as the table
    // breathing in and out under the player.
    const g = resolveTable({ seats: 4, width: 390, height: 844 });
    let previous = Infinity;
    for (const chain of chainSnapshots(4, 5309)) {
      const unit = boardCamera(g, boundsOf(chain)).unit;
      expect(unit).toBeLessThanOrEqual(previous + 1e-9);
      previous = unit;
    }
  });
});

describe("opponent tile hand — stays clear of the domino line", () => {
  // A domino hand starts at 6 or 7 tiles (see dominoes/state.ts's
  // `handSize`) and only shrinks from there.
  const MAX_HAND = 7;

  function handRect(g: ReturnType<typeof resolveTable>, seat: number, index: number, count: number) {
    const placement: Placement = { zone: "hand", seat, index, count, faceUp: false };
    const t = layoutPiece(placement, g, { kind: "tile" });
    const base = baseSize(g);
    const cx = t.x + base.w / 2;
    const cy = t.y + base.h / 2;
    // The tile's own rendered footprint, not the (larger, mostly
    // transparent) base container it's inscribed in — matching how the
    // "domino line" tests above measure a tile via `boardPieceSize`
    // rather than the container it also renders inside.
    const short = tileShortSide(g.miniCard);
    const long = short * 2;
    // A LEFT/RIGHT seat's rack stands its tiles on their short side
    // (`t.rotate` is ±90° there — see layout.ts's "hand" case), which
    // swaps the on-screen AABB. Measuring every seat with the upright
    // short/long box regardless of rotation would silently under-report
    // a rotated tile's true reach into `line` — the one direction this
    // whole test exists to catch.
    const rotated = Math.round((((t.rotate % 180) + 180) % 180) / 90) === 1;
    const w = rotated ? long : short;
    const h = rotated ? short : long;
    return { x: cx - w / 2, y: cy - h / 2, w, h } satisfies Box;
  }

  it("never overlaps the line zone at any density, seat count, or hand size", () => {
    // This is the bug from the /play/dominoes screenshot: an opponent's
    // fanned hand rendering on top of the chain, right where a played
    // tile is hardest to read. `line`'s own clearance (geometry.ts) and
    // this placement (layout.ts) used to be two independently guessed
    // numbers that quietly drifted apart — this is the permanent
    // guarantee that they can't again, the same role the pod-overlap
    // check above plays for the chain itself.
    //
    // Side seats used to be checked only up to 3 tiles, with a rack that
    // reached straight out from the pod and grew with hand size (see git
    // history / the [[domino-side-seat-hand-overlap]] memory) — a real
    // hand-size limit on a real bug. The rotated-rack redesign in
    // layout.ts makes clearance independent of hand size for every
    // anchor, so this now sweeps the FULL 7-tile hand for every seat.
    //
    // A forced density/viewport mismatch (`wide` tiles pushed onto a
    // phone, say — a real, supported lab-preview mode; `resolveDensity`
    // alone never produces one) is a separate axis from hand size and
    // still excluded for side seats: `sideBleed`'s own clamp
    // (`play.w * 0.3`, geometry.ts) can legitimately run out of room
    // for a rotated tile sized for a much bigger density than the
    // viewport, the same documented, accepted residual the old code
    // carried. Top seats have never needed this exclusion.
    for (const vp of VIEWPORTS) {
      const natural = resolveDensity(vp.w, vp.h);
      for (const seats of [2, 3, 4]) {
        for (const density of DENSITIES) {
          const g = resolveTable({ seats, width: vp.w, height: vp.h, density });
          for (const slot of g.seats) {
            if (slot.isHero) continue;
            if (slot.anchor !== "top" && density !== natural) continue;
            for (let count = 1; count <= MAX_HAND; count++) {
              for (let index = 0; index < count; index++) {
                const rect = handRect(g, slot.seat, index, count);
                const label = `${vp.name}/${seats}seats/${density}/seat${slot.seat}/hand${count}#${index}`;
                expect(overlapsBox(rect, g.zones.line), label).toBe(false);
              }
            }
          }
        }
      }
    }
  });

  it("never moves along the fan's FIXED axis as the hand's tile count changes", () => {
    // A tile hand fans along one screen axis and its position on the
    // OTHER axis should be a function of the seat's pod alone, never of
    // how many tiles are in it — TOP racks fan along x and hold a fixed
    // y (this broke once, for any seat not dead-centre on its edge: the
    // seat's small horizontal push component let the hand-width term
    // leak into the vertical anchor too, so a fuller hand visibly sank
    // lower on screen). LEFT/RIGHT racks now fan along y instead (the
    // rotated-column redesign) and so hold a fixed x — the same
    // invariant, on the axis that is now fixed for them.
    for (const vp of VIEWPORTS) {
      for (const seats of [2, 3, 4]) {
        for (const density of DENSITIES) {
          const g = resolveTable({ seats, width: vp.w, height: vp.h, density });
          for (const slot of g.seats) {
            if (slot.isHero) continue;
            const fixedAxis = slot.anchor === "top" ? "y" : "x";
            const centre = (count: number) => {
              const r = handRect(g, slot.seat, 0, count);
              return fixedAxis === "y" ? r.y : r.x;
            };
            const baseline = centre(1);
            for (let count = 2; count <= MAX_HAND; count++) {
              const label = `${vp.name}/${seats}seats/${density}/seat${slot.seat}/hand${count}`;
              expect(centre(count), label).toBeCloseTo(baseline, 5);
            }
          }
        }
      }
    }
  });

  it("never overlaps its own pod, at any density, seat count, or hand size", () => {
    // The follow-up to the vertical-drift bug above: fixing "moves with
    // hand size" by dropping the count-dependent term from a value that
    // ALSO set how far the hand sits from the pod (the two were the same
    // shared, projected scalar) quietly pulled the fixed baseline closer
    // to the pod too, for any off-centre top seat — caught live as the
    // hand's top-left tile lightly overlapping the pod card's corner.
    for (const vp of VIEWPORTS) {
      for (const seats of [2, 3, 4]) {
        for (const density of DENSITIES) {
          const g = resolveTable({ seats, width: vp.w, height: vp.h, density });
          // A TUCKED hand sits behind its pod by design — see the tucked
          // hands' own tests below. This is about a fanned rack.
          if (g.tuck) continue;
          for (const slot of g.seats) {
            if (slot.isHero) continue;
            const pod = podBox(slot, density);
            for (let count = 1; count <= MAX_HAND; count++) {
              for (let index = 0; index < count; index++) {
                const rect = handRect(g, slot.seat, index, count);
                const label = `${vp.name}/${seats}seats/${density}/seat${slot.seat}/hand${count}#${index}`;
                expect(overlapsBox(rect, pod), label).toBe(false);
              }
            }
          }
        }
      }
    }
  });
});

/**
 * The pannable discard fan, and the one thing it cannot do: draw a card
 * outside the region cleared for it.
 *
 * Reported from play, portrait phone, with a deep pile: panning one way
 * ran the fan up under the top seat's pod and off the top of the screen;
 * panning the other ran it down under the board sheet and back out again
 * in the gap below it, over the hand's own chrome. Both are the same
 * defect — a floored fan overflows its box BY DESIGN (that is what makes
 * it pannable) and nothing was hiding the part that spilled, because the
 * piece layer is one flat canvas with no wrapper to clip against.
 *
 * The cards fade themselves out at the boundary instead, on a band
 * anchored to each card's own CENTRE (`FADE_BAND_FRACTION`). Two crisp
 * promises come out of that, and they are what is checked here:
 *
 *   - **A card whose centre has left the region is not drawn at all.**
 *     So nothing is ever visible more than half a card past the edge.
 *   - **A fully drawn card overhangs by at most a few percent of its own
 *     size** — the band deliberately stops a hair short of the card's
 *     half-extent so an unfloored fan, whose outermost piece sits exactly
 *     flush, cannot be dimmed by float residue.
 *
 * The old behaviour fails both at the widest possible margin: opacity 1
 * with the whole card several card-lengths outside.
 */
describe("discard fan — never draws outside the pile region", () => {
  function fanCard(index: number, count: number, g: ReturnType<typeof resolveTable>, pan: number) {
    const placement: Placement = { zone: "discard", index, count, faceUp: true, fanned: true };
    const t = layoutPiece(placement, g, { kind: "card", discardScroll: pan });
    const base = baseSize(g);
    const w = base.w * t.scale;
    const h = base.h * t.scale;
    const cx = t.x + base.w / 2;
    const cy = t.y + base.h / 2;
    return {
      opacity: t.opacity,
      left: cx - w / 2,
      right: cx + w / 2,
      top: cy - h / 2,
      bottom: cy + h / 2,
    };
  }

  /** Real-game viewport/seat/depth matrix, with the board sheet's band
   *  reserved exactly as the play page reserves it. */
  function forEachFanCard(fn: (c: ReturnType<typeof fanCard>, label: string, g: ReturnType<typeof resolveTable>) => void) {
    for (const vp of VIEWPORTS) {
      for (const seats of [2, 4, 6]) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h, bottomZone: 204 });
        for (const count of [12, 20, 30, 45]) {
          const range = discardMaxScroll(g, count);
          // Both extremes and the middle: the spill lands at a different
          // end at each, and the report named both ends.
          for (const pan of [range / 2, 0, -range / 2]) {
            for (let i = 0; i < count; i++) {
              fn(
                fanCard(i, count, g, pan),
                `${vp.name}/${seats}seats/${count}cards/pan${Math.round(pan)}/card${i}`,
                g,
              );
            }
          }
        }
      }
    }
  }

  it("never draws any part of a card outside the region", () => {
    // The strong form, and what the fan box's `fadeMargin` inset buys.
    // The weaker "no card's CENTRE leaves the region" was not enough in
    // practice: a card is drawn while its centre is inside, so the
    // visible edge reached half a card further — ~46px on a desktop,
    // against a clearance of `PILE_BREATHING`. Reported as the far end of
    // a long pile lying across the next player's cards.
    let overflowed = 0;
    forEachFanCard((c, label, g) => {
      if (c.opacity <= 0) {
        overflowed++;
        return;
      }
      const R = g.pileRegion;
      expect(c.left, `${label}: drawn left of the region`).toBeGreaterThanOrEqual(R.x - 1);
      expect(c.right, `${label}: drawn right of the region`).toBeLessThanOrEqual(R.x + R.w + 1);
      expect(c.top, `${label}: drawn above the region`).toBeGreaterThanOrEqual(R.y - 1);
      expect(c.bottom, `${label}: drawn below the region`).toBeLessThanOrEqual(R.y + R.h + 1);
    });
    // Not vacuous: these depths really do pan cards right out of sight,
    // which is the whole reason the fade exists.
    expect(overflowed, "no pile in this matrix overflowed — nothing was tested").toBeGreaterThan(
      20,
    );
  });

  it("keeps a clear gap between the pile and every opponent's own cards", () => {
    // The reported symptom, asserted directly rather than only through
    // the region that is meant to prevent it.
    for (const vp of VIEWPORTS) {
      for (const seats of [3, 4, 6]) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h, bottomZone: 204 });
        const base = baseSize(g);
        const R = g.pileRegion;
        // Same documented exception `geometry.test.ts` carries: on a
        // short landscape phone that has also given up a band to the
        // board sheet, the clearances can leave no region at all and a
        // floor takes over. A pile that cannot be drawn is worse than one
        // sitting close, so there is nothing to assert here.
        if (R.h <= g.card.h * 1.2 + 0.001 || R.w <= g.card.w * 2.42 + 0.001) continue;
        for (const seat of g.seats) {
          if (seat.isHero) continue;
          const t = layoutPiece(
            { zone: "hand", seat: seat.seat, index: 0, count: 1, faceUp: false },
            g,
            { kind: "card" },
          );
          // A side seat's card is turned a quarter turn, so its on-screen
          // footprint has width and height swapped.
          const turned = Math.abs(t.rotate) === 90;
          const w = (turned ? base.h : base.w) * t.scale;
          const h = (turned ? base.w : base.h) * t.scale;
          const cx = t.x + base.w / 2;
          const cy = t.y + base.h / 2;
          const card: Box = { x: cx - w / 2, y: cy - h / 2, w, h };
          expect(
            overlapsBox(R, card),
            `${vp.name}/${seats}seats: seat ${seat.seat}'s card overlaps the pile region`,
          ).toBe(false);
        }
      }
    }
  });

  it("still draws the cards that DO fit at full strength", () => {
    // The fade must be an edge treatment, not a general dimming of a
    // deep pile — a fix that hid the spill by washing out the whole fan
    // would pass the test above and be much worse to play with.
    for (const vp of VIEWPORTS) {
      const g = resolveTable({ seats: 4, width: vp.w, height: vp.h, bottomZone: 140 });
      for (const count of [12, 30]) {
        const range = discardMaxScroll(g, count);
        const solid = Array.from({ length: count }, (_, i) =>
          fanCard(i, count, g, range / 2),
        ).filter((c) => c.opacity === 1);
        expect(
          solid.length,
          `${vp.name} @${count}: a pannable pile must still show a readable run of cards`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("leaves a pile that fits entirely alone", () => {
    // Opting into panning must not cost a short pile anything.
    for (const vp of VIEWPORTS) {
      const g = resolveTable({ seats: 4, width: vp.w, height: vp.h, bottomZone: 140 });
      for (let i = 0; i < 4; i++) {
        expect(fanCard(i, 4, g, 0).opacity, `${vp.name}/card${i}`).toBe(1);
      }
    }
  });
});

/**
 * The hero's own hand pans on exactly the same mechanism, so it has
 * exactly the same defect available to it — a hand that has swallowed
 * half the discard pile overflows its zone and the excess runs off both
 * screen edges. Same fade, checked the same way.
 */
describe("hero hand — never draws a card outside the hand zone", () => {
  function handCard(index: number, count: number, g: ReturnType<typeof resolveTable>, pan: number) {
    const placement: Placement = { zone: "hand", seat: 0, index, count, faceUp: true };
    const t = layoutPiece(placement, g, { kind: "card", handScroll: pan, handIndex: index });
    const base = baseSize(g);
    const cx = t.x + base.w / 2;
    // As drawn: the hand is scaled below the base box on a laptop.
    const half = (base.w * t.scale) / 2;
    return { opacity: t.opacity, left: cx - half, right: cx + half };
  }

  it("draws nothing once a card's centre has left the zone", () => {
    let gone = 0;
    for (const vp of VIEWPORTS) {
      const g = resolveTable({ seats: 4, width: vp.w, height: vp.h });
      for (const count of [24, 34, 48]) {
        const range = handFanMaxScroll(g, count);
        for (const pan of [range / 2, 0, -range / 2]) {
          for (let i = 0; i < count; i++) {
            const c = handCard(i, count, g, pan);
            const zone = g.zones.hand;
            const cx = (c.left + c.right) / 2;
            const label = `${vp.name}/${count}cards/pan${Math.round(pan)}/card${i}`;
            if (cx < zone.x || cx > zone.x + zone.w) {
              gone++;
              expect(c.opacity, `${label}: centre outside the zone but still drawn`).toBe(0);
            }
            if (c.opacity === 1) {
              const over = Math.max(zone.x - c.left, c.right - (zone.x + zone.w), 0);
              expect(over, `${label}: fully drawn while hanging out`).toBeLessThanOrEqual(
                (c.right - c.left) * 0.05 + 1,
              );
            }
          }
        }
      }
    }
    expect(gone, "no hand in this matrix overflowed — nothing was tested").toBeGreaterThan(10);
  });

  it("leaves an ordinary hand completely untouched", () => {
    // The common case: a hand that fits must be drawn exactly as before.
    // Thirteen cards no longer fit a portrait phone at half a card each
    // (the next test), but they still fit everywhere wider.
    for (const vp of VIEWPORTS) {
      const g = resolveTable({ seats: 4, width: vp.w, height: vp.h });
      const counts = vp.w < 600 ? [1, 7, 10] : [1, 7, 10, 13];
      for (const count of counts) {
        for (let i = 0; i < count; i++) {
          expect(handCard(i, count, g, 0).opacity, `${vp.name}/${count}/card${i}`).toBe(1);
        }
      }
    }
  });

  it("shows half of every card in a 13-card hand on a phone, and pans the rest", () => {
    // The user, 2026-09-28: on an iPhone a 13-card Spades hand showed about
    // 25px of each card, too thin to read or to tap. The floor is half a
    // card; what no longer fits pans, starting flush at the near edge.
    for (const w of [360, 375, 390, 430]) {
      const g = resolveTable({ seats: 4, width: w, height: Math.round(w * 2.16) });
      const range = handFanMaxScroll(g, 13);
      expect(range, `${w}px: 13 cards should pan`).toBeGreaterThan(0);
      const start = [0, 1, 2].map((i) => handCard(i, 13, g, range / 2));
      const cardW = start[0]!.right - start[0]!.left;
      expect(start[1]!.left - start[0]!.left, `${w}px: step`).toBeGreaterThanOrEqual(cardW * 0.5 - 0.01);
      expect(start[0]!.opacity, `${w}px: the first card at the near edge`).toBe(1);
    }
  });
});

describe("chip pile clamping — center (the pot)", () => {
  it("keeps a large pot fully on screen at every seat count and density", () => {
    for (const vp of VIEWPORTS) {
      for (const seats of SEAT_COUNTS) {
        for (const density of DENSITIES) {
          const g = resolveTable({ seats, width: vp.w, height: vp.h, density });
          // Every seat's starting chips could end up in the pot.
          const maxPot = seats * 3;
          for (let index = 0; index < maxPot; index++) {
            const box = pieceOnScreen("center", undefined, index, maxPot, g);
            const label = `${vp.name}/${seats}seats/${density}/pot${index}`;
            expect(box.left, label).toBeGreaterThanOrEqual(-0.5);
            expect(box.top, label).toBeGreaterThanOrEqual(-0.5);
            expect(box.right, label).toBeLessThanOrEqual(vp.w + 0.5);
            expect(box.bottom, label).toBeLessThanOrEqual(vp.h + 0.5);
          }
        }
      }
    }
  });
});


describe("hands, laid out from a seat that is not zero", () => {
  /**
   * `TableGeometry.seats` is ordered by POSITION — index 0 is always the
   * bottom-centre chair and the rest walk the ring. `layoutPiece` used to
   * index it with a SEAT id, which is the same thing exactly as long as
   * the viewer is seat 0, and silently returns somebody else's chair the
   * moment they are not.
   *
   * Online it was plainly visible and nobody was looking: a player at
   * seat 1 saw every opponent's hand one position out, and seat 0's hand
   * wrapped around to index 0 — the viewer's OWN chair — so the party
   * leader's tiles were drawn face-down underneath the player's hand.
   *
   * Asserted through `layoutPiece` rather than against `slotForSeat`
   * directly, because the bug was in the caller and a test of the helper
   * alone would have passed throughout.
   */
  const centreOf = (placement: Placement, g: ReturnType<typeof resolveTable>) => {
    const t = layoutPiece(placement, g);
    const base = baseSize(g);
    return { x: t.x + base.w / 2, y: t.y + base.h / 2 };
  };

  for (const seatCount of [4, 6]) {
    for (const viewerSeat of [0, 1, 2, 3]) {
      it(`${seatCount} seats, viewed from seat ${viewerSeat}: every hand sits at its own pod`, () => {
        const g = resolveTable({
          seats: seatCount,
          width: 1440,
          height: 900,
          density: "wide",
          viewerSeat,
        });

        for (const slot of g.seats) {
          if (slot.isHero) continue;
          const hand: Placement = {
            zone: "hand",
            seat: slot.seat,
            index: 0,
            count: 5,
            faceUp: false,
          };
          const { x, y } = centreOf(hand, g);
          // Pulled toward the table centre from the pod, so this is a
          // generous radius rather than an exact point — what it rules
          // out is the hand being at a DIFFERENT seat's chair, and the
          // chairs are much further apart than this.
          const distance = Math.hypot(x - slot.x, y - slot.y);
          const nearer = g.seats
            .filter((other) => other.seat !== slot.seat && !other.isHero)
            .map((other) => Math.hypot(x - other.x, y - other.y));
          expect(
            nearer.every((d) => d > distance),
            `seat ${slot.seat}'s hand is nearer somebody else's pod`,
          ).toBe(true);
        }
      });
    }
  }

  it("never lays another seat's hand on top of the viewer's own", () => {
    // The specific symptom that was reported: face-down tiles rendering
    // underneath the player's own hand, because seat 0 wrapped to the
    // hero slot.
    const g = resolveTable({
      seats: 4,
      width: 1120,
      height: 1650,
      density: "wide",
      viewerSeat: 1,
    });
    const hero = g.seats.find((slot) => slot.isHero)!;

    for (const slot of g.seats) {
      if (slot.isHero) continue;
      const { x, y } = centreOf(
        { zone: "hand", seat: slot.seat, index: 0, count: 5, faceUp: false },
        g,
      );
      expect(
        Math.hypot(x - hero.x, y - hero.y),
        `seat ${slot.seat}'s hand landed in the viewer's own chair`,
      ).toBeGreaterThan(200);
    }
  });
});

/**
 * `VIEWPORTS` plus the laptop sizes the centre-of-table collisions were
 * reported from. A browser window on a 1080p laptop is well under 900
 * tall once its own chrome is paid for, and that is where a centre zone
 * anchored to `play` first reaches up into the top seat's hand.
 */
const TABLE_VIEWPORTS = [
  ...VIEWPORTS,
  { name: "laptop 1080p", w: 1917, h: 977 },
  { name: "laptop 125%", w: 1536, h: 730 },
  { name: "laptop small", w: 1366, h: 650 },
  { name: "desktop 1440p", w: 2552, h: 1227 },
  // The audit's sizes (2026-09-26): tablets both ways round, and the
  // commonest laptop screen.
  { name: "tablet portrait", w: 768, h: 1024 },
  { name: "tablet landscape", w: 1024, h: 768 },
  { name: "laptop 1366", w: 1366, h: 768 },
];

/** A card's on-screen box, with a side seat's quarter turn accounted for. */
function cardRect(g: ReturnType<typeof resolveTable>, placement: Placement): Box {
  const t = layoutPiece(placement, g, { kind: "card" });
  const base = baseSize(g);
  const w = base.w * t.scale;
  const h = base.h * t.scale;
  const cx = t.x + base.w / 2;
  const cy = t.y + base.h / 2;
  const turned = Math.round((((t.rotate % 180) + 180) % 180) / 90) === 1;
  const [bw, bh] = turned ? [h, w] : [w, h];
  return { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
}

describe("trick — stays clear of every opponent's hand", () => {
  /**
   * Reported from a laptop: the partner's trick card sat up inside the
   * top seat's fanned hand. The trick was centred on `play`, which clears
   * the top pod but not the cards hanging below it — so it looked right on
   * a tall desktop and collided as soon as the screen got a little
   * shorter.
   */
  const TRICK_VIEWPORTS = TABLE_VIEWPORTS;
  const HAND = 13;
  const rect = cardRect;

  it("never overlaps an opponent's cards, on any screen", () => {
    const hits: string[] = [];
    for (const vp of TRICK_VIEWPORTS) {
      for (const seats of [2, 3, 4, 5, 6]) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h });
        const trick = Array.from({ length: seats }, (_, seat) =>
          rect(g, { zone: "trick", seat, index: 0, count: 1, faceUp: true }),
        );
        for (let seat = 1; seat < seats; seat++) {
          for (let index = 0; index < HAND; index++) {
            const card = rect(g, { zone: "hand", seat, index, count: HAND, faceUp: false });
            trick.forEach((t, from) => {
              if (overlapsBox(t, card)) hits.push(`${vp.name} ${seats} seats: seat ${from}'s trick card on seat ${seat}'s hand`);
            });
          }
        }
      }
    }
    expect([...new Set(hits)].slice(0, 8)).toEqual([]);
  });
});

describe("poker's centre — stays clear of every opponent's hand", () => {
  /**
   * The same report as the trick's, from a poker table on a laptop: the
   * community row sat inside the top seats' hole cards. Poker's centre is
   * one vertical chain (community, pot, stub + burn), and it was anchored
   * to `play`, which clears the pods but not the cards below them.
   */
  it("never overlaps an opponent's hole cards, on any screen", () => {
    const hits: string[] = [];
    for (const vp of TABLE_VIEWPORTS) {
      for (let seats = 2; seats <= 10; seats++) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h });
        const centre: Array<[string, Box]> = [
          ...[0, 1, 2, 3, 4].map((index): [string, Box] => [
            `community ${index}`,
            cardRect(g, { zone: "community", index, count: 5, faceUp: true }),
          ]),
          ["stub", cardRect(g, { zone: "stub", index: 0, count: 40, faceUp: false })],
          ["burnt", cardRect(g, { zone: "burnt", index: 0, count: 3, faceUp: false })],
          ["pot", g.zones.pot],
        ];
        for (let seat = 1; seat < seats; seat++) {
          for (let index = 0; index < 2; index++) {
            const card = cardRect(g, { zone: "hand", seat, index, count: 2, faceUp: false });
            for (const [name, box] of centre) {
              if (overlapsBox(box, card)) hits.push(`${vp.name} ${seats} seats: ${name} on seat ${seat}'s hand`);
            }
          }
        }
      }
    }
    expect([...new Set(hits)].slice(0, 10)).toEqual([]);
  });
});

describe("the band above the hand — nothing on the table sits under it", () => {
  /**
   * `HandZone` owns the band above the hand: the turn line, the viewer's
   * readouts, and any decision bigger than a row (Spades' bid, Poker's
   * betting). It used to reserve nothing — the row was drawn over the
   * bottom of the ring and the decisions floated over the table on a
   * `calc()`, over the flop and the lowest pods. The surface now reserves
   * the band's ONE ROW (`ResolveOptions.bandZone`), and this holds the table
   * to it — each game with the zones it really uses. A decision panel above
   * the row (a bid, a bet) is drawn over the felt and never reserved:
   * reserving it re-laid the table out every time one opened (the user's
   * call, 2026-09-28).
   *
   * The one allowance is the documented one: a centre chain that has
   * already shrunk to the smallest legible card (`zoneScale` at its floor)
   * may overhang rather than shrink into illegibility.
   */
  const GAMES: Array<{
    game: string;
    seats: number[];
    /** Cards in an opponent's hand — the most the game deals. */
    hand: number;
    zones: readonly ZoneName[];
    bottomZone?: number;
    /** A panel reserved always (`panelReserve`) — Poker's betting. */
    reserve?: (vp: { w: number; h: number }) => number;
  }> = [
    {
      game: "poker",
      seats: [2, 4, 6, 8, 10],
      hand: 2,
      zones: ["community", "pot", "stub", "burnt"],
      reserve: (vp) => (vp.w >= 1024 ? 104 : vp.h < 560 && vp.w >= 640 ? 84 : 114),
    },
    { game: "bs", seats: [2, 4, 6], hand: 13, zones: ["reveal", "pile"] },
    { game: "spades", seats: [4], hand: 13, zones: ["trick"] },
    { game: "rummy", seats: [2, 4, 6], hand: 10, zones: ["deck", "discard"], bottomZone: 140 },
    { game: "dominoes", seats: [2, 3, 4], hand: 7, zones: ["line"] },
  ];

  it("grants at least the band's own row, on every screen", () => {
    for (const vp of TABLE_VIEWPORTS) {
      const row = handHeaderHeight(vp.h);
      const g = resolveTable({ seats: 6, width: vp.w, height: vp.h, bandZone: row });
      expect(g.band.h, vp.name).toBe(row);
      expect(g.band.y + g.band.h, vp.name).toBeCloseTo(g.zones.hand.y);
    }
  });

  it("keeps every pod, hand and centre zone out of it", () => {
    const hits: string[] = [];
    for (const vp of TABLE_VIEWPORTS) {
      const row = handHeaderHeight(vp.h);
      for (const game of GAMES) {
        for (const seats of game.seats) {
          const g = resolveTable({
            seats,
            width: vp.w,
            height: vp.h,
            bandZone: row + (game.reserve?.(vp) ?? 0),
            bottomZone: game.bottomZone,
          });
          const label = `${vp.name}, ${game.game} at ${seats}`;
          for (const slot of g.seats) {
            if (slot.isHero) continue;
            if (overlapsBox(podBox(slot, g.density), g.band)) hits.push(`${label}: seat ${slot.seat}'s pod`);
            for (let index = 0; index < game.hand; index++) {
              const card = cardRect(g, { zone: "hand", seat: slot.seat, index, count: game.hand, faceUp: false });
              if (overlapsBox(card, g.band)) hits.push(`${label}: seat ${slot.seat}'s hand`);
            }
          }
          const floor = Math.min(1, 40 / g.card.h);
          for (const zone of game.zones) {
            const atFloor = (g.zoneScale[zone] ?? 1) <= floor + 1e-9;
            if (overlapsBox(g.zones[zone], g.band) && !atFloor) hits.push(`${label}: ${zone}`);
          }
          // The viewer's own pile (LRC's chips, Spades' tricks) starts above
          // the band rather than under it.
          const own = cardRect(g, { zone: "collected", seat: 0, index: 0, count: 3, faceUp: true });
          if (overlapsBox(own, g.band)) hits.push(`${label}: the viewer's own pile`);
        }
      }
    }
    expect([...new Set(hits)].slice(0, 12)).toEqual([]);
  });
});

describe("the toast lane", () => {
  /**
   * Toasts sit top left (the user's call, 2026-09-28): below the corner
   * buttons, which a toast would otherwise cover and swallow the tap on, and
   * nowhere near the band or the hand at the bottom.
   */
  it("sits below the corner buttons, far above the band", () => {
    for (const vp of TABLE_VIEWPORTS) {
      for (const seats of [2, 4, 6, 10]) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h, bandZone: handHeaderHeight(vp.h) });
        const lane = toastLane(g);
        expect(lane, `${vp.name}, ${seats} seats`).toBeGreaterThanOrEqual(CORNER_CLEAR);
        expect(lane + 40, `${vp.name}, ${seats} seats`).toBeLessThanOrEqual(g.band.y);
      }
    }
  });

  /**
   * "Reconnecting…" keeps the old top lane, so it never stacks with a
   * toast: below every pod on the top edge (where it used to cover a
   * name), and never as low as the band.
   */
  it("keeps the status lane below the top pods, and above the band", () => {
    for (const vp of TABLE_VIEWPORTS) {
      for (const seats of [2, 4, 6, 10]) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h, bandZone: handHeaderHeight(vp.h) });
        const lane = statusLane(g);
        for (const slot of g.seats.filter((s) => s.anchor === "top")) {
          const pod = podBox(slot, g.density);
          expect(lane, `${vp.name}, ${seats} seats`).toBeGreaterThanOrEqual(pod.y + pod.h);
        }
        expect(lane, `${vp.name}, ${seats} seats`).toBeLessThan(g.band.y);
      }
    }
  });
});

/**
 * Board zones are fitted to the room they have, and may grow past the
 * table card (see `stageCeiling`) — but never past the base box every
 * piece renders at. Pieces are `will-change: transform`, so the browser
 * rasterises them at the base size and scales the bitmap: a scale above 1
 * is a blurred card.
 */
describe("board zones — grow to fit, never past the base box", () => {
  const BOARD: Placement[] = [
    { zone: "trick", seat: 1, index: 0, count: 4, faceUp: true },
    { zone: "deck", index: 0, count: 1, faceUp: true },
    { zone: "discard", index: 0, count: 1, faceUp: true },
    { zone: "board", index: 0, count: 3, faceUp: true, group: 0 },
    { zone: "community", index: 0, count: 5, faceUp: true },
    { zone: "reveal", index: 0, count: 4, faceUp: true },
    { zone: "pile", index: 0, count: 1, faceUp: false },
  ];

  it("draws every board piece at a scale of at most 1, everywhere", () => {
    for (const vp of [...VIEWPORTS, { name: "tablet", w: 768, h: 1024 }]) {
      for (const seats of SEAT_COUNTS) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h });
        for (const p of BOARD) {
          const t = layoutPiece(p, g, { kind: "card" });
          expect(t.scale, `${vp.name}, ${seats} seats, ${p.zone}`).toBeLessThanOrEqual(1 + 1e-9);
        }
      }
    }
  });

  it("draws the trick no smaller than the table card it used to be", () => {
    for (const vp of [...VIEWPORTS, { name: "tablet", w: 768, h: 1024 }]) {
      for (const seats of [2, 3, 4]) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h });
        const t = layoutPiece(BOARD[0]!, g, { kind: "card" });
        expect(t.scale * baseSize(g).w, `${vp.name}, ${seats} seats`).toBeGreaterThanOrEqual(
          g.card.w - 1e-6,
        );
      }
    }
  });
});

/**
 * On a phone an opponent's face-down hand tucks behind their pod (the
 * user's call, 2026-09-27). It may peek a few px past the pod's inner edge
 * — that is what makes it read as a hand — but it must cost the board
 * nothing: never into the domino line, never into the pile region, never
 * far from the pod it belongs to. Measured on the real laid-out pieces, so
 * no second model of where a hand "should" reach can drift from layout.ts.
 */
describe("tucked hands — behind the pod, never on the board", () => {
  const PHONES = [
    { name: "phone 390", w: 390, h: 844 },
    { name: "phone 360", w: 360, h: 780 },
    { name: "phone 430", w: 430, h: 932 },
  ];

  function drawn(g: ReturnType<typeof resolveTable>, p: Placement, kind: "card" | "tile"): Box {
    const t = layoutPiece(p, g, { kind });
    const base = baseSize(g);
    const w = (kind === "tile" ? Math.min(base.w, base.h / 2) : base.w) * t.scale;
    const h = (kind === "tile" ? w * 2 : base.h * t.scale);
    const turned = Math.round((((t.rotate % 180) + 180) % 180) / 90) === 1;
    // A small tilt reaches a little further than the upright box; pad for it.
    const [bw, bh] = turned ? [h, w] : [w, h];
    const cx = t.x + base.w / 2;
    const cy = t.y + base.h / 2;
    return { x: cx - bw / 2 - 2, y: cy - bh / 2 - 2, w: bw + 4, h: bh + 4 };
  }

  it("is the phone profile's choice, and only its", () => {
    expect(resolveTable({ seats: 4, width: 390, height: 844 }).tuck).toBe(true);
    expect(resolveTable({ seats: 4, width: 1440, height: 900 }).tuck).toBe(false);
    expect(resolveTable({ seats: 4, width: 768, height: 1024 }).tuck).toBe(false);
  });

  it("stays within a peek of its own pod, and off the board, for every hand", () => {
    for (const vp of PHONES) {
      for (const seats of SEAT_COUNTS) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h });
        for (const slot of g.seats) {
          if (slot.isHero) continue;
          const pod = podBox(slot, g.density);
          // The peek past its inner edge, the wider-than-the-pod spread along
          // its edge, and a tilt's corners.
          const m = g.miniCard.h * TUCK_PEEK_FRACTION + 8;
          const near: Box = { x: pod.x - m, y: pod.y - m, w: pod.w + 2 * m, h: pod.h + 2 * m };
          for (const kind of ["card", "tile"] as const) {
            if (kind === "tile" && seats > 4) continue;
            const max = kind === "tile" ? 7 : 13;
            for (let count = 1; count <= max; count++) {
              for (let index = 0; index < count; index++) {
                const p: Placement = { zone: "hand", seat: slot.seat, index, count, faceUp: false };
                const r = drawn(g, p, kind);
                const label = `${vp.name}/${seats} seats/seat ${slot.seat}/${kind} ${index + 1} of ${count}`;
                expect(r.x >= near.x && r.y >= near.y, label).toBe(true);
                expect(r.x + r.w <= near.x + near.w && r.y + r.h <= near.y + near.h, label).toBe(true);
                if (kind === "tile") expect(overlapsBox(r, g.zones.line), `${label}: line`).toBe(false);
                else expect(overlapsBox(r, g.pileRegion), `${label}: pile region`).toBe(false);
              }
            }
          }
        }
      }
    }
  });

  it("draws a face-up (shown) hand over its pod, upright and readable", () => {
    const g = resolveTable({ seats: 6, width: 390, height: 844 });
    for (const slot of g.seats) {
      if (slot.isHero) continue;
      const pod = podBox(slot, g.density);
      for (let index = 0; index < 2; index++) {
        const p: Placement = { zone: "hand", seat: slot.seat, index, count: 2, faceUp: true };
        const t = layoutPiece(p, g, { kind: "card" });
        expect(Math.abs(t.rotate), `seat ${slot.seat}`).toBeLessThanOrEqual(6);
        const r = drawn(g, p, "card");
        expect(overlapsBox(r, pod), `seat ${slot.seat}`).toBe(true);
        expect(r.h, "legible").toBeGreaterThanOrEqual(40);
      }
    }
  });
});

/**
 * LRC dealt Sam's chips onto Mia's avatar: with two seats stacked high down
 * a phone's side, a chip pile aimed at the board's centre ran straight down
 * through the pod below its own. Face-up piles hang off their pod's inner
 * EDGE on the rim, and must never land on anybody else's pod.
 */
describe("chip piles on the rim — never on another seat's pod", () => {
  it("keeps every face-up pile off every other pod, on every phone", () => {
    for (const vp of [
      { w: 360, h: 780 },
      { w: 390, h: 844 },
      { w: 430, h: 932 },
      { w: 844, h: 390 },
    ]) {
      for (const seats of [3, 4, 5, 6, 7, 8, 9, 10]) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h, handZone: 64, bandZone: 64 });
        for (const slot of g.seats) {
          if (slot.isHero) continue;
          for (let count = 1; count <= 9; count++) {
            for (let index = 0; index < count; index++) {
              const chip = pieceOnScreen("collected", slot.seat, index, count, g);
              // The chip's drawn disc, not its card-shaped base box.
              const d = g.miniCard.w;
              const cx = (chip.left + chip.right) / 2;
              const cy = (chip.top + chip.bottom) / 2;
              const disc: Box = { x: cx - d / 2, y: cy - d / 2, w: d, h: d };
              for (const other of g.seats) {
                if (other.isHero || other.seat === slot.seat) continue;
                expect(
                  overlapsBox(disc, podBox(other, g.density)),
                  `${vp.w}x${vp.h}/${seats} seats: seat ${slot.seat}'s chip ${index + 1}/${count} on seat ${other.seat}'s pod`,
                ).toBe(false);
              }
            }
          }
        }
      }
    }
  });
});

/**
 * Past what its room shows one by one, a chip pile becomes ONE stack with
 * its count written on top (the user's call, 2026-09-28): the pot's grid
 * sat on the dice on a phone, and fifteen chips beside a pod stopped being
 * a count anyone could read.
 */
describe("chip piles that become one stack", () => {
  const phone = () => resolveTable({ seats: 9, width: 390, height: 844, handZone: 16, bandZone: 64 });
  const laptop = () => resolveTable({ seats: 9, width: 1280, height: 800, handZone: 16, bandZone: 64 });
  const centre = (zone: "center" | "collected", seat: number | undefined, index: number, count: number, g: ReturnType<typeof resolveTable>) => {
    const b = pieceOnScreen(zone, seat, index, count, g);
    return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
  };

  it("stacks a phone's pot from two chips, and a larger screen's past ten", () => {
    expect(chipPileStacks(phone(), { zone: "center", count: 1 })).toBe(false);
    expect(chipPileStacks(phone(), { zone: "center", count: 2 })).toBe(true);
    expect(chipPileStacks(laptop(), { zone: "center", count: 10 })).toBe(false);
    expect(chipPileStacks(laptop(), { zone: "center", count: 11 })).toBe(true);
  });

  it("stacks a seat's pile past three rows", () => {
    const top = (g: ReturnType<typeof resolveTable>) => g.seats.find((s) => s.anchor === "top")!.seat;
    const g = phone();
    expect(chipPileStacks(g, { zone: "collected", seat: top(g), count: 6 })).toBe(false);
    expect(chipPileStacks(g, { zone: "collected", seat: top(g), count: 7 })).toBe(true);
    const l = laptop();
    expect(chipPileStacks(l, { zone: "collected", seat: top(l), count: 9 })).toBe(false);
    expect(chipPileStacks(l, { zone: "collected", seat: top(l), count: 10 })).toBe(true);
  });

  it("stacks sooner where a third row would reach the pot", () => {
    // On a landscape phone the viewer's pile rises from the band toward the
    // pot, and its second row ran into it — with the three chips a round
    // starts with.
    const g = resolveTable({ seats: 8, width: 844, height: 390, handZone: 16, bandZone: 64 });
    expect(chipPileStacks(g, { zone: "collected", seat: 0, count: 2 })).toBe(false);
    expect(chipPileStacks(g, { zone: "collected", seat: 0, count: 3 })).toBe(true);
  });

  it("puts every chip of a stack on the pile's first spot, each a hair higher", () => {
    const g = phone();
    const d = g.miniCard.w;
    for (const [zone, seat, count] of [
      ["center", undefined, 15],
      ["collected", g.seats.find((s) => s.anchor === "left")!.seat, 15],
    ] as const) {
      const first = centre(zone, seat, 0, 1, g);
      let above = Infinity;
      for (let index = 0; index < count; index++) {
        const c = centre(zone, seat, index, count, g);
        expect(Math.abs(c.x - first.x), `${zone} chip ${index}`).toBeLessThan(0.01);
        expect(first.y - c.y, `${zone} chip ${index}`).toBeLessThanOrEqual(d * 0.4);
        expect(c.y, `${zone} chip ${index}`).toBeLessThanOrEqual(above);
        above = c.y;
      }
    }
  });

  it("keeps a phone's stacked pot off the dice", () => {
    for (const vp of [
      { w: 360, h: 780 },
      { w: 390, h: 844 },
      { w: 844, h: 390 },
    ]) {
      for (const seats of [2, 5, 9]) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h, handZone: 16, bandZone: 64 });
        const dice = g.zones.dice;
        const top = pieceOnScreen("center", undefined, seats * 3 - 1, seats * 3, g);
        // The disc is as wide as the drawn box; its top is that far above its centre.
        const discTop = (top.top + top.bottom) / 2 - (top.right - top.left) / 2;
        expect(discTop, `${vp.w}x${vp.h}/${seats} seats`).toBeGreaterThanOrEqual(dice.y + dice.h);
      }
    }
  });

  it("keeps every seat's pile off the dice and the pot", () => {
    // Nine seats on a 390px phone put a side seat level with the dice, and
    // the second column of its pile covered the left die.
    for (const vp of [
      { w: 360, h: 780 },
      { w: 390, h: 844 },
      { w: 430, h: 932 },
      { w: 844, h: 390 },
      { w: 932, h: 430 },
      { w: 1280, h: 800 },
      { w: 1440, h: 900 },
    ]) {
      for (const seats of [3, 5, 7, 8, 9, 10]) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h, handZone: 16, bandZone: 64 });
        const dice = g.zones.dice;
        const d = g.miniCard.w;
        // The pot at the most it is ever drawn loose.
        const most = g.profile === "roomy" ? 10 : 7;
        const pot = Array.from({ length: most }, (_, i) => {
          const b = pieceOnScreen("center", undefined, i, most, g);
          const c = { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
          const w = b.right - b.left;
          return { x: c.x - w / 2, y: c.y - w / 2, w, h: w };
        });
        for (const slot of g.seats) {
          for (let count = 1; count <= 15; count++) {
            for (let index = 0; index < count; index++) {
              const chip = pieceOnScreen("collected", slot.seat, index, count, g);
              const cx = (chip.left + chip.right) / 2;
              const cy = (chip.top + chip.bottom) / 2;
              const disc: Box = { x: cx - d / 2, y: cy - d / 2, w: d, h: d };
              expect(
                overlapsBox(disc, dice),
                `${vp.w}x${vp.h}/${seats} seats: seat ${slot.seat}'s chip ${index + 1}/${count} on the dice`,
              ).toBe(false);
              for (const chip of pot) {
                expect(
                  overlapsBox(disc, chip),
                  `${vp.w}x${vp.h}/${seats} seats: seat ${slot.seat}'s chip ${index + 1}/${count} on the pot`,
                ).toBe(false);
              }
            }
          }
        }
      }
    }
  });

  it("writes one count per stack, on its top chip", () => {
    const g = phone();
    const left = g.seats.find((s) => s.anchor === "left")!.seat;
    const placements: Record<string, Placement> = {};
    for (let i = 0; i < 4; i++) placements[`p${i}`] = { zone: "center", index: i, count: 4, faceUp: true };
    for (let i = 0; i < 8; i++) placements[`s${i}`] = { zone: "collected", seat: left, index: i, count: 8, faceUp: true };
    for (let i = 0; i < 3; i++) placements[`h${i}`] = { zone: "collected", seat: 0, index: i, count: 3, faceUp: true };

    const badges = chipStackBadges(g, placements);
    expect(badges.map((b) => b.count).sort((a, b) => a - b)).toEqual([4, 8]);
    const pot = badges.find((b) => b.count === 4)!;
    const top = centre("center", undefined, 3, 4, g);
    expect(pot.cx).toBeCloseTo(top.x, 5);
    expect(pot.cy).toBeCloseTo(top.y, 5);
  });
});
