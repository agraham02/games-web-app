"use client";

/**
 * A betting / LRC chip. `colour` is a token key, not a raw hex, so the
 * palette stays swappable.
 *
 * Tokens are named for their colour, not for any game meaning — an
 * earlier version named them "left"/"center"/"right" and printed those
 * letters on the chip face, which read as if the chip itself carried
 * some persistent significance tied to a die roll. It doesn't: the same
 * physical chip changes hands via every kind of roll, and real LCR
 * chips are plain. LRC renders every chip in one colour (see
 * games/lrc/rules.ts's `pieces()`) so a pile reads as one pile, not a
 * scatter of differently-coloured pieces. No label.
 */

import { memo } from "react";

export type ChipColour = "ruby" | "forest" | "gold" | "neutral" | "brass";

const CHIP: Record<ChipColour, { from: string; to: string }> = {
  ruby: { from: "#c0362c", to: "#8e2a22" },
  forest: { from: "#245c45", to: "#123425" },
  gold: { from: "#d4af6a", to: "#8e6e39" },
  neutral: { from: "#3b3730", to: "#1a1712" },
  brass: { from: "#e3c68f", to: "#b8914e" },
};

export const ChipFace = memo(function ChipFace({
  colour,
  size,
  label,
}: {
  colour: string;
  size: number;
  /** Only for a deliberate on-chip value (a betting denomination, say)
   * — omit for a plain chip, which is the LRC case. */
  label?: string;
}) {
  const spec = CHIP[(colour as ChipColour) in CHIP ? (colour as ChipColour) : "neutral"];

  return (
    <div
      role="img"
      aria-label="chip"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: `linear-gradient(180deg, ${spec.from}, ${spec.to})`,
        // The dashed ring reads as the notched edge of a real chip.
        border: `${Math.max(2, size * 0.07)}px dashed rgb(245 242 234 / 0.55)`,
        boxShadow: "var(--shadow-e2), var(--shadow-rim)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 800,
        fontSize: size * 0.3,
        color: "var(--color-bone-50)",
        backfaceVisibility: "hidden",
      }}
    >
      {label ?? ""}
    </div>
  );
});
