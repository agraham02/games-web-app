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
  /**
   * `illegal-action` is the game's own `validate` refusing the action
   * itself, as opposed to `not-your-turn` refusing the SEAT. Kept
   * distinct because they mean different things to a client: one is a
   * race it lost, the other is a move it should never have offered.
   */
  | { ok: false; reason: "not-your-turn" | "game-over" | "round-over" | "illegal-action" };

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
   *
   * Receives the position and the seat about to act so a driver can let
   * the GAME have an opinion about this particular beat — see
   * `GameDefinition.turnHold`. The driver stays in charge of WHEN: it is
   * the one that folds in playback time, the speed multiplier and reduced
   * motion around whatever the game asks for.
   */
  turnHoldMs?: (state: S, seat: SeatId) => number;
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
  /** A live seat's deadline, when its game declared one. */
  private deadlineTimer: TimerHandle | null = null;
  /**
   * When the wait currently being counted down actually began.
   *
   * Keyed by whatever the game called it, so being asked again about the
   * same wait resumes it rather than restarting it. See
   * `GameDefinition.deadline`'s `key`.
   */
  private deadlineAnchor: { key: string; at: number } | null = null;
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
  setTurnHoldResolver(turnHoldMs: (state: S, seat: SeatId) => number): void {
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
    // A new round is the game moving on, exactly as a move is: a hold or a
    // deadline armed for the round that just ended belongs to a position
    // nobody is at any more.
    this.clearHold();
    this.clearDeadline();
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

    // Every path below either arms a deadline for the position we are in
    // now, or is a position that deserves none - so the honest thing is to
    // start from none. Without this, a deadline armed for a live seat
    // outlived the turn it belonged to: the seat drops mid-window, the
    // liveness edge settles, a bot answers for them in a beat, play moves
    // on - and ten seconds later the orphan fired into a CURRENT window the
    // seat was legitimately entitled to, declining a challenge nobody had
    // been shown. `scheduleDeadline` re-arms immediately below when the
    // position still wants one.
    this.clearDeadline();

    if (this.definition.isOver(current)) return;
    // Checked AFTER isOver: the last round of a match is both, and the
    // match ending is the one that matters.
    if (this.definition.isRoundOver?.(current)) return;

    const seat = this.definition.currentSeat(current);
    if (seat === null) return;
    if (this.isLive(seat)) {
      // Waiting on a person — but not necessarily forever. A game may
      // declare that this seat has a deadline, and if it does, letting it
      // pass acts for them. See `GameDefinition.deadline`: it exists
      // because a table where several seats are entitled at once cannot
      // be unblocked by any one of their browsers.
      this.scheduleDeadline(seat);
      return;
    }

    this.pending = current;
    if (!this.autoAdvance) return; // Wait for an explicit advance().

    // Asking twice for the same position must not arm two timers.
    //
    // It is asked twice in ordinary play: `submit` emits even when a
    // reduce produced no events, so a driver that settles on every frame
    // AND honours the `animated: false` contract calls this twice in a
    // row — which is exactly what the room server does, and there are 33
    // no-op `reduce` paths across the five games to trigger it. The
    // second call used to overwrite `holdTimer` and leak the first; the
    // leaked one then fired, nulled the handle to a live timer, and a bot
    // turn revealed with no hold at all while `advance()` ran a spare
    // time.
    //
    // A hold already armed is a hold for this same position — `submit`
    // and `nextRound` both clear it by moving the game on — so the
    // correct answer to being asked again is to let the first one stand.
    // The deadline branch above is already idempotent for the same
    // reason: `scheduleDeadline` clears before it arms.
    if (this.holdTimer !== null) return;

    const hold = this.opts.turnHoldMs
      ? this.opts.turnHoldMs(current, seat)
      : DEFAULT_TURN_HOLD_MS;
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
    // The position this turn was scheduled FOR, not merely the latest one.
    // A bot turn is stashed while the table waits out its hold, and in that
    // window somebody else may legitimately act - BS hands the seat on turn
    // its plays while a challenge window is open, precisely so a person can
    // play over the top of one. Reducing the stale snapshot then assigned it
    // wholesale over `this.state` and broadcast it, silently undoing the move
    // that had just been made. Whoever moved has already re-armed whatever
    // the new position deserves, so dropping this one loses nothing.
    if (current !== this.state) return;
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
    // Asked of `legalActions` rather than `currentSeat`, and the
    // difference is one game wide. For four of the five the two are the
    // same question — verified across whole matches in
    // `GameSession.test.ts`, some eight thousand seat-turns of it — and
    // `currentSeat` is the cheaper way to ask.
    //
    // Rummy is the exception, and it is why the gate moved. A claim
    // window is a RACE: a card is discarded and every eligible seat may
    // grab it, so more than one seat is entitled to act at the same
    // instant. `currentSeat` can only name one of them (it names whoever
    // the pacing should wait on), and gating on it meant a human at any
    // other eligible seat watched the claim bar appear and did nothing
    // when they pressed it.
    //
    // `legalActions(state, seat)` is the honest question — "is there
    // something this seat may do right now" — and it is the same
    // function the UI already builds its action bar from, so the button
    // and the gate cannot disagree about what is allowed.
    if (this.definition.legalActions(this.state, seat).length === 0) {
      return { ok: false, reason: "not-your-turn" };
    }

    // ...and then whether the thing that arrived is one of them.
    //
    // The gate above answers "may this seat act", which is the question
    // the turn loop cares about. It says nothing about the action itself,
    // and online the action is arbitrary JSON off a socket — `reduce`
    // would otherwise believe a stranger about which card is in their
    // hand, or hand poker a bet of `"abc"`. See
    // `GameDefinition.validate`, which is where each game says what
    // well-formed means for it.
    if (this.definition.validate?.(this.state, seat, action)) {
      return { ok: false, reason: "illegal-action" };
    }

    // Anything random in the action is re-resolved here, against the
    // session's own generator, and whatever the client sent is thrown
    // away. Doing it unconditionally rather than only when the value
    // looks missing is the point: a client that can supply a roll can
    // supply a good one.
    const resolved = this.definition.completeAction
      ? this.definition.completeAction(this.state, action, seat, this.rng)
      : action;

    // Whatever was about to be done on somebody's behalf is moot: the
    // state has moved. `settled()` re-arms one if the new position still
    // wants it.
    this.clearDeadline();
    this.clearHold();

    const { state: next, events } = this.definition.reduce(this.state, resolved);
    this.state = next;
    this.last = { seat, action: resolved };
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
  /**
   * Arms the deadline for a live seat, if its game gave it one.
   *
   * Deliberately only ever armed for the seat `currentSeat` names. Where
   * several seats are entitled at once — Rummy's claim race — unblocking
   * that one seat is enough: the next becomes current and gets its own
   * deadline, so the table is guaranteed to keep moving without a timer
   * per seat.
   */
  private scheduleDeadline(seat: SeatId): void {
    this.clearDeadline();
    // Liveness is the session's to know, and a race's deadline can depend
    // on it: Rummy's ring is the soonest BOT's arrival, never another
    // person's (see `claimDeadlineMs`).
    const due = this.definition.deadline?.(this.state, seat, (s) => this.isLive(s));
    if (!due) {
      this.deadlineAnchor = null;
      return;
    }

    // How long is actually LEFT of this wait, not how long it was worth
    // when it started.
    //
    // A deadline is re-armed on every settle and a settle happens on
    // every frame, so a wait that spans other people's moves used to
    // restart from full each time one arrived. In BS that is the normal
    // case: a window is answered seat by seat, and each answer is a
    // frame, so the person at the back of the queue had their ten seconds
    // silently reset by everybody ahead of them - and reconnecting reset
    // them again, which is a free extension for anybody who refreshes.
    // Games that give a key get the original span counted down; games
    // that do not keep the old behaviour exactly.
    let ms = due.ms;
    if (due.key !== undefined) {
      const now = this.clock.now();
      if (this.deadlineAnchor?.key === due.key) {
        ms = Math.max(0, due.ms - (now - this.deadlineAnchor.at));
      } else {
        this.deadlineAnchor = { key: due.key, at: now };
      }
    } else {
      this.deadlineAnchor = null;
    }
    this.deadlineTimer = this.clock.setTimeout(() => {
      this.deadlineTimer = null;
      // Through `submit`, not `reduce`, so an action that has become
      // illegal in the meantime is refused exactly as a client's would be
      // — the seat may have acted a moment before this fired.
      const result = this.submit(seat, due.action);
      if (result.ok && !result.animated) this.settled();
    }, ms);
  }

  /**
   * Forgets a bot turn that was waiting out its hold.
   *
   * `settled()`'s idempotency guard already states that "a hold already
   * armed is a hold for this same position - `submit` and `nextRound` both
   * clear it by moving the game on". Neither actually did, so a hold armed
   * for a position the game had left stayed armed over the new one.
   */
  private clearHold(): void {
    this.pending = null;
    if (this.holdTimer === null) return;
    this.clock.clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  private clearDeadline(): void {
    if (this.deadlineTimer === null) return;
    this.clock.clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }

  cancelScheduled(): void {
    if (this.holdTimer !== null) {
      this.clock.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    this.clearDeadline();
    this.pending = null;
  }

  /** Ends the session for good. Later `settled()` calls do nothing. */
  dispose(): void {
    this.cancelScheduled();
    this.disposed = true;
  }
}
