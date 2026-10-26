"use client";

/**
 * Chromaly — the table content, shared by the solo screen and the room.
 *
 * Everything that decides what something MEANS lives here rather than in
 * either shell, because it is a rules question with one answer. The two
 * shells differ only in where the held selection is kept (the page in its own
 * state, the room in `RoomScreen` so it survives a trip to the lobby).
 *
 * The one band above the hand has several jobs, and only one at a time
 * (`barMode`):
 *
 *  - the **window**: when a seat has reached its last card the CHROMA! button
 *    comes up for everyone, with the clock round it; first to press wins
 *  - a **penalty** on the table: take it, or (for a +4) call a bluff
 *  - a card just **drawn**: play it or keep it
 *  - your **turn**: Draw, the last-card call when you hold two cards, and
 *    Play for a pair you have picked
 *
 * What is deliberately absent: nothing lights the cards that can be played,
 * nothing says which card could jump in, and the jump-in has no button. A
 * thing merely appearing is a tell, and working out what is playable is the
 * game. The one exception is the last-card button, by the user's choice
 * (2026-10-24): it pops up for the people it is for, because forgetting to
 * call is meant to be a mistake a table can punish, not one the interface
 * quietly prevents. Feedback AFTER a tap — "that does not match the pile" —
 * is fine; a hint before one is not.
 */

import { useEffect } from "react";
import { motion } from "motion/react";
import type { PieceId, SeatId } from "@/engine/types";
import { botColour, botName } from "@/games/_shared/botIdentity";
import {
  COLORS,
  COLOR_NAME,
  cardLabel,
  identical,
  isWild,
  parseCard,
  points,
  type Color,
} from "@/games/chromaly/cards";
import { legalDoubles, whyNotPlayable } from "@/games/chromaly/state";
import { validate } from "@/games/chromaly/rules";
import type { ChromalyAction, ChromalyState } from "@/games/chromaly/types";
import { HAND_SPACING_SETTING, hintsSetting, type GameSetting } from "@/table/gameSettings";
import { HandPan } from "@/table/HandPan";
import { HandZone } from "@/table/HandZone";
import type { SeatStat, SeatView } from "@/table/SeatRing";
import { useTableStore } from "@/table/store";
import { seatCue } from "@/table/turnCue";
import type { GameRuntime } from "@/table/useGameRuntime";
import { useHeldMarks } from "@/table/useHeldMarks";
import { CountdownButton } from "@/ui/primitives/CountdownButton";
import { SHAPE_GLYPH } from "@/ui/primitives/ChromaFace";
import { announce } from "@/ui/disclosure";
import { PileChrome } from "./PileChrome";
import { HeroStatusBadge, TurnIndicator, type ScoreRow } from "@/ui/phases/PhaseScreens";

/** Chromaly's own Settings: Hints (dimming what cannot be played) and Card spacing. */
export const CHROMALY_SETTINGS: readonly GameSetting[] = [
  hintsSetting("Dim the cards you cannot play. Off, every card looks playable."),
  HAND_SPACING_SETTING,
];

type Live = GameRuntime<ChromalyState, ChromalyAction>;

/**
 * Who is looking at this table, and what everyone is called.
 *
 * Offline that is seat 0 and a table of bot names; online it is whatever seat
 * the server sat you in and the real names of the people in the room.
 */
export interface ChromalyView {
  viewerSeat: SeatId;
  nameFor: (seat: SeatId) => string;
  colourFor: (seat: SeatId) => string;
  /** Whether a bot is currently playing that seat for the person who owns it. */
  awayFor?: (seat: SeatId) => boolean;
  /** A seat nobody owns, which a bot plays. */
  botFor?: (seat: SeatId) => boolean;
}

/** Seat 0, against bots — every offline game. */
export const OFFLINE_VIEW: ChromalyView = {
  viewerSeat: 0,
  nameFor: botName,
  colourFor: botColour,
};

/** Is the viewer actually sitting at this table? `SPECTATOR_SEAT` is -1. */
function isSeated(view: ChromalyView, state: ChromalyState): boolean {
  return view.viewerSeat >= 0 && view.viewerSeat < state.seats;
}

/* ============================================================
   What the viewer may do
   ============================================================ */

/**
 * Is it the viewer's turn to play — and the table not busy showing the last
 * move or waiting out a window? Deliberately not `live.isHeroTurn`, which
 * compares against `currentSeat`: during a window that names whoever must
 * answer first, and nobody plays into one.
 */
export function canAct(view: ChromalyView, live: Live): boolean {
  const state = live.state;
  if (live.isOver || state.result !== null || !state.dealt) return false;
  if (state.window !== null || live.latest.window !== null) return false;
  if (live.animating) return false;
  return state.turn === view.viewerSeat;
}

/** Is the viewer in an open window, with the move not yet answered? */
function inWindow(view: ChromalyView, live: Live): boolean {
  const seat = view.viewerSeat;
  const open = (s: ChromalyState) => s.window?.pending.some((p) => p.seat === seat) ?? false;
  return open(live.state) && open(live.latest);
}

/** Is there a seat on its last card for the viewer to save or catch? */
export function canCall(view: ChromalyView, live: Live): boolean {
  return inWindow(view, live) && (live.state.window?.offenders.length ?? 0) > 0;
}

/** May the viewer jump in right now? */
export function canJump(view: ChromalyView, live: Live): boolean {
  return inWindow(view, live) && (live.state.window?.jumpers.includes(view.viewerSeat) ?? false);
}

/** Does playing this single card need a choice first: a colour, or a seat to swap with? */
export function needsChoice(state: ChromalyState, seat: SeatId, id: PieceId): "colour" | "swap" | null {
  const card = parseCard(id);
  if (!card) return null;
  if (isWild(card)) return "colour";
  const hand = state.hands[seat] ?? [];
  if (state.rules.sevenZero && card.kind === "number" && card.value === 7 && hand.length > 1) return "swap";
  return null;
}

/** Is there another card in the hand of the same number, so this one could be half of a pair? */
function couldPair(state: ChromalyState, seat: SeatId, id: PieceId): boolean {
  if (!state.rules.doubles) return false;
  const card = parseCard(id);
  if (card?.kind !== "number") return false;
  return (state.hands[seat] ?? []).some((other) => {
    if (other === id) return false;
    const c = parseCard(other);
    return c?.kind === "number" && c.value === card.value;
  });
}

/**
 * Which the action band shows, for both screens and testable without
 * mounting a table. Only one thing is ever offered at a time.
 */
export type BarMode = "call" | "penalty" | "drawn" | "turn" | null;

export function barMode(view: ChromalyView, live: Live): BarMode {
  if (canCall(view, live)) return "call";
  if (!canAct(view, live)) return null;
  const state = live.state;
  if (state.challenge !== null || state.pendingDraw !== null) return "penalty";
  if (state.drawn !== null) return "drawn";
  return "turn";
}

/* ============================================================
   Picking cards up
   ============================================================ */

/**
 * What picking a card up MEANS — for both screens. Pure: the marks on the
 * table follow from the list (`useHeldMarks`), never from inside a React state
 * updater, where a store write is a write during render.
 *
 * A pair is one number, so a card of a different number starts a new pick
 * rather than joining the old one; a wild or a 7 that must make a choice
 * first is always picked alone.
 */
export function togglePlayCard(
  held: readonly PieceId[],
  id: PieceId,
  state?: ChromalyState,
  seat?: SeatId,
): PieceId[] {
  if (held.includes(id)) return held.filter((x) => x !== id);
  const card = parseCard(id);
  const alone = state !== undefined && seat !== undefined && needsChoice(state, seat, id) !== null;
  if (alone || card?.kind !== "number") return [id];
  const first = held[0] ? parseCard(held[0]) : null;
  if (first?.kind !== "number" || first.value !== card.value) return [id];
  return [...held, id];
}

/** The marks on a card picked up: lifted and ringed, as a meld's in Rummy. */
const HELD_MARKS = { selected: true, highlighted: true } as const;
const HELD_OFF = { selected: false, highlighted: false } as const;

/** Puts every held card down. The store patch is the half easily forgotten. */
export function clearPlayCards(held: readonly PieceId[]): void {
  useTableStore.getState().patchMany(held, HELD_OFF);
}

/**
 * Sends a play, or a jump-in when a window is open — one place for both
 * screens, so what a tap on a card means cannot drift between them.
 *
 * Refused here rather than at the server when it plainly cannot work, because
 * the server's answer is a round trip and a toast is not: "that does not go
 * together" should arrive with the tap.
 */
function sendPlay(
  view: ChromalyView,
  live: Live,
  cards: PieceId[],
  extra: { color?: Color; swapWith?: SeatId } = {},
): boolean {
  const state = live.state;
  const seat = view.viewerSeat;
  const action: ChromalyAction =
    state.window !== null
      ? { t: "jumpIn", seat, card: cards[0]!, swapWith: extra.swapWith }
      : { t: "play", cards, color: extra.color, swapWith: extra.swapWith };
  const problem = validate(state, seat, action);
  if (problem) {
    announce(problem.charAt(0).toUpperCase() + problem.slice(1), "bad");
    return false;
  }
  live.submitAction(action);
  return true;
}

export function onPieceTap(
  view: ChromalyView,
  id: PieceId,
  live: Live,
  toggleHeld: (id: PieceId) => void,
): void {
  const state = live.state;
  const seat = view.viewerSeat;
  if (!isSeated(view, state) || !(state.hands[seat] ?? []).includes(id)) return;

  // In a window a card can only mean one thing: jumping in with it.
  if (state.window !== null) {
    if (!canJump(view, live)) return;
    const top = state.window.card === null ? null : parseCard(state.window.card);
    const mine = parseCard(id);
    if (!top || !mine || !identical(mine, top)) {
      announce("Only the identical card can jump in", "bad");
      return;
    }
    if (needsChoice(state, seat, id) === "swap") toggleHeld(id);
    else sendPlay(view, live, [id]);
    return;
  }

  if (!canAct(view, live)) return;

  const refused = whyNotPlayable(state, seat, id);
  // A pair is picked a card at a time, so a card that could be half of one may
  // be picked even when it could not go down alone.
  if (refused && !(couldPair(state, seat, id) && state.drawn === null)) {
    announce(refused, "bad");
    return;
  }

  // Something to choose first - a colour, a seat - or half of a pair: the
  // card is picked up, and the band asks.
  if (needsChoice(state, seat, id) !== null || couldPair(state, seat, id)) {
    toggleHeld(id);
    return;
  }
  sendPlay(view, live, [id]);
}

/**
 * The client's own countdown on a window.
 *
 * Purely a reflex, and non-authoritative on purpose: the engine holds no
 * wall-clock and `GameDefinition.deadline` is what actually resolves a window.
 * This draws the ring, and if it fires first it only ever removes its own
 * owner from the race. The two are deliberately not tuned to agree; see
 * `WINDOW_GRACE_MS`.
 */
function useWindowCountdown(view: ChromalyView, live: Live): void {
  // Not while their own answer is on its way: it would be a second one.
  const racing = inWindow(view, live) && !live.sending;
  const ms = live.state.rules.windowMs;
  const seat = view.viewerSeat;
  const id = live.state.window?.id ?? 0;
  useEffect(() => {
    if (!racing) return;
    const timer = setTimeout(() => live.submitAction({ t: "declineWindow", seat }), ms);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [racing, ms, seat, id]);
}

/* ============================================================
   The table
   ============================================================ */

export function ChromalyTable({
  view,
  live,
  held,
  onPick,
  onClearHeld,
}: {
  view: ChromalyView;
  live: Live;
  held: PieceId[];
  /** Picks a card up (the shells own where the selection is kept). */
  onPick: (id: PieceId) => void;
  onClearHeld: () => void;
}) {
  const state = live.state;
  // Re-asserted after every batch: you can be picking a pair for your own
  // turn while opponents answer a window, and each answer resets the store.
  useHeldMarks(held, HELD_MARKS, live.state);
  useWindowCountdown(view, live);

  const mode = barMode(view, live);
  const choice = pickedChoice(view, state, held);
  const panel = choice ? (
    <ChoicePanel view={view} live={live} held={held} choice={choice} onClearHeld={onClearHeld} />
  ) : undefined;

  const bar =
    mode === "call" ? (
      <CallBar view={view} live={live} />
    ) : mode === "penalty" ? (
      <PenaltyBar live={live} />
    ) : mode === "drawn" ? (
      <DrawnBar live={live} onPlay={(id) => onPieceTap(view, id, live, onPick)} />
    ) : mode === "turn" ? (
      <TurnBar view={view} live={live} held={held} onClearHeld={onClearHeld} />
    ) : undefined;

  return (
    <>
      <PileChrome state={state} />
      {/* Thirty cards after a few penalties is possible; past a point the hand
          pans rather than compressing into slivers too thin to tap. */}
      {isSeated(view, state) ? <HandPan count={(state.hands[view.viewerSeat] ?? []).length} /> : null}
      <HandZone
        bar={choice ? undefined : bar}
        panel={panel}
        left={<PlayBadge state={state} />}
        center={
          <TurnIndicator label={turnLabel(view, state)} show={mode === "turn" || mode === "drawn" || mode === "penalty"} />
        }
      />
    </>
  );
}

/** What the held card is waiting on, if it is waiting on anything. */
function pickedChoice(
  view: ChromalyView,
  state: ChromalyState,
  held: readonly PieceId[],
): "colour" | "swap" | null {
  if (held.length !== 1 || !isSeated(view, state)) return null;
  return needsChoice(state, view.viewerSeat, held[0]!);
}

/**
 * The colour in force and the way round, always visible: rung 1, never a hint
 * (everybody can see the pile). A fuller version - a halo and a turning ring
 * round the pile - is drawn by the table chrome; this is the line a screen
 * reader and a cramped phone fall back on.
 */
function PlayBadge({ state }: { state: ChromalyState }) {
  const color = state.color;
  const stack = state.pendingDraw?.amount ?? state.challenge?.amount ?? 0;
  return (
    <HeroStatusBadge
      label={`${SHAPE_GLYPH[color]} ${COLOR_NAME[color]}`}
      detail={
        stack > 0
          ? `+${stack} to take`
          : state.direction === 1
            ? "clockwise"
            : "anticlockwise"
      }
    />
  );
}

function turnLabel(view: ChromalyView, state: ChromalyState): string {
  if (state.window !== null) {
    const lone = state.window.offenders[0];
    if (lone !== undefined) {
      return lone === view.viewerSeat ? "You are on one card" : `${view.nameFor(lone)} is on one card`;
    }
    return "Anyone may jump in";
  }
  if (state.pendingDraw !== null || state.challenge !== null) {
    return state.turn === view.viewerSeat ? "Answer or take it" : `${view.nameFor(state.turn)} must answer`;
  }
  return state.turn === view.viewerSeat ? "Your turn" : `${view.nameFor(state.turn)} to play`;
}

/* ============================================================
   The bars
   ============================================================ */

const PRIMARY =
  "min-w-0 shrink-0 rounded-lg bg-linear-to-b from-brass-300 to-brass-500 px-4 py-2 text-xs font-extrabold text-felt-950 shadow-e2 disabled:opacity-40";
const SECONDARY =
  "shrink-0 rounded-lg bg-bone-50/8 px-3 py-2 text-xs font-extrabold text-bone-200 ring-1 ring-bone-50/16";

/**
 * Somebody is on their last card. The same button for everyone: to say it
 * yourself before you are caught, or to catch whoever has not.
 *
 * Which of the two it is depends only on who presses it, and the band does not
 * say — "you are on one card" is on the turn line, because it is public.
 */
function CallBar({ view, live }: { view: ChromalyView; live: Live }) {
  const state = live.state;
  const w = state.window!;
  const seat = view.viewerSeat;
  return (
    <>
      <span className="min-w-0 shrink truncate text-[10px] font-bold text-brass-300">
        {w.offenders[0] === seat ? "You are on one card" : `${view.nameFor(w.offenders[0]!)} is on one card`}
      </span>
      <CountdownButton
        // Keyed by the window, so each gets a fresh ring rather than a reset
        // written from inside an effect.
        key={w.id}
        ms={state.rules.windowMs}
        onClick={() => live.submitAction({ t: "callLast", seat })}
      >
        CHROMA!
      </CountdownButton>
    </>
  );
}

/** A penalty is on the table: take it, call a bluff on a +4, or answer it with a card. */
function PenaltyBar({ live }: { live: Live }) {
  const state = live.state;
  const amount = state.challenge?.amount ?? state.pendingDraw?.amount ?? 0;
  return (
    <>
      <span className="min-w-0 shrink truncate text-[10px] font-bold text-bone-300">
        {state.rules.stacking === "off" ? `+${amount}` : `+${amount} — stack it or take it`}
      </span>
      {state.challenge ? (
        <motion.button type="button" onClick={() => live.submitAction({ t: "challenge" })} className={SECONDARY}>
          Challenge
        </motion.button>
      ) : null}
      <motion.button type="button" onClick={() => live.submitAction({ t: "acceptPenalty" })} className={PRIMARY}>
        Take {amount}
      </motion.button>
    </>
  );
}

/** A card was just drawn and can be played: play it, or keep it. */
function DrawnBar({ live, onPlay }: { live: Live; onPlay: (id: PieceId) => void }) {
  const state = live.state;
  const drawn = state.drawn!;
  const mustPlay = state.rules.forcePlay;
  return (
    <>
      <span className="min-w-0 shrink truncate text-[10px] font-bold text-bone-300">
        You drew {cardLabel(drawn)}
      </span>
      {mustPlay ? null : (
        <motion.button type="button" onClick={() => live.submitAction({ t: "keep" })} className={SECONDARY}>
          Keep
        </motion.button>
      )}
      <motion.button type="button" onClick={() => onPlay(drawn)} className={PRIMARY}>
        Play it
      </motion.button>
    </>
  );
}

/** Your turn: draw, say your last card on two, play the pair you picked up. */
function TurnBar({
  view,
  live,
  held,
  onClearHeld,
}: {
  view: ChromalyView;
  live: Live;
  held: PieceId[];
  onClearHeld: () => void;
}) {
  const state = live.state;
  const seat = view.viewerSeat;
  const hand = state.hands[seat] ?? [];
  const mayCall = hand.length === 2 && state.calls[seat] === undefined;
  return (
    <>
      {held.length === 0 ? (
        <span className="min-w-0 shrink truncate text-[10px] font-bold text-bone-300">
          {mayCall ? "Say it, then play" : "Play a card, or draw"}
        </span>
      ) : null}
      {held.length > 0 ? (
        <>
          <button type="button" onClick={onClearHeld} className={SECONDARY}>
            Clear
          </button>
          <motion.button
            type="button"
            onClick={() => {
              // Pairs only: a single is played by its tap. Refused here with
              // the reason, not silently, if it does not go together.
              if (held.length >= 2 && !legalDoubles(state, seat, held)) {
                announce("Those do not go together", "bad");
                return;
              }
              if (sendPlay(view, live, [...held])) onClearHeld();
            }}
            className={PRIMARY}
          >
            {held.length === 1 ? "Play" : `Play ${held.length}`}
          </motion.button>
        </>
      ) : null}
      {mayCall ? (
        <motion.button
          type="button"
          // Pops in, loud: this is the one thing on the bar that is easy to
          // miss and costs two cards.
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: [0.4, 1.18, 1], opacity: 1 }}
          transition={{ duration: 0.42, times: [0, 0.55, 1], ease: "easeOut" }}
          onClick={() => live.submitAction({ t: "callLast", seat })}
          className="shrink-0 rounded-full bg-linear-to-b from-brass-300 to-brass-500 px-5 py-2 font-display text-sm font-extrabold tracking-wide text-felt-950 shadow-e2"
        >
          CHROMA!
        </motion.button>
      ) : null}
      {held.length === 0 ? (
        <motion.button type="button" onClick={() => live.submitAction({ t: "draw" })} className={SECONDARY}>
          Draw
        </motion.button>
      ) : null}
    </>
  );
}

/* ============================================================
   The two choices a card can ask for
   ============================================================ */

/**
 * The colour a wild is to name, or the seat a 7 is to swap with. A panel, not
 * a modal: it is the player's own decision, it is small, and the hand stays in
 * view under it (POLICY.md rung 1).
 */
function ChoicePanel({
  view,
  live,
  held,
  choice,
  onClearHeld,
}: {
  view: ChromalyView;
  live: Live;
  held: PieceId[];
  choice: "colour" | "swap";
  onClearHeld: () => void;
}) {
  const state = live.state;
  const id = held[0]!;
  const done = (extra: { color?: Color; swapWith?: SeatId }) => {
    if (sendPlay(view, live, [id], extra)) onClearHeld();
  };
  const others = Array.from({ length: state.seats }, (_, s) => s as SeatId).filter(
    (s) => s !== view.viewerSeat,
  );
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-2 rounded-2xl bg-felt-950/88 px-3 py-3 ring-1 ring-brass-400/30 backdrop-blur-sm">
      <span className="text-[11px] font-bold tracking-wide text-bone-300 uppercase">
        {choice === "colour" ? "Name a colour" : "Swap hands with"}
      </span>
      {choice === "colour" ? (
        <div className="flex gap-2">
          {COLORS.map((color) => (
            <motion.button
              key={color}
              type="button"
              aria-label={COLOR_NAME[color]}
              whileTap={{ scale: 0.94 }}
              onClick={() => done({ color })}
              className="flex h-12 w-12 items-center justify-center rounded-xl text-lg font-extrabold text-card-face shadow-e2 ring-2 ring-bone-50/70"
              style={{ background: colourVar(color) }}
            >
              {SHAPE_GLYPH[color]}
            </motion.button>
          ))}
        </div>
      ) : (
        <div className="flex max-w-full flex-wrap justify-center gap-2">
          {others.map((seat) => (
            <motion.button
              key={seat}
              type="button"
              whileTap={{ scale: 0.96 }}
              onClick={() => done({ swapWith: seat })}
              className={SECONDARY}
            >
              {view.nameFor(seat)} · {(state.hands[seat] ?? []).length}
            </motion.button>
          ))}
        </div>
      )}
      <button type="button" onClick={onClearHeld} className="text-[11px] font-bold text-bone-400 hover:text-bone-200">
        Cancel
      </button>
    </div>
  );
}

function colourVar(color: Color): string {
  return `var(--color-chroma-${{ R: "red", Y: "yellow", G: "green", B: "blue" }[color]})`;
}

/* ============================================================
   GameHost slots
   ============================================================ */

function seatName(view: ChromalyView, seat: SeatId): string {
  return seat === view.viewerSeat ? "You" : view.nameFor(seat);
}

function seatColour(view: ChromalyView, seat: SeatId): string {
  return seat === view.viewerSeat ? "var(--color-brass-300)" : view.colourFor(seat);
}

/** A pod's numbers: cards still to get rid of, and points taken. */
function seatStats(state: ChromalyState, seat: SeatId): SeatStat[][] {
  return [
    [{ label: "Cards", value: (state.hands[seat] ?? []).length }],
    [{ label: "Points", value: state.scores[seat] ?? 0 }],
  ];
}

/** Whose play is open to answer right now, if any. */
function playedSeat(state: ChromalyState): SeatId | null {
  return state.window?.by ?? null;
}

/**
 * The seat the "…is thinking" line names (`GameHostProps.turnSeat`). Through a
 * window that is the player whose play it is - the seat the pods keep lit -
 * not whoever the answering queue happens to be waiting on, which would walk
 * from pod to pod and show which of them were eligible.
 */
export function turnSeat(state: ChromalyState, live: Live): SeatId | null {
  return playedSeat(state) ?? live.currentSeat;
}

export function playerViews(view: ChromalyView, state: ChromalyState, live: Live): SeatView[] {
  const out: SeatView[] = [];
  const by = playedSeat(state);
  // Letting a play go shows nothing, so the seat whose answer closed a window
  // has no turn on show; the table is on whoever plays next.
  const letGo = live.lastAction?.action.t === "declineWindow";
  const cueFor = (seat: SeatId) =>
    by !== null
      ? { active: seat === by, thinking: false }
      : letGo
        ? { active: seat === live.currentSeat, thinking: false }
        : seatCue(live, seat);
  // Every seat but the VIEWER's own, counted from 0: the two are the same
  // thing only while the viewer is seat 0, and online they are not.
  for (let i = 0; i < state.seats; i++) {
    const seat = i as SeatId;
    if (seat === view.viewerSeat) continue;
    const cue = cueFor(seat);
    out.push({
      seat,
      name: view.nameFor(seat),
      colour: view.colourFor(seat),
      stats: seatStats(state, seat),
      // Said out loud, so it is public: the pod keeps it until the seat is
      // back above one card.
      status: state.calls[seat] === "called" ? "CHROMA!" : undefined,
      active: cue.active,
      thinking: cue.thinking,
      winning: state.result?.winner === seat,
      away: view.awayFor?.(seat) ?? false,
      bot: view.botFor?.(seat) ?? false,
    });
  }
  return out;
}

export function standings(view: ChromalyView, state: ChromalyState, _live: Live, seats: SeatView[]) {
  const nameOf = (seat: SeatId) =>
    seat === view.viewerSeat ? "You" : (seats.find((s) => s.seat === seat)?.name ?? view.nameFor(seat));
  return Array.from({ length: state.seats }, (_, i) => {
    const seat = i as SeatId;
    return { seat, name: nameOf(seat), total: state.scores[seat] ?? 0 };
  }).sort((a, b) => b.total - a.total);
}

export function statsFor(view: ChromalyView, state: ChromalyState): Array<{ label: string; value: string }> {
  const rows = [
    { label: "Round", value: `${state.round}` },
    { label: "To win", value: `${state.rules.target}` },
  ];
  // A spectator has no hand, so a hand count would be a zero that means
  // nothing rather than a fact about anybody.
  if (isSeated(view, state)) {
    rows.push({ label: "Your cards", value: `${(state.hands[view.viewerSeat] ?? []).length}` });
  }
  return rows;
}

export function roundSummary(view: ChromalyView, state: ChromalyState) {
  const result = state.result;
  if (!result) return null;

  const rows: ScoreRow[] = Array.from({ length: state.seats }, (_, i) => {
    const seat = i as SeatId;
    const left = result.cardsLeft[seat] ?? 0;
    const worth = (state.hands[seat] ?? []).reduce((n, id) => n + points(id), 0);
    return {
      seat,
      name: seatName(view, seat),
      colour: seatColour(view, seat),
      detail: left === 0 ? "went out" : `${left} card${left === 1 ? "" : "s"} left · ${worth} points`,
      delta: result.deltas[seat] ?? 0,
      total: state.scores[seat] ?? 0,
    };
  });

  const note = result.blocked
    ? ({
        tone: "warn",
        title: "Nobody could get out",
        body: "The round ran too long without anyone going out, so it went to the shortest hand — and scored nothing.",
      } as const)
    : undefined;

  const won = result.winner === view.viewerSeat;
  return {
    title: won ? "You take the round" : `${view.nameFor(result.winner)} takes the round`,
    rows,
    note,
    target: state.rules.target,
  };
}

export function pendingLabel(view: ChromalyView, state: ChromalyState, seat: SeatId): string {
  if (state.window?.pending.some((p) => p.seat === seat)) return `${view.nameFor(seat)} pending — answering`;
  return `${view.nameFor(seat)} pending — playing`;
}
