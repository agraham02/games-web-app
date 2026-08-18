/**
 * Placement -> screen transform.
 *
 * The one rule this file exists to enforce: **a piece is always rendered
 * at one fixed base size, and every visual difference is a transform.**
 *
 * A card in the hero's hand and the same card in a trick are different
 * sizes on screen, but animating width/height between them would hit
 * layout on every frame. Instead the DOM box never changes and `scale`
 * does the work, so the whole table animates on the compositor.
 *
 * Pure and O(1) per piece: layout never inspects sibling pieces, which
 * is what lets each <Piece> subscribe to only its own placement.
 */

import type { Placement, PieceKind, SeatId } from "@/engine/types";
import { HERO } from "@/engine/types";
import {
  axisReach,
  fanSlot,
  pileAssembly,
  pileAssemblyHorizontal,
  radialFanSlot,
  tileShortSide,
  MAX_DISCARD_STEP_FRACTION,
  MIN_HAND_GAP_FRACTION,
  POD_SIZE,
  TILE_HAND_GAP,
  type BoardView,
  type Box,
  type PieceSize,
  type TableGeometry,
} from "./geometry";

type BoardCell = NonNullable<Placement["cell"]>;

export interface PieceTransform {
  /** Top-left of the base-size box, in container px. */
  x: number;
  y: number;
  rotate: number;
  scale: number;
  z: number;
  opacity: number;
}

/**
 * Stacking order per zone. Selection lifts a piece above everything.
 *
 * `collected`, `hand` (opponent) and `center` all sit at z >= 850,
 * ABOVE SeatRing's z-800: every one of them is positioned "near a pod"
 * or "near table centre" by design, and a piece that loses a
 * z-index fight with a nameplate reads as broken — a real bug in LRC's
 * chip piles, which sit right outside each pod and were rendering
 * partly hidden behind it before this ordering was fixed.
 */
const Z: Record<string, number> = {
  offscreen: 0,
  deck: 100,
  boneyard: 150,
  board: 200,
  line: 250,
  discard: 300,
  trick: 400,
  collected: 850,
  hand: 900,
  center: 950,
};
const Z_HERO_HAND = 1000;
const Z_SELECTED = 5000;

/** The base box every piece is rendered at, before scaling. */
export function baseSize(g: TableGeometry) {
  return g.handCard;
}

/**
 * What a piece actually DRAWS inside that base box. A card fills it; a
 * domino is 1:2 and inscribes itself (see TileFace), so every scale in
 * this file has to be computed against the art, not the box, or a tile
 * comes out a third too small everywhere.
 *
 * Exported because the same distinction matters OUTSIDE layout: any
 * effect sized as a fraction of "the piece" has to mean the drawn art or
 * it lands differently on a tile than on a card. See `handHoverLift` in
 * PieceLayer, where measuring the hover spread against the box made a
 * domino rack fan roughly 45% wider than a card hand for the same
 * constant.
 */
export function artSize(g: TableGeometry, kind: PieceKind | undefined): PieceSize {
  const base = baseSize(g);
  if (kind !== "tile") return base;
  const w = Math.min(base.w, base.h / 2);
  return { w, h: w * 2 };
}

/** The same piece's size when it is lying on the table / in a pod. */
function tableArt(g: TableGeometry, kind: PieceKind | undefined): number {
  return kind === "tile" ? tileShortSide(g.card) : g.card.w;
}

function miniArt(g: TableGeometry, kind: PieceKind | undefined): number {
  return kind === "tile" ? tileShortSide(g.miniCard) : g.miniCard.w;
}

function centred(cx: number, cy: number, g: TableGeometry) {
  const base = baseSize(g);
  return { x: cx - base.w / 2, y: cy - base.h / 2 };
}

/** `boxCentre` in the `{x, y}` shape `radialFanSlot`'s anchor wants. */
function boxCentreXY(b: Box): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function boxCentre(b: Box) {
  return { cx: b.x + b.w / 2, cy: b.y + b.h / 2 };
}

/**
 * Keeps a piece's centre point on screen. Needed specifically for chip
 * piles: they fan outward from a seat that itself sits near a screen
 * edge, and a pod on the left/right edge is rarely exactly opposite
 * table centre — the perpendicular spread that fans a growing pile
 * sideways then has a component pointing straight off the edge the pod
 * is already hugging. A clamp is simpler and more robust than trying to
 * out-guess every seat's geometry with fan-direction special cases.
 */
function clampToBox(cx: number, cy: number, box: Box, marginW: number, marginH: number) {
  return {
    cx: Math.min(Math.max(cx, box.x + marginW), box.x + box.w - marginW),
    cy: Math.min(Math.max(cy, box.y + marginH), box.y + box.h - marginH),
  };
}

/* ============================================================
   The board camera — dominoes' line of play.
   ============================================================ */

/**
 * A domino chain cannot be laid out from (index, count) the way every
 * other zone is: a double advances the line by one unit where everything
 * else advances it by two, so a tile's spot depends on the entire run
 * before it. The game therefore computes each tile's board-space cell
 * ONCE, when it is played, and that cell is then immutable for the rest
 * of the round — a played tile never moves relative to its neighbours,
 * which is the whole point.
 *
 * What moves instead is this camera. It fits the chain's bounding box
 * into the line zone, so the board is viewed from further back as it
 * grows rather than being re-laid-out. Every relative position and every
 * pip contact is preserved exactly, because a fit is one scale and one
 * translation applied to the whole space.
 *
 * Two properties keep it calm:
 *
 *  - `unit` is CLAMPED at the normal table piece size, so for the
 *    opening tiles the camera is completely still — it only starts
 *    easing out once the chain genuinely no longer fits.
 *  - the bounding box only ever grows (tiles are never removed), so the
 *    scale is monotonically non-increasing. It cannot oscillate.
 */
export interface BoardCamera {
  /** Screen px per board unit. */
  unit: number;
  /** Rotation applied to the whole board space, in degrees. */
  rot: number;
  /** Board-space point that sits at the screen centre of the zone. */
  bx: number;
  by: number;
  /** That screen centre. */
  cx: number;
  cy: number;
}

/** Blank space kept around the chain, in board units. */
const BOARD_PAD = 0.6;

/**
 * A tile renders at slightly under its exact unit footprint, so every
 * joint gets a uniform hairline. Real dominoes on a table have that gap;
 * without it two doubles in adjacent rows read as one solid block.
 */
const CONTACT_GAP = 0.955;

export function boardCamera(g: TableGeometry, board: BoardView | null): BoardCamera {
  const zone = g.zones.line;
  const cx = zone.x + zone.w / 2;
  const cy = zone.y + zone.h / 2;
  const maxUnit = tileShortSide(g.card);

  // Turning the whole board a quarter turn on a portrait zone is not a
  // gimmick: domino pips are rotation-invariant, so it costs nothing to
  // read, and it roughly DOUBLES the usable tile size on a phone (a
  // ~14x8-unit board fits a 270x620 zone at ~19px/unit upright, ~34
  // rotated). Derived from the zone alone, never from the chain, so it
  // is stable for a whole round and only changes on a real resize.
  const rot = zone.h > zone.w ? 90 : 0;

  if (!board) return { unit: maxUnit, rot, bx: 0, by: 0, cx, cy };

  const bw = board.maxX - board.minX + BOARD_PAD * 2;
  const bh = board.maxY - board.minY + BOARD_PAD * 2;
  const fitW = rot === 90 ? bh : bw;
  const fitH = rot === 90 ? bw : bh;

  const unit = Math.min(zone.w / fitW, zone.h / fitH, maxUnit);

  return {
    unit,
    rot,
    bx: (board.minX + board.maxX) / 2,
    by: (board.minY + board.maxY) / 2,
    cx,
    cy,
  };
}

/** Board-space cell -> screen centre and final rotation. */
export function projectCell(cell: BoardCell, cam: BoardCamera) {
  const dx = cell.x - cam.bx;
  const dy = cell.y - cam.by;
  // Screen y runs downward, so a quarter turn clockwise takes
  // (x, y) -> (-y, x). The piece's own rotation gets the same turn, which
  // is what keeps the tile square to the run it was laid along.
  const rx = cam.rot === 90 ? -dy : dx;
  const ry = cam.rot === 90 ? dx : dy;
  return {
    cx: cam.cx + rx * cam.unit,
    cy: cam.cy + ry * cam.unit,
    rotate: cell.rot + cam.rot,
  };
}

/** On-screen size of one board-space piece, for ghosts and markers. */
export function boardPieceSize(cam: BoardCamera) {
  return { short: cam.unit * CONTACT_GAP, long: cam.unit * 2 * CONTACT_GAP };
}

export interface LayoutContext {
  /** What the piece physically is — a tile draws 1:2 inside the base box. */
  kind?: PieceKind;
  /** Extent of everything in board space; drives the camera. */
  board?: BoardView | null;
  /**
   * Pan offsets for the two compress-then-pan zones, and the discard
   * pile's live depth.
   *
   * Each is threaded in only for the pieces that actually need it (see
   * PieceLayer's gated subscriptions): a pan updates on every
   * pointermove, and an ungated subscription would re-render all 52
   * pieces per frame of a drag. `discardCount` is the deck's own — in
   * landscape the deck slides aside as the fan beside it grows, and
   * layout is otherwise deliberately blind to a piece's siblings.
   */
  discardScroll?: number;
  discardCount?: number;
  handScroll?: number;
  /**
   * Where this piece sits in the hero's hand, overriding the
   * placement's own index — a player-chosen sort. Resolved by
   * PieceLayer, which is the layer that knows a piece's id; layout only
   * ever sees one anonymous placement at a time.
   */
  handIndex?: number;
}

export function layoutPiece(
  p: Placement,
  g: TableGeometry,
  ctx?: LayoutContext,
): PieceTransform {
  const base = baseSize(g);
  const art = artSize(g, ctx?.kind);
  const tableScale = tableArt(g, ctx?.kind) / art.w;
  const miniScale = miniArt(g, ctx?.kind) / art.w;

  const zBase = Z[p.zone] ?? 0;
  const z = p.selected ? Z_SELECTED + p.index : zBase + p.index;
  // `dimmed` no longer touches opacity — POLICY.md's "invalid options
  // drop to ~0.3 opacity" was replaced by a grayscale/darken filter
  // (see PieceLayer.tsx) so a dimmed card stays fully legible instead of
  // washing out toward the felt. `hidden` is the one thing that still
  // animates opacity here, since fading a piece out in place (Spades'
  // won tricks) is exactly the case opacity-as-a-transform-safe-property
  // exists for.
  const opacity = p.hidden ? 0 : 1;

  switch (p.zone) {
    /* -------------------------------------------------- deck */
    case "deck": {
      // A game whose discard pile fans (Rummy) passes its live depth,
      // and in LANDSCAPE — where the fan grows along the same axis the
      // two piles are offset on — the deck gives ground to it, keeping
      // the pair centred as one unit. In PORTRAIT the fan grows
      // perpendicular to that offset, so there is no reason for the deck
      // to move and it does not. See geometry's `isPortraitTable`.
      //
      // Every other game passes nothing and gets `g.zones.deck` exactly
      // as before.
      const anchor =
        ctx?.discardCount === undefined
          ? boxCentre(g.zones.deck)
          : (() => {
              const { deckX, deckY } = pileAssemblyHorizontal(g, ctx.discardCount!);
              return { cx: deckX, cy: deckY };
            })();
      // A tall stack reads as depth, not as 52 offset cards — cap it.
      const lift = Math.min(p.index, 10) * 0.4;
      const { x, y } = centred(anchor.cx + lift, anchor.cy - lift, g);
      return { x, y, rotate: 0, scale: tableScale, z, opacity };
    }

    /* ----------------------------------------------- discard */
    case "discard": {
      // Compress-then-pan is strictly opt-in: only a game that has
      // published a pan value (Rummy) gets the floored, pannable,
      // orientation-aware fan. Spades' two-card Blind Nil exchange, and
      // anything else that merely sets `fanned`, keeps the simple
      // centred fan below exactly as it was.
      if (p.fanned && ctx?.discardScroll !== undefined) {
        // Fanned so the player can see how deep the eligible run goes —
        // and floored, so a 20+ card pile stops shrinking into slivers
        // and becomes pannable instead (see MIN_DISCARD_STEP_FRACTION).
        //
        // Both orientations run through `radialFanSlot` rather than
        // `fanSlot` because portrait fans DOWN the screen and landscape
        // ACROSS it, and one parameterised path is the only way the two
        // stay in step. `size.w` is the piece's extent along the spread
        // axis by that function's own convention, hence the swap.
        const a = pileAssembly(g, p.count);
        const along = a.portrait ? g.card.h : g.card.w;
        const slot = radialFanSlot({
          anchor: boxCentreXY(a.fan),
          spread: a.portrait ? { x: 0, y: 1 } : { x: 1, y: 0 },
          away: { x: 0, y: 0 },
          index: p.index,
          count: p.count,
          spreadWidth: a.portrait ? a.fan.h : a.fan.w,
          size: { w: along, h: along },
          baseRotation: 0,
          maxTilt: 0,
          arcLift: 0,
          // Must match `pileAssembly`'s own maxGap exactly — see
          // MAX_DISCARD_STEP_FRACTION for why the two share a constant.
          maxGap: along * MAX_DISCARD_STEP_FRACTION,
          minGap: a.minStep,
          pan: ctx?.discardScroll ?? 0,
          within: a.fan,
        });
        const { x, y } = centred(slot.x, slot.y, g);
        // A panned fan always draws cards outside the box it was given
        // — the compression floor is what makes it pannable, and the
        // excess has to be SOMEWHERE. `pileRegion` is only clear of the
        // seat pods and the sheet INSIDE its own bounds, so a card
        // carried past them lands under a pod, under the board sheet, or
        // off the screen entirely, and reads as broken.
        //
        // It cannot be clipped: the piece layer is one flat canvas of
        // independent absolutely positioned nodes with no wrapper to put
        // `overflow: hidden` on (CLAUDE.md). So the card fades out as it
        // crosses the boundary instead — which is what a masked scroller
        // looks like anyway, and stays on the compositor.
        return { x, y, rotate: 0, scale: tableScale, z, opacity: opacity * slot.visible };
      }
      const { cx, cy } = boxCentre(g.zones.discard);
      if (p.fanned) {
        // Fanned so the player can see how deep the eligible run goes.
        const step = g.card.w * 0.38;
        const spread = step * (p.count - 1);
        const { x, y } = centred(cx - spread / 2 + p.index * step, cy, g);
        return { x, y, rotate: 0, scale: tableScale, z, opacity };
      }
      const lift = Math.min(p.index, 6) * 0.5;
      const { x, y } = centred(cx + lift, cy - lift, g);
      // A small deterministic tilt per card makes a real discard pile.
      const tilt = ((p.index * 37) % 9) - 4;
      return { x, y, rotate: tilt, scale: tableScale, z, opacity };
    }

    /* ------------------------------------------------- trick */
    case "trick": {
      const trick = g.zones.trick;
      const { cx, cy } = boxCentre(trick);
      const seat = p.seat !== undefined ? g.seats[p.seat] : undefined;

      if (!seat) {
        const { x, y } = centred(cx, cy, g);
        return { x, y, rotate: 0, scale: tableScale, z, opacity };
      }

      // Each played card sits offset from the centre toward whoever
      // played it, so a glance at the trick tells you who is winning.
      const dx = seat.x - cx;
      const dy = seat.y - cy;
      const len = Math.hypot(dx, dy) || 1;
      const radius = Math.min(trick.w, trick.h) * 0.26;
      const { x, y } = centred(
        cx + (dx / len) * radius,
        cy + (dy / len) * radius,
        g,
      );
      return {
        x,
        y,
        rotate: ((p.index * 53) % 13) - 6,
        scale: tableScale,
        z,
        opacity,
      };
    }

    /* ------------------------------------------------- board */
    case "board": {
      // A meld LANDING spot, not a permanent board layout.
      //
      // This used to be a full-width wrapping grid, and carried a known
      // bug with it: the grid had no idea where seat pods sat, so at 6+
      // seats a middle row rendered underneath a side pod and got
      // clipped. `podInset` only reserves clearance at the top and
      // bottom of the ring, never down the sides a multi-row grid
      // reaches.
      //
      // The fix is not a cleverer grid. With six players there can be
      // eighteen melds on the table, and no amount of grid maths makes
      // eighteen melds legible on a phone's felt — that is exactly the
      // problem the board sheet exists to solve (POLICY.md's three-tier
      // pattern: ambient pod strips, a peek rail, then targeted
      // filtering). So a laid meld flies to the felt, is visible for the
      // beat its own animation takes, and then fades in place, leaving
      // the felt to the piles. The game marks board pieces `hidden` for
      // that; `applyEvent`'s `moveTo` clears the flag on the way in so
      // the flight always plays.
      //
      // Which means all this has to do is put a landing spot somewhere
      // legible and pod-safe. `pileRegion` is already clear of both pods
      // and fanned opponent hands, so the meld lands BELOW it — on the
      // open felt between the piles and the hand.
      //
      // Below, specifically, and not on the region itself: landing a
      // meld on top of the discard pile makes the lay read as a discard,
      // which is the one other thing cards fly to from your hand. Two
      // different actions have to end in two different places or the
      // animation stops carrying information.
      const region = g.pileRegion;
      const play = g.zones.play;
      const overlap = g.card.w * 0.44;
      const meldW = g.card.w + overlap * Math.max(0, p.count - 1);

      const below = region.y + region.h;
      const room = Math.max(0, play.y + play.h - below);
      // A small per-meld stagger so a meld landing while the previous
      // one is still fading doesn't sit exactly on top of it.
      const lane = (p.group ?? 0) % 3;
      const originX = region.x + region.w / 2 - meldW / 2 + g.card.w / 2;
      const originY =
        below + Math.min(room / 2, g.card.h * 0.7) + (lane - 1) * (g.card.h * 0.16);

      const { x, y } = centred(originX + p.index * overlap, originY, g);
      return { x, y, rotate: 0, scale: tableScale, z, opacity };
    }

    /* -------------------------------------------------- line */
    case "line": {
      // Position comes from the game, not from index/count — see
      // `boardCamera` above for why, and `Placement.cell` for the
      // contract. All this does is project it.
      if (!p.cell) {
        const { cx, cy } = boxCentre(g.zones.line);
        const { x, y } = centred(cx, cy, g);
        return { x, y, rotate: 0, scale: tableScale, z, opacity };
      }
      const cam = boardCamera(g, ctx?.board ?? null);
      const { cx, cy, rotate } = projectCell(p.cell, cam);
      const { x, y } = centred(cx, cy, g);
      return {
        x,
        y,
        rotate,
        // The drawn art's short side becomes exactly one board unit
        // (less the hairline), which is what makes contact exact.
        scale: (cam.unit * CONTACT_GAP) / art.w,
        z,
        opacity,
      };
    }

    /* ---------------------------------------------- boneyard */
    case "boneyard": {
      const zone = g.zones.boneyard;
      const { cx, cy } = boxCentre(zone);
      // Same capped stack as the deck: depth, not a fan of 14 tiles.
      const lift = Math.min(p.index, 8) * 0.45;
      const { x, y } = centred(cx + lift, cy - lift, g);
      return { x, y, rotate: 0, scale: zone.w / art.w, z, opacity };
    }

    /* -------------------------------------------------- hand */
    case "hand": {
      const seatId: SeatId = p.seat ?? HERO;
      // Cards overlap in a fanned arc, which is how you hold cards.
      // Dominoes do not fan — you stand them in a rack, edge to edge and
      // upright — so a tile hand is a flat, evenly spaced row.
      const isTile = ctx?.kind === "tile";

      if (seatId === HERO) {
        // The boneyard shares this strip (see geometry's `boneyard`), so
        // a tile hand keeps clear of it. Card games have no such pile
        // and keep the full width.
        //
        // The reserved space comes off BOTH sides, not just the left
        // where the boneyard actually sits — shifting `within.x` alone
        // (the first version of this) shrank the box from one edge
        // only, which drags its centre off the true hand-zone centre by
        // half the reservation. The hand has to stay centred on the
        // zone regardless of what's parked beside it; a matching phantom
        // margin on the right is the price of that, and it's cheap.
        const gutter = isTile ? g.zones.boneyard.w + 14 : 0;
        const within: Box = {
          ...g.zones.hand,
          x: g.zones.hand.x + gutter,
          w: g.zones.hand.w - gutter * 2,
        };
        // A hand that has just swallowed six cards off the discard pile
        // needs the same compress-then-pan treatment the pile itself
        // does, and for the same reason — past a point, tighter is not
        // more readable, it is less. Opt-in: a game that never threads
        // `handScroll` in gets no floor and behaves exactly as before.
        const panned = ctx?.handScroll !== undefined && !isTile;
        // ONE index drives both the fan position and the stacking order.
        //
        // Splitting them is what produced a card sitting visually
        // between its neighbours while painting behind both of them: a
        // fan overlaps, so which card is on top has to follow the order
        // the eye reads left to right. Taking the sorted index for
        // position and the placement's own for `z` guarantees they
        // disagree the moment a sort is anything but the deal order.
        const handIndex = ctx?.handIndex ?? p.index;
        const slot = fanSlot({
          index: handIndex,
          count: p.count,
          within,
          size: art,
          maxRotation: isTile ? 0 : undefined,
          arcLift: isTile ? 0 : undefined,
          maxGap: isTile ? art.w * 1.14 : undefined,
          minGap: panned ? art.w * MIN_HAND_GAP_FRACTION : undefined,
          pan: panned ? ctx!.handScroll : undefined,
        });
        const lift = p.selected ? -18 : 0;
        return {
          x: slot.x - base.w / 2,
          y: slot.y - base.h / 2 + lift,
          rotate: slot.rotation,
          scale: 1,
          // Selection does NOT change the stacking order. A fan overlaps,
          // so which card paints over which has to follow the order the
          // eye reads along the fan — full stop, in every state. Lifting a
          // selected card to `Z_SELECTED` made it jump in front of its
          // right-hand neighbours, so picking cards for a meld visibly
          // reshuffled the hand's depth as you went. The -18px lift and
          // the ring already say "selected" without touching z.
          z: Z_HERO_HAND + handIndex,
          // Same edge fade the discard fan uses, for the same reason —
          // a panned hand overruns its zone too, and the cards it pushes
          // out slide off the screen edges. Gated on `panned` so an
          // unfloored fan (every other game) is untouched, including by
          // float residue at the exact boundary.
          opacity: panned ? opacity * slot.visible : opacity,
        };
      }

      // Opponent hands sit just inside their pod, pulled toward the
      // centre of the table so they never hang off the edge.
      const seat = g.seats[seatId];
      if (!seat) return { x: 0, y: 0, rotate: 0, scale: miniScale, z, opacity };

      const miniW = miniArt(g, ctx?.kind);
      const miniH = isTile ? miniW * 2 : g.miniCard.h;

      const { cx: pcx, cy: pcy } = boxCentre(g.zones.play);
      const dx = pcx - seat.x;
      const dy = pcy - seat.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;

      // A fixed 2.4x width reads fine for LRC's mini hands (2-4 cards)
      // but a domino hand runs up to 7 tiles, and a FIXED box just
      // packed them tighter as the hand grew — `fanSlot`'s own gap
      // formula (`usable / (count - 1)`) has no choice but to compress
      // once the box can't grow with the count, and `maxGap` below never
      // gets a chance to matter. Scaling with `p.count` gives a big hand
      // the room a fixed box can't, while the floor keeps a small hand
      // (LRC, or dominoes early in a round) exactly as it was.
      const fanW = miniW * Math.max(2.4, p.count * 0.9);
      const pod = POD_SIZE[g.density];

      if (isTile) {
        let anchorX: number;
        let anchorY: number;
        // A tile hand never rotates and always fans along screen-x (see
        // `within` below), so its clearance from the pod is a plain,
        // AXIS-ALIGNED distance derived straight from the seat's own
        // `anchor` — never a scalar projected through (ux, uy) and
        // shared between `anchorX` and `anchorY`, which is what this
        // used to be and is a coupling that caused two separate bugs:
        // a SIDE seat's hand needs `fanW`-scaled clearance because it
        // fans along its own push direction, but that leaking into a
        // TOP seat's `anchorY` (any seat not dead-centre on its edge —
        // any edge with 2+ opponents — has a nonzero `ux`) first showed
        // up as "a fuller hand sinks lower" (the leaked term grew with
        // hand size), and REMOVING that term still left the coupling:
        // `anchorY` is `seat.y + uy * inset`, so shrinking `inset` by
        // dropping `fanW` also shrank the vertical gap itself, nudging
        // a wide hand a hair closer to the pod even at a fixed size.
        // Deriving each axis straight from `anchor` has no shared
        // scalar for either bug to leak through.
        if (seat.anchor === "left" || seat.anchor === "right") {
          const dir = seat.anchor === "left" ? 1 : -1;
          anchorX = seat.x + dir * (pod.w / 2 + fanW / 2 + miniW / 2 + TILE_HAND_GAP);
          anchorY = seat.y;
        } else {
          // "top" is the only anchor left once hero (handled above) and
          // the two side cases are accounted for.
          anchorX = seat.x;
          anchorY = seat.y + (pod.h / 2 + miniH / 2 + TILE_HAND_GAP);
        }
        const slot = fanSlot({
          index: p.index,
          count: p.count,
          within: { x: anchorX - fanW / 2, y: anchorY, w: fanW, h: 0 },
          size: { w: miniW, h: miniH },
          maxRotation: 0,
          arcLift: 0,
          maxGap: miniW * 0.7,
        });

        return {
          x: slot.x - base.w / 2,
          y: slot.y - base.h / 2,
          rotate: slot.rotation,
          scale: miniScale,
          z,
          opacity,
        };
      }

      // Card hands fan PERPENDICULAR to this seat's own line to table
      // centre, not always along screen-x — a side seat's hand runs
      // top-to-bottom, the way a fan of cards actually looks held by
      // someone sitting to your left or right (LRC's chip piles already
      // fan this way; see `collected` below for the same perpendicular
      // vector). Each card also inherits the seat's own base rotation
      // (`SeatSlot.rotation`) so it visually stands toward the table
      // rather than always reading screen-upright regardless of which
      // edge it was dealt to. Dominoes' tile racks (above) deliberately
      // don't get this yet — real dominoes stand upright in a rack
      // regardless of seat, and that redesign is tracked separately
      // ([[domino-side-seat-hand-overlap]]) — this only ever runs for a
      // card game.
      //
      // Clearance from the pod is a plain axisReach along the push
      // direction, same idea as the tile branch's own axis-derived
      // anchor above: since the fan now always spreads PERPENDICULAR to
      // (ux, uy), its width never adds to how far the hand reaches
      // along (ux, uy) — only one card's own thickness does — so this
      // has none of the fanW-leaking-into-the-wrong-axis coupling the
      // tile branch's doc above describes; there is no shared scalar
      // between the two axes to leak through in the first place.
      // `axisReach` assumes an axis-aligned box, but a left/right seat's
      // card is rotated a quarter turn (`baseRotation` below) — its true
      // on-screen footprint along the push direction is governed by its
      // ROTATED bounding box, which swaps width and height. A top seat's
      // 180° rotation doesn't swap anything, so only left/right needs this.
      const rotatedQuarter = seat.anchor === "left" || seat.anchor === "right";
      const cardFootprint: PieceSize = rotatedQuarter
        ? { w: miniH, h: miniW }
        : { w: miniW, h: miniH };
      const podReach = axisReach(ux, uy, pod);
      const cardReach = axisReach(ux, uy, cardFootprint);
      const inset = podReach + cardReach + TILE_HAND_GAP;
      const anchorX = seat.x + ux * inset;
      const anchorY = seat.y + uy * inset;

      const slot = radialFanSlot({
        anchor: { x: anchorX, y: anchorY },
        // Perpendicular to (ux, uy) — the axis the fan spreads along.
        spread: { x: -uy, y: ux },
        // Away from table centre — the ends of the fan bow toward this,
        // the same convention fanSlot's own arcLift uses for the hero's
        // hand (its ends dip toward the screen edge behind the hero).
        away: { x: -ux, y: -uy },
        index: p.index,
        count: p.count,
        spreadWidth: fanW,
        size: { w: miniW, h: miniH },
        baseRotation: seat.rotation,
        maxTilt: 7,
        arcLift: 4,
        maxGap: miniW * 0.42,
      });

      return {
        x: slot.x - base.w / 2,
        y: slot.y - base.h / 2,
        rotate: slot.rotation,
        scale: miniScale,
        z,
        opacity,
      };
    }

    /* --------------------------------------------- collected */
    case "collected": {
      const seat = p.seat !== undefined ? g.seats[p.seat] : undefined;
      if (!seat) return { x: 0, y: 0, rotate: 0, scale: miniScale, z, opacity };

      // A real grid, not a stack: a 0.6px-per-card offset (the old
      // value) is imperceptible on a ~30px chip, so two or three chips
      // rendered as one indistinguishable blob — exactly the "why does
      // it look like I only have one chip" bug this replaces. Fanning
      // outward from the pod in rows of 3 keeps the count legible at a
      // glance, which is the entire point of a chip pile in LRC.
      const { cx: pcx, cy: pcy } = boxCentre(g.zones.play);
      const dx = seat.x - pcx;
      const dy = seat.y - pcy;
      const len = Math.hypot(dx, dy) || 1;
      // Every seat's pile points TOWARD table centre, never away from
      // it. An earlier version sent opponent piles outward, past the
      // pod, toward the nearest screen edge — reasoning that the space
      // out there was "empty." It isn't safe: a pod near an edge has
      // almost no room behind it, so the outward point regularly landed
      // off-screen and clampToBox dragged it straight back on top of
      // the pod it was trying to clear (the actual cause of chips
      // covering names/avatars/chip counts). Toward centre always has
      // room — the play area is large and, in LRC, otherwise empty — so
      // the clamp is a rare safety net again instead of the thing doing
      // the real positioning.
      const ux = -dx / len;
      const uy = -dy / len;
      // Perpendicular unit vector — spreads chips sideways to the pod
      // rather than radially, so a growing pile doesn't drift table-ward.
      const px = -uy;
      const py = ux;

      const chipSize = g.miniCard.w;
      const cols = 3;
      const col = p.index % cols;
      const row = Math.floor(p.index / cols);
      const colSpacing = chipSize * 0.85;
      const rowSpacing = chipSize * 0.9;
      // Clears the pod by its own real footprint along the push
      // direction (ux, uy) — the same `axisReach` helper this file's
      // opponent-hand placement already uses for exactly this question
      // ("how far past this pod does something reaching outward from it
      // need to start"), plus a little breathing room so the pile
      // visibly separates rather than grazing the pod's edge.
      //
      // Deliberately NOT derived from `len` (the seat's distance to
      // table centre) — an earlier version scaled clearance with `len`,
      // reasoning that on a wide table a TOP/BOTTOM seat's span to
      // centre is longer than a LEFT/RIGHT seat's. That's backwards: a
      // wide table's real horizontal room means LEFT/RIGHT seats are
      // the ones far from centre (large `len`), while a top seat, pinned
      // close to the short vertical edge, sits near it (small `len`).
      // Scaling by `len` therefore pushed LEFT/RIGHT piles further from
      // their own pod, toward centre — the seats nobody complained about
      // — while TOP/BOTTOM (the actual "too far from the pod" report)
      // stayed essentially at the old flat value, since its small `len`
      // rarely cleared that floor. The pod's own footprint has no such
      // backwards relationship: `POD_SIZE` is close to square at every
      // density, so every anchor clears by roughly the same amount
      // regardless of how far that seat happens to sit from centre.
      const pod = POD_SIZE[g.density];
      const clearance = axisReach(ux, uy, pod) + g.miniCard.h * 0.55;

      const rowOriginX = seat.x + ux * (clearance + row * rowSpacing);
      const rowOriginY = seat.y + uy * (clearance + row * rowSpacing);
      // Centred on how many chips are actually IN this row, not on the
      // grid's max width. `cols` is a wrap limit, not every row's real
      // count — centring against it left every row short of a full 3
      // (which, for LRC's 3-chips-per-player start, is nearly all of
      // them) visibly shifted toward the pod-outward edge instead of
      // sitting under the pod. A 1-chip pile centred against a
      // 3-wide grid, for instance, always landed at that grid's
      // leftmost slot rather than its middle.
      const rowCount = Math.min(cols, p.count - row * cols);
      const colOffset = (col - (rowCount - 1) / 2) * colSpacing;

      // Margins are the piece's real scaled half-extents, not a rough
      // guess: the underlying box is card-shaped (taller than wide), so
      // a width-based margin used for BOTH axes undershoots vertically
      // by exactly enough to let a chip's top edge clip off-screen —
      // confirmed once already at exactly this gap (~2-3px) in
      // /play/lrc before this was axis-correct.
      const clamped = clampToBox(
        rowOriginX + px * colOffset,
        rowOriginY + py * colOffset,
        g.box,
        g.miniCard.w / 2,
        g.miniCard.h / 2,
      );
      const { x, y } = centred(clamped.cx, clamped.cy, g);
      return { x, y, rotate: 0, scale: miniScale, z, opacity };
    }

    /* ------------------------------------------------ centre */
    case "center": {
      // Same fanning problem and fix as `collected` above — every pot
      // chip used to render at the exact same point (not even a token
      // offset), so the whole pot looked like a single coin sitting on
      // top of wherever the dice overlay happened to be. Fans in a grid
      // that grows DOWN from the play area's centre, leaving the space
      // above center clear for a game's own centre-table overlay (LRC's
      // dice) to live without the two visually colliding.
      const { cx, cy } = boxCentre(g.zones.play);
      const chipSize = g.miniCard.w;
      const cols = 5;
      const col = p.index % cols;
      const row = Math.floor(p.index / cols);
      const colSpacing = chipSize * 0.8;
      const rowSpacing = chipSize * 0.85;
      // Same partial-row centring as `collected` above — a pot of 2 or 3
      // chips (i.e. most of the game, until several rolls land on "C")
      // was centring against a 5-wide grid and landing skewed toward the
      // left columns instead of under the dice.
      const rowCount = Math.min(cols, p.count - row * cols);

      const x = cx + (col - (rowCount - 1) / 2) * colSpacing;
      const y = cy + chipSize * 0.6 + row * rowSpacing;

      // `collected` has always clamped to the viewport; this never did,
      // on the assumption the play area is large enough that a pot of
      // up to 3 chips per seat never reaches its edge. That held for the
      // sizes this shipped with, but is a real gap, not a rule — a
      // bigger `card` size (a wide-density bump) or a high seat count on
      // a short viewport can grow the grid past the box before the
      // count that would trigger it ever gets exercised by eye. Same
      // fix, same reasoning: real margins from the piece's own scaled
      // half-extents, not a guess — and `card`, not `miniCard`, because
      // this piece renders at `tableScale` (see the return below), the
      // one difference from `collected`'s otherwise identical clamp.
      const clamped = clampToBox(x, y, g.box, g.card.w / 2, g.card.h / 2);
      const { x: fx, y: fy } = centred(clamped.cx, clamped.cy, g);
      return { x: fx, y: fy, rotate: 0, scale: tableScale, z, opacity };
    }

    /* --------------------------------------------- offscreen */
    default: {
      const { cx } = boxCentre(g.zones.play);
      const { x, y } = centred(cx, -g.handCard.h, g);
      return { x, y, rotate: 0, scale: tableScale, z, opacity: 0 };
    }
  }
}
