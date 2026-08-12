import { describe, expect, it } from "vitest";
import { resolveTable, type Density } from "./geometry";
import { layoutPiece, baseSize } from "./layout";
import type { Placement } from "@/engine/types";

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
