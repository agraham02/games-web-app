"use client";

/**
 * A Chromaly card, drawn in HTML and CSS.
 *
 * Our own design rather than a lookalike: a full-bleed colour with a printed
 * margin, a round medallion in the middle (the face of the card) and the value
 * in two corners. Every colour also has a SHAPE - circle, triangle, square,
 * diamond - beside the value, so the colour of a card is never the only way
 * to read it. That is for the people who cannot tell red from green, and for
 * everyone at a dim table.
 *
 * Drawn at the base size and scaled by the piece layer's transform, so one
 * render serves every zone (see CardFace).
 */

import { memo } from "react";
import { motion } from "motion/react";
import { ArrowLeftRight, Ban, Shuffle } from "lucide-react";
import type { PieceId } from "@/engine/types";
import { cardLabel, parseCard, type Color } from "@/games/chromaly/cards";

const COLOUR_VAR: Record<Color, string> = {
  R: "var(--color-chroma-red)",
  Y: "var(--color-chroma-yellow)",
  G: "var(--color-chroma-green)",
  B: "var(--color-chroma-blue)",
};

/** For a screen reader: what a wild turned into. */
const COLOR_WORD: Record<Color, string> = { R: "now red", Y: "now yellow", G: "now green", B: "now blue" };

/** The shape that goes with each colour. */
export const SHAPE_GLYPH: Record<Color, string> = {
  R: "●",
  Y: "▲",
  G: "■",
  B: "◆",
};

/** Four equal wedges of the four colours: a wild. */
export const WILD_WHEEL =
  "conic-gradient(from 45deg, var(--color-chroma-red) 0 25%, var(--color-chroma-yellow) 0 50%, var(--color-chroma-green) 0 75%, var(--color-chroma-blue) 0 100%)";

export interface ChromaFaceProps {
  card: PieceId;
  /** Base render size in px. */
  w: number;
  h: number;
  /**
   * `full` draws the corners and the shape watermark; `index` draws just the
   * medallion, larger, for cards that end up small on screen.
   */
  detail?: "full" | "index";
  /** Hides this face while the flip container is showing the back. */
  ariaHidden?: boolean;
  /**
   * The colour a played wild named. Its ink grows into that colour from the
   * medallion out, once - so the change is SEEN happening, a beat after the
   * card lands (the user, 2026-10-30), rather than a wild that arrives
   * already coloured.
   */
  tint?: string;
}

function ChromaFaceImpl({ card, w, h, detail = "full", ariaHidden = false, tint }: ChromaFaceProps) {
  const parsed = parseCard(card);
  const named = tint !== undefined && tint in COLOUR_VAR ? (tint as Color) : null;
  const label = ariaHidden ? undefined : named ? `${cardLabel(card)}, ${COLOR_WORD[named]}` : cardLabel(card);
  const colour = parsed?.color ? COLOUR_VAR[parsed.color] : "var(--color-chroma-ink)";
  const wild = parsed !== null && parsed.color === undefined;
  const full = detail === "full";

  const margin = w * 0.045;
  const medallion = w * (full ? 0.62 : 0.78);

  return (
    <div
      role={ariaHidden ? undefined : "img"}
      aria-hidden={ariaHidden || undefined}
      aria-label={label}
      style={{
        width: w,
        height: h,
        borderRadius: w * 0.1,
        background: "var(--color-card-face)",
        border: "1px solid var(--color-card-edge)",
        boxShadow: "var(--shadow-e1)",
        padding: margin,
        position: "relative",
        overflow: "hidden",
        // Backface is hidden so a flip does not show mirrored text.
        backfaceVisibility: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: margin,
          borderRadius: w * 0.065,
          background: `linear-gradient(158deg, rgb(255 255 255 / 0.16), rgb(0 0 0 / 0.14)), ${colour}`,
          overflow: "hidden",
        }}
      >
        {wild && named ? (
          <motion.div
            key={named}
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              background: `linear-gradient(158deg, rgb(255 255 255 / 0.16), rgb(0 0 0 / 0.14)), ${COLOUR_VAR[named]}`,
            }}
            initial={{ clipPath: "circle(0% at 50% 50%)" }}
            animate={{ clipPath: "circle(75% at 50% 50%)" }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          />
        ) : null}
        {full && parsed?.color ? (
          // A large, faint shape behind the medallion: it fills the card's
          // corners so the colour reads even where the value is hidden by a
          // neighbour in a fanned hand.
          <span
            aria-hidden
            style={{
              position: "absolute",
              right: -w * 0.08,
              bottom: -h * 0.05,
              fontSize: w * 0.9,
              lineHeight: 1,
              color: "rgb(255 255 255 / 0.13)",
            }}
          >
            {SHAPE_GLYPH[parsed.color]}
          </span>
        ) : null}

        {full ? <Corner card={card} w={w} flip={false} /> : null}
        {full ? <Corner card={card} w={w} flip /> : null}

        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: medallion,
            height: medallion,
            transform: "translate(-50%, -50%)",
            borderRadius: "50%",
            background: wild ? WILD_WHEEL : "var(--color-card-face)",
            border: wild ? `${w * 0.035}px solid var(--color-card-face)` : undefined,
            boxShadow: "inset 0 0 0 1px rgb(0 0 0 / 0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Glyph card={card} size={medallion} />
        </div>
      </div>
    </div>
  );
}

/** The value in a corner, with the colour's shape under it. */
function Corner({ card, w, flip }: { card: PieceId; w: number; flip: boolean }) {
  const parsed = parseCard(card);
  if (!parsed) return null;
  const pad = w * 0.06;
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        [flip ? "right" : "left"]: pad,
        [flip ? "bottom" : "top"]: pad,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        lineHeight: 0.95,
        color: "var(--color-card-face)",
        textShadow: "0 1px 1px rgb(0 0 0 / 0.35)",
        transform: flip ? "rotate(180deg)" : undefined,
      }}
    >
      <CornerValue card={card} w={w} />
      {parsed.color ? (
        <span style={{ fontSize: w * 0.13, marginTop: w * 0.012 }}>{SHAPE_GLYPH[parsed.color]}</span>
      ) : (
        <span
          style={{
            width: w * 0.12,
            height: w * 0.12,
            marginTop: w * 0.02,
            borderRadius: "50%",
            background: WILD_WHEEL,
            border: `${w * 0.012}px solid var(--color-card-face)`,
          }}
        />
      )}
    </div>
  );
}

function CornerValue({ card, w }: { card: PieceId; w: number }) {
  const parsed = parseCard(card)!;
  const size = w * 0.2;
  switch (parsed.kind) {
    case "number":
      return (
        <span style={{ fontFamily: "var(--font-rank)", fontWeight: 700, fontSize: size }}>
          {parsed.value}
        </span>
      );
    case "skip":
      return <Ban size={size * 0.9} strokeWidth={3} />;
    case "reverse":
      return <ArrowLeftRight size={size * 0.9} strokeWidth={3} />;
    case "draw2":
      return <span style={{ fontFamily: "var(--font-rank)", fontWeight: 800, fontSize: size * 0.9 }}>+2</span>;
    case "wild4":
      return <span style={{ fontFamily: "var(--font-rank)", fontWeight: 800, fontSize: size * 0.9 }}>+4</span>;
    case "shuffle":
      return <Shuffle size={size * 0.9} strokeWidth={3} />;
    case "wild":
      return <span style={{ fontFamily: "var(--font-rank)", fontWeight: 800, fontSize: size * 0.9 }}>W</span>;
  }
}

/** What sits in the medallion. */
function Glyph({ card, size }: { card: PieceId; size: number }) {
  const parsed = parseCard(card);
  if (!parsed) return null;
  const ink = parsed.color ? COLOUR_VAR[parsed.color] : "var(--color-card-face)";
  const text: React.CSSProperties = {
    fontFamily: "var(--font-rank)",
    fontWeight: 800,
    lineHeight: 1,
    color: ink,
  };
  switch (parsed.kind) {
    case "number": {
      // 6 and 9 read the same upside down: underline them, as printed decks do.
      const needsRule = parsed.value === 6 || parsed.value === 9;
      return (
        <span
          style={{
            ...text,
            fontSize: size * 0.66,
            textDecoration: needsRule ? "underline" : undefined,
            textDecorationThickness: needsRule ? size * 0.04 : undefined,
            textUnderlineOffset: needsRule ? size * 0.05 : undefined,
          }}
        >
          {parsed.value}
        </span>
      );
    }
    case "skip":
      return <Ban size={size * 0.62} strokeWidth={3} color={ink} />;
    case "reverse":
      return <ArrowLeftRight size={size * 0.62} strokeWidth={3} color={ink} style={{ transform: "rotate(-45deg)" }} />;
    case "draw2":
      return <span style={{ ...text, fontSize: size * 0.5 }}>+2</span>;
    case "wild4":
      return <span style={{ ...text, fontSize: size * 0.5, textShadow: "0 2px 3px rgb(0 0 0 / 0.55)" }}>+4</span>;
    case "shuffle":
      return <Shuffle size={size * 0.5} strokeWidth={3.2} color={ink} style={{ filter: "drop-shadow(0 2px 3px rgb(0 0 0 / 0.55))" }} />;
    case "wild":
      return null;
  }
}

export const ChromaFace = memo(ChromaFaceImpl);

/** The back: ink, with the four-colour wheel and the name. */
export const ChromaBack = memo(function ChromaBack({
  w,
  h,
  ariaHidden = false,
}: {
  w: number;
  h: number;
  /** Hides this face when the flip container is showing the front. */
  ariaHidden?: boolean;
}) {
  const margin = w * 0.045;
  return (
    <div
      role={ariaHidden ? undefined : "img"}
      aria-hidden={ariaHidden || undefined}
      aria-label={ariaHidden ? undefined : "face-down card"}
      style={{
        width: w,
        height: h,
        borderRadius: w * 0.1,
        background: "var(--color-card-face)",
        border: "1px solid var(--color-card-edge)",
        boxShadow: "var(--shadow-e1)",
        padding: margin,
        position: "relative",
        backfaceVisibility: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: margin,
          borderRadius: w * 0.065,
          background: "radial-gradient(circle at 50% 38%, #2b261f, var(--color-chroma-ink) 72%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: h * 0.05,
          overflow: "hidden",
        }}
      >
        <span
          aria-hidden
          style={{
            width: w * 0.5,
            height: w * 0.5,
            borderRadius: "50%",
            background: WILD_WHEEL,
            boxShadow: `0 0 0 ${w * 0.03}px rgb(251 248 241 / 0.9), 0 ${h * 0.02}px ${w * 0.1}px rgb(0 0 0 / 0.5)`,
          }}
        />
        <span
          aria-hidden
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: w * 0.105,
            letterSpacing: "0.14em",
            color: "var(--color-card-face)",
            textTransform: "uppercase",
          }}
        >
          Chromaly
        </span>
      </div>
    </div>
  );
});
