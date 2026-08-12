"use client";

/**
 * A domino tile. Ids are "hi-lo", e.g. "6-3".
 *
 * Drawn as CSS: two 3x3 pip grids either side of a hairline. Same
 * reasoning as CardFace — transforms and tokens, not an image.
 */

import { memo } from "react";

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

export function parseTile(id: string): [number, number] {
  const [a, b] = id.split("-").map(Number);
  return [a ?? 0, b ?? 0];
}

export function tileId(a: number, b: number): string {
  return `${Math.max(a, b)}-${Math.min(a, b)}`;
}

/** Double-six set: 28 tiles. */
export function doubleSixSet(): string[] {
  const tiles: string[] = [];
  for (let a = 6; a >= 0; a--) {
    for (let b = a; b >= 0; b--) tiles.push(`${a}-${b}`);
  }
  return tiles;
}

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

export const TileFace = memo(function TileFace({
  tile,
  w,
  h,
}: {
  tile: string;
  w: number;
  h: number;
}) {
  const [a, b] = parseTile(tile);
  return (
    <div
      role="img"
      aria-label={`domino ${a} ${b}`}
      style={{
        width: w,
        height: h,
        background: "var(--color-card-face)",
        border: "1px solid var(--color-card-edge)",
        borderRadius: w * 0.12,
        boxShadow: "var(--shadow-e1)",
        display: "flex",
        flexDirection: "column",
        backfaceVisibility: "hidden",
      }}
    >
      <Half pips={a} size={w} />
      <div
        style={{
          height: 1,
          margin: `0 ${w * 0.13}px`,
          background: "var(--color-card-edge)",
        }}
      />
      <Half pips={b} size={w} />
    </div>
  );
});
