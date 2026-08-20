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
import type { Density } from "./geometry";
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
   * This seat is the HERO's partner — Spades' 2v2 partnership, the first
   * game with any team concept in this app. Purely a rung-1/2 ambient
   * cue (POLICY.md): a small always-visible tag, same weight as `meta`.
   * The hero's own pod never renders here at all (SeatRing filters it
   * out below), so this only ever needs to answer one question — "is
   * THIS pod my partner or an opponent" — not represent teams in the
   * abstract, which is why it's a boolean rather than a team index.
   */
  partner?: boolean;
  /**
   * Dealer/small-blind/big-blind marker — poker's own addition; every
   * other game leaves this unset. Deliberately a single badge per seat,
   * even heads-up (where the button seat is technically also the small
   * blind): real tables mark it with one disc, and the other seat still
   * reads unambiguously as the big blind. See `positionBadge` in
   * `src/games/poker/state.ts` for how it's derived.
   */
  badge?: "D" | "SB" | "BB";
}

function initialsOf(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

/**
 * Pod dimensions per density tier. `compact`/`regular` keep the numbers
 * this component always had; `wide` steps up noticeably rather than a
 * token amount — that tier spans a 1024px laptop to a big desktop
 * monitor, and a pod sized for the former reads as undersized on the
 * latter, the same gap `DENSITY.wide` in geometry.ts exists to close for
 * pieces. Full literal class strings, not built from `density` at
 * runtime — Tailwind only picks up classes that appear as literal
 * substrings in source, and a lookup table keyed by a runtime value is
 * exactly that (unlike `w-${x}`, which it can't see).
 */
const POD_STYLES: Record<Density, { pod: string; avatar: string; name: string; meta: string }> = {
  compact: { pod: "w-16", avatar: "h-8 w-8 text-[11px]", name: "text-[11px]", meta: "text-[9px]" },
  regular: { pod: "w-16", avatar: "h-8 w-8 text-[11px]", name: "text-[11px]", meta: "text-[9px]" },
  wide: { pod: "w-24", avatar: "h-12 w-12 text-[15px]", name: "text-[15px]", meta: "text-[13px]" },
};

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
              <SeatPod view={view} density={geometry.density} />
            </div>
          );
        })}
    </div>
  );
}

const SeatPod = memo(function SeatPod({ view, density }: { view: SeatView; density: Density }) {
  const highlighted = view.active || view.winning;
  const s = POD_STYLES[density];
  return (
    <motion.div
      initial={false}
      animate={{ scale: highlighted ? 1.06 : 1, opacity: view.eliminated ? 0.45 : 1 }}
      transition={TRANSITIONS.ui}
      className={`flex ${s.pod} flex-col items-center gap-1 rounded-xl px-1 py-1.5 backdrop-blur-md transition-colors ${
        highlighted
          ? "bg-felt-950/70 ring-1 ring-brass-400 shadow-[0_0_20px_rgb(212_175_106/0.35)]"
          : "bg-felt-950/55 ring-1 ring-brass-400/20"
      }`}
    >
      <div className="relative">
        <AnimatePresence>{view.winning ? <WinnerCrown /> : null}</AnimatePresence>
        <div
          className={`flex ${s.avatar} items-center justify-center rounded-full font-bold text-felt-950`}
          style={{
            background: view.colour,
            filter: view.eliminated ? "grayscale(1)" : undefined,
          }}
        >
          {initialsOf(view.name)}
        </div>
        {view.thinking ? <ThinkingRing /> : null}
        {view.badge ? <PositionBadge label={view.badge} /> : null}
      </div>

      <div className={`max-w-full truncate ${s.name} leading-none font-semibold text-bone-50`}>
        {view.name}
      </div>

      {view.partner ? (
        <div className={`max-w-full truncate ${s.meta} leading-none font-bold text-brass-300/90`}>
          Partner
        </div>
      ) : null}

      {view.meta ? (
        <div className={`max-w-full truncate ${s.meta} leading-none text-bone-400`}>
          {view.meta}
        </div>
      ) : null}
    </motion.div>
  );
});

/**
 * Dealer/small-blind/big-blind marker — poker only; every other game
 * leaves `SeatView.badge` unset. Rests on the avatar's own corner
 * rather than appending above it, the same "overlap, don't add height"
 * reasoning `WinnerCrown`'s own doc gives: a top-row pod's headroom is
 * thin by design, so this has to fit within the avatar's existing
 * footprint. Opposite corner from `WinnerCrown` (top) so the two never
 * fight for the same few pixels on a seat that's both dealer and, on
 * the final hand, the match winner.
 */
function PositionBadge({ label }: { label: "D" | "SB" | "BB" }) {
  const title = label === "D" ? "Dealer" : label === "SB" ? "Small blind" : "Big blind";
  return (
    <div
      aria-label={title}
      title={title}
      className="absolute -right-1 -bottom-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brass-400 px-1 text-[9px] leading-none font-extrabold text-felt-950 ring-1 ring-felt-950/60"
    >
      {label}
    </div>
  );
}

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

