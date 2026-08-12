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

/** Stacking order per zone. Selection lifts a piece above everything. */
const Z: Record<string, number> = {
  offscreen: 0,
  deck: 100,
  board: 200,
  discard: 300,
  trick: 400,
  collected: 500,
  hand: 600,
  center: 700,
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

      // Won tricks stack just outside the pod, away from the table.
      const { cx: pcx, cy: pcy } = boxCentre(g.zones.play);
      const dx = seat.x - pcx;
      const dy = seat.y - pcy;
      const len = Math.hypot(dx, dy) || 1;
      const out = g.miniCard.h * 0.6;
      const lift = Math.min(p.index, 8) * 0.6;

      const { x, y } = centred(
        seat.x + (dx / len) * out + lift,
        seat.y + (dy / len) * out - lift,
        g,
      );
      return { x, y, rotate: 0, scale: miniScale, z, opacity };
    }

    /* ------------------------------------------------ centre */
    case "center": {
      const { cx, cy } = boxCentre(g.zones.play);
      const { x, y } = centred(cx, cy, g);
      return { x, y, rotate: 0, scale: tableScale, z, opacity };
    }

    /* --------------------------------------------- offscreen */
    default: {
      const { cx } = boxCentre(g.zones.play);
      const { x, y } = centred(cx, -g.handCard.h, g);
      return { x, y, rotate: 0, scale: tableScale, z, opacity: 0 };
    }
  }
}
