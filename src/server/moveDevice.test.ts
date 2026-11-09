// @vitest-environment node

/**
 * Moving to another device: the phone asks for a code, the desktop types it,
 * and the desktop is the same player — same seat, same hand — from then on.
 *
 * What these defend is the shape of the thing rather than its happy path: a
 * code works once, for a little while, for one room, and a room cannot be
 * guessed at. A four-digit code is only acceptable because of all four.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { TestClock } from "@/session/clock";
import {
  MOVE_CODE_LENGTH,
  MOVE_CODE_LOCK_MS,
  MOVE_CODE_MISSES,
  MOVE_CODE_TTL_MS,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "@/session/protocol";
import type { Connection } from "./RoomRuntime";
import { RoomRegistry } from "./RoomRegistry";
import { makePeer, Router, type Peer } from "./router";

class FakeConnection implements Connection {
  readonly sent: ServerMessage[] = [];
  closed = false;
  send(message: ServerMessage): void {
    this.sent.push(message);
  }
  close(): void {
    this.closed = true;
  }
  bufferedAmount(): number {
    return 0;
  }
  last<T extends ServerMessage["t"]>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    return [...this.sent].reverse().find((m) => m.t === t) as Extract<ServerMessage, { t: T }> | undefined;
  }
  clear(): void {
    this.sent.length = 0;
  }
}

describe("moving to another device", () => {
  let clock: TestClock;
  let registry: RoomRegistry;
  let router: Router;

  beforeEach(() => {
    clock = new TestClock();
    registry = new RoomRegistry({ clock, seed: 7 });
    router = new Router(registry, () => clock.now());
  });

  function peerFor(token: string): { peer: Peer; conn: FakeConnection } {
    const conn = new FakeConnection();
    const peer = makePeer(conn, clock.now());
    router.onMessage(peer, JSON.stringify({ t: "hello", token, protocol: PROTOCOL_VERSION }));
    return { peer, conn };
  }
  const send = (peer: Peer, message: unknown) => router.onMessage(peer, JSON.stringify(message));

  /** A two-person room with a game running; the guest is the one who moves. */
  function room() {
    const host = peerFor("host-token");
    send(host.peer, { t: "createRoom", name: "Ada" });
    const code = host.conn.last("room")!.room.code;
    const phone = peerFor("phone-token");
    send(phone.peer, { t: "joinRoom", code, name: "Bo" });
    send(host.peer, { t: "selectGame", gameId: "dominoes", settings: {}, seats: 4, difficulty: "steady" });
    send(host.peer, { t: "startGame" });
    return { host, phone, code };
  }

  const askFor = (who: { peer: Peer; conn: FakeConnection }) => {
    send(who.peer, { t: "moveCode" });
    return who.conn.last("moveCode")!.pin;
  };

  it("gives a member four digits, and says how long they last", () => {
    const { phone } = room();
    send(phone.peer, { t: "moveCode" });
    const answer = phone.conn.last("moveCode")!;
    expect(answer.pin).toMatch(new RegExp(`^\\d{${MOVE_CODE_LENGTH}}$`));
    expect(answer.expiresInMs).toBe(MOVE_CODE_TTL_MS);
  });

  it("has nothing to give somebody who is not in a room", () => {
    const lone = peerFor("lone");
    send(lone.peer, { t: "moveCode" });
    expect(lone.conn.last("moveCode")).toBeUndefined();
    expect(lone.conn.last("error")).toMatchObject({ code: "no-room" });
  });

  it("makes the new device the same player, in the same seat, and steps the old one aside", () => {
    const { phone, code } = room();
    const seat = phone.conn.last("frame")!.frame.seat;
    const pin = askFor(phone);

    const desktop = peerFor("desktop-token");
    send(desktop.peer, { t: "claimCode", code, pin });

    // Greeted as the member, already in the room.
    expect(desktop.conn.last("hello")).toMatchObject({
      session: phone.conn.last("hello")!.session,
      inRoom: true,
    });
    expect(desktop.conn.last("room")!.room.you).toBe(phone.conn.last("room")!.room.you);
    // Their own hand, at their own seat — not a spectator's view.
    expect(desktop.conn.last("frame")!.frame.seat).toBe(seat);
    // Nobody new at the table.
    expect(desktop.conn.last("room")!.room.members).toHaveLength(2);

    // The phone is told, and let go: the usual second-tab screen.
    expect(phone.conn.last("superseded")).toBeDefined();
    expect(phone.conn.closed).toBe(true);
  });

  it("is the same player on the desktop's own, later connections too", () => {
    const { phone, code } = room();
    const pin = askFor(phone);
    const desktop = peerFor("desktop-token");
    send(desktop.peer, { t: "claimCode", code, pin });

    // A refresh of the desktop says hello with its own token and is still them.
    const refreshed = peerFor("desktop-token");
    expect(refreshed.conn.last("hello")).toMatchObject({ inRoom: true });
    expect(refreshed.conn.last("frame")!.frame.seat).toBe(phone.conn.last("frame")!.frame.seat);
  });

  it("works once", () => {
    const { phone, code } = room();
    const pin = askFor(phone);
    send(peerFor("one").peer, { t: "claimCode", code, pin });

    const late = peerFor("two");
    send(late.peer, { t: "claimCode", code, pin });
    expect(late.conn.last("error")).toMatchObject({ code: "bad-move-code" });
    expect(late.conn.last("room")).toBeUndefined();
  });

  it("stops working after two minutes", () => {
    const { phone, code } = room();
    const pin = askFor(phone);
    clock.advance(MOVE_CODE_TTL_MS);

    const desktop = peerFor("desktop-token");
    send(desktop.peer, { t: "claimCode", code, pin });
    expect(desktop.conn.last("error")).toMatchObject({ code: "bad-move-code" });
  });

  it("is replaced by asking again", () => {
    const { phone, code } = room();
    const first = askFor(phone);
    let second = first;
    while (second === first) second = askFor(phone);

    const desktop = peerFor("desktop-token");
    send(desktop.peer, { t: "claimCode", code, pin: first });
    expect(desktop.conn.last("error")).toMatchObject({ code: "bad-move-code" });
    send(desktop.peer, { t: "claimCode", code, pin: second });
    expect(desktop.conn.last("room")).toBeDefined();
  });

  it("is no good without the room it was issued in", () => {
    const { phone } = room();
    const pin = askFor(phone);
    const desktop = peerFor("desktop-token");
    send(desktop.peer, { t: "claimCode", code: "ZZZZ", pin });
    expect(desktop.conn.last("error")).toMatchObject({ code: "bad-move-code" });
  });

  it("says the same thing about every way it can fail", () => {
    // A guess must not learn whether it was close, spent, or too late.
    const { phone, code } = room();
    const pin = askFor(phone);
    const wrong = pin === "0000" ? "0001" : "0000";
    const a = peerFor("a");
    send(a.peer, { t: "claimCode", code, pin: wrong });
    const b = peerFor("b");
    send(b.peer, { t: "claimCode", code: "QQQQ", pin });
    expect(a.conn.last("error")).toEqual(b.conn.last("error"));
  });

  it("shuts a room to guesses after a few wrong ones — even for the right code", () => {
    const { phone, code } = room();
    const pin = askFor(phone);
    const wrong = pin === "0000" ? "0001" : "0000";
    const guesser = peerFor("guesser");
    for (let i = 0; i < MOVE_CODE_MISSES; i++) send(guesser.peer, { t: "claimCode", code, pin: wrong });

    const desktop = peerFor("desktop-token");
    send(desktop.peer, { t: "claimCode", code, pin });
    expect(desktop.conn.last("error")).toMatchObject({ code: "bad-move-code" });
    expect(desktop.conn.last("room")).toBeUndefined();
  });

  it("opens again once the lock has run out", () => {
    const { phone, code } = room();
    const wrong = askFor(phone) === "0000" ? "0001" : "0000";
    const guesser = peerFor("guesser");
    for (let i = 0; i < MOVE_CODE_MISSES; i++) send(guesser.peer, { t: "claimCode", code, pin: wrong });

    clock.advance(MOVE_CODE_LOCK_MS);
    const pin = askFor(phone);
    const desktop = peerFor("desktop-token");
    send(desktop.peer, { t: "claimCode", code, pin });
    expect(desktop.conn.last("room")).toBeDefined();
  });

  it("takes a device out of the room of its own it was sitting in", () => {
    const { phone, code } = room();
    const pin = askFor(phone);

    const desktop = peerFor("desktop-token");
    send(desktop.peer, { t: "createRoom", name: "Solo" });
    const own = desktop.conn.last("room")!.room.code;
    expect(own).not.toBe(code);

    send(desktop.peer, { t: "claimCode", code, pin });
    expect(desktop.conn.last("room")!.room.code).toBe(code);
    // The room it had been in has nobody left, so it is gone.
    expect(registry.get(own)).toBeNull();
  });

  it("does nothing odd when a device claims its own code", () => {
    const { phone, code } = room();
    const pin = askFor(phone);
    send(phone.peer, { t: "claimCode", code, pin });
    expect(phone.conn.last("room")!.room.members).toHaveLength(2);
    expect(phone.conn.closed).toBe(false);
  });
});
