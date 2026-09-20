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
  | "hand"
  /** A fixed 5-slot row for poker's community cards — see `resolveTable`
   * for why it sits above `center`'s own pot readout rather than needing
   * a second independent "middle of the table" guess. */
  | "community"
  /** Poker's own pot-total badge box, anchored below `community` — see
   * `engine/types.ts`'s `ZoneId` doc for why this is not `"center"`. */
  | "pot"
  /** Poker's own remaining-deck stub, tucked beside `burnt` below `pot`
   * — see `engine/types.ts`'s `ZoneId` doc for why this is not `"deck"`. */
  | "stub"
  /** Poker's own burnt-card pile, beside `stub` — see `engine/types.ts`'s
   * `ZoneId` doc for why this is not `"discard"`. */
  | "burnt"
  /** BS's single central face-down stack, dead centre with `reveal`
   * stacked above it — see `engine/types.ts`'s `ZoneId` doc for why this
   * is neither `"deck"`, `"discard"` nor `"trick"`. */
  | "pile"
  /** The face-up row a challenged play is turned over into, above
   * `pile` — see `engine/types.ts`'s `ZoneId` doc. */
  | "reveal";

/**
 * Where a given SEAT is sitting, from this viewer's chair.
 *
 * `TableGeometry.seats` is ordered by POSITION, not by seat id — index 0
 * is always the bottom-centre chair and the rest walk the ring from
 * there. Offline the two coincide, because the viewer is seat 0 and
 * `seatAt(i)` is the identity; online they do not, and indexing the array
 * with a seat id silently returns somebody else's chair.
 *
 * It did exactly that. A player at seat 1 saw every opponent's hand one
 * position out — seat 2's tiles on the top edge instead of the left,
 * seat 3's on the right instead of the top — and seat 0's hand wrapped
 * around to index 0, which is the viewer's OWN chair, so the leader's
 * tiles were drawn face-down underneath the player's hand.
 */
export function slotForSeat(geometry: TableGeometry, seat: SeatId): SeatSlot | undefined {
  return geometry.seats.find((slot) => slot.seat === seat);
}

export interface TableGeometry {
  box: Box;
  density: Density;
  seats: SeatSlot[];
  /** See `ResolveOptions.viewerSeat`. Echoed so layout needs no second source. */
  viewerSeat: SeatId | null;
  zones: Record<ZoneName, Box>;
  /**
   * The box a growing pile assembly (deck + fanned discard) may occupy.
   *
   * Distinct from `zones.play` because `play` is only inset past the
   * seat RING, and a pod is not the outermost thing a seat owns — its
   * fanned hand reaches further in. A boundary derived from the pod's
   * own footprint alone undershoots the moment a hand is fanned beside
   * it, which is how a deep discard pile ends up sliding under an
   * opponent's cards. Computed once here and consumed by BOTH the fan's
   * clamp and the landscape deck's position (see `pileAssembly`), so the
   * two can never disagree — a second, independent version of this
   * calculation is precisely what went out of sync before.
   *
   * Same idea as `zones.line`, which does this for a camera-fitted
   * domino chain against fanned TILE hands; this is the card equivalent.
   */
  pileRegion: Box;
  /**
   * The y the pile assembly is CENTRED on — deck centre and discard-fan
   * centre both, so the two read as one row however deep the pile gets.
   *
   * A centre line rather than a starting edge, which is the correction
   * that matters. The fan used to begin at the region's top and grow
   * downward, which is `flex-start` by another name: a short pile sat
   * level with the deck and every card after that dragged the fan's
   * centre further below it. Growing symmetrically about a fixed line
   * keeps them level at every depth.
   *
   * Defaults to the side seats' own mid-y, so the piles sit level with
   * the pods flanking them, and falls back to the region's centre when
   * there are no side seats. `ResolveOptions.pileAnchor` overrides it.
   */
  pileAxis: number;
  /**
   * What `ResolveOptions.topZone`/`bottomZone` were actually GRANTED, in
   * px, which is not always what was asked for — a short landscape phone
   * cannot give up 150px above the hand and still have a table left.
   *
   * A game must size its own chrome from this rather than from the value
   * it requested. Assuming the request was honoured is how a bottom
   * sheet ends up resting on top of the seat pods on exactly one device.
   */
  reserved: { top: number; bottom: number };
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

/**
 * Below this height a viewport has no vertical room to spare, whatever
 * its width. Three things key off it and they are the same judgement:
 * `resolveDensity` refuses the `wide` tier, `resolveTable` shrinks the
 * hand strip to what the cards actually need, and Rummy refuses to lay
 * out at all (see `isShortViewport`).
 */
export const SHORT_VIEWPORT_H = 560;

export function resolveDensity(w: number, h: number): Density {
  // Width drives the tier, but a short landscape phone (e.g. 844x390)
  // has no vertical room for `wide` piece sizes, so height demotes it.
  if (w < 640) return "compact";
  if (w < 1024 || h < SHORT_VIEWPORT_H) return "regular";
  return "wide";
}

/**
 * Is this viewport too short to lay a full table out on?
 *
 * Measured on a 1052x486 landscape phone with Rummy's real chrome: hand
 * zone 165px, hand header 64px and a 81px resting board sheet left the
 * table **86px tall** — pods, deck and discard all crushed into one strip
 * behind the sheet. Three bands dividing an exhausted budget, which no
 * single constant can fix.
 *
 * A game with this much chrome answers it by not rendering: Rummy asks
 * the player to rotate. Games with less chrome (Spades, Dominoes, LRC)
 * still fit, and only take the hand-strip relief `resolveTable` applies.
 *
 * Keyed on HEIGHT, not on landscape-ness: a 1440x900 desktop is
 * landscape and perfectly fine, while a 844x390 phone is not.
 */
export function isShortViewport(box: { h: number }): boolean {
  return box.h < SHORT_VIEWPORT_H;
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
  // The two phone tiers were sized before any fan could pan. Under that
  // constraint every piece had to be small enough that the WORST case
  // still fitted on screen, so the ordinary case paid for the extreme
  // one. Compress-then-pan removes that: an overflowing fan now has
  // somewhere to go (see MIN_HAND_GAP_FRACTION), so these are sized for
  // the hand you normally hold rather than the biggest one possible.
  // `wide` is unchanged — a desktop already had the room and never had
  // the problem.
  compact: {
    handCard: { w: 64, h: 90 },
    card: { w: 48, h: 67 },
    miniCard: { w: 28, h: 39 },
    handZone: 150,
    ringPad: 14,
    podInset: 46,
  },
  regular: {
    handCard: { w: 74, h: 103 },
    card: { w: 56, h: 78 },
    miniCard: { w: 32, h: 45 },
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
 * `LINE_BREATHING`'s counterpart for `pileRegion`.
 *
 * Raised from 8 once the fan stopped overhanging its region (see
 * `fadeMargin` in `pileAssembly`): with the overhang gone, this is the
 * WHOLE visible gap between the pile and the next player's cards, and 8px
 * of it read as the two touching.
 */
const PILE_BREATHING = 16;

/**
 * Felt between the deck and the discard fan, as a fraction of card
 * width. Shared between `pileAssembly`, which lays the pair out, and
 * `pileRegion`'s own minimum width, which has to be wide enough to hold
 * that pair — a floor narrower than the thing it is flooring is not a
 * floor, and let the assembly hang out of its own region on a small
 * phone at six seats.
 */
const PILE_GAP_FRACTION = 0.42;

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
  /**
   * Reserved band at the TOP of the viewport for a game's own HUD strip,
   * in px. The seat ring and everything inside it starts below it.
   * Default 0 — every existing game is unaffected.
   */
  topZone?: number;
  /**
   * Reserved band directly ABOVE the hand, in px — for a bottom sheet's
   * resting height (Rummy's board rail). The ring stops above this
   * rather than the sheet covering the table's lowest seats. Default 0.
   */
  bottomZone?: number;
  /**
   * Where the pile assembly's CENTRE LINE sits within `pileRegion`, as a
   * 0..1 fraction (0 = flush top, 1 = flush bottom).
   *
   * Omit it — the default (the side seats' mid-y) is what a game
   * actually wants, since it puts the piles level with the pods either
   * side of them. This exists for a table whose seats say nothing useful
   * about where its piles belong.
   */
  pileAnchor?: number;
  /**
   * Whose point of view the table is drawn from. Defaults to seat 0, which
   * is every offline game.
   *
   * Seats are laid out by POSITION and then labelled, so pinning a
   * different viewer bottom-centre is a relabelling rather than a second
   * layout: position 0 is always "the person looking at this screen", and
   * the seat ids walk anticlockwise from there. Everything downstream
   * still speaks in real seat ids, which is what keeps a game's own state
   * — hands, bids, scores, all keyed by seat — from needing to be rewritten
   * per viewer.
   *
   * `null` is a spectator: nobody is at the bottom, no hand belongs to the
   * viewer, and every seat gets a pod.
   */
  viewerSeat?: SeatId | null;
}

export function resolveTable(opts: ResolveOptions): TableGeometry {
  const { seats: seatCount, width, height } = opts;
  // `undefined` means "no opinion", which is the offline default of seat 0.
  // `null` is a deliberate spectator and is NOT the same thing.
  const viewerSeat = opts.viewerSeat === undefined ? HERO : opts.viewerSeat;
  const seatBase = viewerSeat ?? HERO;
  const watching = viewerSeat === null;
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
  // The hand strip is generous by default, which is right when there is
  // height to be generous with. On a short viewport it is the single
  // biggest claim on the axis everything else is also competing for, so
  // it drops to what the cards themselves actually need: one card plus
  // the ~18px a selected card lifts, and no more. Measured: 165px down
  // to 129px on a 1052x486 landscape phone, all of it handed back to the
  // table. Full-height viewports are untouched.
  const short = height < SHORT_VIEWPORT_H;
  const handZone = Math.min(
    opts.handZone ?? spec.handZone,
    height * 0.34,
    short ? spec.handCard.h * 1.25 : Infinity,
  );

  const box: Box = { x: 0, y: 0, w: width, h: height };

  // The band seats may occupy: full width, top of the viewport down to
  // the top of the hero's hand strip — minus whatever bands the game has
  // reserved for its own chrome above and below (both default 0, so
  // every existing game resolves byte-identically).
  //
  // The clamp has to account for what the RING itself needs, not just
  // for the raw height available: `play` is the ring inset by a full
  // `podInset` on every edge holding seats, so reserving everything down
  // to `height - handZone` leaves a play area of negative height. A
  // short landscape phone (844x390) hits this immediately with any
  // realistic bottom band — confirmed by geometry.test.ts, which caught
  // it as a real -22px play zone rather than a hypothetical.
  //
  // When the request does not fit, both bands scale down TOGETHER rather
  // than one being honoured and the other truncated: they are two halves
  // of one screen composition, and shrinking them proportionally keeps
  // that composition recognisable where dropping one outright would not.
  // `reserved` on the returned geometry reports what was actually
  // granted, so a game can size its own chrome to the answer instead of
  // assuming it got what it asked for.
  const ringNeed = podInset + spec.card.h * 1.1;
  const reserveCap = Math.max(0, height - handZone - spec.ringPad * 2 - ringNeed);
  const wantTop = Math.max(0, opts.topZone ?? 0);
  const wantBottom = Math.max(0, opts.bottomZone ?? 0);
  const wanted = wantTop + wantBottom;
  const scale = wanted > reserveCap && wanted > 0 ? reserveCap / wanted : 1;
  const topZone = wantTop * scale;
  const bottomZone = wantBottom * scale;
  const ringLeft = spec.ringPad;
  const ringRight = width - spec.ringPad;
  const ringTop = spec.ringPad + topZone;
  const ringBottom = height - handZone - bottomZone - spec.ringPad;
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
      seat: seatBase,
      x: width / 2,
      // A spectator has no hand strip to sit above, so the bottom pod
      // would be centred on the very edge of the viewport and half of it
      // would be off screen. It gets the same inset every other edge uses.
      y: watching ? height - podInset / 2 : height - handZone / 2,
      anchor: "bottom",
      rotation: 0,
      isHero: !watching,
    },
  ];

  /**
   * Position index, not a seat id. The two coincide offline because the
   * viewer is seat 0; online they do not, and conflating them is what
   * would put somebody else's cards in your hand.
   */
  let position = 1;
  const seatAt = (i: number): SeatId => (i + seatBase) % seatCount;

  // Left edge, bottom to top — the hero's immediate left comes first.
  for (let i = 0; i < nLeft; i++) {
    seats.push({
      seat: seatAt(position++),
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
      seat: seatAt(position++),
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
      seat: seatAt(position++),
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

  // Community: a fixed row of 5 slots — poker's flop/turn/river. Unlike
  // `trick`'s fanned cluster, these never overlap, so the row wants its
  // full 5-card width; clamped to the play area so it still fits on a
  // narrow phone (layout.ts's own scale math shrinks the cards to match
  // if this clamp ever engages). Sits ABOVE centre, deliberately, leaving
  // room below for the `pot` zone computed right after it.
  const communityGap = spec.card.w * 0.15;
  const communityW = Math.min(play.w * 0.94, spec.card.w * 5 + communityGap * 4);
  const communityH = spec.card.h;
  // The desired gap between the row's own centre-line and `cy`, clamped
  // so it can never push the row above `play.y` — on a short landscape
  // phone `play.h` can be thin enough that the "ideal" offset would put
  // the row over a top-row pod. Matches `pileRegion`'s own precedent of
  // giving ground on the tightest viewport rather than asserting the
  // impossible.
  const communityOffset = Math.min(
    spec.card.h * 0.65,
    Math.max(0, play.h / 2 - communityH / 2),
  );
  const communityBottom = cy - communityOffset - communityH / 2 + communityH;

  // Pot: box for the pot-total badge, sized off `miniCard` (see
  // `ZoneName`'s doc) — originally to hold a small fanned chip pile,
  // kept as the box's footprint now that the pile has been replaced by
  // a plain "$" readout (see `engine/types.ts`'s `ZoneId` doc), since a
  // single-line badge fits it with room to spare and the anchoring below
  // is the part that actually matters. Anchored to `community`'s own
  // actual bottom edge plus a real gap — not to a fraction of `cy` the
  // way an earlier version assumed — so the two zones cannot overlap
  // regardless of how little vertical room a viewport leaves: if there
  // isn't enough room below the community row for the box's wanted
  // height, the BOX shrinks to what's actually there rather than
  // reaching down past `play`'s own bottom edge, the same "give ground
  // on the tightest viewport" trade `pileRegion` already makes.
  const potGap = spec.miniCard.h * 0.3;
  const potRows = 3;
  const potHWanted = spec.miniCard.w * (1 + 0.85 * (potRows - 1));
  const potRoom = Math.max(0, play.y + play.h - (communityBottom + potGap));
  // At least one row tall even on the rare viewport where `potRoom`
  // undershoots that — same "being drawable beats being perfectly
  // contained" trade `pileRegion`'s own floor makes — but never more
  // than what community + gap actually left below it.
  const potH = Math.max(spec.miniCard.w, Math.min(potHWanted, potRoom));
  const potW = Math.max(spec.miniCard.w, Math.min(play.w * 0.9, spec.miniCard.w * 5));
  const potY = communityBottom + potGap;

  // Stub + burnt: poker's own low-emphasis face-down piles — the
  // remaining deck and the burn-card pile — continuing the SAME vertical
  // stack `pot` started below `community`, rather than reusing Rummy's
  // `deck`/`discard` zones, which are anchored to `cy` for a table that
  // has nothing else there. A poker table does, now (`community`/`pot`
  // both claim it), so those two zones would collide with them on every
  // single hand — this is the fix for exactly that, not a guess at one.
  // Side by side, small, tucked below the pot pile; shrinks (never
  // reaches back up into `pot`) on a viewport too short to fit its
  // wanted size, the same floor-then-shrink trade every zone below
  // `community` already makes.
  const stubGap = spec.miniCard.h * 0.3;
  const stubHWanted = spec.miniCard.h * 1.3;
  const stubRoom = Math.max(0, play.y + play.h - (potY + potH + stubGap));
  const stubH = Math.max(spec.miniCard.h * 0.6, Math.min(stubHWanted, stubRoom));
  const stubY = potY + potH + stubGap;
  const stubCardW = spec.miniCard.w * 1.3;
  const stubPairGap = spec.miniCard.w * 0.3;

  // BS: one central face-down pile with the face-up `reveal` row directly
  // above it. Laid out as a PAIR centred on `cy` rather than as two
  // independent guesses at "the middle of the table", because that is the
  // only arrangement in which the two cannot overlap — the same reason
  // poker's community/pot/stub/burnt are computed as one chain rather than
  // each from its own fraction of `cy` (see `engine/types.ts`'s `ZoneId`).
  //
  // The gap between them gives ground first on a viewport too short for
  // both rows; past that the pair keeps its size and is clamped as far
  // inside `play` as it will go, the same "being drawable beats being
  // perfectly contained" trade every zone below `community` already makes.
  const bsGapWanted = spec.card.h * 0.3;
  const bsGap = Math.max(0, Math.min(bsGapWanted, play.h - spec.card.h * 2));
  const bsPairH = spec.card.h * 2 + bsGap;
  const bsTop = Math.max(play.y, Math.min(cy - bsPairH / 2, play.y + play.h - bsPairH));
  // Four cards is as many as one rank can hold, so a reveal never needs a
  // fifth slot. They deliberately do not overlap — the whole point of the
  // row is that all of them are legible at once — so it wants its full
  // width, clamped to the play area for a narrow phone.
  const bsRevealGap = spec.card.w * 0.16;
  const bsRevealW = Math.min(play.w * 0.94, spec.card.w * 4 + bsRevealGap * 3);

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
  const topBleed = Math.max(
    LINE_BREATHING,
    Math.max(0, podSize.h / 2 - podInset / 2) + miniH + TILE_HAND_GAP + LINE_BREATHING,
  );
  // A side seat's rack now stands on its short side and stacks in a
  // COLUMN along the pod's own edge (layout.ts's "hand" case), the same
  // redesign [[domino-side-seat-hand-overlap]] tracked — so, exactly
  // like `topBleed` above, this reserves room for ONE rotated tile
  // (`miniH`, its length once turned sideways), never for the whole
  // rack. A 7-tile hand and a 1-tile hand reach the same distance past
  // the pod; only the column's LENGTH grows with the hand, and that runs
  // parallel to the felt's edge, not into it.
  const sideReach = Math.max(0, podSize.w / 2 - podInset / 2) + miniH + TILE_HAND_GAP;
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

  // `pileRegion` — `play` pulled clear of the real pod footprint AND an
  // opponent's fanned CARD hand, the same job `line` does above for
  // fanned TILE hands and a camera-fitted chain.
  //
  // The card case is genuinely cheaper than the tile one, and for a
  // structural reason worth stating: a card hand fans PERPENDICULAR to
  // its seat's line to table centre (see layout.ts's "hand" case), so
  // the fan's WIDTH never adds to how far that hand reaches inward —
  // only one card's own rotated thickness does. A tile rack fans along
  // screen-x regardless of seat, which is why `sideBleed` above has to
  // carry a whole `maxFanW` and this does not.
  //
  // As with `line`, `podInset / 2` converts a pod-CENTRE-relative reach
  // (what layout.ts computes) into a `play`-EDGE-relative one.
  const cardTopReach =
    Math.max(0, podSize.h / 2 - podInset / 2) + spec.miniCard.h + TILE_HAND_GAP;
  // A left/right seat's cards are rotated a quarter turn, so the
  // footprint facing the table is the card's HEIGHT, not its width —
  // matching `cardFootprint` in layout.ts's own opponent-card branch.
  const cardSideReach =
    Math.max(0, podSize.w / 2 - podInset / 2) + spec.miniCard.h + TILE_HAND_GAP;
  const pileTop = nTop > 0 ? cardTopReach + PILE_BREATHING : PILE_BREATHING;
  const pileSide = nLeft > 0 || nRight > 0 ? cardSideReach + PILE_BREATHING : PILE_BREATHING;
  const rawPile: Box = {
    x: play.x + (nLeft > 0 ? pileSide : PILE_BREATHING),
    y: play.y + pileTop,
    w:
      play.w -
      (nLeft > 0 ? pileSide : PILE_BREATHING) -
      (nRight > 0 ? pileSide : PILE_BREATHING),
    h: play.h - pileTop - PILE_BREATHING,
  };
  // Never let the clearances eat the region entirely on a small phone
  // with seats on every edge — a pile that cannot be drawn is worse than
  // one sitting a little close. The width floor is exactly the deck and
  // one discard card side by side with their gap, derived from the same
  // constant `pileAssembly` lays them out with.
  //
  // Centred on what the clearances DID leave, rather than pinned to
  // their left/top edge: when the floor engages, the region has to
  // encroach on something, and splitting that evenly between the two
  // sides is strictly better than dumping all of it on one.
  const floorW = Math.max(spec.card.w * (2 + PILE_GAP_FRACTION), rawPile.w);
  const floorH = Math.max(spec.card.h * 1.2, rawPile.h);
  const pileRegion: Box = {
    x: rawPile.x - (floorW - rawPile.w) / 2,
    y: rawPile.y - (floorH - rawPile.h) / 2,
    w: floorW,
    h: floorH,
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
    community: {
      x: cx - communityW / 2,
      y: cy - communityH / 2 - communityOffset,
      w: communityW,
      h: communityH,
    },
    pot: { x: cx - potW / 2, y: potY, w: potW, h: potH },
    stub: { x: cx - stubPairGap / 2 - stubCardW, y: stubY, w: stubCardW, h: stubH },
    burnt: { x: cx + stubPairGap / 2, y: stubY, w: stubCardW, h: stubH },
    pile: {
      x: cx - spec.card.w / 2,
      y: bsTop + spec.card.h + bsGap,
      w: spec.card.w,
      h: spec.card.h,
    },
    reveal: { x: cx - bsRevealW / 2, y: bsTop, w: bsRevealW, h: spec.card.h },
  };

  // The line the pile assembly is centred on.
  //
  // By default the SEAT PODS down the sides — the table's real eye level,
  // and where a player looks for the piles. Deriving it from the seats
  // rather than from a fraction of the region is what keeps it right as
  // the region changes shape across densities and seat counts; a
  // hand-tuned fraction lands correctly on one viewport and drifts on the
  // rest. `pileAnchor` overrides it for a table whose seats say nothing
  // useful.
  //
  // Note this is a CENTRE, not the top of a box the fan then grows down
  // from. That earlier arrangement was `flex-start` by another name: the
  // deck stayed level with the pods while every extra discard dragged the
  // fan's own centre further below it. `pileRegion` is left whole, and
  // `pileAssembly` grows the fan symmetrically about this line.
  const sideSeats = seats.filter((s) => s.anchor === "left" || s.anchor === "right");
  const wantedAxis =
    opts.pileAnchor === undefined
      ? sideSeats.length > 0
        ? sideSeats.reduce((sum, s) => sum + s.y, 0) / sideSeats.length
        : pileRegion.y + pileRegion.h / 2
      : pileRegion.y + pileRegion.h * Math.min(1, Math.max(0, opts.pileAnchor));
  // Clamped so a single card on that line still fits the region it was
  // cleared for, whatever the seats happen to be doing.
  const halfCard = spec.card.h / 2;
  const pileAxis = Math.min(
    Math.max(pileRegion.y + halfCard, wantedAxis),
    Math.max(pileRegion.y + halfCard, pileRegion.y + pileRegion.h - halfCard),
  );

  return {
    box,
    density,
    seats,
    viewerSeat,
    zones,
    pileRegion,
    pileAxis,
    reserved: { top: topZone, bottom: bottomZone },
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
  /**
   * How strongly this piece should be drawn given the box it belongs to,
   * 0..1, measured along the spread axis. 1 while it sits comfortably
   * inside, ramping to 0 by the time panning has carried its centre out
   * to the edge (see `alongVisibility` for the exact band).
   *
   * This is what a fan has instead of a clip. A pannable fan ALWAYS
   * draws pieces outside the box it was given — `minGap` stops it
   * compressing, so the excess has to go somewhere — and the app's one
   * flat piece layer has no wrapper to put `overflow: hidden` on: every
   * card is an independent absolutely positioned node, deliberately
   * (see CLAUDE.md). So the pieces fade themselves out instead, which is
   * both the honest fix and a compositor-only one.
   *
   * Ramping rather than snapping at the boundary is what makes it read
   * as a masked scroller rather than as cards blinking out of existence.
   * The band is a fraction of the piece's own extent, so it scales with
   * the pieces and needs no per-density tuning.
   *
   * Only ever below 1 for a fan using `minGap` — a fan without a
   * compression floor fits by construction.
   */
  visible: number;
  /**
   * False once this piece has been panned far enough out of `within` to
   * stop being drawn at all. Exactly `visible > 0`; kept as its own
   * field because "is there hidden content this way" is a different
   * question from "how far faded is this one piece", and the edge-fade
   * affordance asks the first. Never a reason to skip rendering: pieces
   * never unmount.
   */
  inView: boolean;
}

/**
 * How strongly a piece of `extent` centred at `centre` should be drawn
 * given the box `[lo, hi]` it belongs to, as 0..1.
 *
 * Measured from the piece's CENTRE to the nearer edge: solid once that
 * distance reaches `FADE_BAND_FRACTION` of the piece's own extent, and
 * zero by the time the centre reaches the edge itself.
 *
 * Two properties fall out of anchoring it on the centre. A piece is gone
 * before it is even half outside — the fade finishes early rather than
 * trailing a ghost card out into the pods, which is what "bring the
 * start-to-fade cards in a little" asked for. And a fan with no
 * compression floor is untouched with room to spare: its outermost piece
 * sits flush, half an extent from the edge, comfortably past the 0.45
 * the band needs — so no pixel-snapping guard is required to keep float
 * residue from dimming every other game's fans.
 */
const FADE_BAND_FRACTION = 0.45;

function alongVisibility(centre: number, extent: number, lo: number, hi: number): number {
  if (extent <= 0) return 1;
  const band = extent * FADE_BAND_FRACTION;
  if (band <= 0) return 1;
  const inside = Math.min(centre - lo, hi - centre);
  return Math.max(0, Math.min(1, inside / band));
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
  /**
   * Compression FLOOR: the narrowest the gap between piece centres is
   * allowed to get. Default 0, which is exactly today's behaviour —
   * compress without limit until the fan fits.
   *
   * Unbounded compression is wrong past a certain depth: a 20+ card
   * discard pile or a hand that just swallowed half of one shrinks to
   * unreadable slivers, and every extra card makes it worse. With a
   * floor set, the fan compresses to it and then STOPS; whatever no
   * longer fits becomes a pannable range instead (see `pan` and
   * `fanPanRange`). Trading "see all of it, illegibly" for "see part of
   * it, legibly, and drag for the rest" is the whole point.
   */
  minGap?: number;
  /**
   * Pan offset along the spread axis, in px. Meaningful only alongside
   * `minGap`, since a fan with no floor never overflows. Clamp callers'
   * values to `[0, fanPanRange(...)]` and pass the SIGNED offset — see
   * `fanPanRange`'s doc for why the stored value is signed rather than
   * a raw 0..max scroll.
   */
  pan?: number;
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
  minGap = 0,
  pan = 0,
): { offset: number; t: number; overflow: number } {
  if (count <= 1) return { offset: 0, t: 0, overflow: 0 };
  const usable = Math.max(0, available - size);
  // `minGap` is the compression floor. Without one (the default, and
  // every pre-existing caller) this is the original
  // `min(maxGap, usable / (count - 1))` exactly.
  const gap = Math.max(minGap, Math.min(maxGap, usable / (count - 1)));
  const spread = gap * (count - 1);
  return {
    offset: index * gap - spread / 2 + pan,
    // -1 at the left/first edge of the fan, +1 at the right/last.
    t: (index / (count - 1)) * 2 - 1,
    // Only nonzero once the floor stopped the fan from shrinking to fit.
    //
    // Snapped below a whole pixel: a fan sized to exactly its own
    // content leaves float residue on the order of 1e-15, and "there is
    // 0.000000000000007px of hidden content" is not a thing to offer the
    // player a drag for.
    overflow: spread - usable >= 1 ? spread - usable : 0,
  };
}

/**
 * How far a floored fan can be panned, in px — the part of it that does
 * not fit. Zero for any fan without a `minGap`, which is why every
 * existing caller is unaffected.
 *
 * The value callers should STORE is a signed pan in `[-range/2,
 * +range/2]`, not a raw `[0, range]` scroll. `fanSpread` centres the
 * whole fan on `within`, so pan 0 shows the MIDDLE of an overflowing
 * fan with content hidden off BOTH ends — which reads as broken before
 * the player has dragged anything. Converting to a signed pan lets a
 * caller start at `+range/2`, which puts the fan's first piece flush
 * against the near edge, exactly where a hand or a pile should begin.
 */
export function fanPanRange(o: {
  count: number;
  available: number;
  size: number;
  maxGap: number;
  minGap: number;
}): number {
  return fanSpread(0, o.count, o.available, o.size, o.maxGap, o.minGap).overflow;
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
      visible: 1,
      inView: true,
    };
  }

  const { offset, t } = fanSpread(
    index,
    count,
    within.w,
    size.w,
    maxGap,
    o.minGap ?? 0,
    o.pan ?? 0,
  );

  const x = within.x + within.w / 2 + offset;
  // Measured along the spread axis only. The cross axis is fixed by
  // construction — a fan never moves off it — so folding it in would
  // only introduce false fades from rounding.
  const visible = alongVisibility(x, size.w, within.x, within.x + within.w);

  return {
    x,
    // Ends of the arc sit lower than the middle.
    y: within.y + within.h / 2 + t * t * arcLift,
    rotation: t * maxRotation,
    visible,
    // "Any part of the piece is inside the box", not "its centre is" —
    // a card half over the edge is still something the player can see
    // and should not be reported as hidden content behind a fade.
    inView: visible > 0,
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
  /** Compression floor — see `FanOptions.minGap`. */
  minGap?: number;
  /** Pan along `spread`, in px — see `FanOptions.pan`. */
  pan?: number;
  /**
   * Box to measure `visible`/`inView` against. Omit for a fan that
   * always fits (an opponent's hand), in which case the piece is simply
   * fully visible.
   */
  within?: Box;
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

  if (count <= 1) {
    return { x: anchor.x, y: anchor.y, rotation: baseRotation, visible: 1, inView: true };
  }

  // `size.w` is the piece's extent ALONG `spread`, not its screen width
  // — for a fan running down the screen the caller passes the piece's
  // height there. Same convention the opponent-hand caller already uses.
  const { offset, t } = fanSpread(
    index,
    count,
    spreadWidth,
    size.w,
    maxGap,
    o.minGap ?? 0,
    o.pan ?? 0,
  );
  const bow = t * t * arcLift;
  const x = anchor.x + spread.x * offset + away.x * bow;
  const y = anchor.y + spread.y * offset + away.y * bow;

  // Measured along `spread` and nothing else, which needs the box
  // projected onto that direction too. Testing screen-x and screen-y
  // independently (what this did first) is wrong for the same reason it
  // would be for `fanSlot`: only the spread axis can overflow, and the
  // cross axis reports a false partial fade the moment the piece's two
  // dimensions differ — a portrait fan passes the card's HEIGHT as its
  // along-extent, so an x-axis test compares a card's height against a
  // column exactly one card WIDE and finds it hanging out both sides.
  let visible = 1;
  if (o.within) {
    const b = o.within;
    const boxCentreAlong = (b.x + b.w / 2) * spread.x + (b.y + b.h / 2) * spread.y;
    const boxHalfAlong = (Math.abs(spread.x) * b.w + Math.abs(spread.y) * b.h) / 2;
    visible = alongVisibility(
      x * spread.x + y * spread.y,
      size.w,
      boxCentreAlong - boxHalfAlong,
      boxCentreAlong + boxHalfAlong,
    );
  }

  return {
    x,
    y,
    rotation: baseRotation + t * maxTilt,
    visible,
    // Without a `within` there is nothing to be outside of — an
    // opponent's hand has no compression floor and always fits by
    // construction.
    inView: visible > 0,
  };
}

/* ============================================================
   Pile assembly — the deck and discard, and how they share space
   ============================================================ */

/**
 * The compression floor for the discard pile, as a fraction of card
 * width. 0.22 was tried first and still let a deep pile compress to
 * unreadable before panning ever engaged; 0.36 held it, and 0.46 is
 * where it sits now — the pile still read as tightly packed at 0.36 on
 * both phone and desktop, and once panning exists there is no reason to
 * keep squeezing rather than simply offering the drag sooner.
 *
 * Deliberately a SEPARATE constant from `MIN_HAND_GAP_FRACTION` — they
 * answer different questions (how tightly may a pile on the felt stack,
 * vs how tightly may cards you are holding), and retuning one must never
 * silently drag the other along with it. That is not hypothetical: they
 * no longer share a value, precisely because the pile wanted a bigger
 * loosening than the hand could afford.
 */
export const MIN_DISCARD_STEP_FRACTION = 0.46;

/**
 * The hero hand's own compression floor. See MIN_DISCARD_STEP_FRACTION.
 *
 * Raised far less than the pile's, and the ceiling is a real one: a full
 * 13-card Rummy hand has to keep fitting a 390px phone without panning,
 * because dragging to see your own cards while planning a meld is a much
 * worse trade than a slightly tighter fan. At 0.38 with the current
 * `compact` card it fits with a little to spare; past that it does not.
 * The smallest phones (360px) do pan a 13-card hand, which is the
 * accepted cost of the bigger cards.
 */
export const MIN_HAND_GAP_FRACTION = 0.38;

/**
 * The WIDEST the discard fan spreads, as a fraction of the card's extent
 * along the fan — the ceiling `MIN_DISCARD_STEP_FRACTION` is the floor
 * of. A short pile never needs to overlap at all, and at 0.38 even three
 * cards read as one tight stack.
 *
 * Exported because `pileAssembly` (which computes the pan range) and
 * `layout.ts` (which places each card) must pass the SAME value — the
 * two derive different halves of one fan, and a mismatch would offer a
 * drag for content that is not actually hidden, or hide content with no
 * drag on offer.
 */
export const MAX_DISCARD_STEP_FRACTION = 0.55;

/**
 * The shortest run the discard fan will accept before it starts giving
 * back its fade margin, as a multiple of the card's extent along the
 * fan. Roughly four cards at the compression floor — below that the fan
 * stops being a fan and becomes a stack with a drag handle.
 */
const MIN_USABLE_RUN = 2.5;

/**
 * Does the deck/discard assembly lay out side by side (landscape) or
 * stacked one above the other (portrait)?
 *
 * This is NOT a relabelling of the same layout — the two orientations
 * have genuinely different axis relationships, and the deck's behaviour
 * differs because of it:
 *
 *  - PORTRAIT: deck and discard sit side by side on screen-X, and the
 *    discard fans DOWNWARD along screen-Y. The offset axis between the
 *    two piles is perpendicular to the fan's growth axis, so the pile
 *    growing has no reason to move the deck at all. The deck never
 *    moves.
 *  - LANDSCAPE: deck and discard share one horizontal row, and the fan
 *    also grows horizontally. Now the offset axis IS the growth axis, so
 *    the deck slides left to make room as the fan widens, flexbox-style,
 *    clamped at `pileRegion`'s stops. This is deliberate and requested,
 *    not drift to be prevented.
 */
export function isPortraitTable(region: Box): boolean {
  return region.h >= region.w;
}

/**
 * Everything a caller needs to lay out the discard fan and place the
 * deck beside it, derived ONCE from `pileRegion` so the fan's own clamp
 * and the deck's landscape position can never disagree. A second,
 * parallel "how close may this get to a hand" calculation is exactly
 * what drifted out of sync last time.
 */
export interface PileAssembly {
  portrait: boolean;
  /** Box the discard fan spreads inside. */
  fan: Box;
  /** Centre of the deck's own card, before any landscape shift. */
  deck: { x: number; y: number };
  /** Gap between piece centres once the floor has engaged. */
  minStep: number;
  /** How far the fan can be panned; 0 while it still fits. */
  panRange: number;
  /** Leftmost the deck's centre may slide to in landscape. */
  deckMinX: number;
}

export function pileAssembly(g: TableGeometry, discardCount: number): PileAssembly {
  const region = g.pileRegion;
  const card = g.card;
  const axis = g.pileAxis;
  const portrait = isPortraitTable(region);
  const minStep = card.w * MIN_DISCARD_STEP_FRACTION;

  // The fan gets the region minus the deck's own column/row plus a gap.
  const gap = card.w * PILE_GAP_FRACTION;
  const deckSlot = card.w + gap;

  // ...and minus a half-card at each END of its run, which is the piece
  // of this that was missing and got reported.
  //
  // A fanned card is drawn while its CENTRE is inside the fan box (see
  // `alongVisibility`), so the outermost thing on screen reaches half a
  // card PAST that box. Sizing the box flush to `pileRegion` therefore
  // let a fading card cross the region's edge by up to half its width —
  // which on a desktop is ~46px, and the region's own clearance to an
  // opponent's hand is only `PILE_BREATHING`. The visible result was the
  // right-hand end of a long pile lying over the next player's cards.
  //
  // Reserving the overhang inside the box instead makes `pileRegion` a
  // true bound on everything drawn, at the cost of one card's worth of
  // fan length. That is the right trade: the length is recoverable by
  // panning, the overlap was not fixable at all.
  //
  // It is taken out of SLACK, though, never out of the fan's last few
  // cards. On a 360x640 phone that has also given up a band to a bottom
  // sheet, the region is already down to its own floor, and a flat
  // half-card subtraction there left a fan exactly one card long — a
  // pile that pans from the second card is not a pile. Below
  // `MIN_USABLE_RUN` the margin gives way instead, which is the same
  // ordering of priorities `pileRegion`'s own floor already takes: being
  // drawable beats being perfectly contained.
  const usableRun = (room: number, extent: number) =>
    Math.min(extent / 2, Math.max(0, room - extent * MIN_USABLE_RUN) / 2);

  if (portrait) {
    // Deck and discard side by side on X; the fan runs down Y.
    //
    // The fan gets a COLUMN exactly one card wide, not "the whole region
    // minus the deck". `fanSlot` centres a fan inside the box it is
    // given, so handing it a box far wider than it needs parks it in the
    // middle of that width and leaves a lake of empty felt between the
    // two piles — which is precisely what it did. The pair is sized to
    // its real content and then centred as a unit instead.
    const pairW = card.w * 2 + gap;
    const pairLeft = region.x + Math.max(0, (region.w - pairW) / 2);
    const stepV = card.h * MIN_DISCARD_STEP_FRACTION;
    // Sized to its CONTENT, capped at the room available — and the room
    // available is the SYMMETRIC budget about `pileAxis`, not the whole
    // region. A fan centres itself in the box it is given, so a box
    // centred on the axis is a fan centred on the axis, which is a fan
    // level with the deck at every depth. Taking the whole region instead
    // would centre a deep fan on the region's middle and let it drift
    // below the deck as it grew, which is exactly the `flex-start` look
    // this replaced. Past the cap the excess becomes pan range.
    const room = 2 * Math.min(axis - region.y, region.y + region.h - axis);
    const budget = room - usableRun(room, card.h) * 2;
    const fanH = Math.max(
      card.h,
      Math.min(budget, card.h + stepV * Math.max(0, discardCount - 1)),
    );
    const fan: Box = { x: pairLeft + card.w + gap, y: axis - fanH / 2, w: card.w, h: fanH };
    const panRange = fanPanRange({
      count: discardCount,
      available: fanH,
      size: card.h,
      maxGap: card.h * MAX_DISCARD_STEP_FRACTION,
      minGap: stepV,
    });
    return {
      portrait,
      fan,
      // The same line the fan is centred on — one row, two piles.
      deck: { x: pairLeft + card.w / 2, y: axis },
      minStep: stepV,
      panRange,
      deckMinX: pairLeft + card.w / 2,
    };
  }

  // Landscape: one horizontal row, and here the fan legitimately wants
  // the run — it grows along the same axis the two piles are offset on,
  // which is why the deck gives ground to it as the pile deepens (see
  // `pileAssemblyHorizontal`). The fan is centred on what it actually
  // occupies rather than on the leftover width, for the same reason the
  // portrait branch above sizes its pair to content.
  // Both the deck's slot AND the fade overhang at each end come off the
  // run. The right-hand one is the one that showed: without it the pile's
  // far end lay across the next player's cards.
  const run = region.w - deckSlot;
  const naturalW = Math.min(
    run - usableRun(run, card.w) * 2,
    card.w + minStep * Math.max(0, discardCount - 1),
  );
  const fanW = Math.max(card.w, naturalW);
  const pairW = card.w + gap + fanW;
  const pairLeft = region.x + Math.max(0, (region.w - pairW) / 2);
  // One card tall, centred on `pileAxis`: a landscape fan runs sideways,
  // so it needs no vertical room, and pinning it to the axis puts it on
  // the deck's own line (see the portrait branch for the same point).
  const fan: Box = {
    x: pairLeft + card.w + gap,
    y: axis - card.h / 2,
    w: fanW,
    h: card.h,
  };
  const panRange = fanPanRange({
    count: discardCount,
    available: fan.w,
    size: card.w,
    maxGap: card.w * MAX_DISCARD_STEP_FRACTION,
    minGap: minStep,
  });
  return {
    portrait,
    fan,
    // Anchored to the PAIR's left edge, not the region's. Pinning the
    // deck to the region while re-centring the fan is what left the two
    // marooned at opposite ends of the felt — they are one composition
    // and have to be positioned from one origin.
    deck: { x: pairLeft + card.w / 2, y: axis },
    minStep,
    panRange,
    // The hard left stop is still the region's own edge: the deck may
    // give ground to a growing fan right up to it, and no further.
    deckMinX: region.x + card.w / 2,
  };
}

/**
 * The deck's landscape x — how far left it has been pushed by a growing
 * discard fan beside it. Portrait callers never ask (the deck does not
 * move); see `isPortraitTable`.
 *
 * The composition being preserved is "deck + fan, centred as one unit":
 * as the fan widens, the pair's combined centre would drift right, so
 * the deck gives ground to keep it put. Hard-stopped at `deckMinX` so it
 * can never walk out of `pileRegion` and under an opponent's hand.
 */
export function pileAssemblyHorizontal(
  g: TableGeometry,
  discardCount: number,
): { deckX: number; deckY: number } {
  const a = pileAssembly(g, discardCount);
  // `pileAssembly` already positions the deck from the PAIR's own left
  // edge, and the pair is sized to its content and centred — so the deck
  // walking left as the fan widens falls straight out of that, with the
  // gap between the two staying constant.
  //
  // It used to subtract a further shift here on top of that, which
  // double-counted: the deck moved left AND the fan re-centred, opening
  // a gap that grew to ~87px at eight cards and ~155px on desktop before
  // closing again once the fan hit its clamp. Deriving the position once
  // is what makes it right at every depth rather than at the extremes.
  return { deckX: Math.max(a.deckMinX, a.deck.x), deckY: a.deck.y };
}

/** Pan range for the discard fan at its current depth. */
export function discardMaxScroll(g: TableGeometry, discardCount: number): number {
  return pileAssembly(g, discardCount).panRange;
}

/**
 * Pan range for the hero's own hand. Same compress-then-pan pattern as
 * the discard pile — a hand that just swallowed six cards off the pile
 * needs it for exactly the same reason a deep pile does.
 */
export function handFanMaxScroll(g: TableGeometry, count: number): number {
  return fanPanRange({
    count,
    available: g.zones.hand.w,
    size: g.handCard.w,
    maxGap: g.handCard.w * 0.78,
    minGap: g.handCard.w * MIN_HAND_GAP_FRACTION,
  });
}
