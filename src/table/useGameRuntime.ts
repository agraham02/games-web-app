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
import type { GameEvent } from "@/engine/types";
import { useChoreographer } from "@/motion/useChoreographer";
import { prefersReducedMotion } from "@/motion/presets";
import { announce } from "@/ui/disclosure";
import { applyEventToTable } from "./applyEvent";
import { useTableStore } from "./store";

/**
 * Dead air between one turn settling and the next one being revealed —
 * on top of whatever a bot's own `thinkMs` already adds. Without a
 * DELIBERATE pause here, the choreographer's `onIdle` fires the instant
 * the last animation frame lands, which meant a bot's new dice could
 * start tumbling in literally the same tick the previous roll's result
 * became visible. There was no beat to actually read it in. This lives
 * on the shared runtime, not in LRC, because "let the player register
 * what just happened before showing them what's next" is a rule for
 * every game built on this hook, not a one-off LRC tweak. Both this and
 * `DEFAULT_END_HOLD_MS` are exposed as `GameRuntimeOptions` fields
 * rather than being truly fixed — `DevPanel` overrides them live so the
 * actual pacing number can be tuned by feel instead of by guesswork.
 */
const DEFAULT_TURN_HOLD_MS = 900;

/**
 * Dead air between the WINNING move settling and GameEndSummary actually
 * appearing. Before this existed the gap was zero: `isOver` published
 * the instant the last move's animation finished, so the summary could
 * cover the table in the same tick the board first showed who won —
 * no time to read the final board, let alone see a winner call-out on
 * their pod (see SeatRing's `winning` treatment). Deliberately its own
 * number, not reused from DEFAULT_TURN_HOLD_MS: reading "the game just
 * ended" plainly deserves more beat than "the next player is up."
 */
const DEFAULT_END_HOLD_MS = 1200;

/**
 * Dead air between a ROUND ending and its scorecard appearing. Same
 * reasoning as DEFAULT_END_HOLD_MS — the last tile of a round is often
 * the most interesting one on the table, and covering it instantly with
 * a panel of numbers throws it away — but shorter, because a round
 * ending is a punctuation mark and a match ending is a full stop.
 */
const DEFAULT_ROUND_HOLD_MS = 1000;

/**
 * How long the "Round N" title card (`RoundIntro`) stays up over the
 * opening deal — a fixed hold, deliberately NOT tied to how long that
 * round's deal actually takes to animate. It is a brief announcement
 * layered over the deal (see RoundIntro's own doc), not a mask for the
 * whole thing.
 */
const ROUND_INTRO_HOLD_MS = 3000;

/**
 * Events the table itself cannot show. `applyEventToTable` deliberately
 * only knows about placements, so without this an `announce` fell
 * straight through its `default:` and was silently dropped — which is
 * why LRC's "You win the pot!" has never actually appeared. It lives
 * here rather than in applyEvent because this hook is where engine
 * events meet the UI, and applyEvent should stay a pure placement
 * reducer.
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
  /** See DEFAULT_TURN_HOLD_MS. Defaults to it if omitted. */
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
   * gated by REVEAL_HOLD_MS/endHoldMs; use `showSummary` for the UI
   * reveal, which is. */
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
   * then (see `showSummary`'s doc for the same rule applied to the
   * summary panel). Structural, like `winner`/`round` below — reads
   * `state.result.winner`, the shape Dominoes' own per-round result
   * already uses; a round-less game (LRC) or one shaped differently
   * just never sets this. */
  roundWinner: SeatId | null;
  /**
   * Every seat on the side that won the just-finished ROUND — the
   * round-level twin of `winningSeats`, and the same fallback shape:
   * reads `state.result.winningSeats` if the game sets it, otherwise
   * wraps `roundWinner`. So a game that never sets the field produces an
   * IDENTICAL truth table to `=== roundWinner`, which is every existing
   * game.
   *
   * This did not exist until Caribbean dominoes' team mode, and
   * `winningSeats`' own doc used to say why: no partnership game scored
   * a single seat at round end. Team dominoes is the first that does —
   * a partner going out wins the round for both of you — and without
   * this the crown and the confetti would land on whichever partner
   * happened to lay the last tile.
   */
  roundWinningSeats: SeatId[] | null;
  /**
   * Every seat on the winning side, known the same instant `winner` is.
   * For a single-winner game this is just `[winner]` (or `null`) — the
   * field exists for PARTNERSHIP games (Spades: a team win is two
   * seats, not one), where `winner` alone can only ever crown one of
   * them. Structural, like `winner` — reads `state.winningSeats` if the
   * game sets it; falls back to wrapping `winner` for every game that
   * doesn't (Dominoes, LRC), so `winningSeats?.includes(seat)` is a
   * drop-in replacement for `winner === seat` everywhere it matters
   * (GameHost's per-pod crown, HeroWinFlourish) with IDENTICAL behavior
   * for those games. No `roundWinningSeats` companion exists —
   * `roundWinner` is Dominoes-shaped (someone going out) and no
   * partnership game so far scores a single seat at round end.
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
   * NOT derived from `round` above, which only publishes once that
   * deal's entire animation has finished (see `state`'s own doc on why
   * that publish is deliberately late). Gate a `RoundIntro` on
   * `dealingRound !== null`, not on watching `round` change. Carries the
   * round number the incoming deal is FOR, so the intro doesn't have to
   * wait a beat behind it either.
   */
  dealingRound: number | null;
  /**
   * The UNREDACTED state. `state` above is `playerView(state, HERO)`,
   * which is what every game screen should read — this exists for the
   * dev state editor, which has to edit what is actually there rather
   * than the hero's redacted picture of it.
   */
  rawState: S;
  /** DEV ONLY — see the implementation's own doc. */
  replaceState: (next: S) => void;
  /** Deals the next round and clears the scorecard. No-op unless a round
   * is actually over. Wire this to the scorecard's continue button. */
  nextRound: () => void;
  /** Whether bot turns are currently auto-revealing on their own pace
   * (true) or sitting pending until `advance()` is called (false) — the
   * resolved value of `GameRuntimeOptions.autoAdvance`. A revealed
   * turn's OWN animation never depends on this (see `advance`'s doc);
   * it's exposed purely as read-only state for a game's own UI, e.g. to
   * label what mode the DevPanel toggle is currently in. */
  autoAdvance: boolean;
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
  /** True when a bot's turn has been computed and is waiting to be
   * revealed — either the ordinary REVEAL_HOLD_MS pause, or (with
   * `autoAdvance: false`) indefinitely until `advance()` is called. */
  pendingReveal: boolean;
  /** Reveals the currently pending bot turn right now. A no-op if
   * nothing is pending. In normal (autoAdvance) play this just
   * fast-forwards the hold pause rather than double-firing the turn —
   * safe to wire to a "skip wait" affordance, not just the dev step
   * button. */
  advance: () => void;
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

  // `stateRef` is written synchronously the moment a move is DECIDED
  // (inside `reduce`'s caller), so internal bookkeeping — figuring out
  // whose turn is next — always sees the true latest state, exactly
  // like the file-level comment describes. The exposed `state` (the
  // `useState` React re-renders from) is deliberately written on a
  // DIFFERENT schedule: only once that move's animation has actually
  // finished playing, from `onIdle` below. Publishing it early — the
  // instant `reduce` runs, before the choreographer even starts — was
  // the actual bug behind "the round/game summary appears before I can
  // see what the last move was": `isOver`/`winner` flow straight from
  // `state`, so they'd flip true (and GameEndSummary would show) while
  // the winning roll's dice-and-chips animation hadn't even begun.
  const stateRef = useRef(state);

  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roundHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (holdTimer.current !== null) clearTimeout(holdTimer.current);
      if (endHoldTimer.current !== null) clearTimeout(endHoldTimer.current);
      if (roundHoldTimer.current !== null) clearTimeout(roundHoldTimer.current);
    };
  }, []);

  // See `GameRuntime.dealingRound`'s doc — published synchronously from
  // `pushDeal`, not derived from `state`.
  const [dealingRound, setDealingRound] = useState<number | null>(null);

  // Auto-clears `dealingRound` after its hold — a genuine dependency
  // effect, NOT an imperative ref+setTimeout tucked inside `pushDeal`
  // (an earlier version did exactly that, and it broke under React 18
  // dev StrictMode specifically: the `started`-guarded mount effect
  // below calls `pushDeal` SYNCHRONOUSLY on mount, which scheduled the
  // clear-timer inside that same initial effects pass — but StrictMode
  // double-invokes ALL of a commit's effects as mount -> cleanup ->
  // mount, and the OTHER cleanup effect just above (covering
  // holdTimer/endHoldTimer/roundHoldTimer) ran its cleanup in that same
  // pass too, cancelling the freshly-scheduled deal-intro timer. Because
  // `started.current` was already `true` by the remount pass, the
  // `started` effect's body never ran again to reschedule it — leaving
  // `dealingRound` stuck non-null forever in dev, exactly the "does not
  // go away" report. A dependency effect has no such gate: StrictMode's
  // mount -> cleanup -> mount runs THIS effect three times too, but that
  // means schedule -> cancel -> reschedule, which always lands on a live
  // timer either way. Also correctly re-arms on every later round (the
  // dependency changing from one round's number to the next), without
  // needing `pushDeal` to think about clearing anything itself.
  useEffect(() => {
    if (dealingRound === null) return;
    // Same "always go through a real timer, just a 0ms one" shape
    // `onIdle`'s own holds use for reduced motion — a synchronous
    // setState call inside an effect body (calling it directly here
    // instead) triggers React's own cascading-render lint rule, and
    // isn't needed anyway: a 0ms timeout still clears on the very next
    // tick, which reduced motion only cares about being "effectively
    // instant," not literally synchronous.
    const delay = prefersReducedMotion() ? 0 : ROUND_INTRO_HOLD_MS;
    const t = setTimeout(() => setDealingRound(null), delay);
    return () => clearTimeout(t);
  }, [dealingRound]);

  // Gates `showSummary` — see DEFAULT_END_HOLD_MS. Resets to false
  // automatically on a rematch because GameHost remounts this whole hook
  // (fresh `key`), which is exactly the reset a NEW game needs.
  const [gameEndRevealed, setGameEndRevealed] = useState(false);
  // The round-level equivalent. Unlike the game-end flag this one has to
  // be cleared by hand, because the SAME hook instance lives on into the
  // next round.
  const [roundEndRevealed, setRoundEndRevealed] = useState(false);

  // The turn `onIdle` has already decided is next, held here until it's
  // actually revealed (see `advance` below). `hasPending` just mirrors
  // whether the ref is populated, as a render-visible boolean — the ref
  // itself can't be read during render.
  const pendingRef = useRef<S | null>(null);
  const [hasPending, setHasPending] = useState(false);

  /** Computes one bot's turn RIGHT NOW (so a dev inspecting `advance`'s
   * caller sees the true dice count for the true chip total, not a
   * stale one) and reveals it — the "reveal" half of onIdle, split out
   * so it can run after a deliberate pause, or on manual demand,
   * instead of the instant the previous turn's animation ends. */
  const revealBotTurn = (current: S) => {
    const seat = definition.currentSeat(current);
    if (seat === null || seat === HERO) return;

    // `think` rides first in the same batch, so playback waits out that
    // beat before the move events actually animate.
    const bot = definition.bots[difficultyFor(seat, opts.difficulty)];
    // The REDACTED state, not the real one. `playerView` has always been
    // part of the GameDefinition contract ("bots for seat N only ever see
    // view(N)") but nothing enforced it here, because LRC hides nothing
    // and so never noticed. The first game with a concealed hand would
    // have had its bots reading every opponent's tiles. `reduce` still
    // runs against the true state — the bot only chooses from what it can
    // legitimately see.
    const view = definition.playerView(current, seat);
    const thinkMs = bot.thinkMs(view, seat, rng);
    const action = bot.choose(view, seat, rng);
    const { state: next, events } = definition.reduce(current, action);
    stateRef.current = next;
    setLastAction({ seat, action });
    choreographer.push([{ t: "think", seat, ms: thinkMs }, ...events]);
  };

  /**
   * Reveals the currently pending turn. Manual mode's ENTIRE job is
   * deciding WHEN this runs — automatically after turnHoldMs, or only
   * on an explicit call — never HOW the revealed turn plays out once it
   * does. That used to also force the turn to resolve instantly
   * (`choreographer.skip()`) whenever autoAdvance was off, on the
   * reasoning that a dice tumble playing over an "already decided"
   * board would look unresolved. It overcorrected: that made manual
   * mode skip the animation entirely, which is worse — a bot's move now
   * plays exactly the same animated sequence as automatic play whether
   * `advance()` was called by a timer or a click. What actually
   * prevents the "did this happen yet" gap is `pendingReveal` itself:
   * it goes false the instant this runs and only becomes true again
   * once the whole batch (think + moves) genuinely finishes via
   * `onIdle`, so nothing can be clicked ahead of its own animation
   * regardless of which mode is on. Manual mode only ever removes the
   * automatic timer between one turn ending and the next being
   * revealed — nothing about a single turn's own pacing.
   */
  const advance = () => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    const current = pendingRef.current;
    if (!current) return;
    pendingRef.current = null;
    setHasPending(false);
    revealBotTurn(current);
  };

  /**
   * Fires once a batch has fully finished animating. Two (or three, at
   * game end) jobs, on different clocks:
   *
   *  1. Publish `current` right away — reconcile placements (the
   *     self-correcting step: whatever just finished animating IS the
   *     true board) and expose the new `state`/`isOver`/`winner`. The
   *     animation already showed the player this; there's nothing left
   *     to hide, and this is what lets a per-seat winner treatment start
   *     immediately even though the SUMMARY still waits (see below).
   *  2. If the game just ended: hold `showSummary` back for endHoldMs —
   *     `winner` is already public from step 1, so SeatRing can crown
   *     the right pod for that whole pause; the summary catches up after.
   *  3. Otherwise, only after turnHoldMs does it reveal the NEXT turn —
   *     giving the player a genuine pause to read what just happened
   *     before a new dice tumble (or a bot's move) starts overwriting
   *     it. With `autoAdvance: false` this pause never elapses on its
   *     own at all — the turn just sits pending until `advance()` is
   *     called.
   */
  const onIdle = () => {
    const current = stateRef.current;
    setState(current);
    useTableStore.getState().reset(definition.placements(current, HERO), pieceMeta);

    const factor = 1 / Math.max(0.05, opts.speed ?? 1);

    if (definition.isOver(current)) {
      const delay = prefersReducedMotion() ? 0 : (opts.endHoldMs ?? DEFAULT_END_HOLD_MS) * factor;
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
        : (opts.roundHoldMs ?? DEFAULT_ROUND_HOLD_MS) * factor;
      roundHoldTimer.current = setTimeout(() => setRoundEndRevealed(true), delay);
      return;
    }

    const seat = definition.currentSeat(current);
    if (seat === null || seat === HERO) return; // Hero's turn — wait for input, nothing to pace.

    pendingRef.current = current;
    setHasPending(true);
    if (opts.autoAdvance === false) return; // Wait for an explicit advance() call.

    const delay = prefersReducedMotion() ? 0 : (opts.turnHoldMs ?? DEFAULT_TURN_HOLD_MS) * factor;
    holdTimer.current = setTimeout(advance, delay);
  };

  // A stable callback is fine here — onIdle always reads stateRef.current
  // fresh, so it doesn't matter whether useChoreographer fires this
  // synchronously (same tick as the state update that preceded it) or
  // asynchronously (well after this render committed).
  const choreographer = useChoreographer({
    apply: surfaceEvent,
    onIdle,
    speed: opts.speed,
    dealStaggerMs: opts.dealStaggerMs,
  });

  /**
   * Deals a round and lets its events play. Used for the opening deal
   * and for every round after it — they are the same operation, which is
   * why `startRound` is one hook rather than two.
   *
   * This is what makes an opening deal ANIMATE. `setup` can only return
   * state, so a game that deals there has its pieces simply appear;
   * a game with `startRound` returns an undealt state from `setup` and
   * the tiles fly out of the pile like a real deal.
   */
  const pushDeal = () => {
    if (!definition.startRound) return;
    const { state: next, events } = definition.startRound(stateRef.current, rng);
    stateRef.current = next;
    // Published NOW, synchronously — `state` (and so `round`) only
    // update once this deal's whole batch finishes animating (see
    // `onIdle`'s doc), which would show the intro after the deal is
    // already over. Structural read, like `extractRound` below, since
    // `startRound`'s return type isn't required to carry `round`. The
    // auto-clear lives in its own effect above — see that effect's doc
    // for why it can't live here.
    setDealingRound(extractRound(next));
    choreographer.push(events);
  };

  const nextRound = () => {
    if (roundHoldTimer.current !== null) {
      clearTimeout(roundHoldTimer.current);
      roundHoldTimer.current = null;
    }
    if (!definition.isRoundOver?.(stateRef.current)) return;
    if (definition.isOver(stateRef.current)) return;
    // Only the between-rounds path needs these cleared; on mount they
    // already hold exactly these values, which is why the opening deal
    // calls `pushDeal` directly rather than going through here.
    setLastAction(null);
    setRoundEndRevealed(false);
    pushDeal();
  };

  // Kick off the very first turn once, after the table has had a chance
  // to mount with the initial placements (avoids racing the store).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    useTableStore.getState().reset(definition.placements(stateRef.current, HERO), pieceMeta);
    // A game with rounds hasn't dealt yet, so there is nothing to pace
    // until the deal lands — `onIdle` runs at the END of those events.
    if (definition.startRound) pushDeal();
    else onIdle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitAction = (action: A) => {
    const seat = definition.currentSeat(stateRef.current);
    if (seat !== HERO) return; // Not the hero's turn — ignore.
    const { state: next, events } = definition.reduce(stateRef.current, action);
    stateRef.current = next;
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
      // onIdle directly is safe here specifically because it reads
      // stateRef.current rather than a closed-over value, so there's no
      // staleness risk to firing it synchronously.
      onIdle();
    }
  };

  /**
   * DEV ONLY — replaces the live state wholesale and republishes the
   * table from it, so the dev panel's state editor can put the game into
   * a shape rules-legal play would take minutes to reach (a 20-card
   * hand, a 30-card discard pile).
   *
   * Goes through `onIdle` rather than poking the store directly, so the
   * edited state gets the identical publish-and-then-pace treatment any
   * real action's result would: placements reconcile, and if the edit
   * happens to leave a bot on turn, that turn is scheduled properly
   * instead of the table silently sitting there.
   */
  const replaceState = (next: S) => {
    stateRef.current = next;
    onIdle();
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
    rng,
    skip: choreographer.skip,
    lastAction,
    pendingReveal: hasPending,
    advance,
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

/** Structural, like `extractWinner` — reads `state.winningSeats` if a
 * game sets it (Spades' team win). Absent for every existing game. */
function extractWinningSeats<S>(state: S): SeatId[] | null {
  const maybe = state as unknown as { winningSeats?: SeatId[] | null };
  return Array.isArray(maybe.winningSeats) ? maybe.winningSeats : null;
}

/** See `GameRuntime.winningSeats`'s doc: prefers the structural
 * multi-seat field, and falls back to wrapping the single `winner` so
 * every game that never sets `winningSeats` produces an IDENTICAL truth
 * table through `.includes()` that `=== winner` used to produce directly. */
function resolveWinningSeats<S>(state: S): SeatId[] | null {
  const structural = extractWinningSeats(state);
  if (structural) return structural;
  const single = extractWinner(state);
  return single !== null ? [single] : null;
}

/** Same structural read as `extractWinner`, for the scorecard heading. */
function extractRound<S>(state: S): number {
  const maybe = state as unknown as { round?: number };
  return typeof maybe.round === "number" ? maybe.round : 1;
}

/** See `GameRuntime.roundWinner`'s doc. */
function extractRoundWinner<S>(state: S): SeatId | null {
  const maybe = state as unknown as { result?: { winner?: SeatId | null } | null };
  const winner = maybe.result?.winner;
  return typeof winner === "number" ? winner : null;
}

/**
 * The round-level twin of `resolveWinningSeats` — same precedence, same
 * fallback, so a game that sets neither field behaves exactly as before.
 *
 * Exported only so that equivalence can be pinned by a test without
 * standing up the whole runtime: the claim worth proving is that adding
 * this changed nothing for the four games that came before it, and that
 * is a property of this function alone.
 */
export function resolveRoundWinningSeats<S>(state: S): SeatId[] | null {
  const maybe = state as unknown as { result?: { winningSeats?: SeatId[] | null } | null };
  const structural = maybe.result?.winningSeats;
  if (Array.isArray(structural)) return structural;
  const single = extractRoundWinner(state);
  return single !== null ? [single] : null;
}
