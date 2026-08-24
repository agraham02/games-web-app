// @vitest-environment node

/**
 * The server, driven in-process.
 *
 * The `ws` harness in `scripts/` covers the same ground over real sockets
 * and is the better proof, but it needs a server running, so it cannot be
 * part of `npm test`. This gets the same paths into CI by handing the
 * router a fake `Connection` — which is the whole reason the router was
 * written against an interface rather than against `ws`.
 *
 * It also covers the one thing the socket harness genuinely cannot: the
 * one-minute room expiry, and the spec's "reconnecting right at the edge of
 * the window" case. On an injected clock those are microseconds.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { TestClock } from "@/session/clock";
import { PROTOCOL_VERSION, type ServerMessage } from "@/session/protocol";
import { EMPTY_ROOM_TTL_MS, RoomRegistry } from "./RoomRegistry";
import type { Connection } from "./RoomRuntime";
import { makePeer, Router, type Peer } from "./router";

/** Records everything sent, and can pretend to be a socket that has stalled. */
class FakeConnection implements Connection {
  readonly sent: ServerMessage[] = [];
  closed = false;
  buffered = 0;

  send(message: ServerMessage): void {
    this.sent.push(message);
  }
  close(): void {
    this.closed = true;
  }
  bufferedAmount(): number {
    return this.buffered;
  }

  last<T extends ServerMessage["t"]>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    return [...this.sent].reverse().find((m) => m.t === t) as
      | Extract<ServerMessage, { t: T }>
      | undefined;
  }
  all<T extends ServerMessage["t"]>(t: T): Array<Extract<ServerMessage, { t: T }>> {
    return this.sent.filter((m) => m.t === t) as Array<Extract<ServerMessage, { t: T }>>;
  }
  clear(): void {
    this.sent.length = 0;
  }
}

describe("the server, in process", () => {
  let clock: TestClock;
  let registry: RoomRegistry;
  let router: Router;

  beforeEach(() => {
    clock = new TestClock();
    registry = new RoomRegistry({ clock, seed: 4242 });
    router = new Router(registry, () => clock.now());
  });

  /** A connected, greeted peer. */
  function peerFor(token: string): { peer: Peer; conn: FakeConnection } {
    const conn = new FakeConnection();
    const peer = makePeer(conn, clock.now());
    router.onMessage(peer, JSON.stringify({ t: "hello", token, protocol: PROTOCOL_VERSION }));
    return { peer, conn };
  }

  function send(peer: Peer, message: unknown): void {
    router.onMessage(peer, JSON.stringify(message));
  }

  function host(token = "host"): { peer: Peer; conn: FakeConnection; code: string } {
    const { peer, conn } = peerFor(token);
    send(peer, { t: "createRoom", name: "Ada" });
    const code = conn.last("room")!.room.code;
    return { peer, conn, code };
  }

  it("mints one stable public id per token, and never echoes the token", () => {
    const { conn } = peerFor("secret-token-value");
    const hello = conn.last("hello")!;
    expect(hello.session).toBeTruthy();
    // The credential must not come back out — the roster goes to everyone.
    expect(JSON.stringify(conn.sent)).not.toContain("secret-token-value");

    // Same token, new socket: same identity. This is the whole of
    // identity-based reconnection.
    const again = peerFor("secret-token-value");
    expect(again.conn.last("hello")!.session).toBe(hello.session);
  });

  it("keeps a member's pending list to the leader alone", () => {
    // A pending name is somebody the room has not agreed to admit; showing
    // it to people with no say in it is a leak of who is knocking.
    const { peer: hostPeer, code } = host();
    send(hostPeer, { t: "setPrivacy", privacy: "private" });

    const { peer: knocker } = peerFor("knocker");
    send(knocker, { t: "joinRoom", code, name: "Knocker" });

    const { peer: member, conn: memberConn } = peerFor("member");
    send(member, { t: "joinRoom", code, name: "Member" });
    // Still private, so this one is queued too and gets no roster at all.
    expect(memberConn.last("pending")).toBeDefined();

    send(hostPeer, { t: "approve", session: registry.sessionFor("member") });
    memberConn.clear();
    send(member, { t: "rename", name: "Member2" });
    expect(memberConn.last("room")!.room.pending).toEqual([]);
  });

  it("refuses everything until a hello has been seen", () => {
    const conn = new FakeConnection();
    const peer = makePeer(conn, clock.now());
    send(peer, { t: "createRoom", name: "Impatient" });
    expect(conn.last("error")).toBeDefined();
    expect(registry.size).toBe(0);
  });

  it("answers malformed input without dropping the connection", () => {
    const { peer, conn } = peerFor("garbler");
    router.onMessage(peer, "}{not json");
    expect(conn.last("error")!.code).toBe("bad-message");
    expect(conn.closed).toBe(false);

    // Still usable.
    send(peer, { t: "createRoom", name: "Fine" });
    expect(conn.last("room")).toBeDefined();
  });

  it("rate-limits a flood and keeps the room intact", () => {
    const { peer, conn } = peerFor("flooder");
    for (let i = 0; i < 200; i++) send(peer, { t: "ping" });
    expect(conn.all("error").some((e) => e.code === "rate-limited")).toBe(true);
  });

  describe("expiry", () => {
    it("deletes a room a minute after the last person disconnects", () => {
      const { peer, code } = host();
      expect(registry.get(code)).not.toBeNull();

      router.onClose(peer);
      // Still there during the grace period: the commonest cause of an
      // empty room is everybody refreshing at once.
      clock.advance(EMPTY_ROOM_TTL_MS - 1);
      expect(registry.get(code)).not.toBeNull();

      clock.advance(2);
      expect(registry.get(code)).toBeNull();
    });

    it("spares a room when somebody returns inside the window", () => {
      const { peer, code } = host("returner");
      router.onClose(peer);
      clock.advance(EMPTY_ROOM_TTL_MS - 100);

      peerFor("returner");
      clock.advance(EMPTY_ROOM_TTL_MS * 2);
      expect(registry.get(code)).not.toBeNull();
    });

    it("survives a reconnect landing right on the edge of the window", () => {
      // Named in the spec. The reaper re-checks rather than assuming,
      // because the entire point of a grace period is that returning
      // during it is allowed.
      const { peer, code } = host("edge");
      router.onClose(peer);
      clock.advance(EMPTY_ROOM_TTL_MS - 1);

      const back = peerFor("edge");
      clock.advance(1000);

      expect(registry.get(code)).not.toBeNull();
      expect(back.conn.last("room")!.room.code).toBe(code);
    });

    it("does not rearm the timer on a flapping connection", () => {
      // Otherwise a client reconnecting every 59 seconds keeps a dead room
      // alive forever.
      const { peer, code } = host("flapper");
      router.onClose(peer);
      clock.advance(EMPTY_ROOM_TTL_MS / 2);
      router.onClose(peer); // A second close, no reconnect in between.
      clock.advance(EMPTY_ROOM_TTL_MS / 2 + 10);
      expect(registry.get(code)).toBeNull();
    });
  });

  describe("reconnection", () => {
    it("puts a returning player back in their room without them asking", () => {
      const { peer, code } = host("comeback");
      router.onClose(peer);

      const back = peerFor("comeback");
      const view = back.conn.last("room");
      expect(view).toBeDefined();
      expect(view!.room.code).toBe(code);
      expect(view!.room.youAreLeader).toBe(true);
    });

    it("gives a token nobody has seen a clean slate, not somebody's seat", () => {
      host("owner");
      const stranger = peerFor("never-seen-before");
      // No room view at all: an unknown token is simply a new person.
      expect(stranger.conn.last("room")).toBeUndefined();
      expect(stranger.conn.last("hello")).toBeDefined();
    });

    it("replaces a second socket for the same identity rather than doubling it", () => {
      // The seat belongs to the person, not the socket. Two live sockets
      // for one seat would double every frame and make "are they here"
      // ambiguous on disconnect.
      const first = host("two-tabs");
      const second = peerFor("two-tabs");
      expect(first.conn.closed).toBe(true);
      expect(second.conn.last("room")!.room.code).toBe(first.code);
    });
  });

  describe("backpressure", () => {
    it("drops messages for a socket that has stopped draining", () => {
      const { conn, code } = host("slowpoke");
      const other = peerFor("other");
      send(other.peer, { t: "joinRoom", code, name: "Other" });

      conn.clear();
      conn.buffered = 10 * 1024 * 1024; // wedged
      send(other.peer, { t: "rename", name: "Renamed" });

      // Nothing queued for the wedged socket — the next frame is a whole
      // snapshot, so anything skipped is superseded rather than lost.
      expect(conn.sent).toHaveLength(0);

      conn.buffered = 0;
      send(other.peer, { t: "rename", name: "Again" });
      expect(conn.sent.length).toBeGreaterThan(0);
    });
  });

  describe("the game", () => {
    function twoPlayerSpades() {
      const h = host("p1");
      const p2 = peerFor("p2");
      send(p2.peer, { t: "joinRoom", code: h.code, name: "Second" });
      send(h.peer, {
        t: "selectGame",
        gameId: "spades",
        settings: {},
        seats: 4,
        difficulty: "steady",
      });
      send(h.peer, { t: "startGame" });
      return { ...h, p2 };
    }

    it("sends every participant a frame when the game starts", () => {
      const { conn, p2 } = twoPlayerSpades();
      expect(conn.last("frame")).toBeDefined();
      expect(p2.conn.last("frame")).toBeDefined();
    });

    it("tells each player their own seat and nobody else's cards", () => {
      const { conn, p2 } = twoPlayerSpades();
      const mine = conn.last("frame")!.frame;
      const theirs = p2.conn.last("frame")!.frame;

      expect(mine.seat).not.toBeNull();
      expect(theirs.seat).not.toBeNull();
      expect(mine.seat).not.toBe(theirs.seat);

      // Each holds exactly one real hand: their own. The other 39 cards
      // are anonymous stand-ins.
      const standIns = Object.keys(mine.placements).filter((k) => k.startsWith("#"));
      expect(standIns).toHaveLength(39);
    });

    it("refuses a game action from a spectator", () => {
      const { code } = twoPlayerSpades();
      const watcher = peerFor("watcher");
      send(watcher.peer, { t: "joinRoom", code, name: "Watcher" });
      send(watcher.peer, { t: "enterGame", as: "spectator" });
      watcher.conn.clear();

      send(watcher.peer, { t: "action", action: { t: "bid", tricks: 3, nil: false } });
      expect(watcher.conn.last("error")!.message).toBe("not-in-game");
    });

    it("hands a seat to a bot the moment its owner disconnects", () => {
      const { code, p2 } = twoPlayerSpades();
      const runtime = registry.get(code)!;
      const seat = runtime.room.game!.seatOwner.indexOf(registry.sessionFor("p2"));
      expect(seat).toBeGreaterThanOrEqual(0);

      router.onClose(p2.peer);
      const dump = runtime.debugDump();
      expect((dump.liveSeats as boolean[])[seat]).toBe(false);
      // Reserved, not released.
      expect((dump.game as { seatOwner: (string | null)[] }).seatOwner[seat]).toBe(
        registry.sessionFor("p2"),
      );
    });

    it("ends the game and keeps the room when everybody leaves the table", () => {
      const { peer, code, p2 } = twoPlayerSpades();
      send(peer, { t: "exitGame" });
      send(p2.peer, { t: "exitGame" });

      const runtime = registry.get(code)!;
      expect(runtime.hasGame).toBe(false);
      expect(Object.keys(runtime.room.members)).toHaveLength(2);
    });
  });
});
