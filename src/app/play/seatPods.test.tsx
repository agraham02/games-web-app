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
import type { FrameView } from "@/session/protocol";
import { awayFrom } from "@/room/useOnlineRuntime";
import { GAMES, type GameId } from "@/session/registry";
import { GameSession } from "@/session/GameSession";
import { TestClock } from "@/session/clock";
import type { GameRuntime } from "@/table/useGameRuntime";
import type { SeatView } from "@/table/SeatRing";

import { playerViews as bs, standings as bsStandings } from "./bs/table";
import { standings as dominoesStandings } from "./dominoes/table";
import { standings as lrcStandings } from "./lrc/table";
import { standings as pokerStandings } from "./poker/table";
import { standings as rummyStandings } from "./rummy/table";
import { standings as spadesStandings } from "./spades/table";
import { playerViews as dominoes } from "./dominoes/table";
import { playerViews as lrc } from "./lrc/table";
import { playerViews as poker } from "./poker/table";
import { playerViews as rummy } from "./rummy/table";
import { playerViews as spades } from "./spades/table";

const SEATS: Record<GameId, number> = {
  spades: 4,
  dominoes: 4,
  poker: 6,
  lrc: 6,
  rummy: 4,
  bs: 4,
};

/** Enough of a runtime for a `players` callback; none of them reduce. */
function fakeLive(state: unknown): GameRuntime<unknown, unknown> {
  return {
    state,
    rawState: state,
    latest: state,
    busy: false,
    lastAction: null,
    isHeroTurn: false,
  } as unknown as GameRuntime<unknown, unknown>;
}

/** Each game's own view object, pointed at one seat. */
function viewFor(viewerSeat: SeatId, awayFor?: (seat: SeatId) => boolean) {
  return {
    viewerSeat,
    nameFor: (seat: SeatId) => `Seat ${seat}`,
    colourFor: () => "#fff",
    awayFor,
  };
}

// Each game's `playerViews` has its own shape — most take the state
// directly, Rummy curries the seat count first — so the callers below
// adapt them one by one rather than pretending they share a signature.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

type Caller = (
  viewerSeat: SeatId,
  state: unknown,
  seats: number,
  awayFor?: (seat: SeatId) => boolean,
) => SeatView[];

const CALLERS: Record<GameId, Caller> = {
  dominoes: (v, state, _s, away) => (dominoes as AnyFn)(viewFor(v, away), state, fakeLive(state)),
  lrc: (v, state, _s, away) => (lrc as AnyFn)(viewFor(v, away), state, fakeLive(state)),
  poker: (v, state, _s, away) => (poker as AnyFn)(viewFor(v, away), state, fakeLive(state)),
  spades: (v, state, _s, away) => (spades as AnyFn)(viewFor(v, away), state, fakeLive(state)),
  bs: (v, state, _s, away) => (bs as AnyFn)(viewFor(v, away), state, fakeLive(state)),
  // Rummy curries the seat count; the rest read it off state.
  rummy: (v, state, seats, away) =>
    (rummy as AnyFn)(viewFor(v, away), seats)(state, fakeLive(state)),
};

/** A dealt table for one game, played far enough to have real hands. */
function dealt(gameId: GameId, seats: number): unknown {
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
  for (let i = 0; i < 12; i++) {
    session.settled();
    clock.advance(20);
  }
  return session.snapshot();
}

describe("seat pods", () => {
  for (const gameId of Object.keys(SEATS) as GameId[]) {
    const seats = SEATS[gameId];
    for (let viewerSeat = 0; viewerSeat < seats; viewerSeat++) {
      it(`${gameId}: seat ${viewerSeat} gets a pod for everyone else and none for itself`, () => {
        const views = CALLERS[gameId](viewerSeat, dealt(gameId, seats), seats);
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

/**
 * A bot playing somebody's seat, said out loud.
 *
 * The failure this covers is a quiet one and there is no crash to catch:
 * a bot took over Bo's hand, the pod still says "Bo", and from across the
 * table the game has silently stopped being the one people think they are
 * in. Nothing about the board looks wrong.
 *
 * Two halves, tested separately because they fail differently. `awayFrom`
 * asks the frame the right QUESTION — a bot seat nobody owns is an empty
 * chair, not an abandoned one. Each game's `playerViews` then has to
 * actually carry the answer, and that is five copies of one loop, which is
 * exactly the shape of the bug the rest of this file exists for.
 */
describe("a seat a bot has taken over", () => {
  function frame(partial: Partial<FrameView>): FrameView {
    return { botSeats: [], seatNames: [], ...partial } as FrameView;
  }

  it("marks a seat whose owner is not here", () => {
    const away = awayFrom(frame({ botSeats: [2], seatNames: [null, "Ada", "Bo", null] }));
    expect(away(2)).toBe(true);
  });

  it("leaves a chair nobody ever sat in alone", () => {
    // The reason `botSeats` alone is the wrong question: a room of two at
    // a four-seat table has two chairs a bot plays because nobody ever
    // took them. Calling those "away" would report two abandonments in a
    // game that has had none.
    const away = awayFrom(frame({ botSeats: [2, 3], seatNames: ["Ada", "Bo", null, null] }));
    expect(away(2)).toBe(false);
    expect(away(3)).toBe(false);
  });

  it("says nothing about a seat its owner is sitting in", () => {
    const away = awayFrom(frame({ botSeats: [2], seatNames: ["Ada", "Bo", "Cy", null] }));
    expect(away(0)).toBe(false);
    expect(away(1)).toBe(false);
  });

  for (const gameId of Object.keys(SEATS) as GameId[]) {
    it(`${gameId}: carries the flag onto the pod`, () => {
      const seats = SEATS[gameId];
      const state = dealt(gameId, seats);
      // Viewer at seat 0, so seat 1 is somebody else's pod either way.
      const marked = CALLERS[gameId](0, state, seats, (seat) => seat === 1);
      expect(marked.find((v) => v.seat === 1)?.away, `${gameId} seat 1`).toBe(true);
      expect(marked.find((v) => v.seat === 2)?.away, `${gameId} seat 2`).toBe(false);

      // And an offline view supplies no `awayFor` at all, which has to
      // read as "nobody is away" rather than as undefined behaviour.
      const offline = CALLERS[gameId](0, state, seats);
      expect(offline.every((v) => v.away === false), `${gameId} offline`).toBe(true);
    });
  }
});

/**
 * Nobody gets a row for a seat they are not sitting in.
 *
 * `SPECTATOR_SEAT` is -1, and -1 is a perfectly ordinary number. Three of
 * the six games built their game-end standings by PREPENDING
 * `{ seat: viewerSeat, name: "You" }` to the real seats, which for a
 * watcher meant a row for seat -1, scored zero, sorted in among the
 * players. The two that got it right built from the seat range and
 * decided the name by comparison, which is the shape they all use now.
 *
 * The same -1 class that once put a "Partner" badge on a spectator's
 * table and showed them a hero badge reading "You - $0". It keeps coming
 * back, so it is swept for rather than fixed one game at a time.
 */
describe("standings, seen by somebody who is not playing", () => {
  const SPECTATOR = -1 as SeatId;

  /**
   * Each game's rows, for one viewer. The signatures genuinely differ -
   * Rummy curries the seat count the way its `playerViews` does - so they
   * are adapted one by one rather than pretended to match.
   */
  type Row = { seat: number; name: string };
  const ROWS: Record<GameId, (v: SeatId, state: unknown, seats: number) => Row[]> = {
    spades: (v, state, seats) =>
      (spadesStandings as AnyFn)(viewFor(v), state, fakeLive(state), CALLERS.spades(v, state, seats)),
    dominoes: (v, state, seats) =>
      (dominoesStandings as AnyFn)(viewFor(v), state, fakeLive(state), CALLERS.dominoes(v, state, seats)),
    poker: (v, state, seats) =>
      (pokerStandings as AnyFn)(viewFor(v), state, fakeLive(state), CALLERS.poker(v, state, seats)),
    lrc: (v, state, seats) =>
      (lrcStandings as AnyFn)(viewFor(v), state, fakeLive(state), CALLERS.lrc(v, state, seats)),
    bs: (v, state, seats) =>
      (bsStandings as AnyFn)(viewFor(v), state, fakeLive(state), CALLERS.bs(v, state, seats)),
    rummy: (v, state, seats) => (rummyStandings as AnyFn)(viewFor(v), seats)(state),
  };

  /**
   * Games whose rows name the viewer at all.
   *
   * Rummy deliberately calls everybody by name, including you - it is the
   * one whose scorecard reads as a list of players rather than a list
   * with you in it. Spades names a PAIR ("You & Bo"), because its rows
   * are teams rather than seats, which is why this is a substring test.
   */
  const SAYS_YOU: Record<GameId, boolean> = {
    spades: true,
    dominoes: true,
    poker: true,
    lrc: true,
    bs: true,
    rummy: false,
  };

  for (const gameId of Object.keys(ROWS) as GameId[]) {
    it(`${gameId}: gives a spectator no row of their own`, () => {
      const seats = SEATS[gameId];
      const state = dealt(gameId, seats);
      const rows = ROWS[gameId](SPECTATOR, state, seats);

      for (const row of rows) {
        expect(row.seat, `${gameId} listed seat ${row.seat}`).toBeGreaterThanOrEqual(0);
        expect(row.seat).toBeLessThan(seats);
      }
      // And nobody is called "You", because nobody watching is.
      for (const row of rows) {
        expect(row.name, `${gameId} called a row "${row.name}"`).not.toMatch(/\bYou\b/);
      }
    });

    it(`${gameId}: still names a seated player's own row`, () => {
      const seats = SEATS[gameId];
      const state = dealt(gameId, seats);
      const seat = 1 as SeatId;
      const rows = ROWS[gameId](seat, state, seats);

      for (const row of rows) {
        expect(row.seat).toBeGreaterThanOrEqual(0);
        expect(row.seat).toBeLessThan(seats);
      }
      if (SAYS_YOU[gameId]) {
        expect(rows.filter((r) => /\bYou\b/.test(r.name))).toHaveLength(1);
      }
    });
  }
});
