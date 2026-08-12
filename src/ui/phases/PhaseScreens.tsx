"use client";

/**
 * Game-agnostic phase screens.
 *
 * Every game here runs the same arc — round opens, decisions get made,
 * the round scores, the game ends. These are the shells for that arc,
 * with slots for whatever a specific game needs to say. Spades fills the
 * decision slot with a bid pad, Rummy with a knock confirmation, Poker
 * with a bet sizer; the framing, motion and responsive behaviour are
 * shared so they cannot drift apart.
 */

import { AnimatePresence, motion } from "motion/react";
import type { SeatId } from "@/engine/types";
import { AnimatedNumber } from "@/ui/primitives/AnimatedNumber";
import { TRANSITIONS } from "@/motion/presets";

/* ============================================================
   Round intro — a brief title card over the deal.
   ============================================================ */

export function RoundIntro({
  show,
  eyebrow,
  title,
}: {
  show: boolean;
  eyebrow: string;
  title: string;
}) {
  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          className="pointer-events-none absolute inset-0 z-2000 flex flex-col items-center justify-center gap-2"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={TRANSITIONS.ui}
        >
          <motion.div
            className="absolute inset-0 bg-felt-950/55 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <motion.span
            className="eyebrow relative"
            initial={{ y: 8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -8, opacity: 0 }}
            transition={{ ...TRANSITIONS.ui, delay: 0.05 }}
          >
            {eyebrow}
          </motion.span>
          <motion.span
            className="relative font-display text-3xl tracking-wider text-brass-300"
            initial={{ y: 12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -12, opacity: 0 }}
            transition={{ ...TRANSITIONS.ui, delay: 0.09 }}
          >
            {title}
          </motion.span>
          <motion.span
            className="rule-brass relative mt-1 w-32"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            exit={{ scaleX: 0 }}
            transition={{ ...TRANSITIONS.ui, delay: 0.14 }}
          />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/* ============================================================
   Turn indicator — inline HUD, never a popup.
   ============================================================ */

export function TurnIndicator({ label, show }: { label: string; show: boolean }) {
  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          className="pointer-events-none absolute left-1/2 z-900 -translate-x-1/2 text-[11px] font-bold tracking-[0.16em] text-brass-300 uppercase"
          style={{ bottom: "calc(var(--hand-zone, 150px) + 8px)" }}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={TRANSITIONS.ui}
        >
          {label}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/* ============================================================
   Round end
   ============================================================ */

export interface ScoreRow {
  seat: SeatId;
  name: string;
  colour: string;
  detail?: string;
  delta: number;
  total: number;
  /** Extra flag shown inline, e.g. "3 bags". */
  flag?: string;
}

export function RoundEndScorecard({
  show,
  eyebrow,
  title,
  rows,
  note,
  onContinue,
  continueLabel = "Next round",
}: {
  show: boolean;
  eyebrow: string;
  title: string;
  rows: readonly ScoreRow[];
  note?: { tone: "warn" | "info"; title: string; body: string };
  onContinue?: () => void;
  continueLabel?: string;
}) {
  return (
    <PhaseSheet show={show}>
      <div className="flex flex-col items-center gap-1.5 pt-2">
        <span className="eyebrow">{eyebrow}</span>
        <h2 className="font-display text-2xl tracking-wider text-brass-300">
          {title}
        </h2>
        <span className="rule-brass mt-1 w-32" />
      </div>

      <div className="mt-6 flex flex-col">
        {rows.map((r, i) => (
          <motion.div
            key={r.seat}
            className="grid grid-cols-[22px_1fr_auto_auto] items-center gap-2.5 border-b border-bone-50/7 py-2.5 last:border-b-0"
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ ...TRANSITIONS.ui, delay: 0.06 * i }}
          >
            <span
              className="flex h-[22px] w-[22px] items-center justify-center rounded-full text-[9px] font-bold text-felt-950"
              style={{ background: r.colour }}
            >
              {r.name.slice(0, 2).toUpperCase()}
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="text-[13px] leading-none font-semibold text-bone-50">
                {r.name}
              </span>
              {r.detail ? (
                <span className="text-[10px] leading-none text-bone-400">
                  {r.detail}
                  {r.flag ? <span className="text-warn"> · {r.flag}</span> : null}
                </span>
              ) : null}
            </span>
            <span
              className={`text-[13px] font-bold ${r.delta >= 0 ? "text-win" : "text-loss"}`}
            >
              {r.delta >= 0 ? "+" : "−"}
              {Math.abs(r.delta)}
            </span>
            <AnimatedNumber
              value={r.total}
              className="w-11 text-right text-[17px] font-extrabold text-bone-50"
            />
          </motion.div>
        ))}
      </div>

      {note ? (
        <div
          className={`mt-6 rounded-xl p-3.5 ring-1 ${
            note.tone === "warn"
              ? "bg-warn/9 ring-warn/28"
              : "bg-bone-50/5 ring-bone-50/12"
          }`}
        >
          <div
            className={`mb-1 text-[11px] font-bold ${note.tone === "warn" ? "text-warn" : "text-bone-200"}`}
          >
            {note.title}
          </div>
          <div className="text-[11px] text-bone-200">{note.body}</div>
        </div>
      ) : null}

      {onContinue ? (
        <PrimaryAction onClick={onContinue}>{continueLabel}</PrimaryAction>
      ) : null}
    </PhaseSheet>
  );
}

/* ============================================================
   Game end
   ============================================================ */

export function GameEndSummary({
  show,
  winnerName,
  winnerColour,
  subtitle,
  standings,
  stats,
  onRematch,
  onLobby,
}: {
  show: boolean;
  winnerName: string;
  winnerColour: string;
  subtitle: string;
  standings: ReadonlyArray<{ seat: SeatId; name: string; total: number }>;
  stats?: ReadonlyArray<{ label: string; value: string }>;
  onRematch?: () => void;
  onLobby?: () => void;
}) {
  return (
    <PhaseSheet show={show}>
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 left-1/2 h-80 w-80 -translate-x-1/2 rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgb(212 175 106 / 0.22), transparent 68%)",
        }}
      />

      <div className="relative flex flex-col items-center gap-2 pt-4">
        <span className="eyebrow text-brass-400">Winner</span>
        <motion.span
          className="flex h-[74px] w-[74px] items-center justify-center rounded-full text-2xl font-bold text-felt-950"
          style={{
            background: winnerColour,
            boxShadow:
              "0 0 0 3px var(--color-brass-500), 0 0 44px rgb(212 175 106 / 0.55)",
          }}
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 220, damping: 18 }}
        >
          {winnerName.slice(0, 2).toUpperCase()}
        </motion.span>
        <h2 className="mt-1 font-display text-3xl tracking-wider text-brass-300">
          {winnerName}
        </h2>
        <span className="text-[13px] text-bone-400">{subtitle}</span>
      </div>

      <span className="rule-brass my-6 block" />

      <div className="flex flex-col gap-2.5">
        {standings.map((s, i) => (
          <motion.div
            key={s.seat}
            className="flex items-center justify-between"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ ...TRANSITIONS.ui, delay: 0.05 * i }}
          >
            <span className="flex items-center gap-2.5">
              <span
                className={`w-4 text-[11px] font-extrabold ${i === 0 ? "text-brass-400" : "text-bone-600"}`}
              >
                {i + 1}
              </span>
              <span
                className={`text-[13px] font-semibold ${i === 0 ? "text-bone-50" : "text-bone-200"}`}
              >
                {s.name}
              </span>
            </span>
            <AnimatedNumber
              value={s.total}
              className={`text-[15px] font-extrabold ${i === 0 ? "text-bone-50" : "text-bone-200"}`}
            />
          </motion.div>
        ))}
      </div>

      {stats?.length ? (
        <>
          <span className="rule-brass my-5 block" />
          <div className="flex gap-2.5">
            {stats.map((s) => (
              <div key={s.label} className="flex-1 rounded-lg bg-bone-50/5 p-2.5">
                <div className="mb-1 text-[10px] text-bone-400">{s.label}</div>
                <div className="tnum text-[15px] font-extrabold text-bone-50">
                  {s.value}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div className="mt-7 flex gap-2.5">
        {onLobby ? (
          <button
            type="button"
            onClick={onLobby}
            className="flex-1 rounded-lg bg-bone-50/6 px-5 py-3.5 text-sm font-semibold text-bone-200 ring-1 ring-bone-50/16"
          >
            Lobby
          </button>
        ) : null}
        {onRematch ? (
          <button
            type="button"
            onClick={onRematch}
            className="flex-[1.4] rounded-lg bg-linear-to-b from-brass-300 to-brass-500 px-5 py-3.5 text-sm font-extrabold text-felt-950 shadow-e2"
          >
            Rematch
          </button>
        ) : null}
      </div>
    </PhaseSheet>
  );
}

/* ============================================================
   Shared shell
   ============================================================ */

/**
 * Full-height on a phone, a centred card on a wide screen. One
 * component so a game never has to think about which it is on.
 */
function PhaseSheet({
  show,
  children,
}: {
  show: boolean;
  children: React.ReactNode;
}) {
  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          className="absolute inset-0 z-3000 flex items-end justify-center sm:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={TRANSITIONS.ui}
        >
          <div className="absolute inset-0 bg-felt-950/70 backdrop-blur-sm" />
          <motion.div
            className="relative max-h-full w-full overflow-y-auto rounded-t-[20px] bg-linear-to-b from-felt-800/95 to-felt-900 p-5 ring-1 ring-brass-400/25 sm:max-w-md sm:rounded-2xl"
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0 }}
            transition={TRANSITIONS.ui}
          >
            {children}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function PrimaryAction({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-7 w-full rounded-lg bg-linear-to-b from-brass-300 to-brass-500 px-5 py-3.5 text-sm font-extrabold text-felt-950 shadow-e2"
    >
      {children}
    </button>
  );
}
