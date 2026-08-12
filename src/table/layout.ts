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

import type { Placement, SeatId } from "@/engine/types";
import { HERO } from "@/engine/types";
import { fanSlot, type Box, type TableGeometry } from "./geometry";

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
  board: 200,
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

function centred(cx: number, cy: number, g: TableGeometry) {
  const base = baseSize(g);
  return { x: cx - base.w / 2, y: cy - base.h / 2 };
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

export function layoutPiece(p: Placement, g: TableGeometry): PieceTransform {
  const base = baseSize(g);
  const tableScale = g.card.w / base.w;
  const miniScale = g.miniCard.w / base.w;

  const zBase = Z[p.zone] ?? 0;
  const z = p.selected ? Z_SELECTED + p.index : zBase + p.index;
  const opacity = p.dimmed ? 0.32 : 1;

  switch (p.zone) {
    /* -------------------------------------------------- deck */
    case "deck": {
      const { cx, cy } = boxCentre(g.zones.deck);
      // A tall stack reads as depth, not as 52 offset cards — cap it.
      const lift = Math.min(p.index, 10) * 0.4;
      const { x, y } = centred(cx + lift, cy - lift, g);
      return { x, y, rotate: 0, scale: tableScale, z, opacity };
    }

    /* ----------------------------------------------- discard */
    case "discard": {
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
      // Melds flow left-to-right, wrapping into rows. `group` is the
      // meld index, `index` the card within it.
      //
      // KNOWN ISSUE (confirmed in /lab/rummy, not yet fixed): this grid
      // fills the whole board zone width and has no idea where seat
      // pods sit. SeatRing positions pods independently along the same
      // zone's edges, so a meld row that lands at a side-seat's height
      // renders underneath that pod and gets visually clipped — seen
      // with 6+ seats where a middle meld row collides with a side pod.
      // `podInset` in geometry.ts only reserves clearance at the
      // top/bottom of the ring, not down the sides where a multi-row
      // grid can reach. Real fix: either constrain each row's usable
      // x-range by which seats occupy that row's height, or reserve a
      // permanent side gutter sized to the pod width. Do this
      // deliberately when Rummy 500 is actually built, not as a patch.
      const board = g.zones.board;
      const overlap = g.card.w * 0.44;
      const meldW = g.card.w + overlap * 2.2;
      const meldH = g.card.h * 1.18;
      const cols = Math.max(1, Math.floor(board.w / (meldW + 8)));

      const group = p.group ?? 0;
      const row = Math.floor(group / cols);
      const col = group % cols;

      const originX = board.x + col * (meldW + 8) + g.card.w / 2;
      const originY = board.y + row * meldH + g.card.h / 2;

      const { x, y } = centred(originX + p.index * overlap, originY, g);
      return { x, y, rotate: 0, scale: tableScale, z, opacity };
    }

    /* -------------------------------------------------- hand */
    case "hand": {
      const seatId: SeatId = p.seat ?? HERO;

      if (seatId === HERO) {
        const slot = fanSlot({
          index: p.index,
          count: p.count,
          within: g.zones.hand,
          size: base,
        });
        const lift = p.selected ? -18 : 0;
        return {
          x: slot.x - base.w / 2,
          y: slot.y - base.h / 2 + lift,
          rotate: slot.rotation,
          scale: 1,
          z: p.selected ? Z_SELECTED : Z_HERO_HAND + p.index,
          opacity,
        };
      }

      // Opponent hands sit just inside their pod, pulled toward the
      // centre of the table so they never hang off the edge.
      const seat = g.seats[seatId];
      if (!seat) return { x: 0, y: 0, rotate: 0, scale: miniScale, z, opacity };

      const { cx: pcx, cy: pcy } = boxCentre(g.zones.play);
      const dx = pcx - seat.x;
      const dy = pcy - seat.y;
      const len = Math.hypot(dx, dy) || 1;
      const inset = g.miniCard.h * 0.85;

      const anchorX = seat.x + (dx / len) * inset;
      const anchorY = seat.y + (dy / len) * inset;

      const fanW = g.miniCard.w * 2.4;
      const slot = fanSlot({
        index: p.index,
        count: p.count,
        within: { x: anchorX - fanW / 2, y: anchorY, w: fanW, h: 0 },
        size: g.miniCard,
        maxRotation: 7,
        arcLift: 4,
        maxGap: g.miniCard.w * 0.42,
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
      // Clears the pod (~half its real rendered height, see SeatRing.tsx)
      // with a visible gap to spare, not just a non-overlapping hair —
      // the hero's own pile also has to clear the turn-indicator text
      // sitting just above the hand zone, which needs a bit more than
      // bare pod clearance.
      const clearance = g.miniCard.h * 1.9;

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

      const { x: fx, y: fy } = centred(x, y, g);
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
