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
  /** Where a domino chain is fitted. Aliases the whole play area. */
  | "line"
  /** Dominoes' face-down draw pool. See `resolveTable` for why it sits
   * in the hand strip rather than out on the table. */
  | "boneyard"
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
    // A first pass at this (96/76/42) still read as small on an
    // ordinary 1440x900 window — confirmed live, not guessed. This tier
    // covers everything from a 1024px laptop to a big desktop monitor,
    // and pieces sized for the former leave a lot of dead felt around
    // them on the latter. Pushed substantially further this time, not
    // another token step: there is real headroom (a 7-tile hand at
    // these sizes still uses well under half the hand zone's width on a
    // 1440px window), so the earlier pass was too conservative, not
    // wrong in kind.
    handCard: { w: 118, h: 165 },
    card: { w: 92, h: 129 },
    miniCard: { w: 50, h: 70 },
    handZone: 250,
    ringPad: 28,
    podInset: 88,
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
 * Roughly what a seat pod covers on screen, centred on its slot. Per
 * density because SeatRing's avatar/text scale with it (see that file) —
 * this is a deliberately generous estimate so layout code and tests can
 * keep pieces clear of the pods without reaching into the React
 * component, but a stale one is worse than no estimate: `wide`'s bigger
 * avatar and text push the pod noticeably taller than `compact`'s, and
 * this needs to track that or the clearance math it feeds (hand
 * placement, the domino line's inset) quietly stops being generous
 * enough.
 */
export const POD_SIZE: Record<Density, PieceSize> = {
  compact: { w: 60, h: 62 },
  regular: { w: 64, h: 68 },
  wide: { w: 96, h: 100 },
};

/** Clearance between the domino line's box and anything around it. */
const LINE_BREATHING = 6;

/**
 * Gap between an opponent's pod and their fanned tile hand — shared with
 * layout.ts's opponent-hand placement (`TILE_HAND_GAP` there is this
 * same number) so the two can never drift apart again. They used to be
 * independently guessed: `line`'s own clearance only ever budgeted room
 * for the POD, and the hand's own placement reached much further past
 * it than that budgeted for, which is exactly what let a full domino
 * hand render on top of the chain it's meant to sit beside.
 */
export const TILE_HAND_GAP = 8;

/**
 * How far a box of the given size reaches along a push direction
 * (ux, uy) — the projection of its own half-extents onto that
 * direction. Shared by every "how far past this pod does that box
 * reach" calculation (the pod itself, an opponent's tile hand) in both
 * this file's `line` clearance and layout.ts's opponent-hand placement,
 * so the two compute it identically instead of each re-deriving it.
 */
export function axisReach(ux: number, uy: number, size: PieceSize): number {
  return Math.abs(ux) * (size.w / 2) + Math.abs(uy) * (size.h / 2);
}

/**
 * Minimum distance between two seat-pod centres before the names
 * collide on screen. Enforced by geometry.test.ts.
 */
export const POD_GAP: Record<Density, number> = {
  compact: 58,
  regular: 66,
  // Tracks POD_SIZE.wide's footprint (96px wide) with the same margin
  // `regular` already keeps over ITS pod width — left too small here
  // would let two pods sit closer together than they now are wide.
  wide: 104,
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

  // Both clamped against the ACTUAL viewport, not just the density spec.
  // `density` can be forced (the lab previews other devices at a chosen
  // tier — see `ResolveOptions.density`), which is exactly the case
  // `resolveDensity` itself can never produce: `wide` forced onto a
  // small phone, with `wide`'s much bigger pods/hand strip pushing
  // `ringH` toward zero or negative before anything downstream gets a
  // chance to clamp it. A real, auto-resolved `wide` viewport is always
  // comfortably larger than these thresholds, so this is a no-op there
  // — it only bites the forced-onto-something-tiny case.
  const podInsetCap = Math.max(24, Math.min(width, height) * 0.16);
  const podInset = Math.min(spec.podInset, podInsetCap);
  const handZone = Math.min(opts.handZone ?? spec.handZone, height * 0.34);

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
    podInset,
  );

  // Each edge stops short of the corners the other edges occupy,
  // otherwise the topmost side seat and the leftmost top seat land
  // within a pod's width of each other.
  const sideTop = ringTop + (nTop > 0 ? podInset : 0);
  const sideH = Math.max(0, ringBottom - sideTop);
  const topLeft = ringLeft + (nLeft > 0 ? podInset : 0);
  const topRight = ringRight - (nRight > 0 ? podInset : 0);
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
      x: ringLeft + podInset / 2,
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
      y: ringTop + podInset / 2,
      anchor: "top",
      rotation: 180,
      isHero: false,
    });
  }

  // Right edge, top to bottom — ends at the hero's immediate right.
  for (let i = 0; i < nRight; i++) {
    seats.push({
      seat: seat++,
      x: ringRight - podInset / 2,
      y: sideTop + ((i + 0.5) / nRight) * sideH,
      anchor: "right",
      rotation: -90,
      isHero: false,
    });
  }

  // The play area is the ring pulled in past whichever edges hold seats.
  const play: Box = {
    x: ringLeft + (nLeft > 0 ? podInset : 0),
    y: ringTop + (nTop > 0 ? podInset : 0),
    w: ringW - (nLeft > 0 ? podInset : 0) - (nRight > 0 ? podInset : 0),
    h: ringH - (nTop > 0 ? podInset : 0),
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

  const hand: Box = {
    x: spec.ringPad,
    y: height - handZone,
    w: width - spec.ringPad * 2,
    h: handZone,
  };

  // The boneyard lives at the left end of the HAND strip, not out on the
  // table. Two reasons, both about the thing dominoes is short of:
  // room. A draw pile parked anywhere inside the play area would have to
  // be carved out of the one region the chain needs (and the chain is
  // fitted by a camera, so it would happily grow straight over it),
  // whereas the hand strip has spare width at every size. It also reads
  // correctly — it is the pile YOU draw from, so it belongs next to your
  // hand and next to the Draw button.
  const tileW = tileShortSide(spec.card);
  const bone: Box = {
    x: hand.x,
    y: hand.y + Math.max(0, (handZone - tileW * 2) / 2),
    w: tileW,
    h: Math.min(handZone, tileW * 2),
  };

  // `play` is inset by a full `podInset` on each edge that holds seats,
  // but a pod is centred at `podInset / 2` from the ring and has its own
  // real footprint (see POD_SIZE) — so on a tight density, or a pod
  // sized bigger than that inset expects, it can bleed a few px back
  // INTO the play area. Card zones sit near the middle and never notice;
  // a camera-fitted domino chain fills the whole box and would tuck its
  // ends straight under a pod. `line` is that box pulled clear of the
  // real pod footprint AND an opponent's fanned tile hand (see
  // layout.ts's "hand" case) at its largest (a fresh 6-or-7-tile deal),
  // plus a little breathing room.
  //
  // Mirrors layout.ts's own (axis-decoupled) opponent-hand placement
  // exactly: every TOP seat's hand reaches the exact same distance below
  // its pod regardless of where that seat sits on the edge or how many
  // tiles are in it (see that file's doc for the two separate bugs a
  // shared, projected reach used to cause), so unlike an earlier version
  // of this, there is no need to check every real seat and take a max —
  // one calculation covers every top seat, and one covers every side
  // seat. `podInset / 2` converts a pod-CENTRE-relative distance (what
  // layout.ts computes) into a `play`-EDGE-relative one (what `line`
  // needs), since a seat's own centre sits `podInset / 2` inside `play`.
  const podSize = POD_SIZE[density];
  const miniW = tileShortSide(spec.miniCard);
  const miniH = miniW * 2;
  const maxFanW = miniW * Math.max(2.4, 7 * 0.9);
  const topBleed = Math.max(
    LINE_BREATHING,
    Math.max(0, podSize.h / 2 - podInset / 2) + miniH + TILE_HAND_GAP + LINE_BREATHING,
  );
  // A full 7-tile rack genuinely does not fit beside a pod on a narrow
  // phone with seats on both sides of the board — the real fix is
  // rotating a side seat's rack to stand along the pod's own edge
  // instead of reaching straight out from it (dominoes tops out at 4
  // seats, and only that table ever puts a hand on a side edge at all).
  // Clamped so `line` can't collapse to nothing chasing a case that has
  // no real solution without that redesign; the residual gap is a large
  // hand on a side seat still reaching a little into the chain on the
  // narrowest phones, not the pod-adjacent overlap this whole change
  // fixes everywhere else.
  const sideReach =
    Math.max(0, podSize.w / 2 - podInset / 2) + maxFanW + miniW / 2 + TILE_HAND_GAP;
  const sideBleed = Math.max(
    LINE_BREATHING,
    Math.min(sideReach + LINE_BREATHING, play.w * 0.3),
  );
  const line: Box = {
    x: play.x + (nLeft > 0 ? sideBleed : LINE_BREATHING),
    y: play.y + (nTop > 0 ? topBleed : LINE_BREATHING),
    w:
      play.w -
      (nLeft > 0 ? sideBleed : LINE_BREATHING) -
      (nRight > 0 ? sideBleed : LINE_BREATHING),
    h: play.h - (nTop > 0 ? topBleed : LINE_BREATHING) - LINE_BREATHING,
  };

  const zones: Record<ZoneName, Box> = {
    play,
    trick: { x: cx - trickW / 2, y: cy - trickH / 2, w: trickW, h: trickH },
    deck: { x: deckX - spec.card.w / 2, y: pileY, w: spec.card.w, h: spec.card.h },
    discard: { x: discardX - spec.card.w / 2, y: pileY, w: spec.card.w, h: spec.card.h },
    board: play,
    line,
    boneyard: bone,
    hand,
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

/**
 * A domino is 1:2 where a card is 2.5:3.5, and every piece renders into
 * the card-shaped base box (see table/layout.ts), so a tile inscribes
 * itself in that box rather than filling it. This is the resulting short
 * side — the unit the whole chain is measured in. Shared with
 * TileFace's own `tileBox` so the maths and the drawing agree.
 */
export function tileShortSide(card: PieceSize): number {
  return Math.min(card.w, card.h / 2);
}

/* ============================================================
   Board space — the coordinate system a domino chain lives in.
   Pure, and kept here rather than in the store so that layout and its
   tests never have to reach into React state to do maths.
   ============================================================ */

/** Extent of everything laid in board space, in board units. */
export interface BoardView {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Half-extents of a piece laid at `rot`, in board units. A piece in
 * board space is 1x2 (a domino), so a quarter turn swaps the axes.
 */
export function cellHalfExtent(rot: number): { hw: number; hh: number } {
  const turned = Math.round((((rot % 360) + 360) % 360) / 90) % 2 === 1;
  return turned ? { hw: 1, hh: 0.5 } : { hw: 0.5, hh: 1 };
}

export function podBox(slot: SeatSlot, density: Density = "regular"): Box {
  const size = POD_SIZE[density];
  return {
    x: slot.x - size.w / 2,
    y: slot.y - size.h / 2,
    w: size.w,
    h: size.h,
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
 * The 1-D distribution both `fanSlot` and `radialFanSlot` share: how far
 * apart to place `count` items across `available` px so a short hand
 * doesn't stretch to the edges and a long one compresses instead of
 * overflowing, plus the signed `-1..1` position of `index` within that
 * spread (used for the arc lift and rotation tapering at the ends).
 * Pulled out so a fan that runs along an arbitrary screen direction
 * (`radialFanSlot`) computes the exact same overlap/compression curve an
 * axis-aligned one does, rather than a second, easily-drifting copy of
 * the formula.
 */
function fanSpread(
  index: number,
  count: number,
  available: number,
  size: number,
  maxGap: number,
): { offset: number; t: number } {
  if (count <= 1) return { offset: 0, t: 0 };
  const usable = Math.max(0, available - size);
  const gap = Math.min(maxGap, usable / (count - 1));
  const spread = gap * (count - 1);
  return {
    offset: index * gap - spread / 2,
    // -1 at the left/first edge of the fan, +1 at the right/last.
    t: (index / (count - 1)) * 2 - 1,
  };
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

  const { offset, t } = fanSpread(index, count, within.w, size.w, maxGap);

  return {
    x: within.x + within.w / 2 + offset,
    // Ends of the arc sit lower than the middle.
    y: within.y + within.h / 2 + t * t * arcLift,
    rotation: t * maxRotation,
  };
}

export interface RadialFanOptions {
  /** Centre point the fan is built around. */
  anchor: { x: number; y: number };
  /**
   * Unit vector the fan spreads ALONG. `fanSlot` always spreads along
   * screen-x; this is the generalisation a side seat's hand needs —
   * perpendicular to that seat's own line to table centre, so it runs
   * top-to-bottom instead. (Named for what it does, not what axis it
   * happens to be — for a top/bottom seat this vector just points along
   * screen-x again, and the two functions agree exactly.)
   */
  spread: { x: number; y: number };
  /**
   * Unit vector pointing away from table centre. The ends of the fan
   * bow toward this — the same role `fanSlot`'s `arcLift` plays for the
   * hero's own hand (its ends dip toward the bottom of the screen, away
   * from the table).
   */
  away: { x: number; y: number };
  index: number;
  count: number;
  /** Total on-screen spread available — plays `within.w`'s role. */
  spreadWidth: number;
  size: PieceSize;
  /**
   * Rotation shared by every card in this fan before its own small
   * per-card tilt — a seat's base orientation (`SeatSlot.rotation`), so
   * a card actually stands toward the table rather than always reading
   * screen-upright regardless of which edge it was dealt to.
   */
  baseRotation: number;
  /** Max additional tilt at the outermost piece, in degrees. */
  maxTilt?: number;
  arcLift?: number;
  maxGap?: number;
}

/**
 * `fanSlot`'s generalisation to an arbitrary on-screen direction. Same
 * overlap/compression curve (`fanSpread`), projected along `spread`
 * instead of assuming screen-x, with the arc bow along `away` instead of
 * assuming screen-y-down and rotation starting from `baseRotation`
 * instead of 0.
 */
export function radialFanSlot(o: RadialFanOptions): FanSlot {
  const { anchor, spread, away, index, count, spreadWidth, size, baseRotation } = o;
  const maxTilt = o.maxTilt ?? 7;
  const arcLift = o.arcLift ?? 4;
  const maxGap = o.maxGap ?? size.w * 0.42;

  if (count <= 1) return { x: anchor.x, y: anchor.y, rotation: baseRotation };

  const { offset, t } = fanSpread(index, count, spreadWidth, size.w, maxGap);
  const bow = t * t * arcLift;

  return {
    x: anchor.x + spread.x * offset + away.x * bow,
    y: anchor.y + spread.y * offset + away.y * bow,
    rotation: baseRotation + t * maxTilt,
  };
}
