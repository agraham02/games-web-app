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
import type { GameDefinition, SeatId } from "@/engine/types";
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
