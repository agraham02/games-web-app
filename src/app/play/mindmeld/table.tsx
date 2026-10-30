"use client";

/**
 * Mind Meld — the table content, shared by the solo screen and the room.
 *
 * There are no pieces here, so the table is mostly empty, and what fills it is
 * deliberately not words: the previous words are NOT kept on screen (the
 * user's call, 2026-10-24: players should remember them, not read them off the
 * felt). While people think the field is two soft orbs - yours and your
 * partner's - that brighten as each locks in a word, and draw together when
 * both have. Nothing on it could prompt anybody. The only moment the table is
 * loud is the reveal: a countdown, then both words, then the verdict.
 *
 * Seating needs no special geometry. Partners sit on adjacent seats, so every
 * other pair already lands side by side round the rim; my own partner's rim
 * pod is simply not drawn, and the two of us are shown together, as pods side by
 * side, in the strip above the input.
 */

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { SeatId } from "@/engine/types";
import { botColour, botName } from "@/games/_shared/botIdentity";
import { wordProblem } from "@/games/mindmeld/rules";
import { isActive, pairIndexOf, pairOf, partnerOf } from "@/games/mindmeld/state";
import type { MindMeldAction, MindMeldState, Pair, Reveal } from "@/games/mindmeld/types";
import { onCue } from "@/table/fx";
import type { GameSetting } from "@/table/gameSettings";
import { HandZone } from "@/table/HandZone";
import type { SeatView } from "@/table/SeatRing";
import { useTableStore } from "@/table/store";
import { useCueFeedback } from "@/table/cueSounds";
import type { GameRuntime } from "@/table/useGameRuntime";
import { announce } from "@/ui/disclosure";
import type { ScoreRow } from "@/ui/phases/PhaseScreens";

type Live = GameRuntime<MindMeldState, MindMeldAction>;

/** No in-game settings of its own beyond the shared Sound and Vibration. */
export const MINDMELD_SETTINGS: readonly GameSetting[] = [];

/**
 * The strip where a hand would be. There are no cards here, so it only holds
 * the band off the bottom edge - the same call, and the same size, as LRC's.
 */
export const MINDMELD_HAND_ZONE = 16;

/** How long the revealed words stay up before the field empties again. */
const REVEAL_HOLD_MS = 4200;
/** A beat per countdown number. */
const COUNT_MS = 800;

/** Who is looking at this table, and what everyone is called. */
export interface MindMeldView {
  viewerSeat: SeatId;
  nameFor: (seat: SeatId) => string;
  colourFor: (seat: SeatId) => string;
  awayFor?: (seat: SeatId) => boolean;
  botFor?: (seat: SeatId) => boolean;
}

export const OFFLINE_VIEW: MindMeldView = { viewerSeat: 0, nameFor: botName, colourFor: botColour };

function isSeated(view: MindMeldView, state: MindMeldState): boolean {
  return view.viewerSeat >= 0 && view.viewerSeat < state.seats;
}

function seatName(view: MindMeldView, seat: SeatId): string {
  return seat === view.viewerSeat ? "You" : view.nameFor(seat);
}

function seatColour(view: MindMeldView, seat: SeatId): string {
  return seat === view.viewerSeat ? "var(--color-brass-300)" : view.colourFor(seat);
}

/** "You & Bo", or "Sam & Mia". */
function pairName(view: MindMeldView, pair: Pair): string {
  return `${seatName(view, pair.seats[0])} & ${seatName(view, pair.seats[1])}`;
}

/* ============================================================
   What the viewer may do
   ============================================================ */

/**
 * May the viewer lock in a word right now? Not while a reveal is still being
 * played (`animating`), once their pair has melded, or between rounds.
 */
export function canLock(view: MindMeldView, live: Live): boolean {
  const state = live.state;
  if (live.isOver || state.result !== null || !state.dealt || live.animating) return false;
  if (!isSeated(view, state)) return false;
  const pair = pairOf(state, view.viewerSeat);
  return Boolean(pair) && isActive(pair!, state.rules) && state.locks[view.viewerSeat] === null;
}

/* ============================================================
   Little hooks
   ============================================================ */

/**
 * The shared three-two-one. The countdown is a `cue` that holds the queue, so
 * this plays while the table still shows the position BEFORE the reveal; the
 * moment it ends the new state - with every word in it - is drawn.
 */
function useCountdown(): number | null {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const off = onCue((cue) => {
      if (cue.kind !== "countdown") return;
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
      setN(3);
      timers.push(setTimeout(() => setN(2), COUNT_MS), setTimeout(() => setN(1), COUNT_MS * 2), setTimeout(() => setN(null), COUNT_MS * 3));
    });
    return () => {
      off();
      for (const t of timers) clearTimeout(t);
    };
  }, []);
  return n;
}

/**
 * The reveal just shown, for a few seconds, then nothing: a table that went on
 * showing the last words would be the history the user asked not to have.
 */
function useRevealShown(state: MindMeldState): Reveal[] | null {
  const [dismissed, setDismissed] = useState(-1);
  useEffect(() => {
    if (!state.reveal || state.tryNo === 0) return;
    const timer = setTimeout(() => setDismissed(state.tryNo), REVEAL_HOLD_MS);
    return () => clearTimeout(timer);
  }, [state.reveal, state.tryNo]);
  return state.reveal && state.tryNo > 0 && dismissed < state.tryNo ? state.reveal : null;
}

/* ============================================================
   The table
   ============================================================ */

export function MindMeldTable({
  view,
  live,
  settings,
}: {
  view: MindMeldView;
  live: Live;
  settings?: Readonly<Record<string, string | boolean>>;
}) {
  const state = live.state;
  const countdown = useCountdown();
  const reveal = useRevealShown(state);
  useCueFeedback({
    sound: settings?.sound !== false,
    vibration: settings?.vibration !== false,
    viewerSeat: view.viewerSeat,
  });

  const seated = isSeated(view, state);
  const mine = seated ? pairOf(state, view.viewerSeat) : undefined;
  const lockable = canLock(view, live);

  return (
    <>
      <MeldField view={view} live={live} reveal={reveal} countdown={countdown} />
      <HandZone
        panel={mine ? <PairStrip view={view} state={state} pair={mine} /> : undefined}
        bar={
          lockable ? (
            <WordBar view={view} live={live} />
          ) : seated && mine && state.locks[view.viewerSeat] !== null && state.result === null ? (
            <LockedBar view={view} state={state} />
          ) : undefined
        }
      />
    </>
  );
}

/* ============================================================
   The field
   ============================================================ */

/**
 * The middle of the table, anchored to the stage between the rim pods - the one
 * geometry-anchored container this game draws, with everything inside it laid
 * out in flow.
 */
function MeldField({
  view,
  live,
  reveal,
  countdown,
}: {
  view: MindMeldView;
  live: Live;
  reveal: Reveal[] | null;
  countdown: number | null;
}) {
  const g = useTableStore((s) => s.geometry);
  const state = live.state;
  if (!g) return null;
  const box = g.zones.play;
  const seated = isSeated(view, state);
  const mine = seated ? pairOf(state, view.viewerSeat) : undefined;
  const myReveal = reveal?.find((r) => r.pair === mine?.id);
  const partner = seated ? partnerOf(view.viewerSeat) : null;
  const meLocked = seated && state.locks[view.viewerSeat] !== null;
  const partnerLocked = partner !== null && state.locks[partner] !== null;
  const finished = Boolean(mine) && !isActive(mine!, state.rules);

  return (
    <div
      className="pointer-events-none absolute flex flex-col items-center justify-center gap-3 px-2 text-center"
      style={{ left: box.x, top: box.y, width: box.w, height: box.h, zIndex: 5 }}
    >
      <span className="eyebrow">
        Round {state.round}
        {state.rules.rounds > 0 ? ` of ${state.rules.rounds}` : ""}
        {mine ? ` · Try ${Math.min(mine.tries + 1, state.rules.tries)} of ${state.rules.tries}` : ""}
      </span>
      {mine ? <TryPips pair={mine} cap={state.rules.tries} /> : null}

      <Orbs
        view={view}
        meLocked={meLocked}
        partnerLocked={partnerLocked}
        outcome={myReveal?.outcome ?? null}
        melded={finished && mine?.meldedOn !== null}
        seated={seated}
        pair={mine}
      />

      <AnimatePresence mode="wait" initial={false}>
        {countdown !== null ? (
          <motion.div
            key={`count-${countdown}`}
            className="font-display text-7xl font-extrabold text-brass-300"
            initial={{ scale: 1.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.28, ease: "easeOut" }}
          >
            {countdown}
          </motion.div>
        ) : reveal && myReveal && mine ? (
          <RevealWords key={`words-${state.tryNo}`} view={view} pair={mine} reveal={myReveal} />
        ) : (
          <motion.p
            key="line"
            className="max-w-xs text-sm font-semibold text-bone-300"
            aria-live="polite"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {fieldLine(view, state, mine)}
          </motion.p>
        )}
      </AnimatePresence>

      {reveal ? <OtherPairs view={view} state={state} reveal={reveal} mineId={mine?.id} /> : null}
    </div>
  );
}

function fieldLine(view: MindMeldView, state: MindMeldState, mine: Pair | undefined): string {
  if (state.result) return "Round over";
  if (!mine) return "Watching";
  if (mine.meldedOn !== null) return `Melded in ${mine.meldedOn} — ${mine.points} points. Waiting for the others…`;
  if (!isActive(mine, state.rules)) return "Out of tries — waiting for the others…";
  const me = view.viewerSeat;
  const partner = partnerOf(me);
  if (state.locks[me] === null) return "Type a word";
  if (state.locks[partner] === null) return `Locked in — waiting for ${view.nameFor(partner)}`;
  return "Everyone's nearly in…";
}

/** Tries used and tries left, as dots: a count, never a word. */
function TryPips({ pair, cap }: { pair: Pair; cap: number }) {
  return (
    <div className="flex gap-1.5" aria-label={`${pair.tries} of ${cap} tries used`}>
      {Array.from({ length: cap }, (_, i) => (
        <span
          key={i}
          className={`h-1.5 w-1.5 rounded-full ${i < pair.tries ? "bg-brass-300" : "bg-bone-50/20"}`}
          style={pair.meldedOn !== null && i + 1 === pair.meldedOn ? { boxShadow: "0 0 8px var(--color-brass-300)" } : undefined}
        />
      ))}
    </div>
  );
}

/**
 * Two orbs, yours and your partner's, slowly circling. A word locked in makes
 * an orb brighten and stop pulsing; both locked and they drift together. After a
 * reveal they fuse (a meld), touch and wobble apart (so close) or bounce away
 * (a miss). Abstract on purpose: nothing here says a word.
 */
function Orbs({
  view,
  meLocked,
  partnerLocked,
  outcome,
  melded,
  seated,
  pair,
}: {
  view: MindMeldView;
  meLocked: boolean;
  partnerLocked: boolean;
  outcome: Reveal["outcome"] | null;
  melded: boolean;
  seated: boolean;
  pair: Pair | undefined;
}) {
  const bothIn = meLocked && partnerLocked;
  // Distance of each orb from the centre.
  const gap = outcome === "meld" || melded ? 0 : outcome === "miss" || outcome === "timeout" ? 68 : outcome === "close" ? 18 : bothIn ? 26 : 52;
  const scale = outcome === "meld" || melded ? 1.45 : 1;
  const mineColour = seated ? "var(--color-brass-300)" : "var(--color-bone-300)";
  const theirsColour = seated && pair ? view.colourFor(partnerOf(view.viewerSeat)) : "var(--color-bone-400)";

  const orb = (colour: string, locked: boolean, side: -1 | 1) => (
    <motion.span
      className="absolute rounded-full"
      style={{
        width: 52,
        height: 52,
        left: "50%",
        top: "50%",
        marginLeft: -26,
        marginTop: -26,
        background: `radial-gradient(circle at 35% 30%, color-mix(in srgb, ${colour} 70%, white), ${colour} 70%)`,
      }}
      animate={{
        x: side * gap,
        scale,
        opacity: locked || outcome ? 1 : 0.62,
        boxShadow: locked || outcome ? `0 0 28px 6px color-mix(in srgb, ${colour} 55%, transparent)` : `0 0 10px 0 color-mix(in srgb, ${colour} 30%, transparent)`,
      }}
      transition={{ type: "spring", stiffness: 120, damping: 16 }}
    />
  );

  return (
    <motion.div
      aria-hidden
      className="relative h-36 w-52"
      // Circling slowly; stops when the table is showing a result.
      animate={outcome || melded ? { rotate: 0 } : { rotate: 360 }}
      transition={outcome || melded ? { duration: 0.4 } : { duration: 22, repeat: Infinity, ease: "linear" }}
    >
      {orb(mineColour, meLocked, -1)}
      {orb(theirsColour, partnerLocked, 1)}
    </motion.div>
  );
}

/** Both words of the viewer's pair, big, and what they came to. */
function RevealWords({ view, pair, reveal }: { view: MindMeldView; pair: Pair; reveal: Reveal }) {
  const me = view.viewerSeat;
  const iAmFirst = pair.seats[0] === me;
  const mine = iAmFirst ? reveal.a : reveal.b;
  const theirs = iAmFirst ? reveal.b : reveal.a;
  const headline =
    reveal.outcome === "meld"
      ? "MIND MELD!"
      : reveal.outcome === "close"
        ? "So close!"
        : reveal.outcome === "timeout"
          ? "Out of time"
          : "Not yet";
  return (
    <motion.div
      className="flex flex-col items-center gap-2"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      aria-live="assertive"
    >
      {reveal.outcome !== "timeout" ? (
        <div className="flex items-baseline gap-5 font-display text-4xl font-extrabold text-bone-50">
          <motion.span initial={{ x: -26, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 22 }}>
            {mine}
          </motion.span>
          <span className="text-xl text-bone-500">·</span>
          <motion.span initial={{ x: 26, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 22 }}>
            {theirs}
          </motion.span>
        </div>
      ) : null}
      <span
        className={`font-display text-xl font-extrabold tracking-widest uppercase ${
          reveal.outcome === "meld" ? "text-brass-300" : "text-bone-300"
        }`}
      >
        {headline}
      </span>
    </motion.div>
  );
}

/** What every other pair said, small, for as long as the reveal is up. */
function OtherPairs({
  view,
  state,
  reveal,
  mineId,
}: {
  view: MindMeldView;
  state: MindMeldState;
  reveal: Reveal[];
  mineId: number | undefined;
}) {
  const others = reveal.filter((r) => r.pair !== mineId && r.outcome !== "timeout");
  if (others.length === 0) return null;
  return (
    <ul className="flex max-w-full flex-col gap-0.5 text-[11px] text-bone-400">
      {others.map((r) => (
        <li key={r.pair}>
          <span className="font-bold text-bone-300">{pairName(view, state.pairs[r.pair]!)}</span>: {r.a} · {r.b}
          {r.outcome === "meld" ? " ✓" : ""}
        </li>
      ))}
    </ul>
  );
}

/* ============================================================
   The input, and the pair
   ============================================================ */

const PRIMARY =
  "shrink-0 rounded-lg bg-linear-to-b from-brass-300 to-brass-500 px-4 py-2 text-xs font-extrabold text-felt-950 shadow-e2 disabled:opacity-40";

function WordBar({ view, live }: { view: MindMeldView; live: Live }) {
  const [word, setWord] = useState("");
  const [shake, setShake] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const state = live.state;
  const seat = view.viewerSeat;

  // Focus for the next try. On a phone focusing raises the keyboard unasked, so
  // only where there is a fine pointer: a desktop player starts typing at once.
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches) input.current?.focus();
  }, [state.tryNo, state.round]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const problem = wordProblem(state, seat, word);
    if (problem) {
      // Feedback after an attempt: the same words the server would use.
      announce(problem, "bad");
      setShake((n) => n + 1);
      return;
    }
    live.submitAction({ t: "submit", seat, word: word.trim() });
    setWord("");
  };

  return (
    <motion.form
      onSubmit={submit}
      className="flex w-full min-w-0 items-center gap-2"
      key="word-bar"
      animate={shake > 0 ? { x: [0, -7, 7, -5, 5, 0] } : undefined}
      transition={{ duration: 0.35 }}
    >
      <input
        ref={input}
        value={word}
        onChange={(e) => setWord(e.target.value)}
        maxLength={30}
        aria-label="Your word"
        placeholder="Your word"
        // The phone must not "fix" a word the player means (a typo is a miss, and
        // a friend who cannot spell is the joke), and the felt's `select-none`
        // would otherwise stop iOS typing here at all.
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="send"
        data-pan-ignore
        className="min-w-0 flex-1 rounded-lg bg-felt-950/85 px-3 py-2 text-base font-semibold text-bone-50 select-text ring-1 ring-brass-400/40 outline-none placeholder:text-bone-500 focus:ring-2 focus:ring-brass-300"
      />
      <motion.button type="submit" whileTap={{ scale: 0.96 }} className={PRIMARY} disabled={word.trim() === ""}>
        Lock in
      </motion.button>
    </motion.form>
  );
}

/** After locking in: said plainly, so nobody wonders whether the press registered. */
function LockedBar({ view, state }: { view: MindMeldView; state: MindMeldState }) {
  const partner = partnerOf(view.viewerSeat);
  const waitingOn = state.locks[partner] === null ? view.nameFor(partner) : null;
  return (
    <span className="text-xs font-bold text-brass-300" aria-live="polite">
      Locked in ✓{waitingOn ? ` — waiting for ${waitingOn}` : ""}
    </span>
  );
}

/** My pair, as two pods side by side. */
function PairStrip({ view, state, pair }: { view: MindMeldView; state: MindMeldState; pair: Pair }) {
  return (
    <div className="flex items-stretch gap-2">
      {pair.seats.map((seat) => (
        <PodCard key={seat} view={view} state={state} pair={pair} seat={seat} />
      ))}
      <div className="flex flex-col items-center justify-center rounded-xl bg-felt-950/85 px-3 py-2 ring-1 ring-bone-50/15 backdrop-blur-sm">
        <span className="text-[10px] font-bold tracking-wide text-bone-400 uppercase">Points</span>
        <span className="font-display text-lg leading-none font-extrabold text-brass-300">
          {state.scores[pair.seats[0]] ?? 0}
        </span>
      </div>
    </div>
  );
}

function statusOf(state: MindMeldState, pair: Pair, seat: SeatId): string {
  if (pair.meldedOn !== null) return `Melded · try ${pair.meldedOn}`;
  if (!isActive(pair, state.rules)) return "Out of tries";
  return state.locks[seat] !== null ? "Locked in ✓" : "Thinking…";
}

function PodCard({ view, state, pair, seat }: { view: MindMeldView; state: MindMeldState; pair: Pair; seat: SeatId }) {
  const locked = state.locks[seat] !== null;
  // Said of the partner as well as of anyone on the rim: a bot playing their
  // seat changes the game, and the rim pod that would say so is not drawn.
  const who = seat === view.viewerSeat ? null : view.awayFor?.(seat) ? "Away" : view.botFor?.(seat) ? "Bot" : null;
  return (
    <div
      className="flex min-w-28 items-center gap-2 rounded-xl bg-felt-950/85 px-3 py-2 ring-1 backdrop-blur-sm"
      style={{ ["--tw-ring-color" as string]: locked ? "var(--color-brass-300)" : "rgb(245 242 234 / 0.14)" }}
    >
      <span
        aria-hidden
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-extrabold text-felt-950"
        style={{ background: seatColour(view, seat) }}
      >
        {seatName(view, seat).slice(0, 2).toUpperCase()}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-xs font-bold text-bone-50">{seatName(view, seat)}</span>
        <span className="truncate text-[10px] text-bone-400">
          {who ? `${who} · ` : ""}
          {statusOf(state, pair, seat)}
        </span>
      </span>
    </div>
  );
}

/* ============================================================
   GameHost slots
   ============================================================ */

/** Everybody but MY PAIR: my partner is drawn beside me, not on the rim. */
export function playerViews(view: MindMeldView, state: MindMeldState, _live: Live): SeatView[] {
  const out: SeatView[] = [];
  const myPair = isSeated(view, state) ? pairIndexOf(view.viewerSeat) : -1;
  for (let i = 0; i < state.seats; i++) {
    const seat = i as SeatId;
    if (pairIndexOf(seat) === myPair) continue;
    const pair = state.pairs[pairIndexOf(seat)]!;
    out.push({
      seat,
      name: view.nameFor(seat),
      colour: view.colourFor(seat),
      stats: [[{ label: "Points", value: state.scores[seat] ?? 0 }], [{ label: "Try", value: pair.tries }]],
      status: statusOf(state, pair, seat),
      // Nobody is "on turn": everybody is thinking at once, and a pod lighting
      // in turn would say which bot was quickest.
      active: false,
      thinking: false,
      winning: state.result?.winner === seat,
      away: view.awayFor?.(seat) ?? false,
      bot: view.botFor?.(seat) ?? false,
    });
  }
  return out;
}

/** One row per PAIR, named "You & Bo", on the pair's first seat. */
export function standings(view: MindMeldView, state: MindMeldState, _live: Live, _seats: SeatView[]) {
  return state.pairs
    .map((pair) => ({ seat: pair.seats[0], name: pairName(view, pair), total: state.scores[pair.seats[0]] ?? 0 }))
    .sort((a, b) => b.total - a.total);
}

export function statsFor(view: MindMeldView, state: MindMeldState): Array<{ label: string; value: string }> {
  const rows = [
    { label: "Round", value: `${state.round}` },
    { label: "Rounds", value: `${state.rules.rounds}` },
  ];
  if (isSeated(view, state)) rows.push({ label: "Your pair", value: `${state.scores[view.viewerSeat] ?? 0}` });
  return rows;
}

export function roundSummary(view: MindMeldView, state: MindMeldState) {
  const result = state.result;
  if (!result) return null;

  const rows: ScoreRow[] = Array.from({ length: state.seats }, (_, i) => {
    const seat = i as SeatId;
    const pair = result.pairs[pairIndexOf(seat)]!;
    return {
      seat,
      name: seatName(view, seat),
      colour: seatColour(view, seat),
      detail: pair.meldedOn !== null ? `melded on try ${pair.meldedOn}` : "never met",
      delta: result.deltas[seat] ?? 0,
      total: state.scores[seat] ?? 0,
    };
  });

  // The chain, played back: by now the words are history, and the laugh is in
  // seeing where the two of you went. Not shown during play.
  const mine = isSeated(view, state) ? result.pairs[pairIndexOf(view.viewerSeat)] : undefined;
  const note = mine && mine.chain.length > 0
    ? ({ tone: "info", title: "Your words", body: chainText(mine.chain) } as const)
    : undefined;

  const winnerPair = result.pairs.find((p) => p.seats[0] === result.winner)!;
  const won = isSeated(view, state) && pairIndexOf(view.viewerSeat) === pairIndexOf(result.winner);
  return {
    title: won ? "Your pair takes the round" : `${pairName(view, state.pairs[winnerPair.seats[0] / 2]!)} take the round`,
    rows,
    note,
    target: undefined,
  };
}

/** "ocean · beach → sand · sun → …": each try's two words, in order. */
function chainText(chain: readonly string[]): string {
  const tries: string[] = [];
  for (let i = 0; i < chain.length; i += 2) tries.push(`${chain[i]} · ${chain[i + 1] ?? "…"}`);
  return tries.join("  →  ");
}

export function pendingLabel(view: MindMeldView, _state: MindMeldState, seat: SeatId): string {
  return `${view.nameFor(seat)} pending — thinking`;
}
