// @vitest-environment node

/**
 * A move that is no choice at all plays itself after `FORCED_MOVE_MS` (the
 * user, 2026-09-29: "the last card in hand in Spades, passing in Dominoes,
 * rolling in LRC").
 *
 * Two halves, because there are two ways to get it wrong:
 *
 * - WHICH moves. "Exactly one legal action" is not the rule: a Spades
 *   singleton in the suit led is one legal action too, and a card that
 *   lands exactly when the wait runs out tells the table it was a singleton. So
 *   every game's `forcedMove` is held, across real matches, to answering
 *   only when the move is both the only legal one AND forced for a reason
 *   the whole table can already see — and the private cases are counted, so
 *   a test that never met one cannot pass.
 * - WHEN. `FORCED_MOVE_MS` from when the player could first move, never
 *   refilled by the table settling again over the same position.
 */

import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import type { GameDefinition, SeatId } from "@/engine/types";
import { createLrc } from "@/games/lrc/rules";
import type { LrcState } from "@/games/lrc/types";
import { GAMES, GAME_IDS, type GameId } from "./registry";
import { FORCED_MOVE_MS, GameSession } from "./GameSession";
import { TestClock } from "./clock";

/** The hand a card or tile game keeps per seat, where it has one. */
function handOf(state: unknown, seat: SeatId): readonly string[] | null {
  const hands = (state as { hands?: Record<SeatId, readonly string[]> }).hands;
  return hands?.[seat] ?? null;
}

/**
 * Why a forced move may be made for somebody: something everybody at the
 * table can see. Returns a failure message, or null when it is fine.
 */
function publicReason(game: GameId, state: unknown, seat: SeatId, action: { t: string }): string | null {
  const cards = handOf(state, seat)?.length ?? 0;
  switch (game) {
    case "spades":
    case "bs":
      return cards === 1 ? null : `a ${game} play forced with ${cards} cards in hand`;
    case "dominoes":
      if (action.t === "draw" || action.t === "pass") return null;
      return cards === 1 ? null : `a domino played for somebody holding ${cards}`;
    case "lrc":
      return action.t === "roll" ? null : `LRC forced a ${action.t}`;
    case "rummy":
      if (action.t === "drawStock") {
        const pile = (state as { discard: readonly string[] }).discard.length;
        return pile === 0 ? null : `a stock draw forced with ${pile} on the discard pile`;
      }
      if (action.t === "discard") return cards === 1 ? null : `a discard forced with ${cards} in hand`;
      return `Rummy forced a ${action.t}`;
    case "poker":
      return "poker has no forced move";
  }
}

describe("which moves are forced", () => {
  // Bots play whole stretches of each game; every seat is checked at every
  // position, which is far more positions than any one scripted test.
  for (const game of GAME_IDS) {
    it(`${game}: only the only move, and only when the table can already see why`, () => {
      const entry = GAMES[game];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const def: GameDefinition<any, any> = entry.create(entry.parse({}));
      const seats = entry.defaultSeats;
      let forcedSeen = 0;
      /** One legal move, but a private one — must NOT be forced. */
      let privateOnly = 0;

      for (const seed of [11, 22, 33]) {
        const rng = createRng(seed);
        let state = def.setup({ seats, rng });
        if (def.startRound) state = def.startRound(state, rng).state;

        for (let step = 0; step < 2_500 && !def.isOver(state); step++) {
          if (def.isRoundOver?.(state)) {
            state = def.startRound!(state, rng).state;
            continue;
          }
          for (let seat = 0; seat < seats; seat++) {
            const legal = def.legalActions(state, seat);
            const forced = def.forcedMove?.(state, seat) ?? null;
            if (forced !== null) {
              forcedSeen++;
              expect(legal, `${game}: a forced move must be the only legal one`).toHaveLength(1);
              expect(forced).toEqual(legal[0]);
              expect(publicReason(game, state, seat, forced)).toBeNull();
            } else if (legal.length === 1 && (handOf(state, seat)?.length ?? 0) > 1) {
              privateOnly++;
            }
          }
          const seat = def.currentSeat(state);
          if (seat === null) break;
          const action = def.bots.steady.choose(def.playerView(state, seat), seat, rng);
          state = def.reduce(state, action).state;
        }
      }

      if (game === "poker") {
        expect(forcedSeen).toBe(0);
        return;
      }
      expect(forcedSeen, `${game}: never met a forced move, so nothing was tested`).toBeGreaterThan(0);
      if (game === "spades" || game === "dominoes") {
        // The cases the rule exists for: one legal move from a bigger hand.
        expect(privateOnly, `${game}: never met a private one-move position`).toBeGreaterThan(0);
      }
    });
  }
});

describe("a forced move plays itself", () => {
  /** An LRC table where every seat is a person who never presses anything. */
  function silentLrc(opts: { lead?: number | ((now: number) => number) } = {}) {
    const clock = new TestClock();
    const definition = createLrc(3);
    const session = new GameSession<LrcState, unknown>({
      definition: definition as GameDefinition<LrcState, unknown>,
      seats: 3,
      seed: 99,
      clock,
      isSeatLive: () => true,
      turnHoldMs: () => 0,
      deadlineLeadMs:
        opts.lead === undefined
          ? undefined
          : () => (typeof opts.lead === "function" ? opts.lead(clock.now()) : opts.lead!),
      emit: () => session.settled(),
    });
    return { clock, session, definition };
  }

  it("after exactly FORCED_MOVE_MS, and not a moment before", () => {
    const { clock, session } = silentLrc();
    session.start();
    const before = session.snapshot();

    clock.advance(FORCED_MOVE_MS - 1);
    expect(session.snapshot()).toBe(before);

    clock.advance(1);
    expect(session.snapshot()).not.toBe(before);
  });

  it("starts the wait after whatever is still playing", () => {
    const { clock, session } = silentLrc({ lead: 1_200 });
    session.start();
    const before = session.snapshot();

    clock.advance(1_200 + FORCED_MOVE_MS - 1);
    expect(session.snapshot()).toBe(before);
    clock.advance(1);
    expect(session.snapshot()).not.toBe(before);
  });

  it("lets the player make it first, and leaves nothing behind to fire", () => {
    const { clock, session, definition } = silentLrc();
    session.start();
    const seat = definition.currentSeat(session.snapshot())!;
    clock.advance(4_000);
    expect(session.submit(seat, { t: "roll", dice: [] }).ok).toBe(true);
    const afterPress = session.snapshot();

    // The next seat's own wait starts from the press, not from the
    // first seat's deadline.
    clock.advance(FORCED_MOVE_MS - 1);
    expect(session.snapshot()).toBe(afterPress);
    clock.advance(1);
    expect(session.snapshot()).not.toBe(afterPress);
  });

  it("is not refilled by the table settling again over the same position", () => {
    // What a liveness edge does: somebody else drops or comes back, and the
    // room settles the session. The countdown must carry on, or anybody
    // with a flaky connection could hold a forced move open for ever.
    const { clock, session } = silentLrc();
    session.start();
    const before = session.snapshot();

    clock.advance(3_000);
    session.settled();
    clock.advance(FORCED_MOVE_MS - 3_000);
    expect(session.snapshot()).not.toBe(before);
  });

  it("counts down the span it first gave, even as the lead it included runs out", () => {
    // What the server passes is what is LEFT of the frame's playback, which
    // shrinks as time passes. A re-settle part-way through must not take
    // the elapsed lead off twice — once as time spent, once as lead gone.
    const { clock, session } = silentLrc({ lead: (now) => Math.max(0, 1_200 - now) });
    session.start();
    const before = session.snapshot();

    clock.advance(600);
    session.settled();
    clock.advance(1_200 + FORCED_MOVE_MS - 600 - 1);
    expect(session.snapshot(), "fired early").toBe(before);
    clock.advance(1);
    expect(session.snapshot()).not.toBe(before);
  });

  it("remembers who it played for, briefly", () => {
    const { clock, session, definition } = silentLrc();
    session.start();
    const seat = definition.currentSeat(session.snapshot())!;
    clock.advance(FORCED_MOVE_MS);
    expect(session.playedFor(seat, 3_000)).toBe(true);
    expect(session.playedFor((seat + 1) % 3, 3_000)).toBe(false);
    clock.advance(3_001);
    expect(session.playedFor(seat, 3_000)).toBe(false);
  });

  it("plays a whole table of silent people to the end", () => {
    // The reachability claim for LRC, whose only move is always forced.
    const { clock, session, definition } = silentLrc();
    session.start();
    for (let rounds = 0; rounds < 50 && !definition.isOver(session.snapshot()); rounds++) {
      clock.drain();
      session.nextRound();
    }
    expect(definition.isOver(session.snapshot())).toBe(true);
  });
});
