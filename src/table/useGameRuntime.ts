"use client";

/**
 * Drives any `GameDefinition` end to end, from React.
 *
 * The progression half of this hook — dealing, reducing, running bots,
 * deciding whose turn is next — now lives in `GameSession`, which has no
 * React in it and runs identically in a Node server. What is left here is
 * the half that only makes sense in a browser:
 *
 *  - the choreographer, which turns a batch of events into motion
 *  - the placement store reconcile at the end of every batch
 *  - the two holds that gate when a round or game SUMMARY may appear,
 *    which are pacing for a watching human and nothing to do with rules
 *  - publishing state to React on the right schedule
 *
 * The division is worth stating precisely, because it is easy to put a
 * thing on the wrong side: the session decides WHAT happens next, and the
 * driver decides WHEN it is allowed to. That is why `settled()` is a call
 * this hook makes rather than something the session does for itself. The
 * pacing rule it preserves is the one this file has always had — a bot's
 * turn is computed only once the PREVIOUS turn has finished animating,
 * not the instant its state update lands. `reduce` is synchronous and
 * cheap, so nothing stops a whole match resolving in a tight loop; the
 * choreographer's `onIdle` is what paces it out to what a player is
 * actually watching. A server has no animation to wait for and settles
 * the moment it has broadcast, so the same session code paces a browser
 * off motion and a server off its clock.
 *
 * `GameSession` owns the authoritative state, which is what retired the
 * `stateRef`/`useState` pair this file used to carry. The reason for that
 * pair still applies and is now the session's: `useChoreographer.push`
 * can call `onIdle` SYNCHRONOUSLY, in the same tick as the `setState`
 * before it, whenever a batch holds a single event — so a closure reading
 * React state would be stale by the time onIdle ran. Reading
 * `session.snapshot()` is always current, because the session writes it
 * synchronously the moment a move is decided, on nobody's schedule but
 * its own.
 */

import { useEffect, useRef, useState } from "react";
import type { BotDifficulty, GameDefinition, GameEvent, SeatId } from "@/engine/types";
import { HERO } from "@/engine/types";
import type { Rng } from "@/engine/rng";
import { useChoreographer } from "@/motion/useChoreographer";
import { prefersReducedMotion } from "@/motion/presets";
import { announce } from "@/ui/disclosure";
import {
  DEFAULT_TURN_HOLD_MS,
  GameSession,
  type SessionFrame,
} from "@/session/GameSession";
import {
  extractRound,
  extractRoundWinner,
  extractWinner,
  resolveRoundWinningSeats,
  resolveWinningSeats,
} from "@/session/structural";
import { applyEventToTable } from "./applyEvent";
import { useTableStore } from "./store";

/**
 * Re-exported from its new home so the existing test keeps its import
 * path. The function is pure and answers a question the server needs too,
 * which is why it moved to `src/session/structural.ts` with its siblings.
 */
export { resolveRoundWinningSeats };

/**
 * Dead air between the WINNING move settling and GameEndSummary actually
 * appearing. Before this existed the gap was zero: `isOver` published the
 * instant the last move's animation finished, so the summary could cover
 * the table in the same tick the board first showed who won — no time to
 * read the final board, let alone see a winner call-out on their pod.
 * Deliberately its own number, not reused from the turn hold: reading
 * "the game just ended" plainly deserves more beat than "the next player
 * is up."
 */
const DEFAULT_END_HOLD_MS = 1200;

/**
 * Dead air between a ROUND ending and its scorecard appearing. Same
 * reasoning as DEFAULT_END_HOLD_MS — the last tile of a round is often the
 * most interesting one on the table, and covering it instantly with a
 * panel of numbers throws it away — but shorter, because a round ending is
 * a punctuation mark and a match ending is a full stop.
 */
const DEFAULT_ROUND_HOLD_MS = 1000;

/**
 * How long the "Round N" title card (`RoundIntro`) stays up over the
 * opening deal — a fixed hold, deliberately NOT tied to how long that
 * round's deal actually takes to animate. It is a brief announcement
 * layered over the deal, not a mask for the whole thing.
 */
const ROUND_INTRO_HOLD_MS = 3000;

/**
 * Events the table itself cannot show. `applyEventToTable` deliberately
 * only knows about placements, so without this an `announce` fell straight
 * through its `default:` and was silently dropped. It lives here rather
 * than in applyEvent because this hook is where engine events meet the UI,
 * and applyEvent should stay a pure placement reducer.
 */
function surfaceEvent(event: GameEvent): void {
  if (event.t === "announce") announce(event.text, event.tone);
  applyEventToTable(event);
}

export interface GameRuntimeOptions {
  seats: number;
  /** Omit for a fresh random game; pass a fixed value to replay one exactly. */
  seed?: number;
  /** Per-seat bot difficulty. Seat 0 (hero) is ignored. Defaults to "steady". */
  difficulty?: BotDifficulty[];
  /** 1 = designed pace. Forwarded to useChoreographer. */
  speed?: number;
  /** Dev/debug affordance, default true. When false, a bot's turn is
   * still computed the instant it's reachable (so `pendingReveal`
   * becomes true and the dev can inspect exactly what it will roll and
   * against what chip count) but is never auto-revealed — the caller
   * must call `advance()` to step it forward one turn at a time. Built
   * for verifying pacing and rules turn-by-turn without bots racing
   * ahead of what a human can actually watch. */
  autoAdvance?: boolean;
  /** Dead air between one turn settling and the next being revealed. */
  turnHoldMs?: number;
  /** See DEFAULT_END_HOLD_MS. Defaults to it if omitted. */
  endHoldMs?: number;
  /** See DEFAULT_ROUND_HOLD_MS. Defaults to it if omitted. */
  roundHoldMs?: number;
  /** See `ChoreographOptions.dealStaggerMs`. Forwarded to useChoreographer. */
  dealStaggerMs?: number;
}

export interface GameRuntime<S, A> {
  /** Hero-redacted view of the live state, updated after every settle. */
  state: S;
  isHeroTurn: boolean;
  /** True the instant the engine says the game is over — gates real
   * behavior (stops bot turns, disables the hero's own controls). NOT
   * gated by endHoldMs; use `showSummary` for the UI reveal, which is. */
  isOver: boolean;
  /** Known as soon as `isOver` is — deliberately NOT held back the way
   * `showSummary` is, so a per-seat "winner" treatment (SeatRing's
   * crown) can start the moment the board itself shows who won, with
   * GameEndSummary catching up a beat later. */
  winner: SeatId | null;
  /** The just-finished ROUND's winner — same "public immediately, not
   * held back for the summary" pacing as `winner`, but for a round
   * instead of the match. A multi-round game's real, frequent "someone
   * won" moment is a round ending (Dominoes: going out), not the match
   * (which can take many rounds to reach a target score) — so SeatRing's
   * crown and HeroWinFlourish's confetti key off `winner ?? roundWinner`,
   * not `winner` alone. Null whenever `winner` is non-null: the last
   * round of a match is both, and the match-level treatment takes over
   * then. */
  roundWinner: SeatId | null;
  /**
   * Every seat on the side that won the just-finished ROUND — the
   * round-level twin of `winningSeats`, and the same fallback shape:
   * reads `state.result.winningSeats` if the game sets it, otherwise
   * wraps `roundWinner`. So a game that never sets the field produces an
   * IDENTICAL truth table to `=== roundWinner`, which is every existing
   * game.
   *
   * This did not exist until Caribbean dominoes' team mode — a partner
   * going out wins the round for both of you — and without it the crown
   * and the confetti would land on whichever partner happened to lay the
   * last tile.
   */
  roundWinningSeats: SeatId[] | null;
  /**
   * Every seat on the winning side, known the same instant `winner` is.
   * For a single-winner game this is just `[winner]` (or `null`) — the
   * field exists for PARTNERSHIP games (Spades: a team win is two seats,
   * not one), where `winner` alone can only ever crown one of them.
   * Structural, like `winner` — reads `state.winningSeats` if the game
   * sets it; falls back to wrapping `winner` for every game that doesn't,
   * so `winningSeats?.includes(seat)` is a drop-in replacement for
   * `winner === seat` everywhere it matters, with IDENTICAL behavior.
   */
  winningSeats: SeatId[] | null;
  /** True only after `isOver` AND the endHoldMs pause has elapsed — this
   * is what should gate GameEndSummary's `show`, not `isOver` itself. */
  showSummary: boolean;
  /** The round-level equivalent of `showSummary`: true once the round's
   * final move has finished animating AND roundHoldMs has elapsed. Gate
   * a round scorecard on this, never on the definition's `isRoundOver`,
   * which flips the instant `reduce` runs. */
  showRoundSummary: boolean;
  /** 1-based round number, for a scorecard's heading. */
  round: number;
  /**
   * Non-null for a fixed hold right as a round's deal is DISPATCHED —
   * NOT derived from `round` above, which only publishes once that deal's
   * entire animation has finished. Gate a `RoundIntro` on
   * `dealingRound !== null`, not on watching `round` change. Carries the
   * round number the incoming deal is FOR, so the intro doesn't have to
   * wait a beat behind it either.
   */
  dealingRound: number | null;
  /**
   * The UNREDACTED state. `state` above is `playerView(state, HERO)`,
   * which is what every game screen should read — this exists for the dev
   * state editor, which has to edit what is actually there rather than the
   * hero's redacted picture of it.
   */
  rawState: S;
  /** DEV ONLY — see the implementation's own doc. */
  replaceState: (next: S) => void;
  /** Deals the next round and clears the scorecard. No-op unless a round
   * is actually over. Wire this to the scorecard's continue button. */
  nextRound: () => void;
  /** Whether bot turns are currently auto-revealing on their own pace
   * (true) or sitting pending until `advance()` is called (false) — the
   * resolved value of `GameRuntimeOptions.autoAdvance`. A revealed turn's
   * OWN animation never depends on this; it's exposed purely as read-only
   * state for a game's own UI, e.g. to label what mode the DevPanel toggle
   * is currently in. */
  autoAdvance: boolean;
  /** True whenever it is not the hero's turn to act — bots thinking,
   * animation still playing, or the game hasn't started resolving yet. */
  busy: boolean;
  /** Call with the hero's chosen action. Bot turns are handled internally. */
  submitAction: (action: A) => void;
  /** The runtime's own persistent rng. A human path needing randomness
   * (LRC's "Roll" button) resolves it here, exactly like a bot's
   * `choose(state, seat, rng)` does. */
  rng: Rng;
  /** Instantly finishes any in-flight animation. Exposed for a "skip"
   * affordance; most screens won't need it. */
  skip: () => void;
  /** The most recently applied action and who took it — e.g. LRC's play
   * screen reads `lastAction.action.dice` to show what was rolled.
   * Generic on purpose: any game can show "what just happened" without a
   * bespoke event just for its own UI. */
  lastAction: { seat: SeatId; action: A } | null;
  /** True when a bot's turn has been computed and is waiting to be
   * revealed — either the ordinary turn-hold pause, or (with
   * `autoAdvance: false`) indefinitely until `advance()` is called. */
  pendingReveal: boolean;
  /** Reveals the currently pending bot turn right now. A no-op if nothing
   * is pending. In normal (autoAdvance) play this just fast-forwards the
   * hold pause rather than double-firing the turn — safe to wire to a
   * "skip wait" affordance, not just the dev step button. */
  advance: () => void;
}

export function useGameRuntime<S, A>(
  definition: GameDefinition<S, A>,
  opts: GameRuntimeOptions,
): GameRuntime<S, A> {
  // The live options, for callbacks that outlive the render that made
  // them: the session asks for a turn hold from a timer, long after this
  // render committed, and DevPanel retunes speed between turns.
  const optsRef = useRef(opts);

  // Constructed with only the values that are fixed for the whole game.
  // Where frames GO and how long a hold LASTS are both wired in an effect
  // below instead of closed over here: this initializer runs during
  // render, and reaching into a ref from inside it is exactly the pattern
  // that makes a component quietly fail to update.
  const [session] = useState(
    () =>
      new GameSession<S, A>({
        definition,
        seats: opts.seats,
        seed: opts.seed,
        difficulty: opts.difficulty,
        // Offline single-player: seat 0 is the one human, every other seat
        // is a bot. Online this becomes "is this seat claimed by a
        // connected player", and nothing else about the loop changes.
        isSeatLive: (seat) => seat === HERO,
        autoAdvance: opts.autoAdvance,
      }),
  );

  const pieceMeta = session.pieceMeta();

  const [state, setState] = useState<S>(() => session.snapshot());
  const [lastAction, setLastAction] = useState<{ seat: SeatId; action: A } | null>(null);
  const [hasPending, setHasPending] = useState(false);

  const endHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roundHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // See `GameRuntime.dealingRound` — published as the deal is dispatched,
  // not derived from `state`.
  const [dealingRound, setDealingRound] = useState<number | null>(null);

  // Gates `showSummary`. Resets on a rematch because GameHost remounts
  // this whole hook on a fresh `key`, which is the reset a new game wants.
  const [gameEndRevealed, setGameEndRevealed] = useState(false);
  // The round-level equivalent, cleared by hand because the SAME hook
  // instance lives on into the next round.
  const [roundEndRevealed, setRoundEndRevealed] = useState(false);

  /**
   * Fires once a batch has fully finished animating. Three jobs, on
   * different clocks:
   *
   *  1. Publish right away — reconcile placements (the self-correcting
   *     step: whatever just finished animating IS the true board) and
   *     expose the new `state`/`isOver`/`winner`. The animation already
   *     showed the player this, so there is nothing left to hide, and it
   *     is what lets a per-seat winner treatment start immediately even
   *     though the SUMMARY still waits.
   *  2. If the game or round just ended, hold the summary back — the
   *     winner is already public from step 1, so a pod can be crowned for
   *     that whole pause and the summary catches up after.
   *  3. Otherwise hand back to the session, which decides whether anyone
   *     is owed a turn and schedules it.
   */
  const onIdle = () => {
    const current = session.snapshot();
    setState(current);
    useTableStore.getState().reset(definition.placements(current, HERO), pieceMeta);

    const live = optsRef.current;
    const factor = 1 / Math.max(0.05, live.speed ?? 1);

    if (definition.isOver(current)) {
      const delay = prefersReducedMotion() ? 0 : (live.endHoldMs ?? DEFAULT_END_HOLD_MS) * factor;
      endHoldTimer.current = setTimeout(() => setGameEndRevealed(true), delay);
      return;
    }

    // Checked AFTER isOver: the last round of a match is both, and the
    // match ending is the one the player cares about. Like the game-end
    // branch this schedules no next turn — the round is waiting on the
    // player to continue, not on a bot.
    if (definition.isRoundOver?.(current)) {
      const delay = prefersReducedMotion()
        ? 0
        : (live.roundHoldMs ?? DEFAULT_ROUND_HOLD_MS) * factor;
      roundHoldTimer.current = setTimeout(() => setRoundEndRevealed(true), delay);
      return;
    }

    session.settled();
    setHasPending(session.pendingReveal);
  };

  // A stable callback is fine: onIdle always reads `session.snapshot()`
  // fresh, so it does not matter whether useChoreographer fires it
  // synchronously (same tick as the state update before it) or well after
  // this render committed.
  const choreographer = useChoreographer({
    apply: surfaceEvent,
    onIdle,
    speed: opts.speed,
    dealStaggerMs: opts.dealStaggerMs,
  });

  /** One batch of things the session says happened. */
  const onFrame = (frame: SessionFrame<A>) => {
    setLastAction(frame.lastAction);
    if (frame.dealtRound !== null) setDealingRound(frame.dealtRound);
    setHasPending(session.pendingReveal);
    if (frame.events.length > 0) {
      choreographer.push(frame.events);
    } else {
      // A legal action that moves nothing — Spades' `look`. The
      // choreographer bails on an empty batch without ever calling
      // `onIdle`, so nothing would advance the game past here.
      onIdle();
    }
  };

  // Declared BEFORE the mount effect below, and that ordering is
  // load-bearing: effects run in declaration order, so on the very first
  // commit the session is pointed at `onFrame` before `session.start()`
  // emits the opening deal into it. Re-runs every render so both closures
  // stay current with a live DevPanel.
  useEffect(() => {
    optsRef.current = opts;
    session.setEmit(onFrame);
    session.setTurnHoldResolver(() => {
      const live = optsRef.current;
      if (prefersReducedMotion()) return 0;
      const factor = 1 / Math.max(0.05, live.speed ?? 1);
      return (live.turnHoldMs ?? DEFAULT_TURN_HOLD_MS) * factor;
    });
  });

  // Auto-clears `dealingRound` after its hold — a genuine dependency
  // effect, NOT an imperative ref+setTimeout tucked inside the deal (an
  // earlier version did exactly that, and it broke under StrictMode
  // specifically: the mount effect dealt synchronously, scheduling the
  // clear-timer inside that same effects pass, and the unmount cleanup ran
  // in that same pass too and cancelled it — leaving `dealingRound` stuck
  // non-null forever in dev). A dependency effect has no such gate:
  // StrictMode's mount -> cleanup -> mount becomes schedule -> cancel ->
  // reschedule, which always lands on a live timer.
  useEffect(() => {
    if (dealingRound === null) return;
    // Always a real timer, just a 0ms one under reduced motion: a
    // synchronous setState in an effect body trips React's cascading-render
    // rule, and is not needed — a 0ms timeout still clears on the next
    // tick, which is all "effectively instant" requires.
    const delay = prefersReducedMotion() ? 0 : ROUND_INTRO_HOLD_MS;
    const t = setTimeout(() => setDealingRound(null), delay);
    return () => clearTimeout(t);
  }, [dealingRound]);

  // DevPanel's manual-mode toggle is live between turns, so the session
  // has to hear about it rather than having captured it at construction.
  useEffect(() => {
    session.configure({ autoAdvance: opts.autoAdvance !== false, difficulty: opts.difficulty });
  }, [session, opts.autoAdvance, opts.difficulty]);

  useEffect(() => {
    return () => {
      if (endHoldTimer.current !== null) clearTimeout(endHoldTimer.current);
      if (roundHoldTimer.current !== null) clearTimeout(roundHoldTimer.current);
      // Deliberately `cancelScheduled` and not `dispose`: StrictMode runs
      // mount -> cleanup -> mount against this same session, and a
      // permanent teardown here would hand the second mount a dead loop.
      session.cancelScheduled();
    };
  }, [session]);

  // Kick off the very first turn once, after the table has had a chance to
  // mount with the initial placements (avoids racing the store).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    useTableStore.getState().reset(definition.placements(session.snapshot(), HERO), pieceMeta);
    // `start()` covers both shapes. A game with rounds hasn't dealt yet,
    // so there is nothing to pace until the deal lands and `onIdle` runs
    // at the END of those events; a game that sets up entirely in `setup`
    // has nothing to animate and simply settles. The store is already
    // reconciled on the line above and React state was initialised from
    // the same snapshot, so neither branch has anything left to publish.
    session.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitAction = (action: A) => {
    // The session owns the "is this seat even on turn" check now; an
    // out-of-turn tap is simply refused and nothing is emitted.
    session.submit(HERO, action);
  };

  /**
   * DEV ONLY — replaces the live state wholesale and republishes the table
   * from it, so the dev panel's state editor can put the game into a shape
   * rules-legal play would take minutes to reach (a 20-card hand, a
   * 30-card discard pile).
   *
   * Goes through `onIdle` rather than poking the store directly, so the
   * edited state gets the identical publish-and-then-pace treatment any
   * real action's result would: placements reconcile, and if the edit
   * happens to leave a bot on turn, that turn is scheduled properly
   * instead of the table silently sitting there.
   */
  const replaceState = (next: S) => {
    session.adoptState(next);
    onIdle();
  };

  const nextRound = () => {
    if (roundHoldTimer.current !== null) {
      clearTimeout(roundHoldTimer.current);
      roundHoldTimer.current = null;
    }
    const current = session.snapshot();
    if (!definition.isRoundOver?.(current)) return;
    if (definition.isOver(current)) return;
    // Only the between-rounds path needs these cleared; on mount they
    // already hold exactly these values, which is why the opening deal
    // goes through `session.start()` rather than through here.
    setLastAction(null);
    setRoundEndRevealed(false);
    session.nextRound();
  };

  const advance = () => {
    session.advance();
    setHasPending(session.pendingReveal);
  };

  const currentSeat = definition.currentSeat(state);
  const isOver = definition.isOver(state);
  const roundOver = definition.isRoundOver?.(state) ?? false;

  return {
    state: definition.playerView(state, HERO),
    rawState: state,
    replaceState,
    isHeroTurn: !isOver && currentSeat === HERO && !choreographer.isPlaying,
    isOver,
    winner: isOver ? extractWinner(state) : null,
    winningSeats: isOver ? resolveWinningSeats(state) : null,
    roundWinner: !isOver && roundOver ? extractRoundWinner(state) : null,
    roundWinningSeats: !isOver && roundOver ? resolveRoundWinningSeats(state) : null,
    showSummary: isOver && gameEndRevealed,
    showRoundSummary: !isOver && roundOver && roundEndRevealed,
    round: extractRound(state),
    dealingRound,
    nextRound,
    autoAdvance: opts.autoAdvance !== false,
    busy: choreographer.isPlaying || (!isOver && currentSeat !== HERO),
    submitAction,
    rng: session.rng,
    skip: choreographer.skip,
    lastAction,
    pendingReveal: hasPending,
    advance,
  };
}
