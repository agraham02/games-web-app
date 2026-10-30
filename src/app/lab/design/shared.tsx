"use client";

/**
 * What the two design test pages (/lab/design/bold, /lab/design/luxury)
 * have in common: the behaviour, never the look.
 *
 * - `GameArt`: a game drawn as a small arrangement of its OWN pieces.
 * - `GameBackdrop`: one layer per game, cross-faded by opacity (the only
 *   thing that animates is opacity, so it stays on the compositor).
 * - `Carousel`: native scroll-snap, the nearest slide to the centre is the
 *   active one. No library.
 *
 * Both directions use the same ones, so the pick between them is a pick of
 * style, not of what the screen can do.
 */

import { useCallback, useEffect, useRef } from "react";
import { motion, useReducedMotion } from "motion/react";
import { GAME_IDS, type GameId } from "@/session/registry";
import { CardBack, CardFace } from "@/ui/primitives/CardFace";
import { ChipFace } from "@/ui/primitives/ChipFace";
import { ChromaFace } from "@/ui/primitives/ChromaFace";
import { DiceFace } from "@/ui/primitives/DiceFace";
import { TileFace } from "@/ui/primitives/TileFace";

/* ---------------------------------------------------------------
   Hero art
   --------------------------------------------------------------- */

interface Placed {
  x: number;
  y: number;
  rot: number;
  el: React.ReactNode;
  /** Seconds, so the arrangement bobs out of step with itself. */
  phase?: number;
}

const ART_W = 260;
const ART_H = 200;

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
        {
          x: 22,
          y: 50,
          rot: 0,
          el: <Orb size={128} colour="var(--color-brass-300)" />,
        },
        {
          x: 104,
          y: 22,
          rot: 0,
          el: <Orb size={128} colour="var(--color-team-b)" blend />,
          phase: 1,
        },
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

/** A game as its own pieces, arranged. `scale` 1 is 260 × 200. */
export function GameArt({ id, scale = 1, still = false }: { id: GameId; scale?: number; still?: boolean }) {
  return (
    <div aria-hidden className="relative shrink-0" style={{ width: ART_W * scale, height: ART_H * scale }}>
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

/* ---------------------------------------------------------------
   Backdrop
   --------------------------------------------------------------- */

/**
 * One layer per game, all mounted, the active one at full opacity. Eight
 * painted gradients cost nothing, and a fast swipe through three games
 * never has to wait for a layer to mount. `felt` carries the game's own
 * surface (weave, wood grain, satin); `glow` is the quiet variant: a
 * near-black page with only a pool of the game's colour.
 */
export function GameBackdrop({ active, kind = "felt" }: { active: GameId; kind?: "felt" | "glow" }) {
  const reduced = useReducedMotion();
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {GAME_IDS.map((id) => (
        <motion.div
          key={id}
          data-game={id}
          className={kind === "felt" ? "felt felt-weave" : undefined}
          style={
            kind === "felt"
              ? { position: "absolute", inset: 0 }
              : {
                  position: "absolute",
                  inset: 0,
                  background:
                    "radial-gradient(70% 55% at 50% 38%, color-mix(in srgb, var(--color-felt-700) 62%, transparent), transparent 72%), radial-gradient(120% 80% at 50% 120%, color-mix(in srgb, var(--color-felt-850) 80%, transparent), transparent 60%), #050505",
                }
          }
          initial={false}
          animate={{ opacity: id === active ? 1 : 0 }}
          transition={{ duration: reduced ? 0 : 0.6, ease: "easeInOut" }}
        />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------
   Carousel
   --------------------------------------------------------------- */

export interface CarouselProps {
  active: number;
  onActive: (index: number) => void;
  count: number;
  /** CSS length of one slide; the scroller pads itself so any slide can centre. */
  slideWidth: string;
  gap?: string;
  label: string;
  className?: string;
  children: (index: number, isActive: boolean) => React.ReactNode;
}

export function Carousel({ active, onActive, count, slideWidth, gap = "1rem", label, className, children }: CarouselProps) {
  const ref = useRef<HTMLDivElement>(null);
  /** Set while we scroll on purpose, so the slides it passes do not each become active. */
  const lock = useRef<number | null>(null);
  const frame = useRef(0);
  const reduced = useReducedMotion();

  const nearest = useCallback(() => {
    const el = ref.current;
    if (!el) return 0;
    const mid = el.scrollLeft + el.clientWidth / 2;
    let best = 0;
    let bestDist = Infinity;
    Array.from(el.children).forEach((child, i) => {
      const c = child as HTMLElement;
      const dist = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid);
      if (dist < bestDist) {
        best = i;
        bestDist = dist;
      }
    });
    return best;
  }, []);

  const scrollToIndex = useCallback(
    (i: number) => {
      const el = ref.current;
      const target = el?.children[i] as HTMLElement | undefined;
      if (!el || !target) return;
      lock.current = i;
      el.scrollTo({
        left: target.offsetLeft + target.offsetWidth / 2 - el.clientWidth / 2,
        behavior: reduced ? "auto" : "smooth",
      });
      window.setTimeout(() => {
        if (lock.current === i) lock.current = null;
      }, 700);
    },
    [reduced],
  );

  const goTo = useCallback(
    (i: number) => {
      onActive(i);
      scrollToIndex(i);
    },
    [onActive, scrollToIndex],
  );

  // The page can change the active game too (the dots, the lobby's picker):
  // follow it. While the user is scrolling, `active` already IS the nearest
  // slide, so this does nothing.
  useEffect(() => {
    if (nearest() !== active) scrollToIndex(active);
  }, [active, nearest, scrollToIndex]);

  const onScroll = () => {
    if (lock.current !== null) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const i = nearest();
      if (i !== active) onActive(i);
    });
  };

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return (
    <div
      ref={ref}
      role="group"
      aria-roledescription="carousel"
      aria-label={label}
      tabIndex={0}
      onScroll={onScroll}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          goTo(Math.min(count - 1, active + 1));
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          goTo(Math.max(0, active - 1));
        }
      }}
      className={`relative flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] focus-visible:outline-none [&::-webkit-scrollbar]:hidden ${className ?? ""}`}
      style={{ gap, paddingInline: `calc(50% - ${slideWidth} / 2)` }}
    >
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          role="group"
          aria-roledescription="slide"
          aria-label={`${i + 1} of ${count}`}
          className="shrink-0 snap-center"
          style={{ width: slideWidth }}
          onClick={() => {
            if (i !== active) goTo(i);
          }}
        >
          {children(i, i === active)}
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------
   Mock room, so the lobby has somebody in it
   --------------------------------------------------------------- */

export const MOCK_CODE = "KQHM";

export const MOCK_ROSTER: ReadonlyArray<{ name: string; you?: boolean; leader?: boolean; bot?: boolean; status: string }> = [
  { name: "Ada", you: true, leader: true, status: "Here" },
  { name: "Ben", status: "Here" },
  { name: "Cy", status: "Joining…" },
  { name: "Bot", bot: true, status: "Steady" },
];
