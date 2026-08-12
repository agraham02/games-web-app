"use client";

/**
 * A betting / LRC chip. `colour` is a token key, not a raw hex, so the
 * palette stays swappable.
 */

import { memo } from "react";

export type ChipColour = "left" | "center" | "right" | "neutral" | "brass";

const CHIP: Record<ChipColour, { from: string; to: string; ink: string; label: string }> = {
  left: { from: "#c0362c", to: "#8e2a22", ink: "var(--color-bone-50)", label: "L" },
  center: { from: "#245c45", to: "#123425", ink: "var(--color-bone-50)", label: "C" },
  right: { from: "#d4af6a", to: "#8e6e39", ink: "var(--color-felt-950)", label: "R" },
  neutral: { from: "#3b3730", to: "#1a1712", ink: "var(--color-bone-50)", label: "" },
  brass: { from: "#e3c68f", to: "#b8914e", ink: "var(--color-felt-950)", label: "" },
};

export const ChipFace = memo(function ChipFace({
  colour,
  size,
  label,
}: {
  colour: string;
  size: number;
  label?: string;
}) {
  const spec = CHIP[(colour as ChipColour) in CHIP ? (colour as ChipColour) : "neutral"];
  const text = label ?? spec.label;

  return (
    <div
      role="img"
      aria-label={`${colour} chip`}
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
        color: spec.ink,
        backfaceVisibility: "hidden",
      }}
    >
      {text}
    </div>
  );
});
