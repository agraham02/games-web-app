/**
 * The game loop, with no React in it.
 *
 * This is `useGameRuntime`'s progression half, lifted out whole. What
 * stayed behind in the hook is presentation: the choreographer, the
 * placement store, and the two holds that gate when a SUMMARY is allowed
 * to appear. What moved here is everything that decides what actually
 * happens — dealing, reducing, whose turn is next, and when a bot acts.
 *
 * Three changes from the hook's version, and only three:
 *
 *  1. `setTimeout` became an injected `Clock`, so a test can play a whole
 *     match out in microseconds and a server can be driven by its own
 *     timers.
 *  2. `seat === HERO` became `isSeatLive(seat)` — "is a connected human
 *     sitting here". Offline that is true for seat 0 alone, which is the
 *     old behaviour exactly; online it is true for whichever seats are
 *     claimed. This one substitution is what makes N humans possible.
 *  3. `submit` takes the acting seat and refuses a seat that is not on
 *     turn. `reduce` itself has never checked — poker's fold applies to
 *     `state.toAct[0]` no matter who sent it — so a networked client
 *     could otherwise act for somebody else.
 *
 * The pacing rule the hook's header describes is preserved exactly, and
 * it is why `settled()` is a separate call rather than the session simply
 * running itself: a bot's turn is computed only once the PREVIOUS turn
 * has finished being shown. `reduce` is synchronous and cheap, so nothing
 * stops this class from playing an entire match in a tight loop; the
 * driver calling `settled()` is what paces it to what a player is
 * actually watching. A server, having no animation to wait for, calls
 * `settled()` as soon as it has broadcast — so the same code paces a
 * browser off animation and a server off its clock.
 */

import type {
  BotDifficulty,
  GameDefinition,
  GameEvent,
  PieceId,
  PieceMeta,
  SeatId,
} from "@/engine/types";
import { HERO } from "@/engine/types";
import { createRng, randomSeed, type Rng } from "@/engine/rng";
import { realClock, type Clock, type TimerHandle } from "./clock";
import { extractRound } from "./structural";

/**
 * Dead air between one turn settling and the next being revealed, on top
 * of whatever a bot's own `thinkMs` already adds. Without a deliberate
 * pause the next move starts the instant the last frame lands, leaving no
 * beat to actually read what just happened.
 */
export const DEFAULT_TURN_HOLD_MS = 900;

/**
 * One batch of things that happened, handed to whoever is driving.
 *
 * Deliberately NOT carrying the resulting state. The driver reads
 * `snapshot()` when it settles, which is what the hook has always done
 * (`setState(stateRef.current)` inside `onIdle`) and is the behaviour that
 * survives two batches being queued back to back — the frame's own state
 * would be the older of the two. When the wire needs a state payload it is
 * a per-viewer REDACTION of `snapshot()` computed at send time, not this.
 */
export interface SessionFrame<A> {
  /** Monotonic per session. The wire uses it to spot a client falling behind. */
  seq: number;
  events: GameEvent[];
  /** Who acted and what they did, or null for a deal. */
  lastAction: { seat: SeatId; action: A } | null;
  /**
   * Non-null only on a round's opening deal, carrying that round's number.
   * Published as the deal is DISPATCHED rather than derived from state
   * afterwards, so a "Round N" title card can ride over the deal instead
   * of appearing once it has already finished.
   */
  dealtRound: number | null;
}

export type SubmitResult =
  | {
      ok: true;
      /**
       * False when `reduce` legitimately produced nothing to show — a
       * Spades `look`, which changes real state but moves no piece.
       *
       * This is NOT a rejection, and keeping the two apart matters: the
       * action was applied and the state moved on. It exists because a
       * driver that paces off animation will never settle a batch with
       * nothing in it (`useChoreographer.push` bails on an empty array
       * without calling `onIdle`), so on `false` the driver has to settle
       * the session itself or the game silently stops.
       */
      animated: boolean;
    }
  | { ok: false; reason: "not-your-turn" | "game-over" | "round-over" };

export interface GameSessionOptions<S, A> {
  definition: GameDefinition<S, A>;
  seats: number;
  /** Omit for a fresh random game; pass a fixed value to replay one exactly. */
  seed?: number;
  /** Per-seat bot difficulty, index-aligned. Live seats are ignored. */
  difficulty?: BotDifficulty[];
  clock?: Clock;
  /**
   * "Is a connected human sitting in this seat?" A seat that is not live
   * is played by its bot. Defaults to seat 0 alone, which is offline
   * single-player and the behaviour every existing game already has.
   *
   * Read fresh on every turn rather than captured once, because online it
   * changes mid-hand: a player disconnects and their seat becomes a bot's
   * between one turn and the next.
   */
  isSeatLive?: (seat: SeatId) => boolean;
  /**
   * Resolved milliseconds to hold between a turn settling and the next
   * being revealed. A function, not a number, because the browser resolves
   * it against a live speed control and the reduced-motion setting, both
   * of which can change between turns.
   */
  turnHoldMs?: () => number;
  /**
   * When false a bot's turn is computed as soon as it is reachable but
   * never auto-revealed — the driver must call `advance()`. Dev affordance
   * for stepping a game one turn at a time.
   */
  autoAdvance?: boolean;
  /**
   * Where frames go. Optional at construction and rewireable via
   * `setEmit`, because a driver often cannot supply it yet: the browser
   * builds its choreographer after the session exists, and a server
   * re-points this when a room's set of listeners changes.
   */
  emit?: (frame: SessionFrame<A>) => void;
}

export class GameSession<S, A> {
  readonly definition: GameDefinition<S, A>;
  readonly rng: Rng;

  private readonly clock: Clock;
  private readonly opts: GameSessionOptions<S, A>;
  private readonly meta: Record<PieceId, PieceMeta>;

  private state: S;
  private seq = 0;
  private last: { seat: SeatId; action: A } | null = null;

  private holdTimer: TimerHandle | null = null;
  /** A bot turn that `settled()` has decided on but not yet revealed. */
  private pending: S | null = null;
  private disposed = false;

  constructor(opts: GameSessionOptions<S, A>) {
    this.opts = opts;
    this.definition = opts.definition;
    this.clock = opts.clock ?? realClock;
    this.rng = createRng(opts.seed ?? randomSeed());
    this.state = opts.definition.setup({
      seats: opts.seats,
      rng: this.rng,
      difficulty: opts.difficulty,
    });
    this.meta = opts.definition.pieces(this.state);
  }

  /**
   * Retunes the knobs a driver is allowed to change mid-game.
   *
   * `autoAdvance` is genuinely live: DevPanel's manual-mode toggle flips
   * it between turns, and a session that captured it once at construction
   * would ignore the switch until the next rematch. `difficulty` is here
   * for symmetry and for the server, where a seat can change hands
   * mid-match — nothing in the offline app retunes it today.
   *
   * Deliberately narrow. Everything else (the definition, the seat count,
   * the seed) is identity: changing it means a different game, which is a
   * new session, not a reconfigured one.
   */
  configure(next: { autoAdvance?: boolean; difficulty?: BotDifficulty[] }): void {
    if (next.autoAdvance !== undefined) this.opts.autoAdvance = next.autoAdvance;
    if (next.difficulty !== undefined) this.opts.difficulty = next.difficulty;
  }

  /** The TRUE state. Redaction is a send-time concern, never this. */
  snapshot(): S {
    return this.state;
  }

  /** Fixed for the whole game — computed once, exactly as the hook did. */
  pieceMeta(): Record<PieceId, PieceMeta> {
    return this.meta;
  }

  get pendingReveal(): boolean {
    return this.pending !== null;
  }

  get autoAdvance(): boolean {
    return this.opts.autoAdvance !== false;
  }

  private isLive(seat: SeatId): boolean {
    return this.opts.isSeatLive ? this.opts.isSeatLive(seat) : seat === HERO;
  }

  /**
   * Points the session at a new frame consumer. Safe to call at any time;
   * frames emitted before anything is wired are dropped, which is correct
   * — nothing had asked for them yet.
   */
  setEmit(emit: (frame: SessionFrame<A>) => void): void {
    this.opts.emit = emit;
  }

  /** Replaces the turn-hold resolver. See `GameSessionOptions.turnHoldMs`. */
  setTurnHoldResolver(turnHoldMs: () => number): void {
    this.opts.turnHoldMs = turnHoldMs;
  }

  private emit(events: GameEvent[], dealtRound: number | null): void {
    this.opts.emit?.({ seq: ++this.seq, events, lastAction: this.last, dealtRound });
  }

  /**
   * Deals the opening round and starts the loop. A game with rounds has
   * nothing to pace until its deal lands, so that goes straight out as a
   * frame; a game that sets up fully in `setup` (LRC) has nothing to
   * animate and settles immediately.
   */
  start(): void {
    if (this.definition.startRound) this.pushDeal();
    else this.settled();
  }

  private pushDeal(): void {
    if (!this.definition.startRound) return;
    const { state: next, events } = this.definition.startRound(this.state, this.rng);
    this.state = next;
    this.last = null;
    this.emit(events, extractRound(next));
  }

  /**
   * The driver has finished showing the last frame. Decide what happens
   * next — and note that all three stopping cases simply return: a game
   * that is over, a round waiting on the player to continue, and a live
   * seat's turn all park the loop until something external moves it. Only
   * a bot's turn schedules anything.
   */
  settled(): void {
    if (this.disposed) return;
    const current = this.state;

    if (this.definition.isOver(current)) return;
    // Checked AFTER isOver: the last round of a match is both, and the
    // match ending is the one that matters.
    if (this.definition.isRoundOver?.(current)) return;

    const seat = this.definition.currentSeat(current);
    if (seat === null || this.isLive(seat)) return; // Waiting on a human.

    this.pending = current;
    if (!this.autoAdvance) return; // Wait for an explicit advance().

    const hold = this.opts.turnHoldMs ? this.opts.turnHoldMs() : DEFAULT_TURN_HOLD_MS;
    this.holdTimer = this.clock.setTimeout(() => {
      this.holdTimer = null;
      this.advance();
    }, hold);
  }

  /**
   * Reveals the pending bot turn now. A no-op if nothing is pending, so it
   * is safe to wire to a "skip the wait" affordance as well as to the dev
   * step button — in ordinary play it collapses the hold rather than
   * firing the turn twice.
   */
  advance(): void {
    if (this.holdTimer !== null) {
      this.clock.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    const current = this.pending;
    if (!current) return;
    this.pending = null;
    this.revealBotTurn(current);
  }

  /**
   * Computes one bot's turn RIGHT NOW — against the state as it actually
   * stands, not a snapshot taken when the turn was first scheduled.
   */
  private revealBotTurn(current: S): void {
    const seat = this.definition.currentSeat(current);
    if (seat === null || this.isLive(seat)) return;

    const tier = this.opts.difficulty?.[seat] ?? "steady";
    const bot = this.definition.bots[tier];
    // The REDACTED state, never the real one: a bot for seat N sees
    // view(N) and nothing more. `reduce` still runs against the truth —
    // the bot only CHOOSES from what it can legitimately see.
    const view = this.definition.playerView(current, seat);
    const thinkMs = bot.thinkMs(view, seat, this.rng);
    const action = bot.choose(view, seat, this.rng);
    const { state: next, events } = this.definition.reduce(current, action);
    this.state = next;
    this.last = { seat, action };
    // `think` rides first in the same batch, so playback waits out that
    // beat before the move itself animates.
    this.emit([{ t: "think", seat, ms: thinkMs }, ...events], null);
  }

  /**
   * A human's move. Unlike the hook's `submitAction` this names the seat
   * and checks it: `reduce` applies an action to whoever is on turn
   * regardless of who sent it, so without this gate a networked client
   * could fold someone else's hand.
   *
   * Returns a result rather than throwing — a rejected action is an
   * ordinary thing for a server to answer, not an exceptional one.
   */
  submit(seat: SeatId, action: A): SubmitResult {
    if (this.definition.isOver(this.state)) return { ok: false, reason: "game-over" };
    if (this.definition.isRoundOver?.(this.state)) return { ok: false, reason: "round-over" };
    if (this.definition.currentSeat(this.state) !== seat) {
      return { ok: false, reason: "not-your-turn" };
    }

    const { state: next, events } = this.definition.reduce(this.state, action);
    this.state = next;
    this.last = { seat, action };
    this.emit(events, null);
    return { ok: true, animated: events.length > 0 };
  }

  /** Deals the next round. No-op unless a round is genuinely over. */
  nextRound(): void {
    if (!this.definition.isRoundOver?.(this.state)) return;
    if (this.definition.isOver(this.state)) return;
    this.pushDeal();
  }

  /**
   * DEV ONLY — assigns state wholesale, deciding nothing, so the dev
   * panel's state editor can reach a shape legal play would take minutes
   * to get to.
   *
   * Split from `replaceState` because a browser driver has to reconcile
   * the table against the new state BEFORE anything is scheduled off it,
   * and that ordering is the driver's to own.
   */
  adoptState(next: S): void {
    this.state = next;
  }

  /** `adoptState` plus the settle a caller with nothing to reconcile wants. */
  replaceState(next: S): void {
    this.adoptState(next);
    this.settled();
  }

  /**
   * Drops any scheduled turn without ending the session.
   *
   * Deliberately reversible, and that is the whole point: React StrictMode
   * runs a mount as mount -> cleanup -> mount against the SAME hook state,
   * so an unmount cleanup that permanently killed the session would hand
   * the second mount a dead one and freeze the game in dev. This clears
   * the timer and leaves the session able to keep playing; `dispose` is
   * the permanent one, for a server that is genuinely finished.
   */
  cancelScheduled(): void {
    if (this.holdTimer !== null) {
      this.clock.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    this.pending = null;
  }

  /** Ends the session for good. Later `settled()` calls do nothing. */
  dispose(): void {
    this.cancelScheduled();
    this.disposed = true;
  }
}
