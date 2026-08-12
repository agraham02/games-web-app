"use client";

/**
 * Opponent seat pods, positioned from the geometry engine.
 *
 * Pods are vertical (avatar above a name) rather than horizontal. A
 * horizontal pod is ~140px wide, which does not fit against the left or
 * right edge of a 390px phone, and collides with its neighbours when
 * four of them share the top edge. Vertical is ~64px and fits every
 * seat count on every device, so there is one pod shape, not three.
 */

import { memo } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { SeatId } from "@/engine/types";
import { useGeometry } from "./store";
import { TRANSITIONS } from "@/motion/presets";

export interface SeatView {
  seat: SeatId;
  name: string;
  /** Avatar tint. Any CSS colour. */
  colour: string;
  /** Second line: "bid 3 · won 2", "7 cards", etc. */
  meta?: string;
  /** Highlights the pod and shows a pulse. */
  active?: boolean;
  thinking?: boolean;
  /** Out for the rest of the game — LRC's elimination, a future game's
   * fold/bust. Dims the pod; it stays in the ring rather than
   * disappearing, since the seat itself is still a real position other
   * players' relative left/right depends on. */
  eliminated?: boolean;
  /** This seat won. GameHost sets this from `live.winner`, which (unlike
   * `live.showSummary`) is public the instant the game ends — so the
   * crown lands on the table itself before GameEndSummary covers it,
   * the same "show it, THEN summarize it" pacing the endHoldMs pause
   * exists for. */
  winning?: boolean;
  /**
   * Rummy's ambient disclosure tier: a micro-strip of this player's
   * board melds, always visible at zero interaction cost.
   */
  melds?: string[];
}

function initialsOf(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

export function SeatRing({ players }: { players: readonly SeatView[] }) {
  const geometry = useGeometry();
  if (!geometry) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-800">
      {geometry.seats
        .filter((slot) => !slot.isHero)
        .map((slot) => {
          const view = players.find((p) => p.seat === slot.seat);
          if (!view) return null;
          return (
            <div
              key={slot.seat}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left: slot.x, top: slot.y }}
            >
              <SeatPod view={view} />
            </div>
          );
        })}
    </div>
  );
}

const SeatPod = memo(function SeatPod({ view }: { view: SeatView }) {
  const highlighted = view.active || view.winning;
  return (
    <motion.div
      initial={false}
      animate={{ scale: highlighted ? 1.06 : 1, opacity: view.eliminated ? 0.45 : 1 }}
      transition={TRANSITIONS.ui}
      className={`flex w-16 flex-col items-center gap-1 rounded-xl px-1 py-1.5 backdrop-blur-md transition-colors ${
        highlighted
          ? "bg-felt-950/70 ring-1 ring-brass-400 shadow-[0_0_20px_rgb(212_175_106/0.35)]"
          : "bg-felt-950/55 ring-1 ring-brass-400/20"
      }`}
    >
      <div className="relative">
        <AnimatePresence>{view.winning ? <WinnerCrown /> : null}</AnimatePresence>
        <div
          className="flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-bold text-felt-950"
          style={{
            background: view.colour,
            filter: view.eliminated ? "grayscale(1)" : undefined,
          }}
        >
          {initialsOf(view.name)}
        </div>
        {view.thinking ? <ThinkingRing /> : null}
      </div>

      <div className="max-w-full truncate text-[11px] leading-none font-semibold text-bone-50">
        {view.name}
      </div>

      {view.meta ? (
        <div className="max-w-full truncate text-[9px] leading-none text-bone-400">
          {view.meta}
        </div>
      ) : null}

      {view.melds?.length ? <MeldStrip melds={view.melds} /> : null}
    </motion.div>
  );
});

/** Bot deliberation, made visible. */
function ThinkingRing() {
  return (
    <motion.span
      aria-hidden
      className="absolute -inset-0.5 rounded-full border border-brass-300"
      animate={{ opacity: [0.15, 0.85, 0.15], scale: [1, 1.14, 1] }}
      transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
    />
  );
}

/**
 * The per-seat echo of GameEndSummary's winner callout, landing on the
 * table itself the instant `live.winner` is known (see the `winning`
 * doc on SeatView) — well before the summary panel does, per the same
 * "show it, then summarize it" pacing endHoldMs exists for.
 *
 * Rests ON the avatar's own top edge rather than floating clear above
 * it with a gap: TableSurface clips its contents (`overflow-hidden`),
 * and a top-row pod's own headroom above it is thin by design (14–24px
 * of `ringPad`, tuned only for the pod itself) — a crown hovering a
 * full ~20px above the avatar reliably poked past that and got clipped
 * at the screen edge. Overlapping the avatar instead of appending above
 * it means the crown never needs more vertical room than the pod
 * already has, on any seat, at any density.
 *
 * Motion: a settle-style entrance (no bounce, matching the app's whole
 * direction — see layout.ts/CLAUDE.md), then a slow, gentle float while
 * it holds, small enough to stay within that same margin. That float is
 * ambient idle motion, not a bounce: it never overshoots or rebounds,
 * just drifts up and back on a long, easeInOut sine — the same category
 * of motion as ThinkingRing's pulse just above it in this file, not the
 * bounce the rest of the app deliberately avoids.
 */
function WinnerCrown() {
  return (
    <motion.div
      aria-hidden
      className="pointer-events-none absolute -top-1.5 left-1/2 -translate-x-1/2 text-sm"
      style={{ filter: "drop-shadow(0 0 5px rgb(212 175 106 / 0.65))" }}
      initial={{ opacity: 0, scale: 0.5, y: 3 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.6, y: 3 }}
      transition={TRANSITIONS.deal}
    >
      <motion.span
        className="block"
        animate={{ y: [0, -1.5, 0] }}
        transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
      >
        👑
      </motion.span>
    </motion.div>
  );
}

/**
 * Tier 1 of Rummy's three-tier disclosure: what this player has on the
 * board, small enough to ignore and close enough to read without any
 * interaction at all.
 */
function MeldStrip({ melds }: { melds: readonly string[] }) {
  const shown = melds.slice(0, 2);
  const extra = melds.length - shown.length;

  return (
    <div className="flex max-w-full flex-col items-center gap-0.5">
      {shown.map((m, i) => (
        <span
          key={i}
          className="max-w-full truncate rounded-[3px] bg-brass-400/15 px-1 text-[8px] leading-[1.4] font-bold text-brass-300"
        >
          {m}
        </span>
      ))}
      {extra > 0 ? (
        <span className="text-[8px] leading-none font-bold text-bone-400">
          +{extra} more
        </span>
      ) : null}
    </div>
  );
}
