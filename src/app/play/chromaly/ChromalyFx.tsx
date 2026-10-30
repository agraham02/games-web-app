"use client";

/**
 * What the table does when something happens that has no card to move: a
 * skip, a reverse, a stack growing, a bluff called, a last card said.
 *
 * Every one arrives as a `cue` event through the queue (so it obeys skip, the
 * speed setting and reduced motion without any code here), is drawn where it
 * happened - on the pod it is about, or from the pile - and goes away on its
 * own. Nothing here is state the game depends on: a cue that is never drawn
 * changes nothing but the show.
 *
 * Two restraint rules keep it lively without turning cartoonish. Pieces move
 * on the table's own springs and chrome uses short tweens; and there is at
 * most ONE text ribbon on screen, a new one replacing the old, because three
 * words shouting at once is noise.
 */

import { AnimatePresence, motion } from "motion/react";
import { Ban, Shuffle, Repeat2, ArrowLeftRight, Gavel, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CueKind, SeatId } from "@/engine/types";
import { CUE_SECONDS } from "@/motion/presets";
import { onCue, type CueFx } from "@/table/fx";
import { slotForSeat } from "@/table/geometry";
import { useGeometry } from "@/table/store";

/** Kinds drawn as the one ribbon; a new ribbon replaces whichever is up. */
const RIBBON: ReadonlySet<CueKind> = new Set(["reverse", "jump", "bluff", "clean", "swap", "pass", "shuffleHands"]);

const COLOUR: Record<string, string> = {
  R: "212 74 63",
  Y: "232 185 47",
  G: "63 157 94",
  B: "58 114 194",
};

interface Active {
  id: number;
  cue: CueFx;
}

export function ChromalyFx({ names }: { names: (seat: SeatId) => string }) {
  const g = useGeometry();
  const [active, setActive] = useState<Active[]>([]);
  const next = useRef(0);

  useEffect(
    () =>
      onCue((cue) => {
        const id = ++next.current;
        setActive((all) => [...all.filter((a) => !(RIBBON.has(cue.kind) && RIBBON.has(a.cue.kind))), { id, cue }]);
        const ms = (CUE_SECONDS[cue.kind] ?? 0.6) * 1000 + 250;
        setTimeout(() => setActive((all) => all.filter((a) => a.id !== id)), ms);
      }),
    [],
  );

  if (!g) return null;
  const pile = {
    x: g.zones.discard.x + g.zones.discard.w / 2,
    y: g.zones.discard.y + g.zones.discard.h / 2,
  };
  // Kept inside the table: a pod on the rim has half a ribbon's width beside
  // it at most, and an effect hung off the edge is an effect nobody reads.
  const pod = (seat: SeatId | undefined, margin: number) => {
    const slot = seat === undefined ? undefined : slotForSeat(g, seat);
    if (!slot) return pile;
    // A box narrower than the effect itself is centred: it cannot fit anyway.
    const x = g.box.w < margin * 2 ? g.box.w / 2 : Math.min(g.box.w - margin, Math.max(margin, slot.x));
    return { x, y: Math.min(g.box.h - 60, Math.max(60, slot.y)) };
  };

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0" style={{ zIndex: 1600 }}>
      <AnimatePresence>
        {active.map(({ id, cue }) => {
          const name = cue.seat === undefined ? "" : names(cue.seat);
          return (
            <Effect key={id} cue={cue} pile={pile} at={pod(cue.seat, halfWidth(cue, name))} name={name} />
          );
        })}
      </AnimatePresence>
    </div>
  );
}

/** The words a ribbon shows, which is also what decides how wide it is. */
function ribbonText(cue: CueFx, name: string): string | null {
  switch (cue.kind) {
    case "jump":
      return "Jump in!";
    case "bluff":
      return name ? `${name}: bluff!` : "Bluff!";
    case "clean":
      return "Played it straight";
    default:
      return null;
  }
}

/**
 * Half the width an effect needs, so its pod can be kept that far inside the
 * table. A ribbon is as wide as its words (a pill of tracked-out capitals, an
 * icon, padding): a fixed margin let "Played it straight" run off the right
 * edge and arrive as "Played it" (the user, 2026-10-30).
 */
function halfWidth(cue: CueFx, name: string): number {
  const text = ribbonText(cue, name);
  return text === null ? 90 : Math.max(90, text.length * 7.5 + 44);
}

function Effect({
  cue,
  pile,
  at,
  name,
}: {
  cue: CueFx;
  pile: { x: number; y: number };
  at: { x: number; y: number };
  name: string;
}) {
  switch (cue.kind) {
    case "skip":
      return <Stamp at={at} tone="rose" icon={<Ban size={34} strokeWidth={3} />} />;

    case "draw":
      return <Numeral from={pile} to={at} amount={cue.amount ?? 1} />;

    case "colour":
      return <Wash at={pile} rgb={COLOUR[cue.colour ?? "R"] ?? COLOUR.R!} />;

    case "called":
      return <Bubble at={at} text="CHROMA!" tone="brass" />;

    case "caught":
      return <Bubble at={at} text="Caught!" tone="rose" />;

    case "reverse":
      return (
        <Ribbon
          at={pile}
          text={cue.amount && cue.amount > 1 ? `Reverse ×${cue.amount}` : "Reverse"}
          icon={<Repeat2 size={22} strokeWidth={3} />}
          spin={cue.dir ?? 1}
        />
      );
    case "jump":
      return <Ribbon at={at} text="Jump in!" lift />;
    case "bluff":
      return <Ribbon at={at} text={name ? `${name}: bluff!` : "Bluff!"} icon={<Gavel size={22} strokeWidth={3} />} tone="rose" lift />;
    case "clean":
      return <Ribbon at={at} text="Played it straight" icon={<Check size={22} strokeWidth={3} />} lift />;
    case "swap":
      return <Ribbon at={pile} text="Swap hands" icon={<ArrowLeftRight size={22} strokeWidth={3} />} />;
    case "pass":
      return <Ribbon at={pile} text="Pass them on" icon={<Repeat2 size={22} strokeWidth={3} />} />;
    case "shuffleHands":
      return <Ribbon at={pile} text="Shuffle!" icon={<Shuffle size={22} strokeWidth={3} />} />;

    case "stack":
      // Drawn by the pile's own badge, which grows with the stack.
      return null;
  }
}

/* ============================================================
   The pieces
   ============================================================ */

const TONE = {
  brass: "bg-felt-950/92 text-brass-300 ring-brass-400/70",
  rose: "bg-felt-950/92 text-[#ff8f84] ring-[#d44a3f]/80",
} as const;

/** A stamp that lands on a pod with a thud: grows from big to settled, then goes. */
function Stamp({ at, tone, icon }: { at: { x: number; y: number }; tone: keyof typeof TONE; icon: React.ReactNode }) {
  return (
    <motion.div
      className="absolute"
      style={{ left: at.x, top: at.y, x: "-50%", y: "-50%" }}
      initial={{ opacity: 0, scale: 2.1, rotate: -14 }}
      animate={{ opacity: 1, scale: 1, rotate: -8 }}
      exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.18 } }}
      transition={{ type: "spring", stiffness: 520, damping: 26 }}
    >
      <span className={`flex h-14 w-14 items-center justify-center rounded-full ring-4 ${TONE[tone]}`}>{icon}</span>
    </motion.div>
  );
}

/** The cards on their way: a numeral that leaves the pile and lands on the pod. */
function Numeral({ from, to, amount }: { from: { x: number; y: number }; to: { x: number; y: number }; amount: number }) {
  return (
    <motion.span
      className="absolute font-display text-3xl font-extrabold text-brass-300"
      style={{ left: 0, top: 0, textShadow: "0 2px 6px rgb(0 0 0 / 0.7)" }}
      initial={{ x: from.x - 14, y: from.y - 18, opacity: 0, scale: 0.6 }}
      animate={{ x: to.x - 14, y: to.y - 30, opacity: [0, 1, 1, 0], scale: [0.6, 1.15, 1, 0.9] }}
      transition={{ duration: 0.6, times: [0, 0.2, 0.7, 1], ease: "easeOut" }}
    >
      +{amount}
    </motion.span>
  );
}

/** A colour rippling out from the pile across the felt. Low opacity: a wash, not a flash. */
function Wash({ at, rgb }: { at: { x: number; y: number }; rgb: string }) {
  return (
    <motion.div
      className="absolute rounded-full"
      style={{
        left: at.x,
        top: at.y,
        width: 160,
        height: 160,
        x: "-50%",
        y: "-50%",
        background: `radial-gradient(closest-side, rgb(${rgb} / 0.0), rgb(${rgb} / 0.38) 78%, rgb(${rgb} / 0) 100%)`,
      }}
      initial={{ scale: 0.4, opacity: 0.9 }}
      animate={{ scale: 9, opacity: 0 }}
      transition={{ duration: 0.55, ease: "easeOut" }}
    />
  );
}

/** A speech bubble above a pod: a word said out loud. */
function Bubble({ at, text, tone }: { at: { x: number; y: number }; text: string; tone: keyof typeof TONE }) {
  return (
    <motion.div
      className="absolute"
      style={{ left: at.x, top: at.y - 46, x: "-50%", y: "-50%" }}
      initial={{ opacity: 0, scale: 0.5, y: "-30%" }}
      animate={{ opacity: 1, scale: 1, y: "-50%" }}
      exit={{ opacity: 0, y: "-90%", transition: { duration: 0.2 } }}
      transition={{ type: "spring", stiffness: 480, damping: 22 }}
    >
      <span
        className={`block rounded-full px-3 py-1 font-display text-sm font-extrabold tracking-wide whitespace-nowrap ring-2 ${TONE[tone]}`}
      >
        {text}
      </span>
    </motion.div>
  );
}

/**
 * The one ribbon: a few words across the table for the moments that change the
 * game. `spin` turns the icon the way play is now going.
 */
function Ribbon({
  at,
  text,
  icon,
  tone = "brass",
  lift = false,
  spin,
}: {
  at: { x: number; y: number };
  text: string;
  icon?: React.ReactNode;
  tone?: keyof typeof TONE;
  /** Hung above a pod rather than over the pile. */
  lift?: boolean;
  spin?: number;
}) {
  return (
    <motion.div
      className="absolute"
      style={{ left: at.x, top: at.y + (lift ? -70 : -130), x: "-50%", y: "-50%" }}
      initial={{ opacity: 0, scale: 0.8, y: "-20%" }}
      animate={{ opacity: 1, scale: 1, y: "-50%" }}
      exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
      transition={{ duration: 0.22, ease: "easeOut" }}
    >
      <span
        className={`flex items-center gap-2 rounded-full px-4 py-1.5 font-display text-lg font-extrabold tracking-widest whitespace-nowrap uppercase ring-2 ${TONE[tone]}`}
      >
        {icon ? (
          <motion.span
            className="flex"
            animate={spin ? { rotate: spin * 360 } : undefined}
            transition={{ duration: 0.6, ease: "easeOut" }}
          >
            {icon}
          </motion.span>
        ) : null}
        {text}
      </span>
    </motion.div>
  );
}
