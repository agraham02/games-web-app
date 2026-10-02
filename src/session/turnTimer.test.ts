// @vitest-environment node

/**
 * The turn timer, in the session: when a live seat's move is made for it,
 * what is played, and what everybody is shown.
 *
 * The user asked for this one to get "a lot of attention and testing", and
 * the shape of the risk is the same as every deadline here before it: the
 * table must be shown to MOVE (`TestClock` makes the timing exact), not
 * merely to have news. Two families of test:
 *
 * - timing, to the millisecond: lead + clock + grace, never refilled by a
 *   re-settle, never armed for a bot, never while a round is over;
 * - reachability: whole matches of every game with every seat a person who
 *   never presses anything, which can only end if EVERY decision point in
 *   every game has a move the timer can make.
 */

import { describe, expect, it } from "vitest";
import type { GameDefinition, GameEvent, SeatId } from "@/engine/types";
import { createSpades } from "@/games/spades/rules";
import type { SpadesAction, SpadesState } from "@/games/spades/types";
import { createPoker, timeoutAction as pokerTimeout } from "@/games/poker/rules";
import { SHOWDOWN_GRACE_MS, SHOWDOWN_MS } from "@/games/poker/state";
import type { PokerState } from "@/games/poker/types";
import { createRummy } from "@/games/rummy/rules";
import { CLAIM_GRACE_MS, claimReactions } from "@/games/rummy/state";
import type { RummyState } from "@/games/rummy/types";
import { GAMES, GAME_IDS, type GameId } from "./registry";
import { GameSession, TURN_GRACE_MS, type SessionFrame } from "./GameSession";
import { TestClock } from "./clock";

/** A table of people, settled the moment a frame goes out, as a server does. */
function table<S, A>(opts: {
  definition: GameDefinition<S, A>;
  seats: number;
  seed?: number;
  turnMs?: number | null;
  lead?: (now: number) => number;
  isSeatLive?: (seat: SeatId) => boolean;
}) {
  const clock = new TestClock();
  const frames: SessionFrame<A>[] = [];
  const session = new GameSession<S, A>({
    definition: opts.definition,
    seats: opts.seats,
    seed: opts.seed ?? 7,
    clock,
    isSeatLive: opts.isSeatLive ?? (() => true),
    turnHoldMs: () => 0,
    turnTimerMs: () => (opts.turnMs === undefined ? 5_000 : opts.turnMs),
    deadlineLeadMs: opts.lead ? () => opts.lead!(clock.now()) : undefined,
    emit: (frame) => {
      frames.push(frame);
      session.settled();
    },
  });
  return { clock, frames, session };
}

describe("the turn timer, to the millisecond", () => {
  it("makes the move at the clock's end plus the grace, and not a moment before", () => {
    const { clock, session, frames } = table({ definition: createSpades(), seats: 4 });
    session.start();
    const seat = session.definition.currentSeat(session.snapshot())!;
    const before = session.snapshot();

    clock.advance(5_000 + TURN_GRACE_MS - 1);
    expect(session.snapshot(), "inside the grace, the person may still move").toBe(before);
    clock.advance(1);
    expect(session.snapshot()).not.toBe(before);

    const made = frames.at(-1)!;
    expect(made.timedOut).toBe(seat);
    expect(made.lastAction?.seat).toBe(seat);
    // The table's toast, first in the frame.
    expect(made.events[0]).toMatchObject({ t: "announce", actor: seat, text: "ran out of time" });
  });

  it("shows everybody the clock ending at the clock's end, not the grace's", () => {
    const { clock, session } = table({ definition: createSpades(), seats: 4 });
    session.start();
    const shown = session.turnClock!;
    expect(shown.seat).toBe(session.definition.currentSeat(session.snapshot()));
    expect(shown.totalMs).toBe(5_000);
    expect(shown.endsAt).toBe(clock.now() + 5_000);
  });

  it("starts the clock after what is still playing on screen", () => {
    const { clock, session } = table({ definition: createSpades(), seats: 4, lead: () => 1_500 });
    session.start();
    expect(session.turnClock!.endsAt).toBe(clock.now() + 1_500 + 5_000);
    const before = session.snapshot();
    clock.advance(1_500 + 5_000 + TURN_GRACE_MS - 1);
    expect(session.snapshot()).toBe(before);
    clock.advance(1);
    expect(session.snapshot()).not.toBe(before);
  });

  it("takes a move made inside the grace, and leaves nothing behind to fire", () => {
    const { clock, session } = table({ definition: createSpades(), seats: 4 });
    session.start();
    const seat = session.definition.currentSeat(session.snapshot())!;
    clock.advance(5_000 + TURN_GRACE_MS - 1);
    const move = session.definition.legalActions(session.snapshot(), seat)[0]!;
    expect(session.submit(seat, move).ok).toBe(true);
    const afterPress = session.snapshot();

    // The next person's clock starts from the press — the old one is gone.
    clock.advance(5_000 + TURN_GRACE_MS - 1);
    expect(session.snapshot()).toBe(afterPress);
    clock.advance(1);
    expect(session.snapshot()).not.toBe(afterPress);
  });

  it("is not refilled when the table settles again over the same move", () => {
    // What another player dropping or coming back does. Refilled, a flaky
    // connection would be a way to hold the table for ever.
    const { clock, session } = table({
      definition: createSpades(),
      seats: 4,
      lead: (now) => Math.max(0, 1_000 - now),
    });
    session.start();
    const key = session.turnClock!.key;
    const before = session.snapshot();
    clock.advance(3_000);
    session.settled();
    expect(session.turnClock!.key).toBe(key);
    clock.advance(1_000 + 5_000 + TURN_GRACE_MS - 3_000 - 1);
    expect(session.snapshot(), "fired early").toBe(before);
    clock.advance(1);
    expect(session.snapshot()).not.toBe(before);
  });

  it("is never armed for a bot, nor shown for one", () => {
    const { clock, session } = table({ definition: createSpades(), seats: 4, isSeatLive: (s) => s === 0 });
    session.start();
    for (let i = 0; i < 200; i++) {
      const seat = session.definition.currentSeat(session.snapshot());
      if (seat === null || session.definition.isRoundOver?.(session.snapshot())) break;
      if (seat !== 0) expect(session.turnClock, `bot seat ${seat}`).toBeNull();
      else expect(session.turnClock?.seat).toBe(0);
      clock.advance(1_000);
    }
  });

  it("does nothing while it is off", () => {
    const { clock, session } = table({ definition: createSpades(), seats: 4, turnMs: null });
    session.start();
    expect(session.turnClock).toBeNull();
    const before = session.snapshot();
    clock.advance(600_000);
    expect(session.snapshot()).toBe(before);
  });

  it("does not run over a round's scorecard", () => {
    // Played to the end of a round, every move timed out.
    const { clock, session } = table({ definition: createSpades(), seats: 4 });
    session.start();
    clock.drain();
    expect(session.definition.isRoundOver?.(session.snapshot())).toBe(true);
    expect(session.turnClock).toBeNull();
    expect(clock.pending).toBe(0);
  });
});

describe("what is played", () => {
  it("never spends a poker player's chips: checks when free, folds when not", () => {
    const definition = createPoker(1_000, 20);
    const { clock, session, frames } = table({ definition, seats: 3 });
    session.start();
    for (let i = 0; i < 60; i++) {
      const state = session.snapshot() as PokerState;
      if (definition.isOver(state) || definition.isRoundOver?.(state)) break;
      const seat = definition.currentSeat(state)!;
      const expected = pokerTimeout(state, seat);
      const count = frames.length;
      clock.advance(5_000 + TURN_GRACE_MS + 10_000);
      const made = frames.slice(count).find((f) => f.timedOut === seat);
      if (made) expect(made.lastAction?.action).toEqual(expected);
    }
    // Over all those turns, nothing was ever bet or raised for anybody.
    for (const f of frames.filter((x) => x.timedOut !== undefined)) {
      expect(["check", "fold", "muck"]).toContain((f.lastAction?.action as { t: string }).t);
    }
  });

  it("mucks at a showdown on the game's own clock, timer or no timer", () => {
    // The page used to be the only thing that mucked, and a hidden tab
    // barely runs its timers: the table waited on it.
    const definition = createPoker(1_000, 20);
    const { clock, session } = table({ definition, seats: 3, turnMs: null });
    const base = session.snapshot();
    const seat: SeatId = 1;
    session.adoptState({
      ...base,
      pendingShowdown: { winningSeats: [0], order: [seat], pendingDeltas: {}, contested: [0, seat] },
    } as PokerState);
    expect(definition.currentSeat(session.snapshot())).toBe(seat);
    session.settled();
    const before = session.snapshot();
    clock.advance(SHOWDOWN_MS + SHOWDOWN_GRACE_MS - 1);
    expect(session.snapshot()).toBe(before);
    clock.advance(1);
    expect(session.snapshot()).not.toBe(before);
  });

  it("leaves a race's own clock alone: Rummy's claim window passes on time", () => {
    const definition = createRummy({ target: 200 });
    const { clock, session, frames } = table({ definition, seats: 4 });
    const base = session.snapshot();
    session.adoptState({
      ...base,
      dealt: true,
      dealSizePending: null,
      phase: "draw" as const,
      turn: 2,
      melds: [{ id: 1, owner: 1, cards: ["S5", "S6", "S7"], hitBy: {} }],
      nextMeldId: 2,
      discard: ["S8"],
      claimWindow: {
        discard: "S8",
        discarder: 1,
        meldId: 1,
        pending: claimReactions({ ...base, round: 1 }, "S8", 1),
      },
    } as RummyState);
    session.settled();
    // The race draws its own ring; the turn timer stays out of it.
    expect(session.turnClock).toBeNull();
    clock.advance(10_000 + CLAIM_GRACE_MS);
    const passes = frames.filter((f) => (f.lastAction?.action as { t?: string } | undefined)?.t === "passClaim");
    expect(passes.length).toBeGreaterThan(0);
    expect(frames.some((f) => f.timedOut !== undefined && f.lastAction?.action === undefined)).toBe(false);
  });
});

describe("every game, with nobody pressing anything", () => {
  // The shortest match each game allows, so the suite stays quick; every
  // seat is a person, every move is the timer's.
  const SHORT: Record<GameId, Record<string, unknown>> = {
    spades: { target: 100 },
    dominoes: {},
    poker: {},
    lrc: { target: 1 },
    rummy: { target: 100 },
    bs: { target: 1 },
  };
  const SEATS: Record<GameId, number> = { spades: 4, dominoes: 4, poker: 3, lrc: 3, rummy: 3, bs: 3 };

  for (const gameId of GAME_IDS) {
    it(`${gameId}: every decision has a move the timer can make`, () => {
      const entry = GAMES[gameId];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const definition = entry.create(entry.parse(SHORT[gameId])) as GameDefinition<any, any>;
      const { clock, session, frames } = table({ definition, seats: SEATS[gameId], seed: 3 });
      session.start();

      // Poker with nobody betting is blinds going round for ever: it is
      // held to many hands without a stall instead of to a winner.
      const rounds = gameId === "poker" ? 25 : 400;
      for (let r = 0; r < rounds && !definition.isOver(session.snapshot()); r++) {
        clock.drain();
        const state = session.snapshot();
        // A stall is a table with nothing scheduled that is neither
        // between rounds nor finished.
        expect(
          definition.isOver(state) || definition.isRoundOver?.(state),
          `${gameId} stalled mid-round`,
        ).toBe(true);
        session.nextRound();
      }
      if (gameId !== "poker") expect(definition.isOver(session.snapshot())).toBe(true);

      const timedOut = frames.filter((f) => f.timedOut !== undefined);
      // LRC included: its only move is a roll, which is forced, but the
      // clock here (5s) runs out long before FORCED_MOVE_MS would play it.
      expect(timedOut.length, "nothing was ever played for anybody").toBeGreaterThan(0);
      for (const f of timedOut) {
        const events = f.events as GameEvent[];
        expect(events[0]).toMatchObject({ t: "announce", text: "ran out of time" });
      }
      if (gameId === "spades") {
        // A timed-out Blind Nil vote is a bot's vote: it defers. Made
        // through `submit`, it would have been stamped a person's firm vote.
        const votes = timedOut
          .map((f) => f.lastAction?.action as SpadesAction)
          .filter((a): a is Extract<SpadesAction, { t: "blindVote" }> => a.t === "blindVote");
        expect(votes.length, "no blind vote was ever timed out, so nothing was tested").toBeGreaterThan(0);
        for (const v of votes) expect(v.defer).toBe(true);
      }
    });
  }
});

// Referenced so the type import is not unused when no Spades state is built.
export type { SpadesState };
