import { describe, expect, it } from "vitest";
import {
  cellHalfExtent,
  podBox,
  resolveDensity,
  resolveTable,
  tileShortSide,
  type Box,
  type Density,
} from "./geometry";
import { boardCamera, boardPieceSize, layoutPiece, projectCell, baseSize } from "./layout";
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
  const t = layoutPiece(placement, g);
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
  const def = createDominoes(61);
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

  it("holds a chain tile at or below the normal table piece size", () => {
    // The clamp is what keeps the camera perfectly still for the opening
    // few tiles instead of blowing one domino up to fill the table.
    for (const vp of VIEWPORTS) {
      for (const density of DENSITIES) {
        const g = resolveTable({ seats: 3, width: vp.w, height: vp.h, density });
        const maxUnit = Math.min(g.card.w, g.card.h / 2);
        for (const chain of chainSnapshots(3, 1234)) {
          const cam = boardCamera(g, boundsOf(chain));
          expect(cam.unit).toBeLessThanOrEqual(maxUnit + 1e-9);
          expect(cam.unit).toBeGreaterThan(0);
        }
      }
    }
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
    const w = tileShortSide(g.miniCard);
    const h = w * 2;
    return { x: cx - w / 2, y: cy - h / 2, w, h } satisfies Box;
  }

  // A side-anchored seat's rack reaches straight out from its pod along
  // the SAME axis it fans in (see layout.ts's "hand" case) — there is
  // no room to fully clear `line` there once the hand gets big on a
  // FORCED density/viewport mismatch (`wide` tiles pushed onto a phone,
  // say — the lab preview can do this; `resolveDensity` alone never
  // would), short of rotating the rack to stand along the pod's edge
  // instead, which no seat needs today (dominoes tops out at 4 seats,
  // and only that table ever puts a hand on a side edge at all — see
  // the matching clamp comment on `sideBleed` in geometry.ts). Top/
  // bottom seats fan perpendicular to their push and have no such
  // ceiling, forced mismatch or not.
  const MAX_HAND_SIDE_SAFE = 3;

  it("never overlaps the line zone at any density, seat count, or hand size", () => {
    // This is the bug from the /play/dominoes screenshot: an opponent's
    // fanned hand rendering on top of the chain, right where a played
    // tile is hardest to read. `line`'s own clearance (geometry.ts) and
    // this placement (layout.ts) used to be two independently guessed
    // numbers that quietly drifted apart — this is the permanent
    // guarantee that they can't again, the same role the pod-overlap
    // check above plays for the chain itself.
    for (const vp of VIEWPORTS) {
      const natural = resolveDensity(vp.w, vp.h);
      for (const seats of [2, 3, 4]) {
        for (const density of DENSITIES) {
          const g = resolveTable({ seats, width: vp.w, height: vp.h, density });
          for (const slot of g.seats) {
            if (slot.isHero) continue;
            // A forced density/viewport mismatch is a real, supported
            // lab-preview mode, but only for the seats it was already
            // proven exact for — see the comment above.
            if (slot.anchor !== "top" && density !== natural) continue;
            const maxHand = slot.anchor === "top" ? MAX_HAND : MAX_HAND_SIDE_SAFE;
            for (let count = 1; count <= maxHand; count++) {
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

  it("never moves a hand vertically as the hand's tile count changes", () => {
    // A tile hand fans along screen-x only (see layout.ts's "hand"
    // case) — its vertical position should be a function of the seat's
    // pod alone, never of how many tiles are in it. This broke for any
    // seat not dead-centre on its edge (any edge with 2+ opponents,
    // e.g. the exact 3-seat/both-on-top table from the /play/dominoes
    // screenshot): the seat's small horizontal push component let the
    // hand-width term leak into the vertical anchor too, so a fuller
    // hand visibly sank lower on screen.
    for (const vp of VIEWPORTS) {
      for (const seats of [2, 3, 4]) {
        for (const density of DENSITIES) {
          const g = resolveTable({ seats, width: vp.w, height: vp.h, density });
          for (const slot of g.seats) {
            if (slot.isHero) continue;
            const centreY = (count: number) => handRect(g, slot.seat, 0, count).y;
            const baseline = centreY(1);
            for (let count = 2; count <= MAX_HAND; count++) {
              const label = `${vp.name}/${seats}seats/${density}/seat${slot.seat}/hand${count}`;
              expect(centreY(count), label).toBeCloseTo(baseline, 5);
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
