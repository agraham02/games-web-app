"use client";

/**
 * A playing card, drawn in HTML and CSS.
 *
 * Not an <svg> and not an image file, for three reasons:
 *  - Motion cannot run layout animations on SVG elements
 *  - CSS custom properties retheme the whole deck for free
 *  - text scales crisply under a transform, a raster asset does not
 *
 * The face is always rendered at the base (hand) size and scaled down by
 * the piece layer's transform, so one render serves every zone.
 */

import { memo } from "react";
import {
  isRed,
  parseCard,
  SUIT_GLYPH,
  cardLabel,
  type Rank,
} from "@/games/_shared/cards";
import type { PieceId } from "@/engine/types";

/**
 * Classic pip arrangements as [x%, y%] within the card's inner area.
 * Pips below the midline are rotated 180deg, as on a printed deck.
 */
const PIPS: Record<string, ReadonlyArray<readonly [number, number]>> = {
  A: [[50, 50]],
  "2": [[50, 12], [50, 88]],
  "3": [[50, 12], [50, 50], [50, 88]],
  "4": [[24, 12], [76, 12], [24, 88], [76, 88]],
  "5": [[24, 12], [76, 12], [50, 50], [24, 88], [76, 88]],
  "6": [[24, 12], [76, 12], [24, 50], [76, 50], [24, 88], [76, 88]],
  "7": [[24, 12], [76, 12], [50, 31], [24, 50], [76, 50], [24, 88], [76, 88]],
  "8": [
    [24, 12], [76, 12], [50, 31], [24, 50],
    [76, 50], [50, 69], [24, 88], [76, 88],
  ],
  "9": [
    [24, 12], [76, 12], [24, 37], [76, 37], [50, 50],
    [24, 63], [76, 63], [24, 88], [76, 88],
  ],
  "10": [
    [24, 12], [76, 12], [50, 25], [24, 37], [76, 37],
    [24, 63], [76, 63], [50, 75], [24, 88], [76, 88],
  ],
};

const COURT: Record<string, string> = { J: "J", Q: "Q", K: "K" };

export interface CardFaceProps {
  card: PieceId;
  /** Base render size in px. */
  w: number;
  h: number;
  /**
   * `full` draws the pip layout; `index` draws just the corner index and
   * one large suit glyph. The piece layer picks `index` for cards that
   * end up small on screen, where pips would be mud.
   */
  detail?: "full" | "index";
  /**
   * Hides this face from assistive tech. The 3D flip in PieceLayer's
   * `Flipper` mounts both faces at once and only hides the wrong one
   * *visually* via backface-visibility — that leaves a face-down card's
   * rank and suit fully readable in the accessibility tree unless the
   * inactive face is explicitly hidden here.
   */
  ariaHidden?: boolean;
}

function CardFaceImpl({
  card,
  w,
  h,
  detail = "full",
  ariaHidden = false,
}: CardFaceProps) {
  const { suit, rank } = parseCard(card);
  const red = isRed(suit);
  const glyph = SUIT_GLYPH[suit];
  const colour = red ? "var(--color-suit-red)" : "var(--color-suit-ink)";

  const pad = w * 0.075;
  const rankSize = w * 0.27;
  const suitSize = w * 0.2;
  const isCourt = rank in COURT;

  const index = (flip: boolean) => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        lineHeight: 0.94,
        color: colour,
        transform: flip ? "rotate(180deg)" : undefined,
        alignSelf: flip ? "flex-end" : "flex-start",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-rank)",
          fontWeight: 700,
          fontSize: rankSize,
        }}
      >
        {rank}
      </span>
      <span style={{ fontSize: suitSize, marginTop: -w * 0.012 }}>{glyph}</span>
    </div>
  );

  return (
    <div
      role={ariaHidden ? undefined : "img"}
      aria-hidden={ariaHidden || undefined}
      aria-label={ariaHidden ? undefined : cardLabel({ id: card, suit, rank })}
      style={{
        width: w,
        height: h,
        padding: pad,
        borderRadius: w * 0.1,
        background: "var(--color-card-face)",
        border: "1px solid var(--color-card-edge)",
        boxShadow: "var(--shadow-e1)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        position: "relative",
        overflow: "hidden",
        // Backface is hidden so a flip does not show mirrored text.
        backfaceVisibility: "hidden",
      }}
    >
      {index(false)}

      {detail === "index" ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: w * 0.46,
            color: colour,
            opacity: 0.9,
          }}
        >
          {glyph}
        </div>
      ) : isCourt ? (
        <CourtPanel rank={rank} glyph={glyph} colour={colour} w={w} h={h} />
      ) : (
        <PipField rank={rank} glyph={glyph} colour={colour} w={w} h={h} />
      )}

      {index(true)}
    </div>
  );
}

function PipField({
  rank,
  glyph,
  colour,
  w,
  h,
}: {
  rank: Rank;
  glyph: string;
  colour: string;
  w: number;
  h: number;
}) {
  const pips = PIPS[rank] ?? [];
  // Pips live in the middle column band, clear of the corner indices.
  const fieldX = w * 0.26;
  const fieldW = w * 0.48;
  const fieldY = h * 0.14;
  const fieldH = h * 0.72;
  const size = rank === "A" ? w * 0.42 : w * 0.19;

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {pips.map(([px, py], i) => (
        <span
          key={i}
          style={{
            position: "absolute",
            left: fieldX + (px / 100) * fieldW,
            top: fieldY + (py / 100) * fieldH,
            transform: `translate(-50%, -50%)${py > 50 ? " rotate(180deg)" : ""}`,
            fontSize: size,
            lineHeight: 1,
            color: colour,
          }}
        >
          {glyph}
        </span>
      ))}
    </div>
  );
}

/**
 * Court cards get a brass-ruled monogram panel rather than hand-drawn
 * figure art — honest, legible at every size, and themeable.
 */
function CourtPanel({
  rank,
  glyph,
  colour,
  w,
  h,
}: {
  rank: Rank;
  glyph: string;
  colour: string;
  w: number;
  h: number;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: w * 0.2,
        right: w * 0.2,
        top: h * 0.15,
        bottom: h * 0.15,
        border: "1px solid var(--color-brass-500)",
        borderRadius: w * 0.05,
        background:
          "linear-gradient(160deg, rgb(212 175 106 / 0.14), rgb(212 175 106 / 0.03))",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: h * 0.015,
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: w * 0.36,
          lineHeight: 1,
          color: colour,
        }}
      >
        {COURT[rank]}
      </span>
      <span style={{ fontSize: w * 0.2, lineHeight: 1, color: colour }}>
        {glyph}
      </span>
    </div>
  );
}

export const CardFace = memo(CardFaceImpl);

/* ============================================================
   Card back
   ============================================================ */

export const CardBack = memo(function CardBack({
  w,
  h,
  ariaHidden = false,
}: {
  w: number;
  h: number;
  /** Hides this face when the flip container is showing the front. */
  ariaHidden?: boolean;
}) {
  return (
    <div
      role={ariaHidden ? undefined : "img"}
      aria-hidden={ariaHidden || undefined}
      aria-label={ariaHidden ? undefined : "face-down card"}
      style={{
        width: w,
        height: h,
        borderRadius: w * 0.1,
        border: "1px solid var(--color-brass-600)",
        boxShadow: "var(--shadow-e1)",
        background:
          "repeating-linear-gradient(45deg, var(--color-felt-700) 0 4px, var(--color-felt-800) 4px 8px)",
        position: "relative",
        backfaceVisibility: "hidden",
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: w * 0.07,
          border: "1px solid var(--color-brass-500)",
          borderRadius: w * 0.055,
          opacity: 0.55,
        }}
      />
    </div>
  );
});
