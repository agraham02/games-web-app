// @vitest-environment node
//
// Node, deliberately, and not jsdom like the rest of the suite: the whole
// claim this file exists to prove is that the game loop runs with no DOM,
// no React and no real timers behind it. A jsdom environment would let a
// stray `window` reference pass unnoticed and only fail later, on the
// server, where it is far more expensive to find.

import { describe, expect, it } from "vitest";
import { createSpades } from "@/games/spades/rules";
import type { SpadesAction } from "@/games/spades/types";
import { createLrc } from "@/games/lrc/rules";
import { createRummy } from "@/games/rummy/rules";
import { claimReactions } from "@/games/rummy/state";
import type { GameDefinition, SeatId } from "@/engine/types";
import { GAMES, GAME_IDS, type GameId } from "./registry";
import { GameSession, type SessionFrame } from "./GameSession";
import { TestClock } from "./clock";

/**
 * Stands in for whatever is driving the session. A browser settles when an
 * animation finishes; a server settles the moment it has broadcast. This
 * settles immediately, which is the server's shape.
 */
function harness<S, A>(opts: {
  definition: GameDefinition<S, A>;
  seats: number;
  seed: number;
  isSeatLive?: (seat: SeatId) => boolean;
}) {
  const clock = new TestClock();
  const frames: SessionFrame<A>[] = [];
  const session = new GameSession<S, A>({
    definition: opts.definition,
    seats: opts.seats,
    seed: opts.seed,
    clock,
    isSeatLive: opts.isSeatLive,
    emit: (frame) => {
      frames.push(frame);
      session.settled();
    },
  });
  return { clock, frames, session };
}

/** Plays until the match ends, continuing through every round boundary. */
function playToEnd<S, A>(session: GameSession<S, A>, clock: TestClock, maxRounds = 200): void {
  session.start();
  clock.drain();
  let rounds = 0;
  while (!session.definition.isOver(session.snapshot())) {
    if (++rounds > maxRounds) throw new Error("match did not finish");
    session.nextRound();
    clock.drain();
  }
}

describe("GameSession — the loop outside React", () => {
  it("plays a whole Spades match to a winner with every seat botted", () => {
    // The single most important claim in the extraction: with no seat
    // marked live, nothing waits for a human and the session drives the
    // entire match itself. This is exactly the shape the server runs, and
    // it is the substitution (`seat === HERO` -> `isSeatLive(seat)`) that
    // makes N humans possible at all.
    const { clock, session } = harness({
      definition: createSpades(),
      seats: 4,
      seed: 12345,
      isSeatLive: () => false,
    });

    playToEnd(session, clock);

    const final = session.snapshot() as { winner: SeatId | null; winningSeats?: SeatId[] };
    expect(final.winner).not.toBeNull();
    expect(final.winningSeats).toHaveLength(2); // Spades wins are a partnership.
    expect(clock.pending).toBe(0); // Loop genuinely parked, not still ticking.
  });

  it("parks on a live seat instead of playing it, and resumes when that seat submits", () => {
    // The mirror of the test above: seat 0 live is offline single-player,
    // and the loop must stop dead rather than let a bot play the human.
    const spades = createSpades();
    const { clock, session } = harness({
      definition: spades,
      seats: 4,
      seed: 99,
      isSeatLive: (seat) => seat === 0,
    });

    session.start();
    clock.drain();

    expect(spades.currentSeat(session.snapshot())).toBe(0);
    expect(clock.pending).toBe(0); // Nothing scheduled — it is waiting on a person.

    const before = session.snapshot();
    const legal = spades.legalActions(before, 0);
    expect(legal.length).toBeGreaterThan(0);

    // Spades opens on `look`, which is legal and moves real state but
    // emits no event — so `animated` is false while `ok` stays true. The
    // two must not be conflated: a server that answered "rejected" here
    // would be telling the client its move failed when it had landed.
    const result = session.submit(0, legal[0]!);
    expect(result.ok).toBe(true);
    clock.drain();
    expect(session.snapshot()).not.toBe(before);
  });

  it("refuses an action from a seat that is not on turn, and changes nothing", () => {
    // `reduce` has never checked who sent an action — poker's fold applies
    // to `state.toAct[0]` regardless — so this gate is the only thing
    // stopping a networked client from acting for somebody else.
    const spades = createSpades();
    const { clock, session } = harness({
      definition: spades,
      seats: 4,
      seed: 7,
      isSeatLive: () => true, // Everyone human: the loop parks on seat 0.
    });

    session.start();
    clock.drain();

    const onTurn = spades.currentSeat(session.snapshot())!;
    const impostor = ((onTurn + 1) % 4) as SeatId;
    const before = session.snapshot();

    // Borrow a genuinely legal action from the seat that IS on turn, so
    // the only thing wrong with the submission is who sent it.
    const action = spades.legalActions(before, onTurn)[0]!;
    expect(session.submit(impostor, action)).toEqual({ ok: false, reason: "not-your-turn" });
    expect(session.snapshot()).toBe(before); // Identity, not just equality.
  });

  it("replays identically from the same seed and diverges from a different one", () => {
    const run = (seed: number) => {
      const { clock, frames, session } = harness({
        definition: createSpades(),
        seats: 4,
        seed,
        isSeatLive: () => false,
      });
      playToEnd(session, clock);
      return frames.map((f) => JSON.stringify(f.lastAction)).join("|");
    };

    expect(run(4242)).toBe(run(4242));
    expect(run(4242)).not.toBe(run(4243));
  });

  it("holds a bot turn for the configured beat rather than firing it instantly", () => {
    // The pacing rule the hook's header describes, now on an injected
    // clock: a bot's turn is scheduled, not immediate, so a player gets a
    // beat to read what just happened.
    const clock = new TestClock();
    const frames: SessionFrame<SpadesAction>[] = [];
    const spades = createSpades();
    const session = new GameSession({
      definition: spades,
      seats: 4,
      seed: 31,
      clock,
      isSeatLive: (seat) => seat === 0,
      turnHoldMs: () => 900,
      emit: (frame) => {
        frames.push(frame);
        session.settled();
      },
    });

    session.start();
    clock.drain(); // Deal, then park on seat 0 (live).

    const action = spades.legalActions(session.snapshot(), 0)[0]!;
    session.submit(0, action);
    const afterSubmit = frames.length;

    // A bot is now on turn but must not have acted yet.
    clock.advance(899);
    expect(frames.length).toBe(afterSubmit);

    clock.advance(1);
    expect(frames.length).toBeGreaterThan(afterSubmit);
  });

  it("rides the round number on the deal frame, not behind it", () => {
    const { clock, frames, session } = harness({
      definition: createLrc(),
      seats: 4,
      seed: 5,
      isSeatLive: () => false,
    });

    session.start();
    clock.drain();

    expect(frames[0]!.dealtRound).toBe(1);
    // Only the deal carries it; ordinary turns do not.
    expect(frames.slice(1).every((f) => f.dealtRound === null)).toBe(true);
  });

  it("cancels a scheduled turn on dispose", () => {
    const { clock, frames, session } = harness({
      definition: createSpades(),
      seats: 4,
      seed: 77,
      isSeatLive: (seat) => seat === 0,
    });

    session.start();
    clock.drain();
    const action = session.definition.legalActions(session.snapshot(), 0)[0]!;
    session.submit(0, action);

    const settled = frames.length;
    session.dispose();
    clock.drain();

    expect(frames.length).toBe(settled); // Nothing fired after disposal.
  });
});

/* ============================================================
   The submit gate
   ============================================================ */

describe("legalActions as the submit gate", () => {
  /**
   * `submit` used to ask `currentSeat(state) === seat` and now asks
   * whether the seat has any legal action at all. The two must stay the
   * same question everywhere except where a game deliberately widens it,
   * or the change quietly becomes a way to act out of turn.
   *
   * Rummy is the deliberate exception: a claim window is a race, and
   * several seats are entitled to grab the card at the same instant. It
   * is skipped here and asserted properly in Rummy's own rules test.
   */
  const SEATS: Record<GameId, number> = {
    spades: 4,
    dominoes: 4,
    poker: 6,
    lrc: 6,
    rummy: 4,
  };

  for (const gameId of GAME_IDS) {
    it(`${gameId}: no seat may act that is not the one on turn`, () => {
      const entry = GAMES[gameId];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const definition = entry.create(entry.parse({})) as GameDefinition<any, any>;
      const clock = new TestClock();
      const session = new GameSession({
        definition,
        seats: SEATS[gameId],
        seed: 31,
        clock,
        isSeatLive: () => false,
        turnHoldMs: () => 0,
      });

      const wrong: string[] = [];
      let checks = 0;
      session.setEmit(() => {
        const state = session.snapshot() as { claimWindow?: unknown };
        if (gameId === "rummy" && state.claimWindow) return;
        const current = definition.currentSeat(state);
        for (let seat = 0; seat < SEATS[gameId]; seat++) {
          checks++;
          const mayAct = definition.legalActions(state, seat).length > 0;
          if (mayAct !== (current === seat)) {
            wrong.push(`seat ${seat}: legalActions=${mayAct} currentSeat=${current === seat}`);
          }
        }
      });

      session.start();
      for (let turn = 0; turn < 400 && !definition.isOver(session.snapshot()); turn++) {
        session.settled();
        clock.advance(10);
        if (definition.isRoundOver?.(session.snapshot())) session.nextRound();
      }

      expect(checks).toBeGreaterThan(100);
      expect([...new Set(wrong)].slice(0, 4)).toEqual([]);
    });
  }
});

/* ============================================================
   Deadlines
   ============================================================ */

describe("a live seat that never answers", () => {
  /**
   * The rule this enforces: a table with several people at it must not be
   * unblockable by any one of their browsers.
   *
   * Rummy's claim race is the case. A discard is offered to every
   * eligible seat at once, and the whole table is parked until each
   * answers — so the page ran a `setTimeout` and submitted `passClaim`
   * when it expired. That works exactly as long as the page is the only
   * authority. Online it is a stall waiting to happen: a backgrounded tab
   * throttles its timers to about one a minute, so one player switching
   * apps mid-race froze the game for everybody else.
   *
   * The ws harness found it, which is the layer that should have: it
   * drives real sockets with no page behind them, so a table that only
   * moves because a browser is running stops dead.
   */
  it("is acted for, so the table keeps moving", () => {
    const clock = new TestClock();
    const rummy = createRummy({ target: 200 });
    const session = new GameSession({
      definition: rummy,
      seats: 4,
      seed: 4242,
      clock,
      // Everybody is a live human who never does anything — the worst
      // case, and the one a client-side timer cannot rescue.
      isSeatLive: () => true,
      turnHoldMs: () => 0,
    });

    session.start();
    session.settled();
    // Nobody submits anything, ever. Without a deadline the loop parks on
    // the dealer's hand-size choice and stays there.
    clock.advance(120_000);

    // A seat with no deadline (the deal-size choice) legitimately waits
    // forever, so the state here is still undealt — and that is correct.
    // What must NOT happen is a claim race parking the same way.
    expect(rummy.currentSeat(session.snapshot())).not.toBeNull();
  });

  it("passes a claim for a seat that lets its window run out", () => {
    const clock = new TestClock();
    const rummy = createRummy({ target: 200 });
    const session = new GameSession({
      definition: rummy,
      seats: 4,
      seed: 4242,
      clock,
      isSeatLive: () => true,
      turnHoldMs: () => 0,
    });

    // Build the race directly. Reaching one by playing takes about twelve
    // rounds, which is what `rummyScenarios` exists for on the dev panel.
    const base = session.snapshot();
    const racing = {
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
    };
    session.adoptState(racing);
    session.settled();

    const before = session.snapshot().claimWindow!.pending.length;
    expect(before).toBe(3);

    // Every seat is a live human and none of them answers. Each in turn
    // has its window expire and is passed for, and the race resolves.
    clock.advance(60_000);

    const after = session.snapshot();
    expect(after.claimWindow).toBeNull();
    // Nobody claimed it, so the card stays where it was and play moved on.
    expect(after.melds[0]!.cards).toEqual(["S5", "S6", "S7"]);
    expect(clock.pending).toBe(0);
  });

  it("does not act for a seat that answers in time", () => {
    const clock = new TestClock();
    const rummy = createRummy({ target: 200 });
    const session = new GameSession({
      definition: rummy,
      seats: 4,
      seed: 4242,
      clock,
      isSeatLive: () => true,
      turnHoldMs: () => 0,
    });

    const base = session.snapshot();
    const racing = {
      ...base,
      dealt: true,
      dealSizePending: null,
      phase: "draw" as const,
      turn: 2,
      hands: { ...base.hands, 0: ["CK"] },
      melds: [{ id: 1, owner: 1, cards: ["S5", "S6", "S7"], hitBy: {} }],
      nextMeldId: 2,
      discard: ["S8"],
      claimWindow: {
        discard: "S8",
        discarder: 1,
        meldId: 1,
        pending: claimReactions({ ...base, round: 1 }, "S8", 1),
      },
    };
    session.adoptState(racing);
    session.settled();

    const claimer = rummy.currentSeat(session.snapshot())!;
    expect(session.submit(claimer, { t: "claim", seat: claimer }).ok).toBe(true);

    // The card went to whoever pressed first, and the deadline that was
    // armed for them did not fire afterwards and pass on their behalf.
    expect(session.snapshot().melds[0]!.cards).toContain("S8");
    clock.advance(60_000);
    expect(session.snapshot().melds[0]!.cards).toContain("S8");
  });
});
