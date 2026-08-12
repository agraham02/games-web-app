/**
 * The seat-ring layout engine.
 *
 * Pure functions: (viewport box, seat count) -> where everything sits.
 * No React, no DOM. That makes the whole layout testable without a
 * browser, which matters because "does seat 7 of 9 overlap seat 8 on a
 * phone" is exactly the bug that is miserable to catch by eye.
 *
 * Two shape decisions worth knowing:
 *
 * 1. Seats walk the perimeter of a rounded rectangle, not an ellipse.
 *    On a 9:19.5 phone an ellipse pushes seats toward the vertical poles
 *    and wastes the horizontal band, which is the only place a name and
 *    a score actually fit.
 *
 * 2. Edge allocation is a hand-tuned table per density, with a
 *    proportional fallback. Pure math distributes seats "correctly" and
 *    reads generic; real games tune. The fallback keeps arbitrary counts
 *    working so a future game can seat 12.
 */

import { HERO, type SeatId } from "@/engine/types";

export type Density = "compact" | "regular" | "wide";
export type Anchor = "top" | "left" | "right" | "bottom";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PieceSize {
  w: number;
  h: number;
}

export interface SeatSlot {
  seat: SeatId;
  /** Centre of the seat pod, in container-local px. */
  x: number;
  y: number;
  anchor: Anchor;
  /** Rotation a physical hand would have at this edge, in degrees. */
  rotation: number;
  isHero: boolean;
}

export type ZoneName =
  | "play"
  | "trick"
  | "deck"
  | "discard"
  | "board"
  | "hand";

export interface TableGeometry {
  box: Box;
  density: Density;
  seats: SeatSlot[];
  zones: Record<ZoneName, Box>;
  /** Cards lying on the table. */
  card: PieceSize;
  /** Cards in the hero's hand — always the largest. */
  handCard: PieceSize;
  /** Opponent hand cards, usually face-down. */
  miniCard: PieceSize;
}

/* ============================================================
   Tier resolution
   ============================================================ */

export const CARD_ASPECT = 2.5 / 3.5;

export function resolveDensity(w: number, h: number): Density {
  // Width drives the tier, but a short landscape phone (e.g. 844x390)
  // has no vertical room for `wide` piece sizes, so height demotes it.
  if (w < 640) return "compact";
  if (w < 1024 || h < 560) return "regular";
  return "wide";
}

interface DensitySpec {
  handCard: PieceSize;
  card: PieceSize;
  miniCard: PieceSize;
  /** Reserved bottom strip for the hero's hand. */
  handZone: number;
  /** Clearance between the viewport edge and the seat ring. */
  ringPad: number;
  /** Space a seat pod occupies inward from the ring. */
  podInset: number;
}

const DENSITY: Record<Density, DensitySpec> = {
  compact: {
    handCard: { w: 58, h: 81 },
    card: { w: 44, h: 62 },
    miniCard: { w: 26, h: 36 },
    handZone: 150,
    ringPad: 14,
    podInset: 46,
  },
  regular: {
    handCard: { w: 68, h: 95 },
    card: { w: 52, h: 73 },
    miniCard: { w: 30, h: 42 },
    handZone: 172,
    ringPad: 18,
    podInset: 54,
  },
  wide: {
    handCard: { w: 84, h: 118 },
    card: { w: 64, h: 90 },
    miniCard: { w: 36, h: 50 },
    handZone: 204,
    ringPad: 24,
    podInset: 62,
  },
};

/* ============================================================
   Edge allocation

   [left, top, right] for a given opponent count. Seat order runs
   anticlockwise from the hero: hero's left edge bottom-to-top,
   across the top left-to-right, then down the right edge — so
   seat 1 is the player to the hero's left, matching the direction
   turn order passes in every game here.
   ============================================================ */

type EdgeAlloc = readonly [left: number, top: number, right: number];

const EDGES: Record<Density, Record<number, EdgeAlloc>> = {
  // Narrow screens: the top band is short, so load the sides.
  compact: {
    1: [0, 1, 0],
    2: [0, 2, 0],
    3: [1, 1, 1],
    4: [1, 2, 1],
    5: [2, 1, 2],
    6: [2, 2, 2],
    7: [3, 1, 3],
    8: [3, 2, 3],
    9: [4, 1, 4],
  },
  regular: {
    1: [0, 1, 0],
    2: [0, 2, 0],
    3: [1, 1, 1],
    4: [1, 2, 1],
    5: [2, 1, 2],
    6: [2, 2, 2],
    7: [2, 3, 2],
    8: [3, 2, 3],
    9: [3, 3, 3],
  },
  // Wide screens have room across the top; keep the sides clear.
  wide: {
    1: [0, 1, 0],
    2: [0, 2, 0],
    3: [1, 1, 1],
    4: [1, 2, 1],
    5: [1, 3, 1],
    6: [2, 2, 2],
    7: [2, 3, 2],
    8: [2, 4, 2],
    9: [3, 3, 3],
  },
};

/**
 * Minimum distance between two seat-pod centres before the names
 * collide on screen. Enforced by geometry.test.ts.
 */
export const POD_GAP: Record<Density, number> = {
  compact: 58,
  regular: 66,
  wide: 74,
};

/**
 * Fallback for counts outside the tuned table: split proportionally to
 * edge length, keeping the sides symmetric.
 */
function allocateByPerimeter(
  opponents: number,
  ringW: number,
  ringH: number,
): EdgeAlloc {
  const total = ringW + 2 * ringH;
  const top = Math.max(1, Math.round((opponents * ringW) / total));
  const perSide = Math.floor((opponents - top) / 2);
  return [perSide, opponents - perSide * 2, perSide];
}

/**
 * The tuned table assumes a reasonably tall ring. A short landscape
 * phone (844x390) has ~180px of vertical ring, which fits one seat per
 * side, not three — so clamp the sides to what actually fits and let
 * the overflow ride the top edge, which is where the room is.
 *
 * Capacity is measured against the INSET ranges used for positioning
 * (see resolveTable), because a seat pushed into a corner is as bad as
 * two pods overlapping mid-edge.
 */
export function allocateEdges(
  opponents: number,
  density: Density,
  ringW: number,
  ringH: number,
  podInset: number = DENSITY[density].podInset,
): EdgeAlloc {
  if (opponents <= 0) return [0, 0, 0];

  const base =
    EDGES[density][opponents] ?? allocateByPerimeter(opponents, ringW, ringH);
  const gap = POD_GAP[density];

  // Sides lose the top corner once anything sits on the top edge, and
  // the top edge loses both corners once anything sits on the sides.
  // Assume both are occupied whenever there are enough opponents to
  // reach around, which is what the tuned table does from 3 up.
  const willUseSides = opponents >= 3;
  const sideSpan = ringH - (opponents >= 1 ? podInset : 0);
  const topSpan = ringW - (willUseSides ? podInset * 2 : 0);

  const sideCap = Math.max(0, Math.floor(sideSpan / gap));
  const topCap = Math.max(1, Math.floor(topSpan / gap));

  let perSide = Math.min(base[0], sideCap);
  let top = opponents - perSide * 2;

  // If the top is now over-subscribed, push seats back onto the sides.
  while (top > topCap && perSide < sideCap && opponents - (perSide + 1) * 2 >= 0) {
    perSide++;
    top = opponents - perSide * 2;
  }

  return [perSide, Math.max(0, top), perSide];
}

/* ============================================================
   Main resolver
   ============================================================ */

export interface ResolveOptions {
  /** Total seats including the hero. */
  seats: number;
  /** Container size in px (already inside any safe-area padding). */
  width: number;
  height: number;
  /** Override the computed tier — used by the lab harness. */
  density?: Density;
  /** Games with no hero hand (e.g. LRC) reclaim the bottom strip. */
  handZone?: number;
}

export function resolveTable(opts: ResolveOptions): TableGeometry {
  const { seats: seatCount, width, height } = opts;
  const density = opts.density ?? resolveDensity(width, height);
  const spec = DENSITY[density];
  const handZone = opts.handZone ?? spec.handZone;

  const box: Box = { x: 0, y: 0, w: width, h: height };

  // The band seats may occupy: full width, top of the viewport down to
  // the top of the hero's hand strip.
  const ringLeft = spec.ringPad;
  const ringRight = width - spec.ringPad;
  const ringTop = spec.ringPad;
  const ringBottom = height - handZone - spec.ringPad;
  const ringW = Math.max(0, ringRight - ringLeft);
  const ringH = Math.max(0, ringBottom - ringTop);

  const opponents = Math.max(0, seatCount - 1);
  const [nLeft, nTop, nRight] = allocateEdges(
    opponents,
    density,
    ringW,
    ringH,
    spec.podInset,
  );

  // Each edge stops short of the corners the other edges occupy,
  // otherwise the topmost side seat and the leftmost top seat land
  // within a pod's width of each other.
  const sideTop = ringTop + (nTop > 0 ? spec.podInset : 0);
  const sideH = Math.max(0, ringBottom - sideTop);
  const topLeft = ringLeft + (nLeft > 0 ? spec.podInset : 0);
  const topRight = ringRight - (nRight > 0 ? spec.podInset : 0);
  const topW = Math.max(0, topRight - topLeft);

  const seats: SeatSlot[] = [
    {
      seat: HERO,
      x: width / 2,
      y: height - handZone / 2,
      anchor: "bottom",
      rotation: 0,
      isHero: true,
    },
  ];

  let seat: SeatId = 1;

  // Left edge, bottom to top — the hero's immediate left comes first.
  for (let i = 0; i < nLeft; i++) {
    seats.push({
      seat: seat++,
      x: ringLeft + spec.podInset / 2,
      y: ringBottom - ((i + 0.5) / nLeft) * sideH,
      anchor: "left",
      rotation: 90,
      isHero: false,
    });
  }

  // Top edge, left to right.
  for (let i = 0; i < nTop; i++) {
    seats.push({
      seat: seat++,
      x: topLeft + ((i + 0.5) / nTop) * topW,
      y: ringTop + spec.podInset / 2,
      anchor: "top",
      rotation: 180,
      isHero: false,
    });
  }

  // Right edge, top to bottom — ends at the hero's immediate right.
  for (let i = 0; i < nRight; i++) {
    seats.push({
      seat: seat++,
      x: ringRight - spec.podInset / 2,
      y: sideTop + ((i + 0.5) / nRight) * sideH,
      anchor: "right",
      rotation: -90,
      isHero: false,
    });
  }

  // The play area is the ring pulled in past whichever edges hold seats.
  const play: Box = {
    x: ringLeft + (nLeft > 0 ? spec.podInset : 0),
    y: ringTop + (nTop > 0 ? spec.podInset : 0),
    w: ringW - (nLeft > 0 ? spec.podInset : 0) - (nRight > 0 ? spec.podInset : 0),
    h: ringH - (nTop > 0 ? spec.podInset : 0),
  };

  const cx = play.x + play.w / 2;
  const cy = play.y + play.h / 2;

  // Trick: a square-ish cluster at the centre, sized to hold a fanned
  // pile of table cards without touching the seat pods.
  const trickW = Math.min(play.w * 0.72, spec.card.w * 3.4);
  const trickH = Math.min(play.h * 0.62, spec.card.h * 2.6);

  const pileGap = spec.card.w * 0.45;
  const deckX = cx - spec.card.w / 2 - pileGap;
  const discardX = cx + spec.card.w / 2 + pileGap;
  const pileY = cy - spec.card.h / 2;

  const zones: Record<ZoneName, Box> = {
    play,
    trick: { x: cx - trickW / 2, y: cy - trickH / 2, w: trickW, h: trickH },
    deck: { x: deckX - spec.card.w / 2, y: pileY, w: spec.card.w, h: spec.card.h },
    discard: { x: discardX - spec.card.w / 2, y: pileY, w: spec.card.w, h: spec.card.h },
    board: play,
    hand: {
      x: spec.ringPad,
      y: height - handZone,
      w: width - spec.ringPad * 2,
      h: handZone,
    },
  };

  return {
    box,
    density,
    seats,
    zones,
    card: spec.card,
    handCard: spec.handCard,
    miniCard: spec.miniCard,
  };
}

/* ============================================================
   Fan maths — shared by the hero hand, opponent hands and tricks.
   ============================================================ */

export interface FanSlot {
  x: number;
  y: number;
  rotation: number;
}

export interface FanOptions {
  /** Piece index and total. */
  index: number;
  count: number;
  /** Box the fan must fit inside. */
  within: Box;
  size: PieceSize;
  /** Max rotation at the outermost piece, in degrees. */
  maxRotation?: number;
  /** Vertical lift at the outermost piece, in px — gives the arc. */
  arcLift?: number;
  /** Widest allowed gap between piece centres. */
  maxGap?: number;
}

/**
 * Lays a piece out along a shallow arc. Overlap is derived from the
 * available width, so 13 cards compress and 3 cards spread — the hand
 * never overflows and never looks sparse.
 */
export function fanSlot(o: FanOptions): FanSlot {
  const { index, count, within, size } = o;
  const maxRotation = o.maxRotation ?? 11;
  const arcLift = o.arcLift ?? 14;
  const maxGap = o.maxGap ?? size.w * 0.78;

  if (count <= 1) {
    return {
      x: within.x + within.w / 2,
      y: within.y + within.h / 2,
      rotation: 0,
    };
  }

  // Distribute centres across the usable width, capped so a short hand
  // does not stretch to the edges.
  const usable = Math.max(0, within.w - size.w);
  const gap = Math.min(maxGap, usable / (count - 1));
  const spread = gap * (count - 1);

  // -1 at the left edge of the fan, +1 at the right.
  const t = (index / (count - 1)) * 2 - 1;

  return {
    x: within.x + within.w / 2 - spread / 2 + index * gap,
    // Ends of the arc sit lower than the middle.
    y: within.y + within.h / 2 + t * t * arcLift,
    rotation: t * maxRotation,
  };
}
