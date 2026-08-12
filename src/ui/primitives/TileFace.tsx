"use client";

/**
 * A domino tile. Ids are "hi-lo", e.g. "6-3".
 *
 * Drawn as CSS: two 3x3 pip grids either side of a hairline. Same
 * reasoning as CardFace — transforms and tokens, not an image.
 *
 * The tile INSCRIBES itself in the box it is given rather than filling
 * it. Every piece in this app renders into one fixed base box sized for
 * a playing card (see table/layout.ts), and a domino is 1:2 where a card
 * is 2.5:3.5 — filling the card box outright drew a visibly squat
 * domino. Inscribing keeps the real proportions while leaving the box,
 * and therefore the whole "one base size, scale does the rest" rule,
 * exactly as it was. The tile is centred in the box, so it also rotates
 * about its own centre.
 */

import { memo } from "react";
import { parseTile } from "@/games/_shared/tiles";

// Re-exported so existing call sites (the lab fixtures, the tokens page)
// keep working; the model itself lives in games/_shared/tiles.ts, beside
// cards.ts, exactly as CardFace draws a model it does not own.
export { doubleSixSet, parseTile, tileId } from "@/games/_shared/tiles";

/** Which cells of a 3x3 grid are inked, per pip count. */
const PIP_GRID: Record<number, ReadonlyArray<number>> = {
  0: [],
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

function Half({ pips, size }: { pips: number; size: number }) {
  const cells = PIP_GRID[pips] ?? [];
  const dot = size * 0.15;
  return (
    <div
      style={{
        flex: 1,
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gridTemplateRows: "repeat(3, 1fr)",
        placeItems: "center",
        padding: size * 0.13,
      }}
    >
      {Array.from({ length: 9 }, (_, i) => (
        <span
          key={i}
          style={{
            width: dot,
            height: dot,
            borderRadius: "50%",
            background: cells.includes(i) ? "var(--color-suit-ink)" : "transparent",
          }}
        />
      ))}
    </div>
  );
}

/** The 1:2 tile that fits inside a `w` x `h` box, centred. */
export function tileBox(w: number, h: number): { w: number; h: number } {
  const tw = Math.min(w, h / 2);
  return { w: tw, h: tw * 2 };
}

/** Centres an inscribed tile in the box the piece layer hands us. */
function Inset({
  w,
  h,
  children,
}: {
  w: number;
  h: number;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        width: w,
        height: h,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </div>
  );
}

export const TileFace = memo(function TileFace({
  tile,
  w,
  h,
  ariaHidden = false,
}: {
  tile: string;
  w: number;
  h: number;
  /**
   * Hides this face from assistive tech while the flip container is
   * showing the back — same reasoning as CardFace's own `ariaHidden`.
   * Without it, a face-down tile's pips stay fully readable in the
   * accessibility tree even though `backface-visibility` hides them
   * visually, which is a straight information leak in a game where the
   * opponents' hands are secret.
   */
  ariaHidden?: boolean;
}) {
  const [a, b] = parseTile(tile);
  const box = tileBox(w, h);
  return (
    <Inset w={w} h={h}>
      <div
        role={ariaHidden ? undefined : "img"}
        aria-hidden={ariaHidden || undefined}
        aria-label={ariaHidden ? undefined : `domino ${a} ${b}`}
        style={{
          width: box.w,
          height: box.h,
          background: "var(--color-card-face)",
          border: "1px solid var(--color-card-edge)",
          borderRadius: box.w * 0.12,
          boxShadow: "var(--shadow-e1)",
          display: "flex",
          flexDirection: "column",
          backfaceVisibility: "hidden",
        }}
      >
        <Half pips={a} size={box.w} />
        <div
          style={{
            height: 1,
            margin: `0 ${box.w * 0.13}px`,
            background: "var(--color-card-edge)",
          }}
        />
        <Half pips={b} size={box.w} />
      </div>
    </Inset>
  );
});

/**
 * Face-down tile. Deliberately NOT the same art as `CardBack`: a game
 * can have both on the table at once, and the two need to read as
 * different physical objects rather than as one deck at two sizes.
 * Dominoes are opaque blanks, so this is a plain bone-coloured back with
 * a single ruled line where the tile's own hairline would be.
 */
export const TileBack = memo(function TileBack({
  w,
  h,
  ariaHidden = false,
}: {
  w: number;
  h: number;
  ariaHidden?: boolean;
}) {
  const box = tileBox(w, h);
  return (
    <Inset w={w} h={h}>
      <div
        role={ariaHidden ? undefined : "img"}
        aria-hidden={ariaHidden || undefined}
        aria-label={ariaHidden ? undefined : "face-down domino"}
        style={{
          width: box.w,
          height: box.h,
          borderRadius: box.w * 0.12,
          border: "1px solid var(--color-brass-600)",
          boxShadow: "var(--shadow-e1)",
          background:
            "linear-gradient(150deg, var(--color-felt-700), var(--color-felt-800))",
          position: "relative",
          backfaceVisibility: "hidden",
        }}
      >
        <span
          style={{
            position: "absolute",
            inset: box.w * 0.1,
            border: "1px solid var(--color-brass-500)",
            borderRadius: box.w * 0.07,
            opacity: 0.45,
          }}
        />
        <span
          style={{
            position: "absolute",
            left: box.w * 0.18,
            right: box.w * 0.18,
            top: "50%",
            height: 1,
            background: "var(--color-brass-500)",
            opacity: 0.5,
          }}
        />
      </div>
    </Inset>
  );
});
