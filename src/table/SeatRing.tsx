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
import { motion } from "motion/react";
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
  return (
    <motion.div
      initial={false}
      animate={{ scale: view.active ? 1.06 : 1 }}
      transition={TRANSITIONS.ui}
      className={`flex w-16 flex-col items-center gap-1 rounded-xl px-1 py-1.5 backdrop-blur-md transition-colors ${
        view.active
          ? "bg-felt-950/70 ring-1 ring-brass-400 shadow-[0_0_20px_rgb(212_175_106/0.35)]"
          : "bg-felt-950/55 ring-1 ring-brass-400/20"
      }`}
    >
      <div className="relative">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-bold text-felt-950"
          style={{ background: view.colour }}
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
