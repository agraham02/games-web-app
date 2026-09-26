// @vitest-environment node
//
// Node, deliberately, and not jsdom like the rest of the suite: the whole
// claim this file exists to prove is that the game loop runs with no DOM,
// no React and no real timers behind it. A jsdom environment would let a
// stray `window` reference pass unnoticed and only fail later, on the
// server, where it is far more expensive to find.

import { describe, expect, it } from "vitest";
import { blindVoteOpen, createSpades } from "@/games/spades/rules";
import type { SpadesAction, SpadesState } from "@/games/spades/types";
import { createLrc } from "@/games/lrc/rules";
import { createPoker, DEFAULT_BIG_BLIND, DEFAULT_STARTING_STACK } from "@/games/poker/rules";
import { betRange } from "@/games/poker/state";
import { createRummy } from "@/games/rummy/rules";
import { createBs } from "@/games/bs/rules";
import { REACTION_MAX as BS_REACTION_MAX } from "@/games/bs/state";
import type { BsAction, BsState } from "@/games/bs/types";
import { CLAIM_GRACE_MS, claimReactions } from "@/games/rummy/state";
import type { RummyAction, RummyState } from "@/games/rummy/types";
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
    // The game's own beat where it asks for one, as both real drivers
    // give it — a race's timing is decided here, so a flat hold would test
    // a race nobody plays.
    turnHoldMs: (state, seat) => opts.definition.turnHold?.(state, seat) ?? 900,
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

  /**
   * Settling twice for one position is ordinary, not hostile.
   *
   * `submit` emits even when a reduce produced no events — and there are
   * 33 such no-op paths across the five games — so a driver that settles
   * on every frame AND honours the `animated: false` contract asks twice
   * in a row. The room server is exactly that driver.
   *
   * The second ask used to arm a second hold timer and leak the first.
   * The leaked one then fired, nulled the handle to a live timer, and a
   * bot turn revealed with no hold at all while `advance()` ran a spare
   * time — a bot appearing to answer before it had thought.
   */
  it("arms one bot-turn timer however many times it is settled", () => {
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

    // `emit` already settled once. This is the driver's second ask.
    const armed = clock.pending;
    session.settled();
    session.settled();
    expect(clock.pending, "asking again must not arm another timer").toBe(armed);

    // And the beat is still honoured rather than collapsed.
    const afterSubmit = frames.length;
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
   The action gate
   ============================================================ */

/**
 * `legalActions` answers "may this seat act". It says nothing about
 * whether the action that ARRIVED is one of the things they may do — and
 * online, the action is arbitrary JSON off a socket. Offline the gap was
 * unreachable, because the only thing authoring actions was the UI's own
 * action bar; a room makes every one of these reachable by a player whose
 * turn it genuinely is.
 */
describe("validate — the action itself, not just the seat", () => {
  /** Runs the loop until seat 0 (the only live seat) is on turn. */
  function parkOnHero<S, A>(definition: GameDefinition<S, A>, seats: number, seed: number) {
    const h = harness({ definition, seats, seed, isSeatLive: (seat) => seat === 0 });
    h.session.start();
    h.clock.drain();
    return h;
  }

  it("spades: refuses a card the seat does not hold", () => {
    const spades = createSpades();
    const { session, clock } = parkOnHero(spades, 4, 31);

    // Bid it out so we reach the play phase with seat 0 on turn, which is
    // where the hole was. Bots move on the clock; seat 0 is the only live
    // seat, so it is the only one this drives by hand.
    let guard = 0;
    while (session.snapshot().phase !== "play" || spades.currentSeat(session.snapshot()) !== 0) {
      if (++guard > 200) throw new Error("never reached seat 0's turn to play");
      if (spades.currentSeat(session.snapshot()) === 0) {
        session.submit(0, spades.legalActions(session.snapshot(), 0)[0]!);
      }
      clock.drain();
    }

    const state = session.snapshot();
    const mine = new Set(state.hands[0] ?? []);
    // A real card, genuinely in the deck, that seat 0 does not hold —
    // which is to say, one sitting in somebody else's hand. Piece ids are
    // suit+rank and entirely guessable, so this is not a hard forgery.
    const theirs = Object.values(state.hands)
      .flat()
      .find((id) => !mine.has(id))!;
    expect(theirs, "the other seats should be holding cards").toBeTruthy();

    const before = JSON.stringify(session.snapshot());
    const result = session.submit(0, { t: "play", card: theirs });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("illegal-action");
    expect(JSON.stringify(session.snapshot()), "nothing should have moved").toBe(before);
  });

  it("poker: refuses a bet that is not a number, and keeps the money real", () => {
    // `Math.round("abc")` is NaN, `Math.max/min` propagate it, and
    // `if (added <= 0)` is FALSE for NaN — so this used to write straight
    // through into every stack and the table's money stayed NaN for the
    // rest of the match.
    const poker = createPoker(DEFAULT_STARTING_STACK, DEFAULT_BIG_BLIND);
    const { session } = parkOnHero(poker, 6, 9);

    const seat = poker.currentSeat(session.snapshot())!;
    expect(seat).toBe(0);

    for (const bad of ["abc", null, undefined, {}, [], Number.NaN, Infinity, -Infinity]) {
      const result = session.submit(seat, { t: "raise", to: bad } as never);
      expect(result.ok, `a bet of ${String(bad)} should be refused`).toBe(false);
    }

    const after = session.snapshot();
    for (const value of Object.values(after.stacks)) {
      expect(Number.isFinite(value), "every stack should still be a real number").toBe(true);
    }
  });

  it("poker: still allows any amount inside the range, not only the minimum", () => {
    // The reason poker cannot share `validateByEnumeration`: its
    // `legalActions` offers one representative of a continuous range, so
    // membership testing would refuse every bet but the smallest.
    const poker = createPoker(DEFAULT_STARTING_STACK, DEFAULT_BIG_BLIND);
    const { session } = parkOnHero(poker, 6, 9);

    const seat = poker.currentSeat(session.snapshot())!;
    const range = betRange(session.snapshot(), seat);
    const between = Math.floor((range.min + range.max) / 2);
    expect(between, "the test needs a range with room in it").toBeGreaterThan(range.min);

    expect(session.submit(seat, { t: "raise", to: between }).ok).toBe(true);
  });

  it("refuses an action of a type that is not on offer at all", () => {
    const spades = createSpades();
    const { session } = parkOnHero(spades, 4, 31);
    // Bidding is open; playing a card is not.
    const result = session.submit(0, { t: "play", card: "AS" } as never);
    expect(result.ok).toBe(false);
  });
});

describe("legalActions as the submit gate", () => {
  /**
   * `submit` used to ask `currentSeat(state) === seat` and now asks whether
   * the seat has any legal action at all. The two must stay the same question
   * everywhere except where a game deliberately widens it, or the change
   * quietly becomes a way to act out of turn.
   *
   * Two games widen it, both for the same reason: a race. Rummy's claim
   * window entitles every seat still in the race to grab the same discard,
   * and BS's challenge window entitles every seat but the claimer to doubt a
   * play, and nobody to play (the seat on turn used to be able to play over
   * the top of an open window). In both, `currentSeat` names only the seat
   * the PACING waits on.
   *
   * Those two are ASSERTED here rather than skipped, which is the difference
   * that matters. The first version of this returned early whenever a window
   * was open — but a window is exactly when an out-of-turn bug is reachable,
   * so the exemption was a hole in the check rather than a narrowing of it,
   * and it covered the one game that opens a window after every single play.
   * Now each race states the set of seats it means to entitle, and anything
   * outside that set is a failure like any other.
   */
  const SEATS: Record<GameId, number> = {
    spades: 4,
    dominoes: 4,
    poker: 6,
    lrc: 6,
    rummy: 4,
    bs: 4,
  };

  /** Seats a race in progress entitles, or null when no race is open. */
  type Racing = { seats: Set<number>; why: string } | null;

  function raceEntitles(gameId: GameId, state: unknown): Racing {
    const s = state as {
      claimWindow?: { pending: ReadonlyArray<{ seat: number }> } | null;
      window?: { pending: ReadonlyArray<{ seat: number }> } | null;
      turn?: number;
    };
    if (gameId === "rummy" && s.claimWindow) {
      return {
        seats: new Set(s.claimWindow.pending.map((p) => p.seat)),
        why: "everyone still in the claim race, and nobody else",
      };
    }
    if (gameId === "bs" && s.window) {
      const seats = new Set(s.window.pending.map((p) => p.seat));
      return { seats, why: "everyone still able to doubt the play, and nobody else" };
    }
    if (gameId === "spades") {
      // The blind vote: both partners of a trailing team, at once.
      const sp = state as SpadesState;
      const seats = ([0, 1, 2, 3] as SeatId[]).filter((x) => blindVoteOpen(sp, x) && !sp.blindVotes[x]);
      if (seats.length > 0) return { seats: new Set(seats), why: "both partners on a blind vote who have not voted" };
    }
    return null;
  }

  for (const gameId of GAME_IDS) {
    it(`${gameId}: no seat may act that the game has not entitled`, () => {
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
      let raced = 0;
      session.setEmit(() => {
        const state = session.snapshot();
        const race = raceEntitles(gameId, state);
        const current = definition.currentSeat(state);
        if (race) {
          raced++;
          // The seat the pacing waits on must be one of the entitled, or the
          // table is parked on somebody who cannot act.
          if (current !== null && !race.seats.has(current)) {
            wrong.push(`currentSeat ${current} is not entitled during a race`);
          }
        }
        const expected = race ? race.seats : new Set(current === null ? [] : [current]);
        for (let seat = 0; seat < SEATS[gameId]; seat++) {
          checks++;
          const mayAct = definition.legalActions(state, seat).length > 0;
          if (mayAct !== expected.has(seat)) {
            wrong.push(
              `seat ${seat}: legalActions=${mayAct} entitled=${expected.has(seat)}` +
                (race ? ` (${race.why})` : ""),
            );
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

      // Guards the guard for the game that is meant to race constantly: BS
      // opens a window after every play, so a run that saw none would mean
      // the widened branch above went untested and this whole test had
      // quietly narrowed back to the ordinary rule.
      //
      // Rummy is deliberately not asserted: its claim window opens about
      // once every twelve rounds, so a 400-turn run genuinely may see none,
      // and its own rules test constructs the race directly.
      if (gameId === "bs") {
        expect(raced, "BS should have raced constantly and did not race at all")
          .toBeGreaterThan(20);
      }
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

/**
 * Rummy's claim race is decided when the ring says it is.
 *
 * Found online with two people and two bots: a player pressed "Rummy!"
 * with time left on the ring and a bot got the card. The bot claimed after
 * the table's flat 900ms beat and spent its reaction time as a `think`
 * AFTER the claim — so the card was gone on the server while the ring
 * still ran. These drive the session the way both drivers do, with the
 * game's own `turnHold`.
 */
describe("the claim race", () => {
  function race(
    pending: Array<{ seat: number; ms: number }>,
    live: (seat: number) => boolean,
  ) {
    const clock = new TestClock();
    const rummy = createRummy({ target: 200 });
    const session = new GameSession({
      definition: rummy,
      seats: 4,
      seed: 4242,
      clock,
      isSeatLive: live,
      turnHoldMs: (state, seat) => rummy.turnHold?.(state, seat) ?? 900,
    });
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
      claimWindow: { discard: "S8", discarder: 1, meldId: 1, pending },
    });
    session.settled();
    return { clock, rummy, session };
  }
  const claimedBy = (session: GameSession<RummyState, RummyAction>) =>
    session.snapshot().melds[0]!.hitBy["S8"];

  it("lets a person win with a press just inside the fastest bot's time", () => {
    const { clock, session } = race(
      [
        { seat: 3, ms: 2000 },
        { seat: 0, ms: 3000 },
        { seat: 2, ms: 4000 },
      ],
      (s) => s === 0,
    );
    clock.advance(1950);
    expect(session.snapshot().claimWindow, "the bot claimed before its time").not.toBeNull();
    expect(session.submit(0, { t: "claim", seat: 0 }).ok).toBe(true);
    expect(claimedBy(session)).toBe(0);
  });

  it("gives the card to the bot when its time comes", () => {
    const { clock, session } = race(
      [
        { seat: 3, ms: 2000 },
        { seat: 0, ms: 3000 },
        { seat: 2, ms: 4000 },
      ],
      (s) => s === 0,
    );
    clock.advance(2001);
    expect(claimedBy(session)).toBe(3);
  });

  it("does not start a bot's clock again after a person lets the card go", () => {
    // The person is first in the list, so the table waits on them. Their
    // ring runs out at the bot's time; the bot has already waited that long.
    const { clock, rummy, session } = race(
      [
        { seat: 0, ms: 1200 },
        { seat: 3, ms: 2000 },
        { seat: 2, ms: 4000 },
      ],
      (s) => s === 0,
    );
    expect(rummy.deadline!(session.snapshot(), 0, (s) => s === 0)!.ms).toBe(2000 + CLAIM_GRACE_MS);
    clock.advance(2000);
    // What the person's own ring submits when it runs out.
    expect(session.submit(0, { t: "passClaim", seat: 0 }).ok).toBe(true);
    session.settled();
    clock.advance(1);
    expect(claimedBy(session)).toBe(3);
  });

  it("races two people against the bot, not against each other", () => {
    // Seat 0's reaction time used to be seat 2's deadline — 1.2s — though
    // nobody was ever going to claim at that moment.
    const { clock, rummy, session } = race(
      [
        { seat: 0, ms: 1200 },
        { seat: 2, ms: 1500 },
        { seat: 3, ms: 3000 },
      ],
      (s) => s === 0 || s === 2,
    );
    const live = (s: number) => s === 0 || s === 2;
    expect(rummy.deadline!(session.snapshot(), 2, live)!.ms).toBe(3000 + CLAIM_GRACE_MS);
    clock.advance(2500);
    expect(session.submit(2, { t: "claim", seat: 2 }).ok).toBe(true);
    expect(claimedBy(session)).toBe(2);
  });
});

/**
 * BS runs a challenge race after EVERY play, which makes it by far the
 * heaviest user of the three things Rummy's claim window grew: several seats
 * entitled at once, `deadline` as the only thing that can unblock them, and
 * now `turnHold` so the seats nobody is sitting in answer in a flicker.
 */
describe("GameSession — BS's challenge window", () => {
  const bsDef = createBs({ target: 2, windowMs: 5000 });

  /**
   * Plays until a window is open with `live` still entitled to answer it.
   *
   * Steps the clock in small slices rather than draining it, deliberately: a
   * drain would run the live seat's own deadline too and resolve the very
   * window this is trying to stop on.
   */
  function untilWindow(live: SeatId) {
    const { clock, session } = harness({
      definition: bsDef,
      seats: 4,
      seed: 21,
      isSeatLive: (seat) => seat === live,
    });
    session.start();
    for (let i = 0; i < 4000; i++) {
      const state = session.snapshot();
      if (state.window !== null && state.window.pending.some((p) => p.seat === live)) {
        return { clock, session, state };
      }
      if (bsDef.isOver(state)) break;
      if (bsDef.isRoundOver!(state)) {
        session.nextRound();
        continue;
      }
      // Parked on the person for an ordinary turn: unblock it by playing.
      if (bsDef.currentSeat(state) === live) {
        const legal = bsDef.legalActions(state, live);
        if (legal.length === 0) break;
        session.submit(live, legal[legal.length - 1]!);
        continue;
      }
      if (clock.pending === 0) break;
      clock.advance(20);
    }
    throw new Error("never reached a window with that seat entitled");
  }

  it("lets a live seat win the race from further down the queue", () => {
    // The whole mechanic. `currentSeat` names only the seat the pacing waits
    // on, so a person two or three deep is still entitled — and `submit`
    // gates on `legalActions`, not on `currentSeat`, which is what makes
    // being quick beat being early in the list.
    const { session, state } = untilWindow(2);
    const order = state.window!.pending.map((p) => p.seat);
    expect(order.length).toBeGreaterThan(1);
    if (order[0] === 2) return; // Already first; nothing to prove here.

    expect(bsDef.currentSeat(state)).not.toBe(2);
    const result = session.submit(2, { t: "callBs", seat: 2 });
    expect(result.ok).toBe(true);
    expect(session.snapshot().reveal?.caller).toBe(2);
  });

  it("never leaves the table parked on a window nobody answers", () => {
    // The stall this shape is most prone to, and the instrument that catches
    // it: a table that has stopped simply has nothing pending. Every other
    // signal — a frame arriving, a badge flipping — can look perfectly
    // healthy while the game has quietly died.
    const { clock, session } = untilWindow(3);
    expect(clock.pending, "a live seat's window must arm a deadline")
      .toBeGreaterThan(0);
    clock.drain();
    const after = session.snapshot();
    // Whatever happened, the window resolved: the seat let it go on the
    // deadline, or somebody called and the pile moved.
    expect(after.window === null || after.window.pending.every((p) => p.seat !== 3)).toBe(true);
  });

  it("plays a whole match out with nobody sitting anywhere", () => {
    const { clock, session } = harness({
      definition: bsDef,
      seats: 4,
      seed: 808,
      isSeatLive: () => false,
    });
    playToEnd(session, clock);
    expect(session.snapshot().winner).not.toBeNull();
    expect(clock.pending, "the loop is parked, not still ticking").toBe(0);
  });

  it("spends a window's reaction times once, not the flat beat per seat", () => {
    // Without `turnHold` every seat that lets a play go cost the driver's
    // full 900ms, so three opponents meant nearly three seconds of blank
    // table after every single play. Each bot now waits the rest of its own
    // reaction time, so a whole window costs about the longest one.
    const { state } = untilWindow(1);
    const seat = bsDef.currentSeat(state)!;
    const mine = state.window!.pending.find((p) => p.seat === seat)!;
    expect(bsDef.turnHold!(state, seat)).toBeLessThanOrEqual(Math.max(120, mine.ms));
    expect(bsDef.turnHold!(state, seat)).toBeLessThanOrEqual(BS_REACTION_MAX);
    const quiet = { ...state, window: null, pendingTake: null };
    expect(bsDef.turnHold!(quiet, 0)).toBeUndefined();
  });

  it("lets a person beat a bot ahead of them while that bot is still reacting", () => {
    // The Rummy bug, BS-shaped: the bot's answer used to be made after the
    // 120ms beat, with its reaction time played on screen afterwards.
    const { clock, session, state } = untilWindow(2);
    // A bot ahead of the person, slow enough to race. Built rather than
    // found, so the race is the same on every run.
    const bot = state.window!.pending.find((p) => p.seat !== 2)!.seat;
    session.adoptState({
      ...state,
      window: {
        ...state.window!,
        pending: [
          { seat: bot, ms: 1500 },
          { seat: 2, ms: 1700 },
        ],
      },
    });
    session.settled();
    clock.advance(1350);
    // The bot has not answered yet: its pod is still reacting on screen,
    // and on the server too.
    expect(session.snapshot().window?.pending.some((p) => p.seat === bot)).toBe(true);
    expect(session.submit(2, { t: "callBs", seat: 2 }).ok).toBe(true);
    expect(session.snapshot().reveal?.caller).toBe(2);
  });
});

/**
 * Two ways a timer could act for somebody after the moment it was armed for
 * had passed. Both are BS-shaped because BS is the game that opens a race
 * after every play, but neither is a BS rule - they are both the session's.
 */
describe("GameSession — a timer belongs to the position that armed it", () => {
  const bsDef = createBs({ target: 2, windowMs: 5000 });


  /**
   * Seeds and live-seat sets that reach the position: a bot's turn waiting
   * out its hold while a person acts first. It was reached by a person
   * playing over the top of an open window until that was ruled out
   * (2026-09-25); now it is a person answering a window while a bot ahead
   * of them in it is still reacting, which is ordinary play.
   */
  const INTERRUPTED: [number, SeatId[]][] = [
    [1, [0, 1]],
    [5, [0, 1]],
    [6, [0, 1]],
    [8, [0, 1, 2]],
  ];

  it("never computes a bot's turn from a position the game has left", () => {
    // The pile is the visible half of this. A bot's turn used to be stashed
    // as a SNAPSHOT of the position it was scheduled for, and nothing
    // cleared it when somebody acted first - so the hold fired, reduced the
    // stale snapshot and assigned it wholesale, and the play that had just
    // landed was silently rolled back, cards and all.
    //
    // Asserted on every emitted frame rather than at the end, because the
    // rewind HEALS: the bot turns that follow push fresh plays onto the
    // pile, so one check afterwards reads as though nothing happened.
    const bsDef = createBs({ target: 5, windowMs: 5000 });
    const violations: string[] = [];

    for (const [seed, liveSeats] of INTERRUPTED) {
      const clock = new TestClock();
      let prev: BsState | null = null;
      const session: GameSession<BsState, BsAction> = new GameSession<BsState, BsAction>({
        definition: bsDef,
        seats: 4,
        seed,
        clock,
        isSeatLive: (seat) => liveSeats.includes(seat),
        emit: () => {
          const now = session.snapshot();
          // An answer undone: the same window, with a seat back in it.
          if (
            prev !== null &&
            prev.window !== null &&
            now.window !== null &&
            now.window.play === prev.window.play &&
            now.window.pending.some((p) => !prev!.window!.pending.some((q) => q.seat === p.seat))
          ) {
            violations.push(`seed ${seed}: a window answer was rolled back`);
          }
          if (prev !== null && now.plays.length < prev.plays.length) {
            // The pile legitimately empties two ways: somebody swallows it
            // after a challenge, or the round ends. Anything else that
            // shortens it is a position being undone.
            const explained =
              prev.pendingTake !== null || prev.result !== null || now.result !== null;
            if (!explained) {
              violations.push(
                `seed ${seed}: pile went ${prev.plays.length} -> ${now.plays.length}`,
              );
            }
          }
          prev = now;
          session.settled();
        },
      });

      session.start();
      for (let i = 0; i < 2000; i++) {
        const state = session.snapshot();
        if (bsDef.isOver(state)) break;
        if (bsDef.isRoundOver!(state)) {
          session.nextRound();
          continue;
        }
        // A person lets a window go the moment it reaches them, even while
        // a bot ahead of them is still reacting — and plays as soon as they
        // may.
        const answering = liveSeats.find(
          (seat) => state.window?.pending.some((p) => p.seat === seat) ?? false,
        );
        if (answering !== undefined) {
          session.submit(answering, { t: "declineBs", seat: answering });
          continue;
        }
        if (liveSeats.includes(state.turn)) {
          const plays = bsDef.legalActions(state, state.turn).filter((a) => a.t === "play");
          if (plays.length > 0) {
            session.submit(state.turn, plays[plays.length - 1]!);
            continue;
          }
        }
        if (clock.pending === 0) break;
        clock.advance(10);
      }
    }

    expect(violations).toEqual([]);
  });

  it("does not let a departed seat's deadline fire into a later window", () => {
    // A deadline is armed for a live seat that owes an answer. If that seat
    // stops being live, a bot answers for it within a beat and play moves
    // on - but the orphaned timer was still out there, and BS opens a fresh
    // window after every play, so when it fired the seat was legitimately
    // entitled again and it declined a challenge nobody had been shown.
    // One person at a table of bots, so the game actually moves.
    let present = true;
    const { clock, session } = harness({
      definition: bsDef,
      seats: 4,
      seed: 21,
      isSeatLive: (seat) => present && seat === 2,
    });
    session.start();

    // Reach a window seat 2 owes an answer to, which is what arms its
    // deadline. Stepped in slices rather than drained, or the deadline
    // this is about would resolve the very window it is waiting for.
    let armed = false;
    for (let i = 0; i < 4000 && !armed; i++) {
      const state = session.snapshot();
      if (state.window !== null && state.window.pending.some((x) => x.seat === 2)) {
        armed = true;
        break;
      }
      if (bsDef.isOver(state)) break;
      if (bsDef.isRoundOver!(state)) {
        session.nextRound();
        continue;
      }
      if (bsDef.currentSeat(state) === 2) {
        const legal = bsDef.legalActions(state, 2);
        if (legal.length === 0) break;
        session.submit(2, legal[legal.length - 1]!);
        continue;
      }
      if (clock.pending === 0) break;
      clock.advance(20);
    }
    expect(armed).toBe(true);

    // They leave. The liveness edge settles, which is what hands the seat
    // to a bot - and from that moment nothing may still be armed to act on
    // the departed person's behalf. Checked BEFORE draining, deliberately:
    // a drain runs every timer and then reports none left, so it cannot
    // tell an orphan that fired from one that was never there. What is
    // SCHEDULED is the whole question.
    //
    // Exactly one thing belongs here: the bot's turn. The orphaned deadline
    // used to sit beside it and fire ten seconds later, into a window the
    // seat had become entitled to all over again, declining a challenge
    // nobody had been shown.
    present = false;
    session.settled();
    expect(clock.pending).toBe(1);

    // And the table still carries on by itself.
    const before = session.snapshot();
    clock.drain();
    expect(session.snapshot()).not.toBe(before);
  });
});

describe("GameSession — one window is one wait", () => {
  const bsDef = createBs({ target: 5, windowMs: 5000 });

  /** Plays until `seat` is the one the table is waiting on in a window. */
  function untilWaitingOn(seat: SeatId) {
    const clock = new TestClock();
    const session: GameSession<BsState, BsAction> = new GameSession<BsState, BsAction>({
      definition: bsDef,
      seats: 4,
      seed: 3,
      clock,
      isSeatLive: (s) => s === seat,
      emit: () => session.settled(),
    });
    session.start();
    for (let i = 0; i < 4000; i++) {
      const state = session.snapshot();
      if (
        state.window !== null &&
        state.window.pending.some((x) => x.seat === seat) &&
        bsDef.currentSeat(state) === seat
      ) {
        return { clock, session };
      }
      if (bsDef.isOver(state)) break;
      if (bsDef.isRoundOver!(state)) {
        session.nextRound();
        continue;
      }
      if (bsDef.currentSeat(state) === seat) {
        const legal = bsDef.legalActions(state, seat);
        if (legal.length === 0) break;
        session.submit(seat, legal[legal.length - 1]!);
        continue;
      }
      if (clock.pending === 0) break;
      clock.advance(20);
    }
    throw new Error("never reached a window waiting on that seat");
  }

  it("does not hand a seat its window back when it is asked again", () => {
    // A deadline is re-armed on every settle, and `settled()` is reached
    // from far more than the seat's own move: a reconnect, a liveness
    // change, any frame at all. Each one used to restart the countdown
    // from full, so refreshing the page was a free extension of your own
    // window - and a table with anything going on could keep a person's
    // deadline alive indefinitely without them ever answering.
    const { clock, session } = untilWaitingOn(1);
    const opened = clock.now();

    // Burn most of the window, then be asked again - which is exactly
    // what a reconnect does.
    clock.advance(4000);
    session.settled();

    // Let it expire. If being asked again restarted the clock, this needs
    // a further full window; if it resumed, it is nearly up already.
    for (let i = 0; i < 400 && clock.pending > 0; i++) {
      if (!bsDef.legalActions(session.snapshot(), 1).some((a) => a.t === "declineBs")) break;
      clock.advance(50);
    }

    const total = clock.now() - opened;
    expect(total).toBeGreaterThanOrEqual(5000);
    // The window plus its grace, and nothing like a second one.
    expect(total).toBeLessThan(5000 + 2000);
  });
});

/**
 * The gates a game must have to be safe on a socket, asserted from the
 * REGISTRY rather than from a list written here.
 *
 * Both of the holes below were found by reading, not by a failing test,
 * and both would have been inherited in silence by a seventh game: the
 * per-game `describe`s elsewhere in this file name spades and poker, so
 * adding a game adds no coverage to them at all.
 */
describe("every online game brings its own gates", () => {
  /**
   * A game may decline `validate` only with a reason, and only when
   * something else is genuinely checking the action.
   *
   * LRC is the one: rolling is its only move, and `completeAction`
   * re-rolls the dice server-side against the session's own generator, so
   * nothing a client puts in the action survives to reach `reduce`. That
   * is a real argument. "The UI would never send that" is not.
   */
  const NO_VALIDATE: Partial<Record<GameId, string>> = {
    lrc: "rolling is the only move and completeAction re-rolls it server-side",
  };

  for (const gameId of GAME_IDS) {
    const entry = GAMES[gameId];
    if (!entry.online) continue;

    it(`${gameId}: checks the action, not just the seat`, () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const definition = entry.create(entry.parse({})) as GameDefinition<any, any>;
      const excused = NO_VALIDATE[gameId];

      if (definition.validate) {
        // A gate that is present must also be a gate: it has to refuse
        // something. Garbage off a socket is the cheapest proof, and it
        // must be REFUSED rather than thrown on - an exception here
        // reaches the router as a generic bad-message and a log line per
        // attempt.
        //
        // Asked of a DEALT position, deliberately. A fresh `setup()` is
        // undealt, and several games answer "the round has not been dealt"
        // before they look at the action at all - so a sweep run against
        // one proves nothing about the parsing underneath.
        const clock = new TestClock();
        const session = new GameSession({
          definition,
          seats: entry.minSeats,
          seed: 5,
          clock,
          isSeatLive: () => true, // Nobody acts, so the deal is all that runs.
        });
        session.start();
        clock.drain();
        const state = session.snapshot();

        for (const bad of [undefined, null, "play", 7, {}, { t: "nonsense" }]) {
          expect(() => definition.validate!(state, 0, bad as never)).not.toThrow();
        }
        expect(definition.validate(state, 0, { t: "nonsense" } as never)).not.toBeNull();
        return;
      }

      // No gate, so there had better be a stated reason.
      expect(excused, `${gameId} has no validate() and no reason on record`).toBeTruthy();
      expect(definition.completeAction, `${gameId} is excused as ${excused}`).toBeTruthy();
    });
  }
});
