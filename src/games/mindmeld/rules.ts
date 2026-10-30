/**
 * Mind Meld: say the same word as your partner.
 *
 * Both of you write a word at the same moment. When everybody is in, a shared
 * countdown runs and every word is shown at once. If your two match you have
 * melded, and the sooner the better; if not, the next try is a word that
 * connects the last two said - and round it goes until you meet.
 *
 * Three things make this unlike every other game here.
 *
 *  - It places nothing on the table. `pieces()` and `placements()` are empty, so
 *    what a viewer may know is entirely `playerView`'s business, and the one
 *    secret is a typed word until it is revealed. Redaction's piece machinery
 *    cannot see it, which is why `redact.test.ts` has a check of its own.
 *  - Every unlocked seat acts at once, and the reveal is a consequence of the
 *    LAST lock rather than of any turn. So `currentSeat` only names who pacing
 *    waits on (the soonest bot, as BS's window does), and `legalActions` is the
 *    real gate.
 *  - What a bot says comes from a `WordBrain` it is handed, never from anything
 *    it loads, so the rules stay pure and a test can pass a fake one.
 *
 * Which pairs play a try is `schedule.ts`'s answer, never a loop here.
 */

import type { Rng } from "@/engine/rng";
import type {
  GameDefinition,
  GameEvent,
  PieceId,
  PieceMeta,
  PlacementMap,
  ReduceResult,
  SeatId,
  SetupOptions,
} from "@/engine/types";
import { currentBrain, type WordBrain } from "./brain";
import { makeBots } from "./bots";
import { isProfane } from "./profanity";
import { activePairs, activeSeats, scheduleFor, type Schedule } from "./schedule";
import {
  DEFAULT_RULES,
  LOCK_BEAT_MS,
  MAX_SEATS,
  MIN_SEATS,
  ROUNDS_MAX,
  ROUNDS_MIN,
  THINK_GRACE_MS,
  TRIES_CHOICES,
  THINK_CHOICES,
  botMs,
  evenSeats,
  isActive,
  pairOf,
  pointsFor,
} from "./state";
import type { MindMeldAction, MindMeldRules, MindMeldState, Pair, Reveal, RoundResult } from "./types";
import { refusal, sameAsAny, sameWord, soClose } from "./words";

/** What a viewer is shown in place of somebody else's locked word. */
export const HIDDEN_WORD = "•";

/** How long the reveal that ends a round stays up before the scorecard. */
const ROUND_READ_MS = 3_600;

/** Never more rounds than this past the target when a tie will not break. */
const TIE_EXTRA_ROUNDS = 3;

function clampRules(rules: Partial<MindMeldRules>): MindMeldRules {
  const merged = { ...DEFAULT_RULES, ...rules };
  const int = (v: number, min: number, max: number, fallback: number) =>
    Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
  return {
    rounds: int(merged.rounds, ROUNDS_MIN, ROUNDS_MAX, DEFAULT_RULES.rounds),
    tries: (TRIES_CHOICES as readonly number[]).includes(merged.tries) ? merged.tries : DEFAULT_RULES.tries,
    thinkSeconds: (THINK_CHOICES as readonly number[]).includes(merged.thinkSeconds)
      ? merged.thinkSeconds
      : DEFAULT_RULES.thinkSeconds,
    start: merged.start === "dealt" ? "dealt" : "free",
    showLast: merged.showLast === true,
    familySafe: merged.familySafe !== false,
    pace: merged.pace === "turns" ? "turns" : "together",
  };
}

/**
 * Why this word may not be locked in by this seat, or null when it may.
 *
 * Shared by `validate` and by the input on the table, so a player is told at
 * once - before anything is sent - exactly what the server would say. Everything
 * refused is refused BEFORE the word is locked, so the cost of a mistake falls
 * on nobody but the person who made it: no try is spent and nothing is shown.
 *
 * "Already used" is feedback after an attempt, not a hint before one: it says
 * only that the word was used, never what to say instead.
 */
export function wordProblem(state: MindMeldState, seat: SeatId, word: unknown): string | null {
  if (typeof word !== "string") return "a word must be text";
  const refused = refusal(word);
  if (refused) return refused;
  if (state.rules.familySafe && isProfane(word)) return "Pick another word";
  const pair = pairOf(state, seat);
  if (pair && sameAsAny(word, pair.chain)) return "That one has been used - try something new";
  return null;
}

export interface MindMeldOptions {
  /** Which pairs play a try. Default: what the `pace` rule says. */
  schedule?: Schedule;
  /** Where a bot's words come from. Default: whichever brain is installed. */
  brain?: () => WordBrain;
}

export function createMindMeld(
  rulesIn: Partial<MindMeldRules> = {},
  opts: MindMeldOptions = {},
): GameDefinition<MindMeldState, MindMeldAction> {
  const rules = clampRules(rulesIn);
  const schedule = opts.schedule ?? scheduleFor(rules);
  const brain = opts.brain ?? currentBrain;

  /* ------------------------------------------------------------- setup */

  function setup({ seats, rng }: SetupOptions): MindMeldState {
    void rng;
    const count = evenSeats(seats);
    const locks: Record<SeatId, string | null> = {};
    const scores: Record<SeatId, number> = {};
    for (let s = 0; s < count; s++) {
      locks[s as SeatId] = null;
      scores[s as SeatId] = 0;
    }
    return {
      seats: count,
      rules,
      round: 0,
      dealt: false,
      pairs: freshPairs(count, []),
      locks,
      tryNo: 0,
      window: null,
      reveal: null,
      scores,
      result: null,
      winner: null,
    };
  }

  function freshPairs(seats: number, starters: Array<[string, string]>): Pair[] {
    return Array.from({ length: seats / 2 }, (_, id) => ({
      id,
      seats: [(id * 2) as SeatId, (id * 2 + 1) as SeatId],
      chain: starters[id] ? [...starters[id]!] : [],
      tries: 0,
      meldedOn: null,
      points: 0,
    }));
  }

  function startRound(state: MindMeldState, rng: Rng): ReduceResult<MindMeldState> {
    const starters: Array<[string, string]> = [];
    if (rules.start === "dealt") {
      for (let i = 0; i < state.seats / 2; i++) {
        const first = brain().starter(rng);
        let second = brain().starter(rng, [first]);
        // Two words that are the same word are not a puzzle.
        for (let n = 0; n < 6 && sameWord(first, second); n++) second = brain().starter(rng, [first, second]);
        starters.push([first, second]);
      }
    }
    const locks: Record<SeatId, string | null> = {};
    for (let s = 0; s < state.seats; s++) locks[s as SeatId] = null;
    const next: MindMeldState = {
      ...state,
      round: state.round + 1,
      dealt: true,
      pairs: freshPairs(state.seats, starters),
      locks,
      tryNo: 0,
      window: null,
      reveal: null,
      result: null,
    };
    next.window = openWindow(next);
    // Nothing is dealt, but a driver paced off animation still needs a beat.
    return { state: next, events: [{ t: "pause" }] };
  }

  /* ------------------------------------------------------------ window */

  /** Every seat of a pair playing this try that has not locked a word, soonest bot first. */
  function openWindow(state: MindMeldState): MindMeldState["window"] {
    const pending = activeSeats(state, schedule)
      .filter((seat) => state.locks[seat] === null)
      .map((seat) => ({ seat, ms: botMs(state, seat) }))
      .sort((a, b) => a.ms - b.ms || a.seat - b.seat);
    return pending.length > 0 ? { pending } : null;
  }

  /* ------------------------------------------------------------ reduce */

  function reduce(state: MindMeldState, action: MindMeldAction): ReduceResult<MindMeldState> {
    if (state.winner !== null || state.result !== null || !state.dealt) {
      return { state, events: [{ t: "pause" }] };
    }
    const d = clone(state);
    const events: GameEvent[] = [];

    if (action.t === "submit") {
      d.locks[action.seat] = action.word.trim();
      const w = d.window;
      if (w) {
        const answered = w.pending.find((p) => p.seat === action.seat)?.ms ?? 0;
        d.window = {
          pending: w.pending.filter((p) => p.seat !== action.seat),
          elapsed: Math.max(w.elapsed ?? 0, answered),
        };
      }
      const waiting = activeSeats(d, schedule).some((seat) => d.locks[seat] === null);
      if (!waiting) resolve(d, new Set(), events);
      // Nothing to show for a word locked in: the pod says "locked" and that
      // is all anyone else is allowed to know.
      return { state: d, events: events.length > 0 ? events : [{ t: "pause" }] };
    }

    // The think time is up: every pair with somebody still to lock forfeits.
    const forfeit = new Set<number>();
    for (const id of activePairs(d, schedule)) {
      if (d.pairs[id]!.seats.some((seat) => d.locks[seat] === null)) forfeit.add(id);
    }
    for (const id of forfeit) {
      for (const seat of d.pairs[id]!.seats) {
        if (d.locks[seat] === null) {
          events.push({ t: "announce", actor: seat, text: "ran out of time", selfText: "ran out of time", tone: "info", selfTone: "bad" });
        }
      }
    }
    resolve(d, forfeit, events);
    return { state: d, events };
  }

  function clone(state: MindMeldState): MindMeldState {
    return {
      ...state,
      pairs: state.pairs.map((p) => ({ ...p, chain: [...p.chain] })),
      locks: { ...state.locks },
      scores: { ...state.scores },
    };
  }

  /**
   * Everybody who is playing is in, or time ran out: show the words.
   *
   * The countdown is an event, and what follows it waits for it, so by the time
   * the table shows any word the queue has run out the three seconds - the same
   * reason every other game's reveals are events and not a render.
   */
  function resolve(d: MindMeldState, forfeit: Set<number>, events: GameEvent[]): void {
    const playing = activePairs(d, schedule);
    const revealed: Reveal[] = [];

    for (const id of playing) {
      const pair = d.pairs[id]!;
      const [s0, s1] = pair.seats;
      if (forfeit.has(id)) {
        pair.tries += 1;
        revealed.push({ pair: id, a: "", b: "", outcome: "timeout" });
      } else {
        const a = d.locks[s0]!;
        const b = d.locks[s1]!;
        pair.chain.push(a, b);
        pair.tries += 1;
        let outcome: Reveal["outcome"];
        if (sameWord(a, b)) {
          outcome = "meld";
          pair.meldedOn = pair.tries;
          pair.points = pointsFor(pair.tries);
        } else {
          outcome = soClose(a, b) ? "close" : "miss";
        }
        revealed.push({ pair: id, a, b, outcome });
      }
      d.locks[s0] = null;
      d.locks[s1] = null;
    }

    if (revealed.some((r) => r.outcome !== "timeout")) events.push({ t: "cue", kind: "countdown", amount: 3 });
    for (const r of revealed) {
      if (r.outcome === "timeout") continue;
      events.push({ t: "cue", kind: r.outcome, seat: d.pairs[r.pair]!.seats[0], amount: d.pairs[r.pair]!.tries });
    }

    d.reveal = revealed;
    d.tryNo += 1;
    d.window = null;

    // The first meld ends the round (the user, 2026-10-30): it is a race, and
    // whoever melds on the same reveal shares it. Everybody else scores
    // nothing for the round.
    const melded = revealed.some((r) => r.outcome === "meld");
    if (melded || d.pairs.every((p) => !isActive(p, d.rules))) {
      endRound(d, events);
    } else {
      d.window = openWindow(d);
    }
  }

  function endRound(d: MindMeldState, events: GameEvent[]): void {
    const deltas: Record<SeatId, number> = {};
    for (const pair of d.pairs) {
      for (const seat of pair.seats) {
        deltas[seat] = pair.points;
        d.scores[seat] = (d.scores[seat] ?? 0) + pair.points;
      }
    }

    // The round goes to the pair that earned most, the lower pair winning a tie
    // so a result is always a single seat (what the pod crown reads).
    let top = d.pairs[0]!;
    for (const pair of d.pairs) if (pair.points > top.points) top = pair;

    const result: RoundResult = {
      deltas,
      pairs: d.pairs.map((p) => ({ seats: p.seats, points: p.points, meldedOn: p.meldedOn, tries: p.tries, chain: [...p.chain] })),
      winner: top.seats[0],
      wentOut: null,
      blocked: false,
    };
    d.result = result;

    // The match ends after the last round, to whoever has the most - and a tie
    // plays on, up to a point, because a game with no winner is not a game.
    let matchWinner: SeatId | null = null;
    if (d.round >= d.rules.rounds) {
      const totals = d.pairs.map((p) => ({ pair: p, total: d.scores[p.seats[0]] ?? 0 }));
      const best = Math.max(...totals.map((t) => t.total));
      const leaders = totals.filter((t) => t.total === best);
      if (leaders.length === 1 || d.pairs.length === 1 || d.round >= d.rules.rounds + TIE_EXTRA_ROUNDS) {
        matchWinner = leaders[0]!.pair.seats[0];
      }
    }
    d.winner = matchWinner;

    events.push({ t: "score", deltas }, { t: "roundEnd", round: d.round });
    if (matchWinner !== null) events.push({ t: "gameEnd", winner: matchWinner });
  }

  /* ------------------------------------------------------------- turns */

  function currentSeat(state: MindMeldState): SeatId | null {
    if (state.winner !== null || state.result !== null || !state.dealt) return null;
    return state.window?.pending[0]?.seat ?? null;
  }

  function isRoundOver(state: MindMeldState): boolean {
    return state.result !== null;
  }

  function isOver(state: MindMeldState): boolean {
    return state.winner !== null;
  }

  function mayLock(state: MindMeldState, seat: SeatId): boolean {
    if (state.winner !== null || state.result !== null || !state.dealt) return false;
    return state.locks[seat] === null && activeSeats(state, schedule).includes(seat);
  }

  function legalActions(state: MindMeldState, seat: SeatId): MindMeldAction[] {
    // ONE representative: a word is anything, and `validate` is the real gate.
    return mayLock(state, seat) ? [{ t: "submit", seat, word: "" }] : [];
  }

  /**
   * The second gate. `legalActions` answers WHO may act; this answers whether
   * the word that arrived may be locked in - which is the only thing a player
   * can get wrong here, and reachable from a socket with anything at all.
   *
   * Everything refused is refused BEFORE the word is locked, so the cost of a
   * mistake falls on nobody but the person who made it: no try is spent and
   * nothing is shown.
   */
  function validate(state: MindMeldState, seat: SeatId, action: MindMeldAction): string | null {
    if (!action || typeof action !== "object") return "that is not an action";
    if (state.winner !== null) return "the match is over";
    if (state.result !== null) return "the round is over";
    if (!state.dealt) return "the round has not been dealt";

    if (action.t === "timeout") {
      return mayLock(state, seat) ? null : "this seat is not waiting on anything";
    }
    if (action.t !== "submit") return "unknown action";
    if (!mayLock(state, seat)) return "this seat has nothing to lock in";

    return wordProblem(state, seat, action.word);
  }

  /** Stamps the acting seat: a client that names another seat locks in for itself or not at all. */
  function completeAction(_state: MindMeldState, action: MindMeldAction, seat: SeatId): MindMeldAction {
    return action.t === "submit" ? { ...action, seat } : action;
  }

  /**
   * With a think time set, the clock a person is shown ends here and every
   * waiting pair forfeits the try - one deadline for the whole table, keyed by
   * try, so a reconnect or the next person's lock-in does not hand the time back.
   *
   * With none there is no deadline of the game's own, deliberately: the room's
   * turn timer then covers a person who has walked away, and what it plays for
   * them is a bot's word, which is a better outcome for their partner than a
   * forfeited try.
   */
  function deadline(state: MindMeldState, seat: SeatId) {
    if (!state.window || !mayLock(state, seat) || state.rules.thinkSeconds === 0) return null;
    const ms = state.rules.thinkSeconds * 1000 + THINK_GRACE_MS;
    return { ms, action: { t: "timeout" } as MindMeldAction, key: `mm:${state.round}:${state.tryNo}` };
  }

  /**
   * A bot waits out the rest of the time it takes to think of a word BEFORE it
   * answers - never less than the beat, so each lock-in lands on its own.
   */
  function turnHold(state: MindMeldState, seat?: SeatId): number | undefined {
    const w = state.window;
    if (!w) return undefined;
    const mine = w.pending.find((p) => p.seat === seat);
    if (!mine) return LOCK_BEAT_MS;
    return Math.max(LOCK_BEAT_MS, mine.ms - (w.elapsed ?? 0));
  }

  /**
   * What one seat is allowed to KNOW: everybody's chain (every word in it has
   * been revealed) and whose seats are still to lock in, but only its OWN
   * locked word. A word is a secret until it is shown, and nothing about it
   * - not its letters, not its length - may travel before that.
   */
  function playerView(state: MindMeldState, viewer: SeatId): MindMeldState {
    const locks: Record<SeatId, string | null> = {};
    for (let s = 0; s < state.seats; s++) {
      const seat = s as SeatId;
      const word = state.locks[seat] ?? null;
      locks[seat] = word === null ? null : seat === viewer ? word : HIDDEN_WORD;
    }
    return { ...state, locks };
  }

  return {
    id: "mindmeld",
    name: "Mind Meld",
    minSeats: MIN_SEATS,
    maxSeats: MAX_SEATS,
    setup,
    reduce,
    legalActions,
    validate,
    completeAction,
    // The reveal depends on words nobody here can see.
    unpredictable: () => true,
    // The round ends on a reveal - somebody's winning words - and the
    // scorecard must not cover them before they are read.
    roundHoldMs: ROUND_READ_MS,
    deadline,
    turnHold,
    pieces: (): Record<PieceId, PieceMeta> => ({}),
    placements: (): PlacementMap => ({}),
    playerView,
    currentSeat,
    isOver,
    startRound,
    isRoundOver,
    bots: makeBots(brain),
  };
}

export const mindmeld = createMindMeld();
