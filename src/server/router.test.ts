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

    /**
     * A bot taking somebody's seat has to reach the people still playing,
     * and `botSeats` — the field every pod's "Away" marker is drawn from —
     * rides on a FRAME. Frames are produced by the game advancing, so
     * without a deliberate push the news waits for the next move.
     *
     * That wait is unbounded in exactly the wrong case. Found in a browser
     * with the table parked on the remaining player: their opponent walked
     * away, the table stopped, and nothing on screen said why — because
     * the only thing that would have said so was a frame that could not
     * arrive until they moved, and they were waiting to be told what was
     * going on before moving.
     */
    describe("a seat changing hands is news", () => {
      it("tells the people still at the table, without waiting for a move", () => {
        const { conn, p2, code } = twoPlayerSpades();
        const runtime = registry.get(code)!;
        const theirSeat = runtime.room.game!.seatOwner.indexOf(registry.sessionFor("p2"));
        expect(theirSeat).toBeGreaterThanOrEqual(0);

        conn.clear();
        send(p2.peer, { t: "exitGame" });

        const frame = conn.last("frame");
        expect(frame, "the remaining player should have been sent a frame").toBeDefined();
        expect(frame!.frame.botSeats).toContain(theirSeat);
      });

      it("says so again when they come back", () => {
        const { conn, p2, code } = twoPlayerSpades();
        const runtime = registry.get(code)!;
        const theirSeat = runtime.room.game!.seatOwner.indexOf(registry.sessionFor("p2"));

        send(p2.peer, { t: "exitGame" });
        conn.clear();
        send(p2.peer, { t: "enterGame" });

        expect(conn.last("frame")!.frame.botSeats).not.toContain(theirSeat);
      });

      it("counts a dropped socket the same as a walk to the lobby", () => {
        // Same push, reached through `detach` rather than through a
        // command the client sent — which is the case a player never
        // chooses and the one most likely to leave everybody confused.
        const { conn, p2, code } = twoPlayerSpades();
        const runtime = registry.get(code)!;
        const theirSeat = runtime.room.game!.seatOwner.indexOf(registry.sessionFor("p2"));

        conn.clear();
        router.onClose(p2.peer);

        expect(conn.last("frame")!.frame.botSeats).toContain(theirSeat);
      });

      /**
       * The assertion every test above this one stops just short of.
       *
       * They all prove the NEWS travels — `liveSeats` flipped, a frame
       * carrying `botSeats` was pushed. None of them proves the game then
       * MOVES, and for a long time it did not: `settled()` is what hands
       * a turn to a bot, and on this server it was only ever reached from
       * `onFrame` — which is to say, from somebody acting. Park the table
       * on a live seat, let that player drop, and the four games with no
       * `deadline?()` armed nothing at all. The seat was bot-played, no
       * bot was ever invoked, and the person still sitting there waited
       * forever with an Away badge for company.
       *
       * `drain()` is the instrument: it runs the loop to a standstill. A
       * table that has genuinely stalled simply stops, with the match
       * unfinished and nothing pending — which is exactly what this
       * asserted against before the fix.
       */
      describe("and the game has to carry on without them", () => {
        /** Runs bots until the table parks on a seat a human owns. */
        function parkOnAHuman(code: string): { seat: number; session: string } {
          const runtime = registry.get(code)!;
          clock.drain();
          const seat = runtime.debugDump().table as { currentSeat: number | null };
          const at = seat.currentSeat;
          expect(at, "the table should be waiting on somebody").not.toBeNull();
          const owner = runtime.room.game!.seatOwner[at!];
          expect(owner, "the table should be parked on a seat a person owns").not.toBeNull();
          return { seat: at!, session: owner! };
        }

        /** `{ currentSeat, fingerprint }` — the cheap "has anything moved". */
        function tableOf(code: string) {
          return registry.get(code)!.debugDump().table as {
            currentSeat: number | null;
            fingerprint: string;
          };
        }

        it("takes the turn of the seat on turn when its owner drops", () => {
          const { code, peer, p2 } = twoPlayerSpades();
          const { seat, session } = parkOnAHuman(code);
          const before = tableOf(code).fingerprint;

          // Drop whichever of the two is actually on turn.
          const hostSession = registry.sessionFor("p1");
          router.onClose(session === hostSession ? peer : p2.peer);
          clock.drain();

          const after = tableOf(code);
          expect(after.currentSeat, "the abandoned seat should have been played").not.toBe(seat);
          expect(after.fingerprint, "the table should have moved").not.toBe(before);
        });

        it("does the same when they walk to the lobby on their turn", () => {
          // `exitGame` rather than a dropped socket: the same liveness
          // edge, reached by a command the player chose to send.
          const { code, peer, p2 } = twoPlayerSpades();
          const { seat, session } = parkOnAHuman(code);
          const before = tableOf(code).fingerprint;

          const hostSession = registry.sessionFor("p1");
          send(session === hostSession ? peer : p2.peer, { t: "exitGame" });
          clock.drain();

          const after = tableOf(code);
          expect(after.currentSeat).not.toBe(seat);
          expect(after.fingerprint).not.toBe(before);
        });

        it("still waits for a human who is present", () => {
          // The other half, and the one that stops the fix becoming "bots
          // play everything": a table parked on a seat somebody IS in must
          // stay parked, however long the loop is drained for. Without
          // this, the fix above could pass by simply never waiting.
          const { code } = twoPlayerSpades();
          const { seat } = parkOnAHuman(code);
          const before = tableOf(code).fingerprint;

          clock.drain();

          const after = tableOf(code);
          expect(after.currentSeat).toBe(seat);
          expect(after.fingerprint).toBe(before);
        });
      });

      it("does not fire a second time for a change that is not one", () => {
        // A room command that leaves every seat exactly as it was must not
        // shower the table with position frames — they reconcile the board
        // and are not free.
        const { conn, peer } = twoPlayerSpades();
        conn.clear();
        send(peer, { t: "setPrivacy", privacy: "private" });
        expect(conn.all("frame")).toHaveLength(0);
      });
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

  /* ============================================================
     The connection lifecycle
     ============================================================ */

  /**
   * Four bugs lived in here, and they shared a shape: the room's map of
   * sockets was updated on some paths and not others, so the server's idea
   * of who it was talking to drifted from the truth. None of them were
   * visible from a client — the symptoms were a bot taking a seat somebody
   * was sitting in, a lobby reappearing over a game, and rooms that never
   * died.
   */
  describe("sockets, and who the room thinks is holding them", () => {
    it("survives a second tab for the same person", () => {
      // `attach` closes the old socket and stores the new one under the
      // same session key. `ws.close()` is asynchronous, so the old
      // socket's close event arrives AFTER the replacement is in the map —
      // and a detach that deleted by session id alone evicted the tab that
      // had just arrived. The player was marked gone and a bot took their
      // seat while they sat looking at the table.
      const firstTab = host();
      const runtime = registry.get(firstTab.code)!;
      const session = registry.sessionFor("host");

      const secondTab = peerFor("host");
      expect(runtime.isAttached(session)).toBe(true);
      expect(firstTab.conn.closed).toBe(true);

      // Now the first tab's close event lands, late, as it really does.
      router.onClose(firstTab.peer);

      expect(runtime.isAttached(session)).toBe(true);
      expect(runtime.room.members[session]!.connected).toBe(true);
      // And the surviving socket is the new one.
      secondTab.conn.clear();
      runtime.broadcastRoom();
      expect(secondTab.conn.last("room")).toBeDefined();
    });

    it("stops talking to somebody who left", () => {
      // The socket stayed in the room's fan-out map after `leaveRoom`, so
      // the next thing anybody did in that room sent a roster update to a
      // player who had gone — and the client acts on a `room` message, so
      // it dragged them back into a lobby they had deliberately left.
      const { peer: hostPeer, code } = host();
      const { peer: guest, conn: guestConn } = peerFor("guest");
      send(guest, { t: "joinRoom", code, name: "Bo" });

      send(guest, { t: "leaveRoom" });
      expect(guestConn.last("left")).toBeDefined();

      guestConn.clear();
      send(hostPeer, { t: "rename", name: "Adaline" });
      expect(guestConn.all("room")).toHaveLength(0);
    });

    it("reaps a room everybody politely left, not just one they dropped out of", () => {
      // `onEmpty` is only reachable through `detach`, and leaving never
      // called it — so a room whose members all pressed "leave" was never
      // handed to the reaper and held its code for the life of the process.
      const { peer } = host();
      expect(registry.size).toBe(1);

      send(peer, { t: "leaveRoom" });
      clock.advance(EMPTY_ROOM_TTL_MS + 1);

      expect(registry.size).toBe(0);
    });

    it("stops talking to somebody it kicked", () => {
      const { peer: hostPeer, code } = host();
      const { peer: guest, conn: guestConn } = peerFor("guest");
      send(guest, { t: "joinRoom", code, name: "Bo" });

      send(hostPeer, { t: "kick", session: registry.sessionFor("guest") });
      expect(guestConn.last("left")!.reason).toBe("kicked");

      guestConn.clear();
      send(hostPeer, { t: "rename", name: "Adaline" });
      expect(guestConn.all("room")).toHaveLength(0);
    });

    it("keeps one person in one room when they make a new one", () => {
      const { peer, code: first } = host();
      const firstRoom = registry.get(first)!;
      const session = registry.sessionFor("host");

      send(peer, { t: "createRoom", name: "Ada" });
      const second = registry.roomOf(session)!;

      expect(second.code).not.toBe(first);
      expect(firstRoom.isAttached(session)).toBe(false);
      expect(firstRoom.room.members[session]).toBeUndefined();
    });

    it("keeps one person in one room when they join another", () => {
      const other = host("other");
      const { peer, code: mine } = host("mover");
      const session = registry.sessionFor("mover");

      send(peer, { t: "joinRoom", code: other.code, name: "Mover" });

      expect(registry.roomOf(session)!.code).toBe(other.code);
      expect(registry.get(mine)?.room.members[session]).toBeUndefined();
    });

    /**
     * A socket speaks for one identity at a time.
     *
     * Nothing stops a client sending a second `hello` with a different
     * token, and when it did, `peer.session` was simply overwritten while
     * the room went on holding the FIRST session against this same
     * socket. `onClose` then detached the second, and the first was never
     * detached at all — permanently. It stayed `connected`, so a bot
     * never took its seat and the room was never reaped, and every frame
     * went on being written to a socket that had closed.
     */
    describe("a socket that changes its mind about who it is", () => {
      it("lets go of the identity it was holding", () => {
        const { peer, conn, code } = host("first");
        const first = registry.sessionFor("first");
        expect(registry.get(code)!.isAttached(first)).toBe(true);

        // Same socket, different token.
        router.onMessage(
          peer,
          JSON.stringify({ t: "hello", token: "second", protocol: PROTOCOL_VERSION }),
        );

        expect(registry.get(code)!.isAttached(first)).toBe(false);
        expect(conn.last("hello")!.session).toBe(registry.sessionFor("second"));
      });

      it("lets the room die rather than pinning it open forever", () => {
        const { peer, code } = host("first");
        router.onMessage(
          peer,
          JSON.stringify({ t: "hello", token: "second", protocol: PROTOCOL_VERSION }),
        );
        router.onClose(peer);

        clock.advance(EMPTY_ROOM_TTL_MS + 1);
        expect(registry.get(code), "nobody is connected, so the room should be gone").toBeNull();
      });

      it("hands the abandoned seat to a bot", () => {
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

        const runtime = registry.get(h.code)!;
        const theirs = registry.sessionFor("p2");
        const seat = runtime.room.game!.seatOwner.indexOf(theirs);

        router.onMessage(
          p2.peer,
          JSON.stringify({ t: "hello", token: "someone-else", protocol: PROTOCOL_VERSION }),
        );

        expect((runtime.debugDump().liveSeats as boolean[])[seat]).toBe(false);
      });
    });
  });

  /* ============================================================
     Hostile input
     ============================================================ */

  describe("input nobody sane would send", () => {
    /**
     * Each value gets its own room, and that matters: assigning a team
     * overwrites the last one, so a loop that assigned all of them to one
     * player would only ever start a game with whichever came last — and
     * `-0 % 2` is `-0`, which is a perfectly good array index. The first
     * version of this test did exactly that and passed against the bug.
     */
    // NaN and Infinity are absent on purpose: `JSON.stringify` turns both
    // into `null`, so the parser rejects the message and they can never
    // arrive this way. They are covered directly on `teamIndex` instead.
    it.each([-1, 0.5, 1e21, -0, Number.MIN_SAFE_INTEGER])(
      "does not die on a team index of %p",
      (team) => {
        // `team % 2` is `-1` for `-1` and `0.5` for `0.5`, and
        // `seatMembers` indexed its queue array with the result —
        // `undefined.shift()`. That threw all the way out through the ws
        // message listener and took every live room in the process with
        // it, on a message a leader is perfectly entitled to send.
        const token = `host-${String(team)}`;
        const { peer, code } = host(token);
        const guestToken = `guest-${String(team)}`;
        const { peer: guest } = peerFor(guestToken);
        send(guest, { t: "joinRoom", code, name: `Bo${String(team)}` });
        send(peer, {
          t: "selectGame",
          gameId: "spades",
          settings: {},
          seats: 4,
          difficulty: "steady",
        });

        send(peer, { t: "assignTeam", session: registry.sessionFor(guestToken), team });
        send(peer, { t: "startGame" });

        const runtime = registry.get(code)!;
        expect(runtime.hasGame).toBe(true);
        // Both of them got a seat — a bad index must not cost anybody one.
        expect(runtime.room.game!.seatOwner.filter(Boolean)).toHaveLength(2);
        // And what was stored is a real team, not whatever arrived.
        expect(runtime.room.teams![registry.sessionFor(guestToken)]).toBeOneOf([0, 1]);
      },
    );

    it("answers a handler that throws instead of taking the process down", () => {
      // The boundary itself, tested by making a command throw on purpose.
      // What matters is not this particular explosion but that ANY of them
      // stays inside one peer's request.
      const { peer, conn, code } = host();
      const runtime = registry.get(code)!;
      const exploded = new Error("boom");
      const original = runtime.broadcastRoom.bind(runtime);
      runtime.broadcastRoom = () => {
        throw exploded;
      };

      conn.clear();
      expect(() => send(peer, { t: "rename", name: "Adaline" })).not.toThrow();
      expect(conn.last("error")).toBeDefined();

      runtime.broadcastRoom = original;
      // And the room is still usable afterwards.
      expect(() => send(peer, { t: "rename", name: "Ada" })).not.toThrow();
    });
  });
});
