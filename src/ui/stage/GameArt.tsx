"use client";

/**
 * A game, drawn as a small arrangement of its OWN pieces: the home
 * carousel's hero art. The app's piece primitives again (see `GameThumb`),
 * so it can never drift from what the table actually draws.
 */

import { motion } from "motion/react";
import type { GameId } from "@/session/registry";
import { CardBack, CardFace } from "@/ui/primitives/CardFace";
import { ChipFace } from "@/ui/primitives/ChipFace";
import { ChromaFace } from "@/ui/primitives/ChromaFace";
import { DiceFace } from "@/ui/primitives/DiceFace";
import { TileFace } from "@/ui/primitives/TileFace";

interface Placed {
  x: number;
  y: number;
  rot: number;
  el: React.ReactNode;
  /** Seconds, so the arrangement bobs out of step with itself. */
  phase?: number;
}

export const ART_W = 260;
export const ART_H = 200;

const card = (id: string) => <CardFace card={id} w={104} h={146} />;
const tile = (id: string) => <TileFace tile={id} w={72} h={140} ariaHidden />;
const chroma = (id: string) => <ChromaFace card={id} w={104} h={146} />;

function arrangement(id: GameId): Placed[] {
  switch (id) {
    case "spades":
      return [
        { x: 18, y: 36, rot: -16, el: card("SQ") },
        { x: 78, y: 18, rot: 0, el: card("SK"), phase: 0.6 },
        { x: 138, y: 36, rot: 16, el: card("SA"), phase: 1.2 },
      ];
    case "rummy":
      return [
        { x: 18, y: 40, rot: -14, el: card("H7") },
        { x: 78, y: 22, rot: 0, el: card("H8"), phase: 0.6 },
        { x: 138, y: 40, rot: 14, el: card("H9"), phase: 1.2 },
      ];
    case "bs":
      return [
        { x: 24, y: 44, rot: -14, el: <CardBack w={104} h={146} ariaHidden /> },
        { x: 70, y: 24, rot: -2, el: <CardBack w={104} h={146} ariaHidden />, phase: 0.6 },
        { x: 132, y: 40, rot: 14, el: card("D7"), phase: 1.2 },
      ];
    case "poker":
      return [
        { x: 22, y: 24, rot: -10, el: card("HA") },
        { x: 82, y: 14, rot: 8, el: card("SA"), phase: 0.5 },
        { x: 70, y: 124, rot: 0, el: <ChipFace colour="gold" size={58} />, phase: 1 },
        { x: 120, y: 132, rot: 0, el: <ChipFace colour="ruby" size={58} />, phase: 1.6 },
        { x: 168, y: 118, rot: 0, el: <ChipFace colour="neutral" size={58} />, phase: 0.2 },
      ];
    case "dominoes":
      return [
        { x: 26, y: 40, rot: -18, el: tile("6-6") },
        { x: 94, y: 22, rot: 4, el: tile("5-2"), phase: 0.7 },
        { x: 160, y: 40, rot: 20, el: tile("3-1"), phase: 1.3 },
      ];
    case "lrc":
      return [
        { x: 16, y: 54, rot: -14, el: <DiceFace face="L" size={72} /> },
        { x: 94, y: 30, rot: 8, el: <DiceFace face="R" size={72} />, phase: 0.6 },
        { x: 170, y: 62, rot: -6, el: <DiceFace face="C" size={72} />, phase: 1.2 },
        { x: 104, y: 134, rot: 0, el: <ChipFace colour="ruby" size={46} />, phase: 0.3 },
      ];
    case "chromaly":
      return [
        { x: 14, y: 44, rot: -20, el: chroma("R5.1") },
        { x: 64, y: 26, rot: -7, el: chroma("YV.1"), phase: 0.5 },
        { x: 116, y: 24, rot: 7, el: chroma("G2.1"), phase: 1 },
        { x: 164, y: 42, rot: 20, el: chroma("W.1"), phase: 1.5 },
      ];
    case "mindmeld":
      return [
        { x: 22, y: 50, rot: 0, el: <Orb size={128} colour="var(--color-brass-300)" /> },
        { x: 104, y: 22, rot: 0, el: <Orb size={128} colour="var(--color-team-b)" blend />, phase: 1 },
      ];
  }
}

function Orb({ size, colour, blend = false }: { size: number; colour: string; blend?: boolean }) {
  return (
    <span
      aria-hidden
      className="block rounded-full"
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle at 35% 30%, color-mix(in srgb, ${colour} 70%, white), ${colour} 70%)`,
        opacity: 0.88,
        mixBlendMode: blend ? "screen" : undefined,
        boxShadow: `0 0 60px color-mix(in srgb, ${colour} 45%, transparent)`,
      }}
    />
  );
}

/**
 * A game as its own pieces, arranged. `scale` 1 is 260 × 200. `still` stops
 * the slow bob (the carousel's slides that are not the one in front).
 */
export function GameArt({ id, scale = 1, still = false }: { id: GameId; scale?: number; still?: boolean }) {
  return (
    // Its own game's colours, whatever page it is on (see `GameThumb`).
    <div aria-hidden data-game={id} className="relative shrink-0" style={{ width: ART_W * scale, height: ART_H * scale }}>
      <div
        className="absolute top-0 left-0"
        style={{ width: ART_W, height: ART_H, transform: `scale(${scale})`, transformOrigin: "top left" }}
      >
        {arrangement(id).map((p, i) => (
          <div
            key={i}
            className="absolute drop-shadow-[0_14px_18px_rgb(0_0_0/0.45)]"
            style={{ left: p.x, top: p.y, transform: `rotate(${p.rot}deg)` }}
          >
            <motion.div
              animate={still ? undefined : { y: [0, -7, 0] }}
              transition={{ duration: 5, ease: "easeInOut", repeat: Infinity, delay: p.phase ?? 0 }}
            >
              {p.el}
            </motion.div>
          </div>
        ))}
      </div>
    </div>
  );
}
