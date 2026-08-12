"use client";

/**
 * Drives any `GameDefinition` end to end. This is the piece the
 * foundation was always missing: `useChoreographer` plays events,
 * `applyEvent`/`store` hold placements, but nothing decided WHEN to call
 * `reduce`, whether the current seat is a bot or the hero, or when a
 * bot's `think` delay should give way to its actual move. LRC is the
 * first game to need it; every game after this one reuses it unchanged.
 *
 * The pacing rule that makes multi-bot turns feel sequential rather than
 * instant: a bot's turn is only ever computed from the choreographer's
 * `onIdle` callback — i.e. once the PREVIOUS turn has finished
 * animating, not the instant its state update lands. `reduce` itself is
 * synchronous and cheap, so nothing stops the engine from computing an
 * entire game in a tight loop; onIdle is what paces that out to match
 * what the player is actually watching.
 *
 * State lives in BOTH useState and a ref, updated together, and that is
 * deliberate, not redundant. `useState` is what this hook's render-time
 * return value is built from — React forbids reading a ref's `.current`
 * during render. But `useChoreographer.push` can call `onIdle`
 * SYNCHRONOUSLY, in the same tick as the `setState` that just preceded
 * it, whenever a batch has only one event (see that hook's `drain`) —
 * before React has committed and re-rendered, which means a closure
 * capturing `state` from the render that scheduled the update is already
 * stale by the time onIdle runs. That exact bug shipped once already:
 * a bot's turn would silently never trigger, because the stale closure
 * still saw the hero's turn. The ref is what `onIdle` actually reads —
 * always current, because it's written synchronously, in the same
 * statement as the `setState` call, not on React's schedule.
 */

import { useEffect, useRef, useState } from "react";
import type { BotDifficulty, GameDefinition, PieceMeta, PieceId, SeatId } from "@/engine/types";
import { HERO } from "@/engine/types";
import { createRng, randomSeed, type Rng } from "@/engine/rng";
import { useChoreographer } from "@/motion/useChoreographer";
import { applyEventToTable } from "./applyEvent";
import { useTableStore } from "./store";

export interface GameRuntimeOptions {
  seats: number;
  /** Omit for a fresh random game; pass a fixed value to replay one exactly. */
  seed?: number;
  /** Per-seat bot difficulty. Seat 0 (hero) is ignored. Defaults to "steady". */
  difficulty?: BotDifficulty[];
  /** 1 = designed pace. Forwarded to useChoreographer. */
  speed?: number;
}

export interface GameRuntime<S, A> {
  /** Hero-redacted view of the live state, updated after every settle. */
  state: S;
  isHeroTurn: boolean;
  isOver: boolean;
  winner: SeatId | null;
  /** True whenever it is not the hero's turn to act — bots thinking,
   * animation still playing, or the game hasn't started resolving yet. */
  busy: boolean;
  /** Call with the hero's chosen action. Bot turns are handled internally. */
  submitAction: (action: A) => void;
  /** The runtime's own persistent rng. A human path needing randomness
   * (LRC's "Roll" button) resolves it here, exactly like a bot's
   * `choose(state, seat, rng)` does — see games/lrc/types.ts for why
   * this keeps `reduce` itself pure. */
  rng: Rng;
  /** Instantly finishes any in-flight animation. Exposed for a "skip"
   * affordance; most screens won't need it. */
  skip: () => void;
  /** The most recently applied action and who took it — e.g. LRC's play
   * screen reads `lastAction.action.dice` to show what was rolled.
   * Generic on purpose: any game can show "what just happened" without
   * a bespoke event just for its own UI. */
  lastAction: { seat: SeatId; action: A } | null;
}

function difficultyFor(seat: SeatId, table?: BotDifficulty[]): BotDifficulty {
  return table?.[seat] ?? "steady";
}

export function useGameRuntime<S, A>(
  definition: GameDefinition<S, A>,
  opts: GameRuntimeOptions,
): GameRuntime<S, A> {
  // Each a one-time, render-safe computation via useState's lazy
  // initializer — never touched again through its setter, just a way
  // to get a stable value without reading/writing a ref during render.
  const [rng] = useState<Rng>(() => createRng(opts.seed ?? randomSeed()));
  const [state, setState] = useState<S>(() =>
    definition.setup({ seats: opts.seats, rng, difficulty: opts.difficulty }),
  );
  const [pieceMeta] = useState<Record<PieceId, PieceMeta>>(() => definition.pieces(state));
  const [lastAction, setLastAction] = useState<{ seat: SeatId; action: A } | null>(null);

  // See the file-level comment: written synchronously alongside every
  // setState call below, never during render. This is what onIdle and
  // submitAction actually read from.
  const stateRef = useRef(state);
  const setGameState = (next: S) => {
    stateRef.current = next;
    setState(next);
  };

  const reconcileAndAdvance = () => {
    const current = stateRef.current;

    // Self-correcting reconciliation: whatever the choreographer just
    // finished animating, the true board is always this. A missed or
    // malformed event heals here instead of desyncing permanently.
    useTableStore.getState().reset(definition.placements(current, HERO), pieceMeta);

    if (definition.isOver(current)) return;

    const seat = definition.currentSeat(current);
    if (seat === null || seat === HERO) return; // Hero's turn — wait for input.

    // A bot's turn: compute it now, but let the choreographer pace the
    // reveal. `think` rides first in the same batch, so playback waits
    // out that beat before the move events actually animate.
    const bot = definition.bots[difficultyFor(seat, opts.difficulty)];
    const thinkMs = bot.thinkMs(current, seat, rng);
    const action = bot.choose(current, seat, rng);
    const { state: next, events } = definition.reduce(current, action);
    setGameState(next);
    setLastAction({ seat, action });
    choreographer.push([{ t: "think", seat, ms: thinkMs }, ...events]);
  };

  // A stable callback is fine here — reconcileAndAdvance always reads
  // stateRef.current fresh, so it doesn't matter whether useChoreographer
  // fires this synchronously (same tick as the state update that
  // preceded it) or asynchronously (well after this render committed).
  const choreographer = useChoreographer({
    apply: applyEventToTable,
    onIdle: reconcileAndAdvance,
    speed: opts.speed,
  });

  // Kick off the very first turn once, after the table has had a chance
  // to mount with the initial placements (avoids racing the store).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    useTableStore.getState().reset(definition.placements(stateRef.current, HERO), pieceMeta);
    reconcileAndAdvance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitAction = (action: A) => {
    const seat = definition.currentSeat(stateRef.current);
    if (seat !== HERO) return; // Not the hero's turn — ignore.
    const { state: next, events } = definition.reduce(stateRef.current, action);
    setGameState(next);
    setLastAction({ seat, action });
    if (events.length > 0) {
      choreographer.push(events);
    } else {
      // A hero action can legitimately produce zero visual events (LRC:
      // rolling all dots moves nothing). useChoreographer.push bails out
      // immediately on an empty array without ever calling onIdle, so
      // nothing would advance the game past this point — the bot path
      // doesn't hit this because it always prepends a `think` event,
      // but the hero's own move has nothing playing that role. Calling
      // reconcileAndAdvance directly is safe here specifically because
      // it reads stateRef.current rather than a closed-over value, so
      // there's no staleness risk to firing it synchronously.
      reconcileAndAdvance();
    }
  };

  const currentSeat = definition.currentSeat(state);
  const isOver = definition.isOver(state);

  return {
    state: definition.playerView(state, HERO),
    isHeroTurn: !isOver && currentSeat === HERO && !choreographer.isPlaying,
    isOver,
    winner: isOver ? extractWinner(state) : null,
    busy: choreographer.isPlaying || (!isOver && currentSeat !== HERO),
    submitAction,
    rng,
    skip: choreographer.skip,
    lastAction,
  };
}

/**
 * `isOver`/`currentSeat` are the only two required signals a
 * GameDefinition must expose; "who won" isn't part of the contract
 * since not every game has a single winner. Games that do (LRC does)
 * put it on their own state — this just reads it back structurally
 * rather than requiring every GameDefinition to add a `winner` method
 * for the one game that currently needs it.
 */
function extractWinner<S>(state: S): SeatId | null {
  const maybe = state as unknown as { winner?: SeatId | null };
  return typeof maybe.winner === "number" ? maybe.winner : null;
}
