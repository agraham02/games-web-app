import { describe, expect, it } from "vitest";
import {
  allocateEdges,
  discardMaxScroll,
  fanPanRange,
  fanSlot,
  handFanMaxScroll,
  isPortraitTable,
  pileAssembly,
  pileAssemblyHorizontal,
  isShortViewport,
  MIN_DISCARD_STEP_FRACTION,
  POD_GAP,
  POD_SIZE,
  resolveDensity,
  resolveTable,
  TILE_HAND_GAP,
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

  it("keeps the community row (poker) inside the play area and clear of every pod, everywhere", () => {
    for (const vp of VIEWPORTS) {
      for (const seats of SEAT_COUNTS) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h });
        const community = g.zones.community;
        const ctx = `${vp.name}/${seats} seats (${g.density})`;

        expect(community.w, `${ctx}: collapsed`).toBeGreaterThan(0);
        expect(community.h, `${ctx}: collapsed`).toBeGreaterThan(0);
        expect(community.x, `${ctx}: left of the play area`).toBeGreaterThanOrEqual(
          g.zones.play.x - 0.001,
        );
        expect(community.x + community.w, `${ctx}: right of the play area`).toBeLessThanOrEqual(
          g.zones.play.x + g.zones.play.w + 0.001,
        );
        expect(community.y, `${ctx}: above the play area`).toBeGreaterThanOrEqual(
          g.zones.play.y - 0.001,
        );

        // The one documented exception, same shape as `pileRegion`'s own:
        // on a short landscape phone, `play.h` can be too thin to give
        // the row its full offset above centre without pushing past
        // `play.y` — the offset clamps down there instead, and pod
        // clearance is not on offer at that point.
        const offsetClamped = community.y <= g.zones.play.y + 0.001;
        if (offsetClamped) continue;

        for (const seat of g.seats) {
          if (seat.isHero || seat.anchor !== "top") continue;
          const pod = POD_SIZE[g.density];
          const podBottom = seat.y + pod.h / 2;
          expect(podBottom, `${ctx}: seat ${seat.seat}'s pod reaches the community row`)
            .toBeLessThanOrEqual(community.y + 0.001);
        }
      }
    }
  });

  it("keeps poker's pot pile below the community row and inside the play area, everywhere", () => {
    // Regression coverage for a real reported bug: the pot pile used to
    // share `center` (LRC's table-scaled chip zone), whose chips render
    // nearly as large as a community card — the pile's own top edge
    // structurally reached back up into the community row on every
    // viewport, not just a cramped one, because the two were never
    // actually distinct BOXES, just an assumption that a small pile
    // "grows down" from centre. `pot` is now a real zone, geometrically
    // anchored to `community`'s own bottom edge, so this asserts the
    // non-overlap directly rather than trusting the assumption again.
    for (const vp of VIEWPORTS) {
      for (const seats of SEAT_COUNTS) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h });
        const community = g.zones.community;
        const pot = g.zones.pot;
        const ctx = `${vp.name}/${seats} seats (${g.density})`;

        expect(pot.w, `${ctx}: collapsed`).toBeGreaterThan(0);
        expect(pot.h, `${ctx}: collapsed`).toBeGreaterThan(0);
        expect(pot.y, `${ctx}: pot overlaps the community row`).toBeGreaterThanOrEqual(
          community.y + community.h - 0.001,
        );
        expect(pot.x, `${ctx}: left of the play area`).toBeGreaterThanOrEqual(
          g.zones.play.x - 0.001,
        );
        expect(pot.x + pot.w, `${ctx}: right of the play area`).toBeLessThanOrEqual(
          g.zones.play.x + g.zones.play.w + 0.001,
        );
      }
    }
  });

  it("keeps poker's stub/burnt piles below the pot and inside the play area, everywhere", () => {
    // Same regression shape as the `pot` test above, one band further
    // down: `stub`/`burnt` replaced Rummy's cy-centred `deck`/`discard`
    // for poker specifically, precisely because those sit where
    // `community`/`pot` now do.
    for (const vp of VIEWPORTS) {
      for (const seats of SEAT_COUNTS) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h });
        const pot = g.zones.pot;
        const ctx = `${vp.name}/${seats} seats (${g.density})`;

        for (const name of ["stub", "burnt"] as const) {
          const z = g.zones[name];
          expect(z.w, `${ctx}: ${name} collapsed`).toBeGreaterThan(0);
          expect(z.h, `${ctx}: ${name} collapsed`).toBeGreaterThan(0);
          expect(z.y, `${ctx}: ${name} overlaps the pot`).toBeGreaterThanOrEqual(
            pot.y + pot.h - 0.001,
          );
        }
        // The two sit side by side, never overlapping each other.
        const stub = g.zones.stub;
        const burnt = g.zones.burnt;
        expect(stub.x + stub.w, `${ctx}: stub overlaps burnt`).toBeLessThanOrEqual(
          burnt.x + 0.001,
        );
      }
    }
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

/* ============================================================
   Compress-then-pan, and the pile region it clamps against
   ============================================================ */

describe("fanSlot — compression floor and panning", () => {
  const within = { x: 0, y: 0, w: 300, h: 100 };
  const size = { w: 60, h: 84 };
  const minGap = size.w * MIN_DISCARD_STEP_FRACTION;

  it("is unchanged for a caller that passes no floor", () => {
    // Every pre-existing caller passes none, and must keep the exact gap
    // it always had — that guarantee is what made extending a shared
    // function safe rather than a rewrite of every fan in the app.
    for (const count of [1, 3, 7, 13, 30]) {
      for (let i = 0; i < count; i++) {
        const plain = fanSlot({ index: i, count, within, size });
        const floored = fanSlot({ index: i, count, within, size, minGap: 0, pan: 0 });
        expect(floored.x, `count ${count} index ${i}`).toBeCloseTo(plain.x, 6);
      }
    }
  });

  it("stops compressing at the floor instead of shrinking without limit", () => {
    // 240px of usable run over a 21.6px floor: the floor only engages
    // past 12 cards, and below that the natural gap is correctly wider.
    for (const count of [13, 20, 40]) {
      const a = fanSlot({ index: 0, count, within, size, minGap });
      const b = fanSlot({ index: 1, count, within, size, minGap });
      expect(b.x - a.x, `count ${count}`).toBeCloseTo(minGap, 6);
    }
  });

  it("reports a pan range of exactly the part that does not fit", () => {
    const usable = within.w - size.w;
    // Short enough to fit: nothing to pan.
    expect(fanPanRange({ count: 4, available: within.w, size: size.w, maxGap: 40, minGap })).toBe(
      0,
    );

    const count = 30;
    const range = fanPanRange({ count, available: within.w, size: size.w, maxGap: 40, minGap });
    expect(range).toBeCloseTo(minGap * (count - 1) - usable, 6);
  });

  it("starts an overflowing fan flush at the near edge, not half-hidden at both", () => {
    // A centred fan at pan 0 hides content off BOTH ends before the
    // player has dragged anything, which reads as broken. The signed pan
    // exists precisely so a caller can start at +range/2 and begin at
    // the edge instead.
    const count = 30;
    const range = fanPanRange({ count, available: within.w, size: size.w, maxGap: 40, minGap });
    const first = fanSlot({ index: 0, count, within, size, minGap, pan: range / 2 });
    expect(first.x).toBeCloseTo(within.x + size.w / 2, 6);
    expect(first.inView).toBe(true);
  });

  it("reports panned-away pieces as out of view, which drives the edge hint", () => {
    const count = 30;
    const range = fanPanRange({ count, available: within.w, size: size.w, maxGap: 40, minGap });
    const far = fanSlot({ index: count - 1, count, within, size, minGap, pan: range / 2 });
    expect(far.inView, "the far end must be hidden before any panning").toBe(false);

    const pulled = fanSlot({ index: count - 1, count, within, size, minGap, pan: -range / 2 });
    expect(pulled.inView, "panning to the far end must reveal it").toBe(true);
  });

  it("fades a piece out as panning carries its centre toward the edge", () => {
    // The fan has no clip — there is no wrapper to put `overflow` on —
    // so a piece panned past the boundary would otherwise draw at full
    // strength under a seat pod, under the board sheet, or off-screen.
    // The band is anchored on the piece's own CENTRE, which is what keeps
    // the fade from trailing a ghost card out into the pods.
    const count = 30;
    const range = fanPanRange({ count, available: within.w, size: size.w, maxGap: 40, minGap });

    // Flush at the near edge: fully solid, and its neighbours inward too.
    const first = fanSlot({ index: 0, count, within, size, minGap, pan: range / 2 });
    expect(first.visible, "a piece flush against the edge is fully drawn").toBe(1);
    expect(fanSlot({ index: 4, count, within, size, minGap, pan: range / 2 }).visible).toBe(1);

    // `pan` shifts the whole fan rigidly, so driving one piece to a
    // chosen x is just the delta from where it sits unpanned. Measuring
    // it beats re-deriving the gap here and getting a different answer
    // from the one under test.
    const solo = { index: 0, count: 2, within, size, minGap } as const;
    const restX = fanSlot(solo).x;
    const drivenTo = (x: number) => fanSlot({ ...solo, pan: x - restX });
    const edge = within.x + within.w;
    const band = size.w * 0.45;

    // Centre ON the edge is the end of the ramp: gone, not faint. This is
    // the promise that bounds how far anything is ever visible — half a
    // piece past the boundary, never more.
    const gone = drivenTo(edge);
    expect(gone.visible, "a piece whose centre reaches the edge is not drawn").toBe(0);
    expect(gone.inView).toBe(false);

    // Halfway along the band is half strength — linear in how far the
    // centre still has to go, so it tracks the card sliding out.
    expect(drivenTo(edge - band / 2).visible).toBeCloseTo(0.5, 6);
    // And a whole band inside is already fully solid, even though a few
    // percent of the piece is technically still over the line — that
    // deliberate slack is what keeps float residue off every unfloored
    // fan in the app.
    expect(drivenTo(edge - band).visible).toBe(1);

    // Symmetric at the near edge — panning the other way must not be a
    // second, subtly different code path.
    expect(drivenTo(within.x).visible).toBe(0);
    expect(drivenTo(within.x + band / 2).visible).toBeCloseTo(0.5, 6);
  });

  it("never fades a fan that has no compression floor", () => {
    // Every other game's fan fits by construction, right down to the
    // pieces sitting exactly on the boundary — where float residue could
    // otherwise report a hair under 1 and dim a card for no reason.
    for (const count of [1, 2, 7, 13, 30]) {
      for (let i = 0; i < count; i++) {
        expect(
          fanSlot({ index: i, count, within, size }).visible,
          `count ${count} index ${i}`,
        ).toBe(1);
      }
    }
  });
});

/**
 * A short viewport has no vertical budget to divide.
 *
 * Reported from play on a 1052x486 landscape phone: Rummy's hand strip
 * (165px), its header (64px) and the board sheet's resting height (81px)
 * left the table **86px tall** — pods, deck and discard crushed into one
 * strip with the sheet over most of it, and the sheet's own cards clipped
 * because 81px minus a handle and a header is not a card.
 *
 * Rummy answers that by declining to lay out at all and asking the player
 * to rotate, which is a page-level decision this file cannot see. What it
 * CAN pin is the relief every game gets from it: the hand strip stops
 * being generous when there is nothing to be generous with, which is what
 * keeps Spades, Dominoes and LRC playable in the same orientation.
 */
describe("short viewports", () => {
  const LANDSCAPE = [
    { name: "phone landscape", w: 844, h: 390 },
    { name: "big phone landscape", w: 1052, h: 486 },
  ];
  const TALL = [
    { name: "phone portrait", w: 390, h: 844 },
    { name: "tablet portrait", w: 768, h: 1024 },
    { name: "desktop", w: 1440, h: 900 },
  ];

  it("recognises a short viewport by HEIGHT, not by orientation", () => {
    for (const vp of LANDSCAPE) {
      expect(isShortViewport(vp), vp.name).toBe(true);
    }
    for (const vp of TALL) {
      // A 1440x900 desktop is landscape and has ample height.
      expect(isShortViewport(vp), vp.name).toBe(false);
    }
  });

  it("shrinks the hand strip only on short viewports", () => {
    for (const vp of LANDSCAPE) {
      const g = resolveTable({ seats: 4, width: vp.w, height: vp.h });
      // Down to the cards plus the lift a selected card takes, no more.
      expect(g.zones.hand.h, vp.name).toBeLessThanOrEqual(g.handCard.h * 1.25 + 0.001);
      expect(g.zones.hand.h, `${vp.name}: still holds a card`).toBeGreaterThan(g.handCard.h);
    }
    for (const vp of TALL) {
      const g = resolveTable({ seats: 4, width: vp.w, height: vp.h });
      // Untouched where there is height to be generous with.
      expect(g.zones.hand.h, vp.name).toBeGreaterThan(g.handCard.h * 1.25);
    }
  });

  it("still leaves the hand strip the biggest single band it was", () => {
    // The relief is a cap, not a rewrite: the strip is still sized from
    // the cards, and there is nothing to check about the ring receiving
    // the difference because `ringBottom` subtracts `handZone` directly —
    // a smaller strip is a taller ring by arithmetic, not by policy.
    for (const vp of [...LANDSCAPE, ...TALL]) {
      const g = resolveTable({ seats: 4, width: vp.w, height: vp.h });
      expect(g.zones.hand.h, `${vp.name}: strip lost the cards`).toBeGreaterThanOrEqual(
        g.handCard.h,
      );
      expect(g.zones.hand.y + g.zones.hand.h, `${vp.name}: strip left the viewport`).toBeCloseTo(
        vp.h,
        5,
      );
    }
  });
});

describe("pileRegion", () => {
  it("stays clear of every seat pod AND its fanned hand, everywhere", () => {
    for (const vp of VIEWPORTS) {
      for (const seats of SEAT_COUNTS) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h });
        const region = g.pileRegion;
        const ctx = `${vp.name}/${seats} seats (${g.density})`;

        expect(region.w, `${ctx}: region collapsed`).toBeGreaterThan(0);
        expect(region.h, `${ctx}: region collapsed`).toBeGreaterThan(0);

        // The one documented exception: on a very small screen with seats
        // on every edge, the clearances can eat the region entirely, and
        // a floor takes over — a pile that cannot be drawn at all is
        // worse than one sitting a little close. Where the floor is what
        // sized the region, "clear of every hand" is not on offer and
        // asserting it would be asserting the impossible.
        const floored =
          region.w <= g.card.w * 2.42 + 0.001 || region.h <= g.card.h * 1.2 + 0.001;
        if (floored) continue;

        for (const seat of g.seats) {
          if (seat.isHero) continue;
          // How far this seat's own fanned CARD hand reaches inward. A
          // boundary derived from the pod's footprint alone undershoots
          // this, which is the exact bug pileRegion exists to prevent —
          // so the assertion has to use the hand's reach, not the pod's.
          const pod = POD_SIZE[g.density];
          const reach =
            (seat.anchor === "top" ? pod.h : pod.w) / 2 + g.miniCard.h + TILE_HAND_GAP;

          if (seat.anchor === "left") {
            expect(seat.x + reach, `${ctx}: seat ${seat.seat}'s hand reaches the pile`)
              .toBeLessThanOrEqual(region.x + 0.001);
          } else if (seat.anchor === "right") {
            expect(seat.x - reach, `${ctx}: seat ${seat.seat}'s hand reaches the pile`)
              .toBeGreaterThanOrEqual(region.x + region.w - 0.001);
          } else if (seat.anchor === "top") {
            expect(seat.y + reach, `${ctx}: seat ${seat.seat}'s hand reaches the pile`)
              .toBeLessThanOrEqual(region.y + 0.001);
          }
        }
      }
    }
  });

  it("sits the assembly higher when a game asks for it", () => {
    const bySeats = resolveTable({ seats: 4, width: 390, height: 844 });
    const high = resolveTable({ seats: 4, width: 390, height: 844, pileAnchor: 0 });
    expect(high.pileAxis).toBeLessThan(bySeats.pileAxis);
  });

  it("puts the pile axis on the side seats' own eye level, inside the region", () => {
    for (const vp of VIEWPORTS) {
      for (const seats of SEAT_COUNTS) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h, bottomZone: 204 });
        const ctx = `${vp.name}/${seats} seats`;
        const sides = g.seats.filter((s) => s.anchor === "left" || s.anchor === "right");
        // Always inside the region by at least half a card, so a single
        // card on the axis is fully drawn.
        expect(g.pileAxis, ctx).toBeGreaterThanOrEqual(g.pileRegion.y + g.card.h / 2 - 0.001);
        expect(g.pileAxis, ctx).toBeLessThanOrEqual(
          g.pileRegion.y + g.pileRegion.h - g.card.h / 2 + 0.001,
        );
        if (sides.length > 0) {
          // Level with the pods flanking it whenever the clamp allows —
          // which is the whole reason the axis is derived from the seats
          // rather than from a fraction of the region.
          const mid = sides.reduce((sum, s) => sum + s.y, 0) / sides.length;
          const clamped =
            mid < g.pileRegion.y + g.card.h / 2 ||
            mid > g.pileRegion.y + g.pileRegion.h - g.card.h / 2;
          if (!clamped) expect(g.pileAxis, ctx).toBeCloseTo(mid, 6);
        }
      }
    }
  });

  it("reserves the bands a game asks for without ever collapsing the ring", () => {
    for (const vp of VIEWPORTS) {
      for (const seats of SEAT_COUNTS) {
        const ctx = `${vp.name}/${seats} seats`;
        const plain = resolveTable({ seats, width: vp.w, height: vp.h });
        const reserved = resolveTable({
          seats,
          width: vp.w,
          height: vp.h,
          topZone: 40,
          bottomZone: 150,
        });
        // The regression: a short landscape phone asked to give up 190px
        // above the hand produced a play zone of NEGATIVE height.
        expect(reserved.zones.play.h, ctx).toBeGreaterThan(0);
        expect(reserved.zones.play.w, ctx).toBeGreaterThan(0);
        expect(reserved.zones.play.h, ctx).toBeLessThanOrEqual(plain.zones.play.h);
        // The hand strip itself never moves — reserved bands come out of
        // the ring above it, never out of the player's own cards.
        expect(reserved.zones.hand.y, ctx).toBe(plain.zones.hand.y);
        // And what was granted is reported honestly, never more than
        // asked and never more than fits.
        expect(reserved.reserved.top, ctx).toBeLessThanOrEqual(40 + 0.001);
        expect(reserved.reserved.bottom, ctx).toBeLessThanOrEqual(150 + 0.001);
      }
    }
  });

  it("scales both reserved bands together when they cannot both fit", () => {
    // Short landscape: the request does not fit, and the two bands keep
    // their ratio rather than one winning outright.
    const g = resolveTable({
      seats: 4,
      width: 844,
      height: 390,
      topZone: 40,
      bottomZone: 160,
    });
    expect(g.reserved.top + g.reserved.bottom).toBeLessThan(200);
    if (g.reserved.bottom > 0) {
      expect(g.reserved.top / g.reserved.bottom).toBeCloseTo(40 / 160, 4);
    }
  });
});

describe("pile assembly — portrait and landscape are different, not relabelled", () => {
  it("never moves the deck in portrait, however deep the pile gets", () => {
    // Portrait's deck/discard offset axis is PERPENDICULAR to the fan's
    // growth axis, so a growing pile has no reason to push the deck
    // anywhere — and must not.
    const g = resolveTable({ seats: 4, width: 390, height: 844 });
    if (!isPortraitTable(g.pileRegion)) return;
    const base = pileAssemblyHorizontal(g, 1);
    for (const count of [5, 20, 40]) {
      const at = pileAssemblyHorizontal(g, count);
      expect(at.deckX, `portrait deck moved at ${count} cards`).toBeCloseTo(base.deckX, 6);
    }
  });

  it("slides the deck left as a landscape fan grows, and hard-stops it", () => {
    // Landscape shares one axis for both, so the deck giving ground is
    // the requested flexbox-style behaviour — bounded, never runaway.
    const g = resolveTable({ seats: 4, width: 1440, height: 900 });
    if (isPortraitTable(g.pileRegion)) return;
    const a = pileAssembly(g, 1);
    let previous = pileAssemblyHorizontal(g, 1).deckX;
    for (const count of [4, 10, 20, 40]) {
      const x = pileAssemblyHorizontal(g, count).deckX;
      expect(x, `deck must not move right as the pile grows (${count})`).toBeLessThanOrEqual(
        previous + 0.001,
      );
      expect(x, `deck walked out of the pile region (${count})`).toBeGreaterThanOrEqual(
        a.deckMinX - 0.001,
      );
      previous = x;
    }
  });

  it("keeps the deck and the discard fan adjacent, not marooned apart", () => {
    // Reported from play: a lake of empty felt between the two piles.
    // Cause was handing the fan a box far wider than it needed —
    // `fanSlot` centres a fan inside its box, so an oversized box parks
    // it in the middle of that width instead of beside the deck.
    for (const vp of VIEWPORTS) {
      // Measured between the deck's right edge and the fan BOX's left
      // edge — the actual felt the player sees between the two piles,
      // independent of how far the fan has been panned inside its box.
      const gaps: number[] = [];
      for (const count of [1, 2, 3, 5, 8, 13, 30]) {
        const g = resolveTable({ seats: 4, width: vp.w, height: vp.h });
        const a = pileAssembly(g, count);
        const { deckX } = pileAssemblyHorizontal(g, count);
        const gapPx = a.fan.x - deckX - g.card.w / 2;
        expect(gapPx, `${vp.name} @${count}: piles drifted apart`).toBeLessThan(g.card.w);
        expect(gapPx, `${vp.name} @${count}: piles overlap`).toBeGreaterThan(0);
        gaps.push(gapPx);
      }
      // And it must not wander with depth — it opened to ~87px at eight
      // cards and closed again by thirty, which is the shape a
      // double-counted re-centring makes.
      const spread = Math.max(...gaps) - Math.min(...gaps);
      expect(spread, `${vp.name}: the gap changes with pile depth`).toBeLessThan(1);
    }
  });

  it("keeps the pile assembly inside its own region", () => {
    for (const vp of VIEWPORTS) {
      const g = resolveTable({ seats: 6, width: vp.w, height: vp.h });
      for (const count of [1, 10, 30]) {
        const a = pileAssembly(g, count);
        const ctx = `${vp.name} @${count}`;
        expect(a.fan.x, ctx).toBeGreaterThanOrEqual(g.pileRegion.x - 0.001);
        expect(a.fan.x + a.fan.w, ctx).toBeLessThanOrEqual(
          g.pileRegion.x + g.pileRegion.w + 0.001,
        );
      }
    }
  });

  it("keeps the discard fan level with the deck at every depth", () => {
    // Reported from play: the fan read as `flex-start`. It began at the
    // region's top edge and grew downward, so a short pile sat level with
    // the deck and every extra card dragged the fan's own centre further
    // below it. The two are one row and have to stay one row.
    for (const vp of VIEWPORTS) {
      for (const seats of [2, 3, 4, 6]) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h, bottomZone: 204 });
        for (const count of [1, 2, 5, 9, 16, 30, 45]) {
          const a = pileAssembly(g, count);
          const ctx = `${vp.name}/${seats}seats @${count}`;
          const fanMid = a.fan.y + a.fan.h / 2;
          expect(fanMid, `${ctx}: fan drifted off the deck's line`).toBeCloseTo(a.deck.y, 6);
          expect(a.deck.y, `${ctx}: the pile left its own axis`).toBeCloseTo(g.pileAxis, 6);
          // And the fan box itself stays inside the region on both axes,
          // which is what makes that box a usable fade boundary.
          expect(a.fan.y, ctx).toBeGreaterThanOrEqual(g.pileRegion.y - 0.001);
          expect(a.fan.y + a.fan.h, ctx).toBeLessThanOrEqual(
            g.pileRegion.y + g.pileRegion.h + 0.001,
          );
        }
      }
    }
  });

  it("only reports a pan range once a pile genuinely overflows", () => {
    const g = resolveTable({ seats: 4, width: 390, height: 844 });
    expect(discardMaxScroll(g, 2)).toBe(0);
    expect(discardMaxScroll(g, 40)).toBeGreaterThan(0);
  });

  it("only reports a hand pan range once the hand genuinely overflows", () => {
    for (const vp of VIEWPORTS) {
      const g = resolveTable({ seats: 4, width: vp.w, height: vp.h });
      expect(handFanMaxScroll(g, 7), `${vp.name}: an ordinary hand must not pan`).toBe(0);
      expect(handFanMaxScroll(g, 34), `${vp.name}: a huge hand must pan`).toBeGreaterThan(0);
    }
  });
});

describe("viewer-relative seating", () => {
  /**
   * Online, the person looking at the screen is rarely seat 0. Rather than
   * teach every game to renumber its own state per viewer — hands, bids and
   * scores are all keyed by seat — the table lays seats out by POSITION and
   * labels them from the viewer. Position 0 is always "you".
   */
  const box = { seats: 4, width: 1024, height: 768 };

  it("puts the viewer bottom-centre whoever they are", () => {
    for (const viewer of [0, 1, 2, 3]) {
      const g = resolveTable({ ...box, viewerSeat: viewer });
      const bottom = g.seats.find((s) => s.anchor === "bottom")!;
      expect(bottom.seat).toBe(viewer);
      expect(bottom.isHero).toBe(true);
      expect(bottom.x).toBeCloseTo(box.width / 2, 0);
    }
  });

  it("keeps every seat present and distinct under rotation", () => {
    for (const viewer of [0, 1, 2, 3]) {
      const g = resolveTable({ ...box, viewerSeat: viewer });
      const ids = g.seats.map((s) => s.seat).sort();
      expect(ids).toEqual([0, 1, 2, 3]);
    }
  });

  it("preserves who sits to your left regardless of your seat number", () => {
    // Numbering runs anticlockwise from the hero, so the seat one higher
    // than yours is always on your left. That relationship is the whole
    // point of rotating rather than renumbering, and a partnership game
    // depends on it: partners must stay across the table.
    for (const viewer of [0, 1, 2, 3]) {
      const g = resolveTable({ ...box, viewerSeat: viewer });
      const left = g.seats.find((s) => s.anchor === "left")!;
      const top = g.seats.find((s) => s.anchor === "top")!;
      expect(left.seat).toBe((viewer + 1) % 4);
      expect(top.seat).toBe((viewer + 2) % 4); // your partner, across
    }
  });

  it("defaults to seat 0 when nobody says otherwise", () => {
    // Every offline game relies on this, so it is worth pinning that
    // `undefined` and an explicit 0 are the same table.
    const implicit = resolveTable(box);
    const explicit = resolveTable({ ...box, viewerSeat: 0 });
    expect(implicit.seats).toEqual(explicit.seats);
    expect(implicit.viewerSeat).toBe(0);
  });

  it("gives a spectator no hero and a pod at every seat", () => {
    // `null` is deliberately not the same as `undefined`: one is somebody
    // watching, the other is nobody having said.
    const g = resolveTable({ ...box, viewerSeat: null });
    expect(g.viewerSeat).toBeNull();
    expect(g.seats.every((s) => !s.isHero)).toBe(true);
    expect(g.seats.map((s) => s.seat).sort()).toEqual([0, 1, 2, 3]);
  });

  it("keeps a spectator's bottom pod fully on screen", () => {
    // With no hand strip to sit above, the bottom pod would otherwise be
    // centred on the viewport edge with half of it cut off.
    const g = resolveTable({ ...box, viewerSeat: null, handZone: 0 });
    const bottom = g.seats.find((s) => s.anchor === "bottom")!;
    expect(bottom.y).toBeLessThan(box.height);
  });
});

/**
 * BS's two central zones.
 *
 * Laid out as a PAIR about `cy` rather than as two independent guesses at
 * "the middle of the table", which is the only arrangement in which they
 * cannot overlap. Poker learned that the hard way: three separate rounds of
 * fixes, each moving one zone off a shared `cy` anchor, before the answer
 * turned out to be one vertical chain (see `ZoneId`). This asserts the
 * property directly instead of waiting for a screenshot to disagree.
 */
describe("bs — the pile and the reveal row", () => {
  it("never overlap, at any viewport or seat count", () => {
    for (const vp of VIEWPORTS) {
      for (const seats of SEAT_COUNTS) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h });
        const { pile, reveal } = g.zones;
        const where = `${vp.name} / ${seats} seats`;
        // The reveal row is above the pile, with a real gap between them, so
        // a card lifted off the stack has somewhere to land that is not the
        // stack.
        expect(reveal.y + reveal.h, `${where}: reveal overlaps the pile`)
          .toBeLessThanOrEqual(pile.y + 0.01);
      }
    }
  });

  it("keeps the pair inside the play area wherever it fits at all", () => {
    for (const vp of VIEWPORTS) {
      for (const seats of SEAT_COUNTS) {
        const g = resolveTable({ seats, width: vp.w, height: vp.h });
        const { play, pile, reveal } = g.zones;
        const where = `${vp.name} / ${seats} seats`;
        const wanted = g.card.h * 2;
        // On a viewport with room for both rows the pair must sit inside
        // `play`; below that it keeps its size and sits proud, which is the
        // same "being drawable beats being perfectly contained" trade every
        // zone below `community` already makes.
        if (play.h >= wanted) {
          expect(reveal.y, `${where}: reveal above the play area`)
            .toBeGreaterThanOrEqual(play.y - 0.01);
          expect(pile.y + pile.h, `${where}: pile below the play area`)
            .toBeLessThanOrEqual(play.y + play.h + 0.01);
        }
        // Horizontally centred on the play area in every case — the pile is
        // the focal point of this game and has nothing to make room for.
        expect(pile.x + pile.w / 2, `${where}: pile off centre`)
          .toBeCloseTo(play.x + play.w / 2, 5);
        expect(reveal.x + reveal.w / 2, `${where}: reveal off centre`)
          .toBeCloseTo(play.x + play.w / 2, 5);
      }
    }
  });

  it("holds four cards in the reveal row wherever the width allows", () => {
    // Four is as many as one rank can hold, so a reveal never needs a fifth
    // slot — but it must never need fewer than four either, or a challenged
    // four-card claim cannot be read.
    for (const vp of VIEWPORTS) {
      const g = resolveTable({ seats: 4, width: vp.w, height: vp.h });
      const { play, reveal } = g.zones;
      if (play.w >= g.card.w * 4.5) {
        expect(reveal.w, `${vp.name}: reveal row too narrow for four cards`)
          .toBeGreaterThanOrEqual(g.card.w * 4);
      }
    }
  });
});
