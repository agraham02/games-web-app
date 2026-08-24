"use client";

/**
 * A server-driven table, wearing `GameRuntime`'s clothes.
 *
 * This returns the same 22-field object `useGameRuntime` does, which is the
 * entire trick: `GameHost`, `SeatRing`, `PieceLayer`, the phase screens and
 * every game's own play screen consume that interface and none of them need
 * to know whether the game is being decided in this tab or on a server.
 *
 * What it does NOT do is decide anything. Offline, the hook owns the rng,
 * runs the bots and paces the turns; here all three live on the server and
 * this is a renderer. The three fields that cannot be honestly answered
 * from a frame are documented individually below rather than quietly
 * faked — a wrong answer there would be a rules bug wearing a UI bug's
 * clothes.
 *
 * The pacing seam is unchanged and is the reason this fits at all: frames
 * carry an event list, the choreographer plays it, and `onIdle` reconciles
 * the board. Offline, `onIdle` also decides what happens next; here it does
 * not, because the next frame is already on its way.
 */

import { useEffect, useRef, useState } from "react";
import type { GameEvent, SeatId } from "@/engine/types";
import { createRng, type Rng } from "@/engine/rng";
import { useChoreographer } from "@/motion/useChoreographer";
import { prefersReducedMotion } from "@/motion/presets";
import type { FrameView } from "@/session/protocol";
import { announce } from "@/ui/disclosure";
import { composeAnnounce } from "@/session/announce";
import { applyEventToTable } from "@/table/applyEvent";
import { useTableStore } from "@/table/store";
import type { GameRuntime } from "@/table/useGameRuntime";

/**
 * How many frames may pile up before the client stops watching history and
 * jumps to the present.
 *
 * This is the client half of "a slow connection must not spoil the game for
 * anyone else". The server never waits, so a tab that was backgrounded, or
 * on a bad link, comes back to a queue. Playing it out would mean watching
 * three turns of catch-up while everybody else is live; skipping to the
 * newest frame costs a few animations and lands on the current board, which
 * is the one thing that actually matters.
 */
const CATCH_UP_FRAMES = 2;

const DEFAULT_END_HOLD_MS = 1200;
const DEFAULT_ROUND_HOLD_MS = 1000;
const ROUND_INTRO_HOLD_MS = 3000;

/**
 * Composing needs to know who is watching, which changes per room — so
 * unlike the offline runtime's module-level version, this is built per
 * frame from the seat names the server sent with it.
 */
function surfaceEventFor(frame: FrameView) {
  return (event: GameEvent): void => {
    if (event.t === "announce") {
      announce(
        composeAnnounce(event, frame.seat, (seat) => frame.seatNames[seat] ?? `Seat ${seat + 1}`),
        event.tone,
      );
    }
    applyEventToTable(event);
  };
}

export interface OnlineRuntimeOptions {
  /** The newest frame, or null when no game is running. */
  frame: FrameView | null;
  /** Sends a move. The server decides whether it was legal. */
  submit: (action: unknown) => void;
  /** Asks for the next round to be dealt. */
  nextRound: () => void;
  speed?: number;
  dealStaggerMs?: number;
}

export function useOnlineRuntime<S, A>(opts: OnlineRuntimeOptions): GameRuntime<S, A> | null {
  const { frame } = opts;

  const [applied, setApplied] = useState<FrameView | null>(null);
  const [dealingRound, setDealingRound] = useState<number | null>(null);
  const [gameEndRevealed, setGameEndRevealed] = useState(false);
  const [roundEndRevealed, setRoundEndRevealed] = useState(false);

  /** The frame currently animating, and any newer one that arrived meanwhile. */
  const playing = useRef<FrameView | null>(null);
  const queued = useRef<FrameView[]>([]);
  const endHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roundHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A local generator, for the one thing it is still allowed to do: a
  // game's own UI that wants a cosmetic random. It decides NOTHING —
  // anything that affects an outcome is resolved on the server, because a
  // client that rolls its own dice is a client that can choose them.
  const [rng] = useState<Rng>(() => createRng(1));

  const settle = () => {
    const current = playing.current;
    if (!current) return;
    setApplied(current);
    useTableStore.getState().reset(current.placements, current.meta);

    if (current.isOver) {
      const delay = prefersReducedMotion() ? 0 : DEFAULT_END_HOLD_MS;
      endHoldTimer.current = setTimeout(() => setGameEndRevealed(true), delay);
    } else if (current.isRoundOver) {
      const delay = prefersReducedMotion() ? 0 : DEFAULT_ROUND_HOLD_MS;
      roundHoldTimer.current = setTimeout(() => setRoundEndRevealed(true), delay);
    }

    playing.current = null;
    pump();
  };

  // Read through a ref so the resolver always matches the frame being
  // played, without rebuilding the choreographer (and losing its queue)
  // every time a frame lands.
  const applyRef = useRef<(event: GameEvent) => void>(applyEventToTable);
  // Declared BEFORE the frame effect below, and that ordering is
  // load-bearing: effects run in declaration order, so on the commit that
  // delivers a frame this is current before `pump` pushes its events into
  // the choreographer and the first one is applied.
  useEffect(() => {
    applyRef.current = frame ? surfaceEventFor(frame) : applyEventToTable;
  });

  const choreographer = useChoreographer({
    apply: (event) => applyRef.current(event),
    onIdle: settle,
    speed: opts.speed,
    dealStaggerMs: opts.dealStaggerMs,
  });

  /** Starts the next queued frame, catching up first if we are behind. */
  const pump = () => {
    if (playing.current) return;
    const backlog = queued.current;
    if (backlog.length === 0) return;

    if (backlog.length > CATCH_UP_FRAMES) {
      // Everything but the newest is history nobody is waiting to watch.
      // Its placements are superseded by the frame we are about to apply,
      // which is a whole snapshot — so dropping them loses position, not
      // truth.
      backlog.splice(0, backlog.length - 1);
      choreographer.skip();
    }

    const next = backlog.shift()!;
    playing.current = next;
    if (next.dealtRound !== null) setDealingRound(next.dealtRound);
    if (next.isRoundOver === false) setRoundEndRevealed(false);

    if (next.events.length > 0) choreographer.push(next.events);
    // A position rather than a step — a reconnect, or entering a running
    // game. There is nothing to animate; adopt it and move on.
    else settle();
  };

  useEffect(() => {
    if (!frame) return;
    queued.current.push(frame);
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame]);

  // Same shape as the offline runtime's: a dependency effect, so
  // StrictMode's mount -> cleanup -> mount becomes schedule -> cancel ->
  // reschedule rather than leaving the intro stuck on screen.
  useEffect(() => {
    if (dealingRound === null) return;
    const delay = prefersReducedMotion() ? 0 : ROUND_INTRO_HOLD_MS;
    const t = setTimeout(() => setDealingRound(null), delay);
    return () => clearTimeout(t);
  }, [dealingRound]);

  useEffect(() => {
    return () => {
      if (endHoldTimer.current !== null) clearTimeout(endHoldTimer.current);
      if (roundHoldTimer.current !== null) clearTimeout(roundHoldTimer.current);
    };
  }, []);

  if (!applied) return null;

  const mySeat = applied.seat;
  const myTurn = mySeat !== null && applied.currentSeat === mySeat;

  return {
    state: applied.state as S,
    // Identical to `state`, and that is the honest answer: the unredacted
    // state exists only on the server. The dev state editor is offline-only
    // for exactly this reason — there is nothing here it could edit that
    // the server would honour.
    rawState: applied.state as S,
    replaceState: () => {
      /* Server-authoritative. Nothing a client wrote here would survive. */
    },
    isHeroTurn: myTurn && !applied.isOver && !choreographer.isPlaying,
    isOver: applied.isOver,
    winner: applied.winner,
    winningSeats: applied.winningSeats,
    roundWinner: applied.isOver ? null : applied.roundWinner,
    roundWinningSeats: applied.isOver ? null : applied.roundWinningSeats,
    showSummary: applied.isOver && gameEndRevealed,
    showRoundSummary: !applied.isOver && applied.isRoundOver && roundEndRevealed,
    round: applied.round,
    dealingRound,
    nextRound: opts.nextRound,
    autoAdvance: true,
    busy: choreographer.isPlaying || !myTurn,
    submitAction: (action) => opts.submit(action),
    rng,
    skip: choreographer.skip,
    // Withheld by the server when the action names a piece this viewer
    // may not identify — see `safeLastAction`.
    lastAction: applied.lastAction as { seat: SeatId; action: A } | null,
    // Both meaningless here: the server owns the clock, so there is never a
    // turn sitting locally waiting to be revealed.
    pendingReveal: false,
    advance: () => {},
  } satisfies GameRuntime<S, A> as GameRuntime<S, A>;
}

/** Convenience for a component that only needs to know where it is sitting. */
export function viewerSeatOf(frame: FrameView | null): SeatId | null {
  return frame ? frame.seat : null;
}
