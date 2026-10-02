"use client";

/**
 * What somebody just said, beside their pod (the user, 2026-09-29) — the
 * table's only sign of the chat, which is never a toast.
 *
 * Its own layer, a sibling of `SeatRing` rather than a child of a pod: the
 * ring is a `z-800` stacking context, and anything inside it loses to an
 * opponent's cards (up to `Z_SHOWN`, 960) whatever z-index it asks for. At
 * 980 a bubble clears every opponent piece and stays under the viewer's own
 * hand (1000) and the band.
 *
 * It hangs below a pod in the top half of the table and above one in the
 * bottom half — never beside it. Beside was the first try, and on a phone,
 * where the side seats stack high, it put a left pod's bubble straight
 * into the toast lane (seen in a screenshot, half hidden behind "Kofi bids
 * first"). It is clamped to the table, so an edge pod's is not cut off.
 *
 * Only what is said while the table is up. A table mounting — a refresh,
 * coming back from the lobby — does not replay the last thing each person
 * said as though they had just said it.
 */

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { TRANSITIONS } from "@/motion/presets";
import { podBox, type Box, type SeatSlot } from "./geometry";
import type { SeatView } from "./SeatRing";
import { useGeometry } from "./store";

/** Widest a bubble is drawn, px. Two lines of this, then an ellipsis. */
const BUBBLE_W = 152;
const GAP = 6;

/** Long enough to read: a beat, plus a little per character, capped. */
export function bubbleMs(text: string): number {
  return Math.min(6_000, 3_000 + text.length * 40);
}

export function SeatBubbles({ players }: { players: readonly SeatView[] }) {
  const geometry = useGeometry();
  // The newest thing already said when the table appeared: nothing up to it
  // is news to a table that was not there to see it.
  const [baseline] = useState(() => Math.max(0, ...players.map((p) => p.bubble?.id ?? 0)));
  if (!geometry) return null;
  const { box, density } = geometry;

  return (
    <div className="pointer-events-none absolute inset-0 z-980">
      {geometry.seats
        .filter((slot) => !slot.isHero)
        .map((slot) => {
          const bubble = players.find((p) => p.seat === slot.seat)?.bubble;
          if (!bubble || bubble.id <= baseline) return null;
          return (
            <Bubble key={slot.seat} id={bubble.id} text={bubble.text} place={placeFor(slot, density, box)} />
          );
        })}
    </div>
  );
}

interface Place {
  left: number;
  top: number;
  /** How the bubble hangs from that point. */
  transform: string;
}

/** Below a pod in the top half of the table, above one in the bottom half. */
export function placeFor(slot: SeatSlot, density: Parameters<typeof podBox>[1], box: Box): Place {
  const pod = podBox(slot, density);
  const left = Math.max(box.x + BUBBLE_W / 2 + 4, Math.min(box.x + box.w - BUBBLE_W / 2 - 4, slot.x));
  const below = slot.anchor === "top" || (slot.anchor !== "bottom" && slot.y < box.y + box.h / 2);
  return below
    ? { left, top: pod.y + pod.h + GAP, transform: "translate(-50%, 0)" }
    : { left, top: pod.y - GAP, transform: "translate(-50%, -100%)" };
}

function Bubble({ id, text, place }: { id: number; text: string; place: Place }) {
  // Which message has had its time. A new one (a new id) shows afresh.
  const [done, setDone] = useState<number | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDone(id), bubbleMs(text));
    return () => clearTimeout(t);
  }, [id, text]);

  return (
    <div className="absolute" style={{ left: place.left, top: place.top, transform: place.transform }}>
      <AnimatePresence>
        {done !== id ? (
          <motion.div
            key={id}
            role="status"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, transition: TRANSITIONS.uiExit }}
            transition={TRANSITIONS.ui}
            className="line-clamp-2 rounded-xl bg-bone-50 px-2.5 py-1.5 text-[12px] leading-snug font-semibold break-words text-felt-950 shadow-[0_4px_16px_rgb(0_0_0/0.35)]"
            style={{ maxWidth: BUBBLE_W, width: "max-content" }}
          >
            {text}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
