"use client";

/**
 * A single LRC die face — L, C, R, or a dot.
 *
 * Dice are NOT PieceLayer pieces: every other piece in this app has a
 * stable id and a persistent Placement for the whole game, but a die
 * has neither — it's re-rolled fresh every turn with no identity worth
 * tracking between rolls. Modelling it as a Piece would mean inventing
 * a fake stable id for something that is, by definition, transient. So
 * this is a plain, self-contained component the LRC play screen
 * mounts and unmounts per roll, not something the piece layer knows
 * about.
 */

import { memo } from "react";

export function dieLabel(face: "L" | "R" | "C" | "dot"): string {
  return face === "dot" ? "blank" : face;
}

export const DiceFace = memo(function DiceFace({
  face,
  size = 52,
}: {
  face: "L" | "R" | "C" | "dot";
  size?: number;
}) {
  return (
    <div
      role="img"
      aria-label={`die showing ${dieLabel(face)}`}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.22,
        background: "var(--color-card-face)",
        border: "1px solid var(--color-card-edge)",
        boxShadow: "var(--shadow-e2)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {face === "dot" ? (
        <span
          style={{
            width: size * 0.22,
            height: size * 0.22,
            borderRadius: "50%",
            background: "var(--color-suit-ink)",
          }}
        />
      ) : (
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: size * 0.46,
            color:
              face === "L" ? "var(--color-suit-red)" : "var(--color-suit-ink)",
          }}
        >
          {face}
        </span>
      )}
    </div>
  );
});
