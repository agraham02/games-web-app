import { describe, expect, it } from "vitest";
import {
  allocateEdges,
  fanSlot,
  POD_GAP,
  resolveDensity,
  resolveTable,
  type Density,
} from "./geometry";
import { HERO } from "@/engine/types";

/**
 * Every viewport the app must survive. Portrait phone through desktop,
 * including the awkward short-landscape case.
 */
const VIEWPORTS = [
  { name: "phone portrait", w: 390, h: 844 },
  { name: "phone portrait small", w: 360, h: 640 },
  { name: "phone landscape", w: 844, h: 390 },
  { name: "tablet portrait", w: 768, h: 1024 },
  { name: "desktop", w: 1440, h: 900 },
  { name: "desktop tall", w: 1280, h: 1100 },
];

const SEAT_COUNTS = [2, 3, 4, 5, 6, 7, 8, 9, 10];
const DENSITIES: Density[] = ["compact", "regular", "wide"];

describe("resolveDensity", () => {
  it("demotes short landscape phones out of the wide tier", () => {
    // 844x390 is wide enough for `wide` on width alone, but has no
    // vertical room for 118px hand cards plus a seat ring.
    expect(resolveDensity(844, 390)).toBe("regular");
    expect(resolveDensity(1440, 900)).toBe("wide");
    expect(resolveDensity(390, 844)).toBe("compact");
  });
});

describe("allocateEdges", () => {
  it("allocates every opponent exactly once", () => {
    for (const density of DENSITIES) {
      for (let opponents = 1; opponents <= 9; opponents++) {
        const [l, t, r] = allocateEdges(opponents, density, 800, 500);
        expect(l + t + r, `${density}/${opponents}`).toBe(opponents);
      }
    }
  });

  it("keeps the two sides symmetric so the table never looks lopsided", () => {
    for (const density of DENSITIES) {
      for (let opponents = 1; opponents <= 9; opponents++) {
        const [l, , r] = allocateEdges(opponents, density, 800, 500);
        expect(l, `${density}/${opponents}`).toBe(r);
      }
    }
  });

  it("falls back proportionally beyond the tuned table", () => {
    const [l, t, r] = allocateEdges(14, "wide", 1200, 600);
    expect(l + t + r).toBe(14);
    expect(l).toBe(r);
  });
});

describe("resolveTable", () => {
  it("seats the hero at bottom centre in every configuration", () => {
    for (const vp of VIEWPORTS) {
      for (const seats of SEAT_COUNTS) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h });
        const hero = g.seats.find((s) => s.isHero)!;

        expect(hero.seat, `${vp.name}/${seats}`).toBe(HERO);
        expect(hero.anchor).toBe("bottom");
        expect(hero.x).toBeCloseTo(vp.w / 2, 5);
        // Hero lives in the bottom third, always.
        expect(hero.y).toBeGreaterThan(vp.h * 0.66);
      }
    }
  });

  it("creates exactly one slot per seat, numbered contiguously", () => {
    for (const vp of VIEWPORTS) {
      for (const seats of SEAT_COUNTS) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h });
        expect(g.seats, `${vp.name}/${seats}`).toHaveLength(seats);
        expect(g.seats.map((s) => s.seat)).toEqual(
          Array.from({ length: seats }, (_, i) => i),
        );
      }
    }
  });

  it("never overlaps two seat pods", () => {
    for (const vp of VIEWPORTS) {
      for (const seats of SEAT_COUNTS) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h });
        const min = POD_GAP[g.density];

        for (let i = 0; i < g.seats.length; i++) {
          for (let j = i + 1; j < g.seats.length; j++) {
            const a = g.seats[i]!;
            const b = g.seats[j]!;
            const dist = Math.hypot(a.x - b.x, a.y - b.y);
            expect(
              dist,
              `${vp.name}/${seats} seats ${a.seat}&${b.seat} (${g.density})`,
            ).toBeGreaterThanOrEqual(min);
          }
        }
      }
    }
  });

  it("keeps every seat inside the viewport", () => {
    for (const vp of VIEWPORTS) {
      for (const seats of SEAT_COUNTS) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h });
        for (const s of g.seats) {
          expect(s.x, `${vp.name}/${seats}/seat${s.seat}`).toBeGreaterThanOrEqual(0);
          expect(s.x).toBeLessThanOrEqual(vp.w);
          expect(s.y).toBeGreaterThanOrEqual(0);
          expect(s.y).toBeLessThanOrEqual(vp.h);
        }
      }
    }
  });

  it("orders opponents anticlockwise from the hero's left", () => {
    // 7 seats on a desktop = 6 opponents = [2 left, 2 top, 2 right].
    const g = resolveTable({ seats: 7, width: 1440, height: 900 });
    const opponents = g.seats.filter((s) => !s.isHero);

    expect(opponents.map((s) => s.anchor)).toEqual([
      "left",
      "left",
      "top",
      "top",
      "right",
      "right",
    ]);

    // Seat 1 is the hero's immediate left, so it sits LOWER on screen
    // than seat 2 (the walk goes bottom-to-top up the left edge).
    expect(opponents[0]!.y).toBeGreaterThan(opponents[1]!.y);
    // The top edge runs left to right.
    expect(opponents[2]!.x).toBeLessThan(opponents[3]!.x);
    // The right edge runs top to bottom, ending at the hero's right.
    expect(opponents[4]!.y).toBeLessThan(opponents[5]!.y);
  });

  it("never lets the play area collide with the hand strip", () => {
    for (const vp of VIEWPORTS) {
      for (const seats of SEAT_COUNTS) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h });
        const playBottom = g.zones.play.y + g.zones.play.h;
        expect(playBottom, `${vp.name}/${seats}`).toBeLessThanOrEqual(
          g.zones.hand.y + 1,
        );
      }
    }
  });

  it("gives every zone a positive area", () => {
    for (const vp of VIEWPORTS) {
      for (const seats of SEAT_COUNTS) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h });
        for (const [name, z] of Object.entries(g.zones)) {
          expect(z.w, `${vp.name}/${seats}/${name}.w`).toBeGreaterThan(0);
          expect(z.h, `${vp.name}/${seats}/${name}.h`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("reclaims the bottom strip when a game has no hero hand", () => {
    const withHand = resolveTable({ seats: 6, width: 390, height: 844 });
    const noHand = resolveTable({ seats: 6, width: 390, height: 844, handZone: 0 });
    expect(noHand.zones.play.h).toBeGreaterThan(withHand.zones.play.h);
  });
});

describe("fanSlot", () => {
  const within = { x: 0, y: 0, w: 360, h: 120 };
  const size = { w: 58, h: 81 };

  it("centres a single piece", () => {
    const s = fanSlot({ index: 0, count: 1, within, size });
    expect(s.x).toBeCloseTo(180, 5);
    expect(s.rotation).toBe(0);
  });

  it("keeps a 13-card hand inside its box", () => {
    for (let i = 0; i < 13; i++) {
      const s = fanSlot({ index: i, count: 13, within, size });
      expect(s.x).toBeGreaterThanOrEqual(within.x);
      expect(s.x).toBeLessThanOrEqual(within.x + within.w);
    }
  });

  it("is symmetric about the centre", () => {
    const first = fanSlot({ index: 0, count: 7, within, size });
    const last = fanSlot({ index: 6, count: 7, within, size });
    expect(first.rotation).toBeCloseTo(-last.rotation, 5);
    expect(first.x + last.x).toBeCloseTo(within.w, 5);
    // Both ends of the arc dip by the same amount.
    expect(first.y).toBeCloseTo(last.y, 5);
  });

  it("compresses rather than overflowing as the hand grows", () => {
    const gapAt5 =
      fanSlot({ index: 1, count: 5, within, size }).x -
      fanSlot({ index: 0, count: 5, within, size }).x;
    const gapAt13 =
      fanSlot({ index: 1, count: 13, within, size }).x -
      fanSlot({ index: 0, count: 13, within, size }).x;
    expect(gapAt13).toBeLessThan(gapAt5);
  });
});
