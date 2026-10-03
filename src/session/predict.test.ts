// @vitest-environment node

/**
 * A prediction never lies.
 *
 * Every game, played through the real server by four people who each make
 * the moves a bot would, from their own screen. Before each move goes out
 * it is predicted from that person's own frame — exactly what their page
 * will do — and held to the frame the server answers with:
 *
 *  - a predicted state must be the state that frame carries;
 *  - a gesture must be the very events that frame begins with.
 *
 * And because a correctness suite cannot see a feature that never fires,
 * each game must actually predict the moves it is supposed to.
 */

import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import type { GameDefinition, SeatId } from "@/engine/types";
import { TestClock } from "./clock";
import { GAMES, GAME_IDS, type GameId } from "./registry";
import { PROTOCOL_VERSION, type FrameView, type ServerMessage } from "./protocol";
import { predict } from "./predict";
import { RoomRegistry } from "@/server/RoomRegistry";
import type { Connection } from "@/server/RoomRuntime";
import { makePeer, Router, type Peer } from "@/server/router";

class Recorder implements Connection {
  readonly frames: FrameView[] = [];
  readonly sent: ServerMessage[] = [];
  /** Every piece this person has been told the face of. */
  readonly known = new Set<string>();
  send(message: ServerMessage): void {
    this.sent.push(message);
    if (message.t !== "frame") return;
    this.frames.push(message.frame);
    for (const id of Object.keys(message.frame.meta)) if (!id.startsWith("#")) this.known.add(id);
  }
  close(): void {}
  bufferedAmount(): number {
    return 0;
  }
}

interface Tally {
  moves: number;
  /** By action type: [moves, with a gesture, with a state]. */
  byType: Record<string, [number, number, number]>;
}

function play(gameId: GameId, seed: number, moves: number): Tally {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const definition = GAMES[gameId].create(GAMES[gameId].parse({})) as GameDefinition<any, any>;
  const clock = new TestClock();
  const registry = new RoomRegistry({ clock, seed });
  const router = new Router(registry, () => clock.now());
  const say = (peer: Peer, message: unknown) => router.onMessage(peer, JSON.stringify(message));
  const people = ["ada", "bo", "cy", "di"].map((token) => {
    const conn = new Recorder();
    const peer = makePeer(conn, 0);
    say(peer, { t: "hello", token, protocol: PROTOCOL_VERSION });
    return { conn, peer };
  });
  const [host] = people;
  say(host!.peer, { t: "createRoom", name: "ada" });
  say(host!.peer, { t: "setTurnTimer", on: false });
  const code = (host!.conn.sent.find((m) => m.t === "room") as Extract<ServerMessage, { t: "room" }>).room.code;
  for (const p of people.slice(1)) say(p.peer, { t: "joinRoom", code, name: `p${people.indexOf(p)}` });
  say(host!.peer, { t: "selectGame", gameId, settings: {}, seats: 4, difficulty: "steady" });
  say(host!.peer, { t: "startGame" });

  const rng = createRng(seed);
  const tally: Tally = { moves: 0, byType: {} };
  let n = 0;
  for (let step = 0; step < moves * 20 && tally.moves < moves; step++) {
    const latest = host!.conn.frames.at(-1);
    if (latest?.isOver) break;
    if (latest?.isRoundOver) {
      clock.advance(1_000);
      say(host!.peer, { t: "nextRound" });
      continue;
    }
    const mover = people.find((p) => {
      const frame = p.conn.frames.at(-1);
      return frame && frame.seat !== null && definition.legalActions(frame.state, frame.seat).length > 0;
    });
    if (!mover) {
      clock.advance(100);
      continue;
    }
    const frame = mover.conn.frames.at(-1)!;
    const seat = frame.seat as SeatId;
    const action = definition.bots.steady.choose(frame.state, seat, rng);
    const prediction = predict(definition, frame.state, seat, action, (id) => mover.conn.known.has(id));

    const before = mover.conn.frames.length;
    n++;
    say(mover.peer, { t: "action", action, n, epoch: "test" });
    tally.moves++;
    const counts = (tally.byType[action.t] ??= [0, 0, 0]);
    counts[0]++;
    if (!prediction) continue;
    if (prediction.gesture.length > 0) counts[1]++;
    if (prediction.state) counts[2]++;

    const answer = mover.conn.frames.slice(before).find((f) => f.answers === n);
    const label = `${gameId} seed ${seed}, move ${n} (${JSON.stringify(action)})`;
    expect(answer, `${label}: the server answered with no frame`).toBeDefined();
    if (prediction.state) expect(prediction.state, `${label}: state`).toEqual(answer!.state);
    expect(answer!.events.slice(0, prediction.gesture.length), `${label}: gesture`).toEqual(
      prediction.gesture,
    );
  }
  return tally;
}

/**
 * What each game must predict, as a share of its moves of that type — with
 * a state (the whole move shown at once) or at least a gesture.
 */
const FLOORS: Record<GameId, Record<string, { state?: number; gesture?: number }>> = {
  spades: { play: { gesture: 1, state: 0.95 }, bid: { state: 1 } },
  rummy: {
    discard: { gesture: 1, state: 0.9 },
    layNewMeld: { gesture: 1, state: 1 },
    extendMeld: { gesture: 1, state: 1 },
    drawDiscard: { gesture: 1, state: 1 },
  },
  bs: { play: { gesture: 1, state: 1 } },
  dominoes: { play: { gesture: 1, state: 0.9 } },
  // Chips move at the end of a street, so a bet is a state, not a gesture;
  // a call or check that closes the street deals cards nobody has seen.
  poker: { fold: { state: 0.85 }, bet: { state: 0.9 }, raise: { state: 0.8 } },
  // The roll is the server's (`unpredictable`): its tumble starts on the press.
  lrc: {},
};

describe("a prediction never lies", () => {
  for (const gameId of GAME_IDS) {
    it(`${gameId}: agrees with the server on every move it predicts`, () => {
      const total: Tally = { moves: 0, byType: {} };
      for (const seed of [11, 4242, 90210]) {
        const tally = play(gameId, seed, 150);
        total.moves += tally.moves;
        for (const [t, [m, g, s]] of Object.entries(tally.byType)) {
          const into = (total.byType[t] ??= [0, 0, 0]);
          into[0] += m;
          into[1] += g;
          into[2] += s;
        }
      }
      expect(total.moves, "nobody moved").toBeGreaterThan(50);
      for (const [type, floor] of Object.entries(FLOORS[gameId])) {
        const [moves, gestures, states] = total.byType[type] ?? [0, 0, 0];
        expect(moves, `${gameId} never made a ${type}`).toBeGreaterThan(0);
        if (floor.gesture !== undefined) {
          expect(gestures / moves, `${gameId} ${type}: share shown at once`).toBeGreaterThanOrEqual(floor.gesture);
        }
        if (floor.state !== undefined) {
          expect(states / moves, `${gameId} ${type}: share predicted whole`).toBeGreaterThanOrEqual(floor.state);
        }
      }
    });
  }
});
