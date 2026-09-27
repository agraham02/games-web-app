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
import { Stats, type StatLines } from "@/ui/primitives/Stats";
import { useTableStore } from "@/table/store";
import { Button } from "@/ui/primitives/Button";
import { useState } from "react";

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

/**
 * Shown ONLY while it's genuinely the hero's move (every call site gates
 * `show` on that already) — so making this unmissable is exactly the
 * point. The pulsing halo behind the label reuses the same
 * opacity/scale pulse language as SeatRing's `ThinkingRing` (a bot
 * deliberating), so the two read as one consistent "something is
 * happening here, act or wait" motion vocabulary across every game.
 *
 * A layout child of `HandZone`'s band and nothing else. It used to have a
 * second, free-floating mode — `absolute`, `calc()`'d against
 * `--hand-zone`, and in a z-index contest with the badge beside it — which
 * is exactly what the band exists to replace.
 */
export function TurnIndicator({ label, show }: { label: string; show: boolean }) {
  // Everybody else's turn, said quietly in the same place: who the table is
  // waiting on (see `TableState.turnLine`). Nothing on a table with no host.
  const waiting = useTableStore((s) => s.turnLine);
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {!show && waiting ? (
        <motion.div
          key={`waiting:${waiting}`}
          className="pointer-events-none min-w-0 truncate px-1 py-1 text-center text-[10px] font-bold tracking-widest text-bone-400 uppercase"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: TRANSITIONS.uiExit }}
          transition={TRANSITIONS.uiEnter}
        >
          {waiting}
        </motion.div>
      ) : null}
      {show ? (
        <motion.div
          key="your-turn"
          className="pointer-events-none min-w-0"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={TRANSITIONS.ui}
        >
          {/* `text-center` belongs HERE, not on the inline <span> below —
              text-align governs how a BLOCK's own line boxes wrap, and an
              inline element sets none of its own; centering it on the
              span was a no-op, which is why a wrapped 2-line label (a
              real case on a narrow phone) rendered left-ragged. */}
          <div className="relative px-1 py-1 text-center">
            <motion.span
              aria-hidden
              className="pointer-events-none absolute -inset-5 rounded-full"
              style={{
                background: "radial-gradient(closest-side, rgb(212 175 106 / 0.65), transparent 72%)",
                filter: "blur(10px)",
              }}
              animate={{ opacity: [0.35, 1, 0.35], scale: [0.9, 1.08, 0.9] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
            />
            <span
              className="relative text-[10px] font-bold tracking-widest text-brass-300 uppercase"
              style={{ textShadow: "0 0 10px rgb(212 175 106 / 0.7)" }}
            >
              {label}
            </span>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/* ============================================================
   Hero status badge — rung 1 ambient HUD for the hero's own
   game-specific stake, since the hero has no seat pod to carry it.
   ============================================================ */

/**
 * The hero's own always-visible readout of whatever this game's central
 * "stake" is — Spades' bid and tricks won, Poker's stack, Rummy's score.
 * Every OTHER seat carries this on its pod (SeatRing); the hero has no pod
 * at all, so this carries the same rung-1 information for them.
 *
 * A layout child of `HandZone`'s band, beside the cards it describes —
 * see `TurnIndicator` for the positioned mode it no longer has.
 */
export function HeroStatusBadge({
  label,
  detail,
  stats,
  show = true,
}: {
  /** e.g. "Your hand" — with `detail`, for a readout that is words. */
  label?: string;
  /** e.g. "Pair of 7s" */
  detail?: string;
  /**
   * Labelled numbers — the same vocabulary the game's pods use (`Stats`),
   * so the viewer's own numbers read like everybody else's. Up to two lines.
   */
  stats?: StatLines;
  show?: boolean;
}) {
  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          className={
            stats
              ? "flex min-w-0 flex-col gap-1 rounded-xl bg-felt-950/78 px-2.5 py-1.5 text-[10px] ring-1 ring-brass-400/30 backdrop-blur-sm"
              : "min-w-0 truncate rounded-full bg-felt-950/78 px-2.5 py-1.5 text-[10px] font-bold text-brass-300 ring-1 ring-brass-400/30 backdrop-blur-sm"
          }
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={TRANSITIONS.ui}
        >
          {stats ? (
            <Stats lines={stats} />
          ) : (
            <>
              <span className="text-bone-300">{label}: </span>
              {detail}
            </>
          )}
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
  /**
   * Groups this row with others sharing the same id — a partnership
   * game's round score is identical for both teammates, so showing it
   * twice is noise rather than information. Rows sharing a `team` render
   * under one shared delta/total (taken from whichever appears first);
   * each member still gets their own name + detail line. Omit for a
   * game with no team concept — that row renders exactly as it always
   * has, unaffected.
   */
  team?: string | number;
  /** The viewer's own row — highlighted. Defaults to a row named "You". */
  you?: boolean;
}

const isYou = (r: ScoreRow) => r.you ?? r.name === "You";

/**
 * "First to 10 · Mia 3" — how far the match has to go, and who is nearest.
 * A team is named by its members. A tie at the top says so rather than
 * picking one of them.
 */
function progressLine(groups: readonly (readonly ScoreRow[])[], target: number): string {
  const [top, next] = groups;
  if (!top?.[0]) return `First to ${target}`;
  const total = top[0].total;
  if (next?.[0] && next[0].total === total) return `First to ${target} · tied at ${total}`;
  return `First to ${target} · ${top.map((r) => r.name).join(" & ")} ${total}`;
}

export function RoundEndScorecard({
  show,
  eyebrow,
  title,
  rows,
  note,
  onContinue,
  continueLabel = "Next round",
  waiting,
  target,
}: {
  show: boolean;
  eyebrow: string;
  title: string;
  rows: readonly ScoreRow[];
  note?: { tone: "warn" | "info"; title: string; body: string };
  onContinue?: () => void;
  continueLabel?: string;
  /**
   * Shown INSTEAD of the continue button when somebody else continues —
   * "Waiting for Ada to continue". A room's round is the leader's to deal.
   */
  waiting?: string;
  /** What the match is played to — adds the progress line. */
  target?: number;
}) {
  // Lowered to a strip, so the table under it can be read — a showdown's
  // board, the last trick, the melds. Every new card opens full.
  const [peek, setPeek] = useState(false);
  const [shownFor, setShownFor] = useState(show);
  if (show !== shownFor) {
    setShownFor(show);
    if (show) setPeek(false);
  }

  // Highest total first: the order a player reads a scoreboard in.
  const groups = groupScoreRows(rows).sort((a, b) => (b[0]?.total ?? 0) - (a[0]?.total ?? 0));

  return (
    <PhaseSheet show={show} strip={peek}>
      {peek ? (
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate font-display text-lg tracking-wide text-brass-300">
            {title}
          </span>
          <Button size="sm" onClick={() => setPeek(false)}>
            Show scores
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-col items-center gap-1.5 pt-2">
            <span className="eyebrow">{eyebrow}</span>
            <h2 className="font-display text-2xl tracking-wider text-brass-300">{title}</h2>
            {target !== undefined ? (
              <span className="text-xs font-semibold text-bone-400">{progressLine(groups, target)}</span>
            ) : null}
            <span className="rule-brass mt-1 w-32" />
          </div>

          <div className="mt-6 flex flex-col">
            {groups.map((group, i) => (
              <ScoreRowGroup key={group.map((r) => r.seat).join("-")} rows={group} index={i} />
            ))}
          </div>

          {note ? (
            <div
              className={`mt-6 rounded-xl p-3.5 ring-1 ${
                note.tone === "warn" ? "bg-warn/9 ring-warn/28" : "bg-bone-50/5 ring-bone-50/12"
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

          {waiting ? (
            <p className="mt-6 text-center text-sm font-semibold text-bone-300" role="status">
              {waiting}
            </p>
          ) : onContinue ? (
            <Button tone="primary" className="mt-7 w-full" onClick={onContinue}>
              {continueLabel}
            </Button>
          ) : null}
          <button
            type="button"
            onClick={() => setPeek(true)}
            className="mt-3 w-full text-center text-xs text-bone-400 underline-offset-4 hover:text-bone-200 hover:underline"
          >
            Look at the table
          </button>
        </>
      )}
    </PhaseSheet>
  );
}

/**
 * Rows sharing a `team` id become one group; a row with no `team` is its
 * own singleton group, rendering exactly as it always has. Preserves
 * first-seen order — a game with no team concept never sees anything
 * change here at all.
 */
function groupScoreRows(rows: readonly ScoreRow[]): ScoreRow[][] {
  const groups: ScoreRow[][] = [];
  const byTeam = new Map<string | number, ScoreRow[]>();
  for (const r of rows) {
    if (r.team === undefined) {
      groups.push([r]);
      continue;
    }
    const existing = byTeam.get(r.team);
    if (existing) {
      existing.push(r);
    } else {
      const fresh = [r];
      byTeam.set(r.team, fresh);
      groups.push(fresh);
    }
  }
  return groups;
}

/**
 * One or more rows sharing a single delta/total. A team of 2 shows one
 * shared score (partners' round score is always identical — repeating
 * it twice is noise, not information) with each member's own avatar,
 * name and detail stacked above/below the other; a solo row (no `team`)
 * renders identically to how this component always has.
 */
function ScoreRowGroup({ rows, index }: { rows: readonly ScoreRow[]; index: number }) {
  const [first] = rows;
  if (!first) return null;
  return (
    <motion.div
      className={`grid grid-cols-[22px_1fr_auto_auto] items-center gap-2.5 border-b border-bone-50/7 py-2.5 last:border-b-0 ${
        rows.some(isYou) ? "-mx-2 rounded-lg bg-brass-400/8 px-2" : ""
      }`}
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ ...TRANSITIONS.ui, delay: 0.06 * index }}
    >
      <span className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <span
            key={r.seat}
            className="flex h-[22px] w-[22px] items-center justify-center rounded-full text-[9px] font-bold text-felt-950"
            style={{ background: r.colour }}
          >
            {r.name.slice(0, 2).toUpperCase()}
          </span>
        ))}
      </span>
      <span className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <span key={r.seat} className="flex flex-col gap-0.5">
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
        ))}
      </span>
      {/* Green is for a gain. "+0" in green read as a win for everybody
          who scored nothing, so a zero is neutral. */}
      <span
        className={`text-[13px] font-bold ${
          first.delta > 0 ? "text-win" : first.delta < 0 ? "text-loss" : "text-bone-400"
        }`}
      >
        {first.delta >= 0 ? "+" : "−"}
        {Math.abs(first.delta)}
      </span>
      <AnimatedNumber
        value={first.total}
        className="w-11 text-right text-[17px] font-extrabold text-bone-50"
      />
    </motion.div>
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
          initial={{ scale: 0.85, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          // The UI tween like everything else here — the spring overshot.
          transition={TRANSITIONS.uiEnterSlow}
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
          <Button className="flex-1" onClick={onLobby}>
            Lobby
          </Button>
        ) : null}
        {onRematch ? (
          <Button tone="primary" className="flex-[1.4]" onClick={onRematch}>
            Rematch
          </Button>
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
  strip = false,
  children,
}: {
  show: boolean;
  /** Lowered to a bar at the bottom, with no backdrop over the table. */
  strip?: boolean;
  children: React.ReactNode;
}) {
  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          className={`absolute inset-0 z-3000 flex items-end justify-center ${
            strip ? "pointer-events-none" : "sm:items-center"
          }`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={TRANSITIONS.ui}
        >
          {strip ? null : <div className="absolute inset-0 bg-felt-950/70 backdrop-blur-sm" />}
          <motion.div
            layout
            className={`pointer-events-auto relative max-h-full w-full overflow-y-auto rounded-t-[20px] bg-linear-to-b from-felt-800/95 to-felt-900 ring-1 ring-brass-400/25 sm:max-w-md ${
              strip ? "px-5 py-3 sm:mb-4 sm:rounded-2xl" : "p-5 sm:rounded-2xl"
            }`}
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

