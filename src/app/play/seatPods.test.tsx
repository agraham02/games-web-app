// @vitest-environment jsdom

/**
 * One nameplate per seat, minus your own — in every game.
 *
 * Each game builds its own `SeatView[]`, and every one of them counted
 * from seat 1. That is the same thing as "everybody but me" for exactly
 * as long as the viewer is seat 0, which offline they always are. Online
 * a player at seat 1 got no pod at all for seat 0 — the party leader
 * simply had no nameplate — and a redundant one for themselves.
 *
 * `SeatRing` was never at fault: it walks the geometry's slots and looks
 * up a view by seat, so a missing view is a missing pod and nothing else
 * reports it. Driven through each game's real `playerViews` rather than a
 * fixture, because the bug was five copies of one loop.
 */

import { describe, expect, it } from "vitest";
import type { GameDefinition, SeatId } from "@/engine/types";
import { GAMES, type GameId } from "@/session/registry";
import { GameSession } from "@/session/GameSession";
import { TestClock } from "@/session/clock";
import type { GameRuntime } from "@/table/useGameRuntime";
import type { SeatView } from "@/table/SeatRing";

import { playerViews as dominoes } from "./dominoes/table";
import { playerViews as lrc } from "./lrc/table";
import { playerViews as poker } from "./poker/table";
import { playerViews as rummy } from "./rummy/table";
import { playerViews as spades } from "./spades/table";

const SEATS: Record<GameId, number> = { spades: 4, dominoes: 4, poker: 6, lrc: 6, rummy: 4 };

/** Enough of a runtime for a `players` callback; none of them reduce. */
function fakeLive(state: unknown): GameRuntime<unknown, unknown> {
  return {
    state,
    rawState: state,
    busy: false,
    lastAction: null,
    isHeroTurn: false,
  } as unknown as GameRuntime<unknown, unknown>;
}

/** Each game's own view object, pointed at one seat. */
function viewFor(viewerSeat: SeatId) {
  return {
    viewerSeat,
    nameFor: (seat: SeatId) => `Seat ${seat}`,
    colourFor: () => "#fff",
  };
}

// Each game's `playerViews` has its own shape — most take the state
// directly, Rummy curries the seat count first — so the callers below
// adapt them one by one rather than pretending they share a signature.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

const CALLERS: Record<GameId, (viewerSeat: SeatId, state: unknown, seats: number) => SeatView[]> = {
  dominoes: (v, state) => (dominoes as AnyFn)(viewFor(v), state, fakeLive(state)),
  lrc: (v, state) => (lrc as AnyFn)(viewFor(v), state, fakeLive(state)),
  poker: (v, state) => (poker as AnyFn)(viewFor(v), state, fakeLive(state)),
  spades: (v, state) => (spades as AnyFn)(viewFor(v), state, fakeLive(state)),
  // Rummy curries the seat count; the rest read it off state.
  rummy: (v, state, seats) => (rummy as AnyFn)(viewFor(v), seats)(state, fakeLive(state)),
};

describe("seat pods", () => {
  for (const gameId of Object.keys(SEATS) as GameId[]) {
    const seats = SEATS[gameId];
    for (let viewerSeat = 0; viewerSeat < seats; viewerSeat++) {
      it(`${gameId}: seat ${viewerSeat} gets a pod for everyone else and none for itself`, () => {
        const entry = GAMES[gameId];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const definition = entry.create(entry.parse({})) as GameDefinition<any, any>;
        const clock = new TestClock();
        const session = new GameSession({
          definition,
          seats,
          seed: 7,
          clock,
          isSeatLive: () => false,
          turnHoldMs: () => 0,
        });
        session.start();
        // Play a little so hands and scores are real rather than empty.
        for (let i = 0; i < 12; i++) {
          session.settled();
          clock.advance(20);
        }

        const views = CALLERS[gameId](viewerSeat, session.snapshot(), seats);
        const seen = views.map((v) => v.seat).sort((a, b) => a - b);
        const expected = Array.from({ length: seats }, (_, i) => i).filter(
          (i) => i !== viewerSeat,
        );

        expect(seen, `${gameId} from seat ${viewerSeat}`).toEqual(expected);
        expect(seen).not.toContain(viewerSeat);
      });
    }
  }
});
