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
import { READY_BEAT_MS, playbackMs } from "@/motion/choreographer";
import { DEFAULT_TURN_HOLD_MS, FORCED_MOVE_MS, TURN_GRACE_MS } from "@/session/GameSession";
import { PROTOCOL_VERSION, type FrameView, type ServerMessage, type TurnClockView } from "@/session/protocol";
import { AUTO_CONTINUE_GRACE_MS, AUTO_CONTINUE_MS, ROUND_END_HOLD_MS } from "@/session/roundEnd";
import { createSpades } from "@/games/spades/rules";
import { GAMES } from "@/session/registry";
import type { PlacementMap } from "@/engine/types";
import { applyEventToTable } from "@/table/applyEvent";
import { useTableStore } from "@/table/store";
import type { SpadesState } from "@/games/spades/types";
import { EMPTY_ROOM_TTL_MS, RoomRegistry } from "./RoomRegistry";
import { LOBBY_GRACE_MS } from "@/session/room";
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

  function host(token = "host", opts: { turnTimer?: boolean } = {}): { peer: Peer; conn: FakeConnection; code: string } {
    const { peer, conn } = peerFor(token);
    send(peer, { t: "createRoom", name: "Ada" });
    const code = conn.last("room")!.room.code;
    // Off unless a test is about it. A new room has it on (30s), and most of
    // these tests park the table on a person who never moves and then
    // `drain()` — which with the timer running would make their moves for
    // them, mark them idle, and end the game: not what they are testing.
    if (!opts.turnTimer) send(peer, { t: "setTurnTimer", on: false });
    conn.clear();
    send(peer, { t: "rename", name: "Ada" });
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
    // A room nobody is left in goes with its last member: each member who
    // drops gets LOBBY_GRACE_MS, then leaves, and `displace` destroys the
    // emptied room. EMPTY_ROOM_TTL_MS is only the backstop now.
    it("lets go of a room everybody dropped out of, once the grace runs out", () => {
      const { peer, code } = host();
      expect(registry.get(code)).not.toBeNull();

      router.onClose(peer);
      // Still there during the grace: the commonest cause of an empty room
      // is everybody refreshing at once.
      clock.advance(LOBBY_GRACE_MS - 1);
      expect(registry.get(code)).not.toBeNull();

      clock.advance(1);
      expect(registry.get(code)).toBeNull();
    });

    it("spares a room when somebody returns inside the grace", () => {
      const { peer, code } = host("returner");
      router.onClose(peer);
      clock.advance(LOBBY_GRACE_MS - 100);

      peerFor("returner");
      clock.advance(EMPTY_ROOM_TTL_MS * 2);
      expect(registry.get(code)).not.toBeNull();
    });

    it("survives a reconnect landing right on the edge of the grace", () => {
      // Named in the spec. The lapse re-checks rather than assuming,
      // because the entire point of a grace period is that returning
      // during it is allowed.
      const { peer, code } = host("edge");
      router.onClose(peer);
      clock.advance(LOBBY_GRACE_MS - 1);

      const back = peerFor("edge");
      clock.advance(1000);

      expect(registry.get(code)).not.toBeNull();
      expect(back.conn.last("room")!.room.code).toBe(code);
    });

    it("does not rearm the timer on a flapping connection", () => {
      // Otherwise a client reconnecting every 19 seconds keeps a dead room
      // alive forever.
      const { peer, code } = host("flapper");
      router.onClose(peer);
      clock.advance(LOBBY_GRACE_MS / 2);
      router.onClose(peer); // A second close, no reconnect in between.
      clock.advance(LOBBY_GRACE_MS / 2 + 10);
      expect(registry.get(code)).toBeNull();
    });

    it("keeps a room holding only a knock for the reaper, which tells the knocker", () => {
      const { peer, code } = host("quitter");
      send(peer, { t: "setPrivacy", privacy: "private" });
      const knocker = peerFor("hopeful");
      send(knocker.peer, { t: "joinRoom", code, name: "Hopeful" });
      expect(knocker.conn.last("pending")).toBeDefined();

      router.onClose(peer);
      clock.advance(LOBBY_GRACE_MS);
      // Its only member is gone, but a knock is still waiting on it.
      expect(registry.get(code)).not.toBeNull();

      clock.advance(EMPTY_ROOM_TTL_MS);
      expect(registry.get(code)).toBeNull();
      expect(knocker.conn.last("left")?.reason).toBe("room-closed");
    });
  });

  describe("chat", () => {
    function lobbyOfTwo() {
      const h = host("ada");
      const bo = peerFor("bo");
      send(bo.peer, { t: "joinRoom", code: h.code, name: "Bo" });
      return { ...h, bo };
    }

    it("reaches everybody in the room, cleaned, with who said it", () => {
      const { conn, bo } = lobbyOfTwo();
      send(bo.peer, { t: "chat", text: "  hello\n\n there  " });
      for (const who of [conn, bo.conn]) {
        expect(who.last("chat")!.message).toMatchObject({ name: "Bo", text: "hello there" });
      }
    });

    it("sends a quick reply by what it says, not what the client claims", () => {
      const { conn, bo } = lobbyOfTwo();
      send(bo.peer, { t: "chat", quick: "luck" });
      expect(conn.last("chat")!.message).toMatchObject({ text: "Good luck!", quick: "luck" });
      send(bo.peer, { t: "chat", quick: "made-up" });
      expect(bo.conn.last("error")?.code).toBe("chat-invalid");
    });

    it("refuses nothing and too much", () => {
      const { bo } = lobbyOfTwo();
      send(bo.peer, { t: "chat", text: "   " });
      expect(bo.conn.last("error")?.code).toBe("chat-invalid");
      send(bo.peer, { t: "chat", text: "x".repeat(121) });
      expect(bo.conn.last("error")?.code).toBe("chat-invalid");
      expect(bo.conn.all("chat")).toHaveLength(0);
    });

    it("keeps a flood down, and lets the talker back in after a moment", () => {
      const { conn, bo } = lobbyOfTwo();
      for (let i = 0; i < 6; i++) send(bo.peer, { t: "chat", text: `m${i}` });
      expect(conn.all("chat")).toHaveLength(5);
      expect(bo.conn.last("error")?.code).toBe("chat-limited");
      clock.advance(10_000);
      send(bo.peer, { t: "chat", text: "later" });
      expect(conn.last("chat")!.message.text).toBe("later");
    });

    it("tells somebody arriving what has been said", () => {
      const { peer, code } = lobbyOfTwo();
      send(peer, { t: "chat", text: "before you came" });
      const cy = peerFor("cy");
      send(cy.peer, { t: "joinRoom", code, name: "Cy" });
      expect(cy.conn.last("chatLog")!.messages.map((m) => m.text)).toEqual(["before you came"]);
    });

    it("hears nothing from somebody still knocking", () => {
      const { peer, conn, code } = host("ada");
      send(peer, { t: "setPrivacy", privacy: "private" });
      const knocker = peerFor("knock");
      send(knocker.peer, { t: "joinRoom", code, name: "Knock" });
      send(knocker.peer, { t: "chat", text: "let me in" });
      expect(knocker.conn.last("error")?.code).toBe("no-room");
      expect(conn.all("chat")).toHaveLength(0);
    });

    describe("table talk in a partnership hand", () => {
      /** Spades, both people seated: a partnership game. */
      function spadesHand() {
        const h = host("ada");
        const bo = peerFor("bo");
        send(bo.peer, { t: "joinRoom", code: h.code, name: "Bo" });
        send(h.peer, { t: "selectGame", gameId: "spades", settings: {}, seats: 4, difficulty: "steady" });
        send(h.peer, { t: "startGame" });
        return { ...h, bo };
      }

      it("limits the players in it to the table-safe quick replies", () => {
        const { peer, conn, bo } = spadesHand();
        expect(conn.last("room")!.room.chat).toBe("quick-only");

        send(peer, { t: "chat", text: "I have the ace" });
        expect(conn.last("error")?.code).toBe("chat-locked");
        send(peer, { t: "chat", quick: "nice" });
        expect(conn.last("error")?.code).toBe("chat-locked");
        send(peer, { t: "chat", quick: "luck" });
        expect(bo.conn.last("chat")!.message.text).toBe("Good luck!");
      });

      it("lets somebody who is only watching say what they like", () => {
        const { conn, code } = spadesHand();
        const cy = peerFor("cy");
        send(cy.peer, { t: "joinRoom", code, name: "Cy" });
        send(cy.peer, { t: "enterGame", as: "spectator" });
        expect(cy.conn.last("room")!.room.chat).toBe("open");
        send(cy.peer, { t: "chat", text: "great game to watch" });
        expect(conn.last("chat")!.message.text).toBe("great game to watch");
      });

      it("still holds somebody who stepped back to the lobby — they know their cards", () => {
        const { peer, conn } = spadesHand();
        send(peer, { t: "exitGame" });
        send(peer, { t: "chat", text: "psst" });
        expect(conn.last("error")?.code).toBe("chat-locked");
      });

      it("gives table talk back when the hand is over", () => {
        // Played out for real: each person takes their first legal action
        // whenever it is their turn, and the bots do the rest.
        const { peer, conn, bo, code } = spadesHand();
        const rules = createSpades();
        const people = [{ peer, conn }, bo];
        for (let i = 0; i < 20_000 && !conn.last("frame")!.frame.isRoundOver; i++) {
          const seat = (registry.get(code)!.debugDump().table as { currentSeat: number | null }).currentSeat;
          const who = people.find((p) => p.conn.last("frame")?.frame.seat === seat);
          if (who && seat !== null) {
            const legal = rules.legalActions(who.conn.last("frame")!.frame.state as SpadesState, seat);
            if (legal[0]) send(who.peer, { t: "action", action: legal[0] });
          }
          clock.advance(100);
        }
        expect(conn.last("frame")!.frame.isRoundOver, "the hand should have been played out").toBe(true);
        expect(conn.last("room")!.room.chat, "the room is told the moment it opens").toBe("open");
        send(peer, { t: "chat", text: "well that went badly" });
        expect(bo.conn.last("chat")!.message.text).toBe("well that went badly");
      });

      it("does not apply to a game without partners", () => {
        const h = host("ada");
        const bo = peerFor("bo");
        send(bo.peer, { t: "joinRoom", code: h.code, name: "Bo" });
        send(h.peer, { t: "selectGame", gameId: "poker", settings: {}, seats: 3, difficulty: "steady" });
        send(h.peer, { t: "startGame" });
        expect(h.conn.last("room")!.room.chat).toBe("open");
        send(h.peer, { t: "chat", text: "all in" });
        expect(bo.conn.last("chat")!.message.text).toBe("all in");
      });

      it("applies to dominoes played in teams, and only then", () => {
        const teams = (on: boolean) => {
          const h = host(`d-${on}`);
          const bo = peerFor(`d-bo-${on}`);
          send(bo.peer, { t: "joinRoom", code: h.code, name: "Bo" });
          send(h.peer, {
            t: "selectGame",
            gameId: "dominoes",
            settings: { mode: "caribbean", teams: on },
            seats: 4,
            difficulty: "steady",
          });
          send(h.peer, { t: "startGame" });
          return h.conn.last("room")!.room.chat;
        };
        expect(teams(true)).toBe("quick-only");
        expect(teams(false)).toBe("open");
      });
    });
  });

  describe("photos", () => {
    const jpeg = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64)]).toString("base64")}`;

    it("shows everybody a member's photo, by id, and takes it down again", () => {
      const { conn, code } = host("ada");
      const bo = peerFor("bo");
      send(bo.peer, { t: "joinRoom", code, name: "Bo" });

      send(bo.peer, { t: "setPhoto", image: jpeg });
      const seen = conn.last("room")!.room.members.find((m) => m.name === "Bo")!;
      expect(seen.photo).toMatch(/^[A-Za-z0-9_-]{16,}$/);
      // The roster carries the id, never the picture.
      expect(JSON.stringify(conn.last("room"))).not.toContain("base64");

      send(bo.peer, { t: "setPhoto", image: null });
      expect(conn.last("room")!.room.members.find((m) => m.name === "Bo")!.photo).toBeNull();
    });

    it("refuses a picture it will not keep, and says so", () => {
      const { peer, conn } = host("ada");
      send(peer, { t: "setPhoto", image: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" });
      expect(conn.last("error")?.code).toBe("photo-rejected");
      expect(conn.last("room")!.room.members[0]!.photo).toBeNull();
    });
  });

  /**
   * The lobby holds nothing for anybody (the user, 2026-09-29): leaving it
   * is leaving, and an unexpected drop gets a silent LOBBY_GRACE_MS.
   */
  describe("leaving the lobby", () => {
    function lobbyOfTwo() {
      const h = host("ada");
      const bo = peerFor("bo");
      send(bo.peer, { t: "joinRoom", code: h.code, name: "Bo" });
      return { ...h, bo, boSession: registry.sessionFor("bo") };
    }

    const memberNamed = (conn: FakeConnection, name: string) =>
      conn.last("room")!.room.members.find((m) => m.name === name);

    it("keeps somebody who dropped looking exactly as they were, then lets them go", () => {
      const { conn, bo, boSession } = lobbyOfTwo();
      router.onClose(bo.peer);

      // Silent: nothing on the leader's screen says Bo dropped.
      expect(memberNamed(conn, "Bo")?.connected).toBe(true);
      clock.advance(LOBBY_GRACE_MS - 1);
      expect(memberNamed(conn, "Bo")).toBeDefined();

      clock.advance(1);
      expect(memberNamed(conn, "Bo")).toBeUndefined();
      expect(conn.all("notice").map((n) => n.text)).toContain("Bo left");
      // Forgotten by the registry too, so the home page offers no rejoin.
      expect(registry.roomOf(boSession)).toBeNull();
    });

    it("keeps them, and says nothing, when they are back inside the grace", () => {
      const { conn, bo, code } = lobbyOfTwo();
      router.onClose(bo.peer);
      clock.advance(LOBBY_GRACE_MS - 1000);
      conn.clear();

      const back = peerFor("bo");
      clock.advance(LOBBY_GRACE_MS * 3);
      expect(back.conn.last("room")!.room.code).toBe(code);
      expect(memberNamed(conn, "Bo")?.connected).toBe(true);
      expect(conn.all("notice").map((n) => n.text)).not.toContain("Bo left");
    });

    it("lets somebody who says bye go at once", () => {
      const { conn, bo, boSession } = lobbyOfTwo();
      send(bo.peer, { t: "bye" });
      expect(memberNamed(conn, "Bo")).toBeUndefined();
      expect(registry.roomOf(boSession)).toBeNull();
    });

    it("lets only the leader close the room", () => {
      const { code, bo } = lobbyOfTwo();
      send(bo.peer, { t: "closeRoom" });
      expect(bo.conn.last("error")?.code).toBe("not-leader");
      expect(registry.get(code)).not.toBeNull();
    });

    it("closes a lobby for everybody, with nothing to settle", () => {
      const { peer, conn, bo, code } = lobbyOfTwo();
      send(peer, { t: "closeRoom" });
      expect(bo.conn.last("left")).toMatchObject({ reason: "room-closed", by: "Ada", settlement: null });
      expect(conn.last("left")?.reason).toBe("room-closed");
      expect(registry.get(code)).toBeNull();
    });

    it("destroys a room the moment its last member leaves", () => {
      const { peer, code } = host("alone");
      send(peer, { t: "leaveRoom" });
      expect(registry.get(code)).toBeNull();
    });

    it("lets the next person into a room nobody is left in, and makes them its leader", () => {
      // Its last member lapsed while a knock was still waiting, so the room
      // is kept (for the reaper) with a leader who is no longer in it. The
      // next person in must not land in a room nobody can start - and there
      // is nobody left to let them in, so they are not made to knock.
      const { peer, code } = host("first");
      send(peer, { t: "setPrivacy", privacy: "private" });
      const knocker = peerFor("waiting");
      send(knocker.peer, { t: "joinRoom", code, name: "Waiting" });
      router.onClose(peer);
      clock.advance(LOBBY_GRACE_MS);

      const late = peerFor("late");
      send(late.peer, { t: "joinRoom", code, name: "Late" });
      expect(late.conn.last("pending")).toBeUndefined();
      expect(late.conn.last("room")!.room.youAreLeader).toBe(true);
    });
  });

  /**
   * Three states that a client could not tell apart, and had to.
   */
  describe("saying which kind of nothing this is", () => {
    it("tells a returning client whether it is still in a room", () => {
      // A client caches the last roster so a navigation does not strand
      // it on "Connecting…". That cache outlives the SERVER: restart the
      // process and a reconnecting client, greeted with nothing but its
      // own identity, went on rendering a complete interactive lobby for
      // a room that no longer existed.
      const fresh = peerFor("nobody");
      expect(fresh.conn.last("hello")!.inRoom).toBe(false);

      const { code } = host("homeowner");
      expect(code).toBeTruthy();
      const back = peerFor("homeowner");
      expect(back.conn.last("hello")!.inRoom).toBe(true);
    });

    it("refuses a wrong protocol with its own code, not a generic one", () => {
      // It used to answer `bad-message`, which a client cannot tell from
      // a garbled frame — so it retried forever behind a "Reconnecting…"
      // spinner that could never resolve, and the explanation was never
      // shown.
      const conn = new FakeConnection();
      const peer = makePeer(conn, clock.now());
      router.onMessage(peer, JSON.stringify({ t: "hello", token: "old", protocol: 999 }));

      expect(conn.last("error")!.code).toBe("protocol-mismatch");
      expect(conn.closed).toBe(true);
    });

    it("answers a refused move as a refused move", () => {
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

      // Nonsense from a seated player.
      h.conn.clear();
      send(h.peer, { t: "action", action: { t: "play", card: "not-a-card" } });

      // `bad-message` before, which is what a garbled frame gets — so a
      // client could not decide which of the two is worth interrupting
      // somebody over.
      expect(h.conn.last("error")!.code).toBe("move-refused");
    });
  });

  /**
   * "Never mind" used to only navigate: the request stayed on the
   * leader's list, so approving it later pulled somebody into a room
   * they had explicitly declined — and, if they had joined another one
   * meanwhile, into two rooms at once.
   */
  describe("taking a knock back", () => {
    function privateRoomWithAKnock() {
      const h = host("owner");
      send(h.peer, { t: "setPrivacy", privacy: "private" });
      const knocker = peerFor("knocker");
      send(knocker.peer, { t: "joinRoom", code: h.code, name: "Knocker" });
      return { ...h, knocker };
    }

    it("clears the request so a later approval does nothing", () => {
      const { peer, code, knocker } = privateRoomWithAKnock();
      const runtime = registry.get(code)!;
      expect(Object.keys(runtime.room.pending)).toHaveLength(1);

      send(knocker.peer, { t: "withdraw" });
      expect(Object.keys(runtime.room.pending)).toHaveLength(0);

      knocker.conn.clear();
      send(peer, { t: "approve", session: registry.sessionFor("knocker") });

      // Nothing drags them in: no roster, no room.
      expect(knocker.conn.last("room")).toBeUndefined();
      expect(registry.roomOf(registry.sessionFor("knocker"))).toBeNull();
    });

    it("tells the requester they are out of it", () => {
      const { knocker } = privateRoomWithAKnock();
      knocker.conn.clear();
      send(knocker.peer, { t: "withdraw" });
      expect(knocker.conn.last("left")).toBeDefined();
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
      // The CODE is the contract a client switches on; the message is for
      // a person, and is a sentence rather than the engine's own reason
      // string - that string was reaching players verbatim on the toast
      // seam, so a lost race announced "not-in-game" at them.
      const refusal = watcher.conn.last("error")!;
      expect(refusal.code).toBe("move-refused");
      expect(refusal.message).toBe("you are not at the table");
    });

    it("sends the face of every card it plays face up, even one gone by the end of the frame", () => {
      // The last card of a trick is played face up and collected face down
      // in one reduce, so the settled board a frame's meta was built from
      // no longer holds it — and `PieceLayer` draws nothing for a piece it
      // cannot describe. Watched from the spectator seat, which can see
      // every trick card and no hand.
      const { code, peer, conn, p2 } = twoPlayerSpades();
      const watcher = peerFor("watcher");
      send(watcher.peer, { t: "joinRoom", code, name: "Watcher" });
      send(watcher.peer, { t: "enterGame", as: "spectator" });
      // Both players stay seated and take their own turns, as a client
      // would: from the redacted state in their own latest frame. (Walking
      // both away, or dropping both, ends the game instead.)
      const players = [
        { peer, conn },
        { peer: p2.peer, conn: p2.conn },
      ];
      const rules = createSpades();
      for (let turn = 0; turn < 200; turn++) {
        clock.drain();
        const on = (registry.get(code)!.debugDump().table as { currentSeat: number | null })
          .currentSeat;
        const who = players.find((p) => p.conn.last("frame")?.frame.seat === on);
        if (on === null || !who) break;
        const frame = who.conn.last("frame")!.frame;
        const legal = rules.legalActions(frame.state as SpadesState, on);
        const action = legal.find((a) => a.t === "bid" && !a.nil) ?? legal[0];
        if (!action) break;
        send(who.peer, { t: "action", action });
      }

      let plays = 0;
      const faceless: string[] = [];
      for (const { frame } of watcher.conn.all("frame")) {
        for (const event of frame.events) {
          if (event.t !== "play" || !event.faceUp) continue;
          plays++;
          if (!frame.meta[event.piece]?.face) faceless.push(event.piece);
        }
      }
      expect(plays, "the bots should have played some tricks").toBeGreaterThan(8);
      expect(faceless).toEqual([]);

      // And the hand it left is one card shorter the moment it leaves —
      // replayed through the table store exactly as the online client
      // does. A card unmasked from a hidden hand used to leave its
      // stand-in behind until the frame reconciled, which for the last
      // card of a trick meant a back sitting in the hand through the hold
      // and the collect, seconds after the card had flown.
      const frames = watcher.conn.all("frame").map((m) => m.frame);
      const start = frames.findIndex((f) => f.events.length === 0);
      const store = useTableStore.getState();
      const inHand = (map: PlacementMap, seat: number) =>
        Object.values(map).filter((q) => q.zone === "hand" && q.seat === seat).length;
      store.reset(frames[start]!.placements, frames[start]!.meta);
      const lingering: string[] = [];
      for (const frame of frames.slice(start + 1)) {
        useTableStore.getState().learnMeta(frame.meta);
        for (const event of frame.events) {
          applyEventToTable(event);
          if (event.t !== "play") continue;
          const now = inHand(useTableStore.getState().placements, event.from);
          const settled = inHand(frame.placements, event.from);
          if (now !== settled) lingering.push(`seat ${event.from}: ${now} in hand, should be ${settled}`);
        }
        useTableStore.getState().reset(frame.placements, frame.meta);
      }
      expect(lingering.slice(0, 5)).toEqual([]);
    });

    it("gives the stand-ins a re-deal hands out a face-down face", () => {
      // From round two, tiles the viewer watched on the line are swept,
      // shuffled and dealt again. They go anonymous at the shuffle through
      // a `mask`, whose stand-ins exist only mid-batch — so the settled
      // board says nothing about them, and without meta `PieceLayer` would
      // deal invisible tiles.
      const h = host("p1");
      const p2 = peerFor("p2");
      send(p2.peer, { t: "joinRoom", code: h.code, name: "Second" });
      send(h.peer, { t: "selectGame", gameId: "dominoes", settings: {}, seats: 4, difficulty: "steady" });
      send(h.peer, { t: "startGame" });
      const players = [h, p2];
      const rules = GAMES.dominoes.create(GAMES.dominoes.parse({}));
      for (let turn = 0; turn < 400; turn++) {
        clock.drain();
        const table = registry.get(h.code)!.debugDump().table as {
          currentSeat: number | null;
          round: number;
          isOver: boolean;
        } | null;
        if (!table || table.isOver || table.round >= 3) break;
        if (table.currentSeat === null) {
          send(h.peer, { t: "nextRound" });
          continue;
        }
        const who = players.find((p) => p.conn.last("frame")?.frame.seat === table.currentSeat);
        if (!who) continue;
        const legal = rules.legalActions(who.conn.last("frame")!.frame.state, table.currentSeat);
        if (legal[0] === undefined) continue;
        send(who.peer, { t: "action", action: legal[0] });
      }

      let masked = 0;
      const faceless: string[] = [];
      for (const { frame } of h.conn.all("frame")) {
        for (const event of frame.events) {
          if (event.t !== "mask") continue;
          for (const { piece } of event.add) {
            masked++;
            if (frame.meta[piece]?.kind !== "tile") faceless.push(piece);
          }
        }
      }
      expect(masked, "a later round should have re-dealt tiles off the line").toBeGreaterThan(0);
      expect(faceless).toEqual([]);
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

        /**
         * The reason a table of bots used to skip its own animations.
         *
         * A bot's `think` rides INSIDE the frame and every client plays it
         * out, but the server spaced turns by a flat 900ms from the moment
         * it broadcast. So each turn took a client longer to watch than
         * the server gave it, the queue grew by a fraction of a second per
         * turn, and past the catch-up limit clients dropped the backlog
         * and jumped to the present — taking the dice tumble with it.
         *
         * Offline never had this, because there the hold starts when the
         * animation FINISHES. Online the hold has to be told how long that
         * was.
         */
        it("gives every bot turn as long to watch as it takes to play", () => {
          /** Wraps a connection so every frame it is sent is timestamped. */
          const stamped = (conn: FakeConnection) => {
            const at = new Map<ServerMessage, number>();
            const original = conn.send.bind(conn);
            conn.send = (message) => {
              at.set(message, clock.now());
              original(message);
            };
            return at;
          };

          const h = host("p1");
          const second = peerFor("p2");
          send(second.peer, { t: "joinRoom", code: h.code, name: "Second" });
          send(h.peer, { t: "selectGame", gameId: "spades", settings: {}, seats: 4, difficulty: "steady" });
          send(h.peer, { t: "startGame" });

          const { session } = parkOnAHuman(h.code);
          const hostIsOnTurn = session === registry.sessionFor("p1");
          const survivor = hostIsOnTurn ? second : h;
          const dropper = hostIsOnTurn ? h : second;

          const at = stamped(survivor.conn);
          survivor.conn.clear();
          router.onClose(dropper.peer);
          clock.drain();

          // The bot-turn frames as the survivor saw them: `think` rides
          // first in exactly those, and in nothing else.
          const turns = survivor.conn
            .all("frame")
            .map((m) => ({ at: at.get(m)!, events: m.frame.events }))
            .filter((t) => t.events[0]?.t === "think");

          expect(turns.length, "bots should have taken more than one turn").toBeGreaterThanOrEqual(2);
          for (let i = 1; i < turns.length; i++) {
            const gap = turns[i]!.at - turns[i - 1]!.at;
            // Exactly the hold plus what the previous frame takes to play.
            // `unmask` is dropped first: it is added per viewer, so the
            // server never saw it when it worked the estimate out.
            const expected =
              DEFAULT_TURN_HOLD_MS + playbackMs(turns[i - 1]!.events.filter((e) => e.t !== "unmask"));
            expect(gap, `bot turn ${i} came ${gap}ms after the last`).toBe(expected);
          }
          // And the case this exists for is really in here: at least one
          // turn long enough that the old flat 900ms would have been wrong.
          expect(
            turns.slice(0, -1).some((t) => playbackMs(t.events.filter((e) => e.t !== "unmask")) > 0),
            "no turn in this run took any time to watch, so nothing was tested",
          ).toBe(true);
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

    /**
     * The user's rule (2026-09-27): when the last real person leaves, the
     * game is torn down, and "all bots should not be playing, not even for
     * 1 second".
     *
     * Each way out is taken at the worst moment: the person has just moved,
     * so a bot's turn is already armed and waiting out its hold. Then the
     * clock is run dry. Not one more frame may reach anybody.
     */
    describe("the last real player out ends it, with no bot turn after", () => {
      type Player = { peer: Peer; conn: FakeConnection };

      /**
       * `stays` is alone at the table and has just made a move; `other`
       * stepped away earlier, so a bot plays their seat.
       */
      function aloneAtTheTable(who: "host" | "guest") {
        const t = twoPlayerSpades();
        const host: Player = { peer: t.peer, conn: t.conn };
        const guest: Player = t.p2;
        const stays = who === "host" ? host : guest;
        const other = who === "host" ? guest : host;
        send(other.peer, { t: "exitGame" });

        // Bots play up to the person still sitting there, who then moves.
        clock.drain();
        const on = (registry.get(t.code)!.debugDump().table as { currentSeat: number }).currentSeat;
        const frame = stays.conn.last("frame")!.frame;
        expect(frame.seat, "the table should be waiting on the one still seated").toBe(on);
        const legal = createSpades().legalActions(frame.state as SpadesState, on);
        send(stays.peer, { t: "action", action: legal.find((a) => a.t === "bid" && !a.nil) ?? legal[0] });
        expect(clock.pending, "a bot's turn should be armed").toBeGreaterThan(0);
        return { code: t.code, stays, other };
      }

      const WAYS_OUT: Array<[string, "host" | "guest", (s: Player, o: Player) => void]> = [
        ["walk back to the lobby", "host", (s) => send(s.peer, { t: "exitGame" })],
        ["leave the room", "host", (s) => send(s.peer, { t: "leaveRoom" })],
        // Closing the tab, losing signal, and now leaving the room's page.
        ["drop their connection", "host", (s) => router.onClose(s.peer)],
        ["are removed by the leader", "guest", (s, leader) => {
          send(leader.peer, { t: "kick", session: registry.sessionFor("p2") });
        }],
      ];

      for (const [how, who, leave] of WAYS_OUT) {
        it(`when they ${how}`, () => {
          const { code, stays, other } = aloneAtTheTable(who);
          stays.conn.clear();
          other.conn.clear();

          leave(stays, other);
          clock.drain();

          expect(registry.get(code)?.hasGame ?? false, "the game should be over").toBe(false);
          expect(stays.conn.all("frame"), "no frame to the one who left").toEqual([]);
          expect(other.conn.all("frame"), "no frame to anybody else").toEqual([]);
        });
      }
    });

    describe("a forced move, made for somebody who does not make it", () => {
      it("rolls for a silent LRC player once the wait is up, and takes their late press quietly", () => {
        const h = host("p1");
        const p2 = peerFor("p2");
        send(p2.peer, { t: "joinRoom", code: h.code, name: "Second" });
        send(h.peer, { t: "selectGame", gameId: "lrc", settings: {}, seats: 3, difficulty: "steady" });
        send(h.peer, { t: "startGame" });

        const runtime = registry.get(h.code)!;
        const table = () => runtime.debugDump().table as { currentSeat: number; fingerprint: string };
        const seat = table().currentSeat;
        const owner = runtime.room.game!.seatOwner[seat];
        expect(owner, "the opening roll should be a person's").not.toBeNull();
        const who = owner === registry.sessionFor("p1") ? h : p2;

        // Their wait starts once the deal that handed them the turn
        // has started on their screen (`READY_BEAT_MS`) and played — the
        // server's own measure of it.
        const frames = h.conn.all("frame");
        expect(frames, "only the deal has happened").toHaveLength(1);
        const lead = READY_BEAT_MS + playbackMs(frames[0]!.frame.events);
        expect(lead, "the deal takes time to watch").toBeGreaterThan(0);

        const before = table().fingerprint;
        clock.advance(lead + FORCED_MOVE_MS - 1);
        expect(table().fingerprint, "nothing before the wait is up").toBe(before);
        clock.advance(1);
        expect(table().fingerprint, "the roll should have been made for them").not.toBe(before);

        // They pressed Roll just as it was made for them: same move, second.
        who.conn.clear();
        send(who.peer, { t: "action", action: { t: "roll", dice: [] } });
        expect(who.conn.all("error")).toEqual([]);
      });
    });

    describe("the next round deals itself", () => {
      // LRC, because every move in it is forced: a room of people who never
      // press anything plays itself to each scorecard, and the only thing
      // left to wait on is Continue.
      function table(gameId: "lrc" | "poker", settings: Record<string, unknown>) {
        const h = host("p1");
        const p2 = peerFor("p2");
        send(p2.peer, { t: "joinRoom", code: h.code, name: "Second" });
        send(h.peer, { t: "selectGame", gameId, settings, seats: 3, difficulty: "steady" });
        // When each frame went out: the server counts the scorecard's twenty
        // seconds from there, plus what that frame takes to play.
        const stamps: Array<{ at: number; frame: FrameView }> = [];
        const deliver = h.conn.send.bind(h.conn);
        h.conn.send = (m: ServerMessage) => {
          if (m.t === "frame") stamps.push({ at: clock.now(), frame: m.frame });
          deliver(m);
        };
        send(h.peer, { t: "startGame" });
        return { h, p2, stamps, runtime: registry.get(h.code)! };
      }
      const lrcTable = () => table("lrc", { target: 3 });

      function untilRoundOver(stamps: Array<{ at: number; frame: FrameView }>, from: number) {
        for (let i = 0; i < 4_000; i++) {
          const hit = stamps.slice(from).find((x) => x.frame.isRoundOver && !x.frame.isOver);
          if (hit) return hit;
          clock.advance(250);
        }
        throw new Error("no round ended");
      }

      const dueAt = (hit: { at: number; frame: FrameView }) =>
        hit.at + playbackMs(hit.frame.events) + ROUND_END_HOLD_MS + AUTO_CONTINUE_MS + AUTO_CONTINUE_GRACE_MS;
      const roundOf = (runtime: NonNullable<ReturnType<RoomRegistry["get"]>>) =>
        (runtime.debugDump().table as { round: number }).round;

      it("twenty seconds after the scorecard goes up, if nobody continues", () => {
        const { stamps, runtime } = lrcTable();
        const hit = untilRoundOver(stamps, 0);
        const round = roundOf(runtime);

        clock.advance(dueAt(hit) - clock.now() - 1);
        expect(roundOf(runtime), "not a moment early").toBe(round);
        clock.advance(1);
        expect(roundOf(runtime), "the next round should have been dealt").toBe(round + 1);
      });

      it("gives every scorecard its own twenty seconds, however soon the last was answered", () => {
        // A timer left over from the first scorecard must not deal the third
        // round early. It can only do that if the second round is already
        // over when it fires, so this needs rounds that end fast: poker hands
        // where both people fold at every chance.
        const { h, p2, stamps, runtime } = table("poker", {});
        const rules = GAMES.poker.create(GAMES.poker.parse({}));
        const people = [h, p2];

        /** Folds (or mucks, or checks) for whichever person is on turn, until a hand ends. */
        const handOver = (from: number) => {
          for (let i = 0; i < 4_000; i++) {
            const hit = stamps.slice(from).find((x) => x.frame.isRoundOver && !x.frame.isOver);
            if (hit) return hit;
            const seat = (runtime.debugDump().table as { currentSeat: number | null }).currentSeat;
            const who = people.find((p) => p.conn.last("frame")?.frame.seat === seat);
            if (who && seat !== null) {
              const legal = rules.legalActions(who.conn.last("frame")!.frame.state, seat) as Array<{ t: string }>;
              const pick =
                legal.find((a) => a.t === "fold") ??
                legal.find((a) => a.t === "muck") ??
                legal.find((a) => a.t === "check") ??
                legal[0];
              if (pick) send(who.peer, { t: "action", action: pick });
            }
            clock.advance(50);
          }
          throw new Error("no hand ended");
        };

        const first = handOver(0);
        clock.advance(2_000);
        send(h.peer, { t: "nextRound" });
        const second = roundOf(runtime);

        const hit = handOver(stamps.length);
        // The whole point: the second hand ended well inside the first
        // scorecard's twenty seconds, which is when a leftover timer bites.
        expect(hit.at).toBeLessThan(dueAt(first));
        expect(roundOf(runtime)).toBe(second);
        clock.advance(dueAt(hit) - clock.now() - 1);
        expect(roundOf(runtime), "dealt early, by the first scorecard's timer").toBe(second);
        clock.advance(1);
        expect(roundOf(runtime)).toBe(second + 1);
      });

      it("leaves nothing behind when the leader ends the game during it", () => {
        const { h, stamps, runtime } = lrcTable();
        const hit = untilRoundOver(stamps, 0);
        send(h.peer, { t: "endGame" });
        const framesAfter = stamps.length;

        clock.advance(dueAt(hit) - clock.now() + 1_000);
        expect(runtime.room.game).toBeNull();
        expect(stamps.length, "no deal for a game that has ended").toBe(framesAfter);
      });
    });

    describe("the turn timer", () => {
      /**
       * Spades with two people at five seconds a move, every message
       * stamped with the clock when it was SENT — the server counts from
       * there, and so must the test.
       */
      function timedSpades() {
        const h = host("ada", { turnTimer: true });
        const bo = peerFor("bo");
        send(bo.peer, { t: "joinRoom", code: h.code, name: "Bo" });
        send(h.peer, { t: "setTurnTimer", on: true, seconds: 5 });
        send(h.peer, { t: "selectGame", gameId: "spades", settings: {}, seats: 4, difficulty: "steady" });
        const people = [
          { peer: h.peer, conn: h.conn, session: registry.sessionFor("ada") },
          { peer: bo.peer, conn: bo.conn, session: registry.sessionFor("bo") },
        ];
        const clocks: Array<{ at: number; clock: TurnClockView | null; to: string }> = [];
        for (const p of people) {
          const deliver = p.conn.send.bind(p.conn);
          p.conn.send = (m: ServerMessage) => {
            if (m.t === "turnClock") clocks.push({ at: clock.now(), clock: m.clock, to: p.session });
            deliver(m);
          };
        }
        send(h.peer, { t: "startGame" });
        const runtime = registry.get(h.code)!;
        return { h, bo, people, clocks, runtime, rules: createSpades() };
      }
      type Timed = ReturnType<typeof timedSpades>;

      const tableOf = (t: Timed) => t.runtime.debugDump().table as { currentSeat: number | null; fingerprint: string };

      /** Steps the bots along until a person is on turn and has been told their clock. */
      function untilPersonOnTurn(t: Timed) {
        for (let i = 0; i < 2_000; i++) {
          const seat = tableOf(t).currentSeat;
          const owner = seat === null ? null : t.runtime.room.game!.seatOwner[seat];
          const person = t.people.find((p) => p.session === owner);
          const told = [...t.clocks].reverse().find((c) => c.to === owner);
          if (person && told?.clock && told.clock.seat === seat) return { seat: seat!, person, told };
          clock.advance(50);
        }
        throw new Error("never reached a person's turn");
      }

      const playFirstLegal = (t: Timed, who: Timed["people"][number], seat: number) => {
        const legal = t.rules.legalActions(who.conn.last("frame")!.frame.state as SpadesState, seat);
        send(who.peer, { t: "action", action: legal[0] });
      };

      it("tells the table whose clock it is, and makes the move when it runs out", () => {
        const t = timedSpades();
        const { seat, told } = untilPersonOnTurn(t);
        expect(told.clock!.totalMs).toBe(5_000);
        // Everybody at the table is told, not only the person on turn.
        expect(new Set(t.clocks.filter((c) => c.clock?.key === told.clock!.key).map((c) => c.to)).size).toBe(2);

        const due = told.at + told.clock!.endsInMs + TURN_GRACE_MS;
        const before = tableOf(t).fingerprint;
        clock.advance(due - clock.now() - 1);
        expect(tableOf(t).fingerprint, "inside the grace the move is still theirs").toBe(before);
        clock.advance(1);
        expect(tableOf(t).currentSeat).not.toBe(seat);
        const said = t.people[0]!.conn.all("frame").flatMap((f) => f.frame.events);
        expect(said).toContainEqual(expect.objectContaining({ t: "announce", text: "ran out of time" }));
      });

      it("takes a press that lands just after the clock ran out without a second word", () => {
        // The frame that made the move already told them ("You ran out of
        // time"); a refusal toast on top was the same news twice, in red.
        const t = timedSpades();
        const { seat, person, told } = untilPersonOnTurn(t);
        const legal = t.rules.legalActions(person.conn.last("frame")!.frame.state as SpadesState, seat);
        clock.advance(told.at + told.clock!.endsInMs + TURN_GRACE_MS - clock.now());
        expect(tableOf(t).currentSeat, "the clock should have made the move").not.toBe(seat);

        const errors = person.conn.all("error").length;
        send(person.peer, { t: "action", action: legal[0] });
        expect(person.conn.all("error")).toHaveLength(errors);
      });

      it("tells somebody arriving mid-move the time actually left, and does not refill it", () => {
        // Somebody else dropping and coming back is a liveness edge, which
        // re-settles the table — the classic way to refill a clock.
        const t = timedSpades();
        const { told, person } = untilPersonOnTurn(t);
        const other = t.people.find((p) => p !== person)!;
        const due = told.at + told.clock!.endsInMs + TURN_GRACE_MS;

        clock.advance(1_500);
        router.onClose(other.peer);
        clock.advance(1_000);
        const back = peerFor(other.session === registry.sessionFor("ada") ? "ada" : "bo");
        const arrived = back.conn.last("turnClock")!.clock!;
        expect(arrived.key).toBe(told.clock!.key);
        expect(arrived.endsInMs).toBe(told.at + told.clock!.endsInMs - clock.now());

        const before = tableOf(t).fingerprint;
        clock.advance(due - clock.now() - 1);
        expect(tableOf(t).fingerprint, "the clock was refilled").toBe(before);
        clock.advance(1);
        expect(tableOf(t).fingerprint).not.toBe(before);
      });

      it("gives the seat to a bot after two in a row, until they say they are back", () => {
        const t = timedSpades();
        const first = untilPersonOnTurn(t);
        const who = first.person;
        let timedOut = 0;
        for (let i = 0; i < 400 && timedOut < 2; i++) {
          const now = untilPersonOnTurn(t);
          if (now.person === who) {
            clock.advance(now.told.at + now.told.clock!.endsInMs + TURN_GRACE_MS - clock.now());
            timedOut++;
          } else {
            playFirstLegal(t, now.person, now.seat);
          }
        }
        expect(timedOut).toBe(2);
        const game = t.runtime.room.game!;
        const seat = game.seatOwner.indexOf(who.session);
        expect(game.idle).toContain(who.session);
        expect(t.runtime.debugDump().liveSeats).toEqual(expect.arrayContaining([false]));
        expect((t.runtime.debugDump().liveSeats as boolean[])[seat]).toBe(false);
        expect(who.conn.last("room")!.room.members.find((m) => m.session === who.session)!.idle).toBe(true);

        send(who.peer, { t: "resume" });
        expect(t.runtime.room.game!.idle).not.toContain(who.session);
        expect((t.runtime.debugDump().liveSeats as boolean[])[seat]).toBe(true);
      });

      it("counts a turn of several moves once: one silent Rummy turn is not two in a row", () => {
        // Every move has its own clock, and a Rummy turn is at least two
        // moves. Counting clocks marked somebody idle after a single turn
        // away — and with both people at a two-person table doing that, the
        // whole game ended in its first round.
        const h = host("ada", { turnTimer: true });
        const bo = peerFor("bo");
        send(bo.peer, { t: "joinRoom", code: h.code, name: "Bo" });
        send(h.peer, { t: "setTurnTimer", on: true, seconds: 5 });
        send(h.peer, { t: "selectGame", gameId: "rummy", settings: {}, seats: 3, difficulty: "steady" });
        send(h.peer, { t: "startGame" });
        const runtime = registry.get(h.code)!;
        const boSeat = runtime.room.game!.seatOwner.indexOf(registry.sessionFor("bo"));
        const onTurn = () => (runtime.debugDump().table as { currentSeat: number | null }).currentSeat;
        const boTimedOut = () =>
          bo.conn
            .all("frame")
            .filter(
              (f) =>
                f.frame.lastAction?.seat === boSeat &&
                f.frame.events.some((e) => e.t === "announce" && e.text === "ran out of time"),
            ).length;
        const botTookBo = () => h.conn.all("notice").some((n) => n.text === "A bot is playing for Bo");

        // Bo's first turn, every move of it run out, and over.
        for (let i = 0; i < 5_000 && !(boTimedOut() >= 2 && onTurn() !== boSeat); i++) clock.advance(100);
        expect(boTimedOut(), "a draw and a discard, at least").toBeGreaterThanOrEqual(2);
        expect(onTurn()).not.toBe(boSeat);
        expect(botTookBo(), "one turn away is not two in a row").toBe(false);

        // The second turn they miss is.
        const firstTurn = boTimedOut();
        for (let i = 0; i < 5_000 && boTimedOut() === firstTurn; i++) clock.advance(100);
        expect(botTookBo()).toBe(true);
      });

      it("takes a move from somebody idle as their being back", () => {
        const t = timedSpades();
        const { person } = untilPersonOnTurn(t);
        // Two timeouts, as above, in fewer words: straight to idle.
        t.runtime.command(person.session, { t: "markIdle" });
        t.runtime.broadcastRoom();
        expect(person.conn.last("room")!.room.members.find((m) => m.session === person.session)!.idle).toBe(true);
        const seat = t.runtime.room.game!.seatOwner.indexOf(person.session);
        for (let i = 0; i < 4_000 && tableOf(t).currentSeat !== seat; i++) {
          const on = tableOf(t).currentSeat;
          const other = t.people.find((p) => p !== person && t.runtime.room.game!.seatOwner[on ?? -1] === p.session);
          if (other && on !== null) playFirstLegal(t, other, on);
          clock.advance(10);
        }
        expect(tableOf(t).currentSeat).toBe(seat);
        playFirstLegal(t, person, seat);
        expect(t.runtime.room.game!.idle).not.toContain(person.session);
        // And their screen is told, so the "I'm back" pill goes.
        expect(person.conn.last("room")!.room.members.find((m) => m.session === person.session)!.idle).toBe(false);
      });

      it("ends the game when everybody has walked away", () => {
        const t = timedSpades();
        for (let i = 0; i < 400 && t.runtime.room.game; i++) {
          const seat = tableOf(t).currentSeat;
          if (seat !== null && t.runtime.room.game.seatOwner[seat]) clock.advance(10_000);
          else clock.advance(50);
        }
        expect(t.runtime.room.game).toBeNull();
        expect(t.people[0]!.conn.all("notice").map((n) => n.text)).toContain("Everyone is away — game ended");
      });

      it("cannot be changed while a game is running", () => {
        const t = timedSpades();
        send(t.h.peer, { t: "setTurnTimer", on: false });
        expect(t.h.conn.last("error")?.code).toBe("game-already-running");
      });
    });

    describe("a seat is held, a lobby row is not", () => {
      it("keeps a dropped seat holder past the grace, and lets them go once the game ends", () => {
        const { peer, p2 } = twoPlayerSpades();
        const second = registry.sessionFor("p2");
        router.onClose(p2.peer);

        clock.advance(LOBBY_GRACE_MS * 3);
        expect(registry.roomOf(second)).not.toBeNull();

        send(peer, { t: "endGame" });
        clock.advance(LOBBY_GRACE_MS - 1);
        expect(registry.roomOf(second)).not.toBeNull();
        clock.advance(1);
        expect(registry.roomOf(second)).toBeNull();
      });

      it("keeps the seat of somebody who says bye mid-game, and the table plays on", () => {
        const { code, p2 } = twoPlayerSpades();
        const second = registry.sessionFor("p2");
        const seat = registry.get(code)!.room.game!.seatOwner.indexOf(second);

        send(p2.peer, { t: "bye" });
        router.onClose(p2.peer);
        const before = registry.get(code)!.debugDump().table as { fingerprint: string };
        clock.drain();

        const runtime = registry.get(code)!;
        expect(runtime.room.game!.seatOwner[seat]).toBe(second);
        expect(registry.roomOf(second)).toBe(runtime);
        const after = runtime.debugDump().table as { fingerprint: string };
        expect(after.fingerprint, "a bot should have played on in their seat").not.toBe(
          before.fingerprint,
        );
      });

      it("lets a spectator who says bye go at once", () => {
        const { code, conn } = twoPlayerSpades();
        const watcher = peerFor("watcher");
        send(watcher.peer, { t: "joinRoom", code, name: "Watcher" });
        send(watcher.peer, { t: "enterGame", as: "spectator" });
        send(watcher.peer, { t: "bye" });
        expect(conn.last("room")!.room.members.some((m) => m.name === "Watcher")).toBe(false);
      });
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

  /**
   * Poker and LRC played for money end with who pays whom (the user,
   * 2026-09-28). Worked out by the server, because when the leader ends a
   * game only the server still holds the position — the table is gone from
   * every screen.
   */
  describe("settling up a game played for money", () => {
    function room(gameId: "poker" | "lrc", settings: Record<string, unknown>) {
      const h = host("p1");
      const p2 = peerFor("p2");
      send(p2.peer, { t: "joinRoom", code: h.code, name: "Bo" });
      send(h.peer, { t: "selectGame", gameId, settings, seats: 3, difficulty: "steady" });
      send(h.peer, { t: "startGame" });
      return { h, p2 };
    }

    it("tells everyone who pays whom when the leader ends the game", () => {
      const { h, p2 } = room("poker", { buyIn: 2000 });
      send(h.peer, { t: "endGame" });
      const settled = p2.conn.last("room")!.room.settlement!;
      expect(settled.stake).toBe("$20 buy-in");
      expect(settled.finished).toBe(false);
      // The two people, never the bot in the third seat.
      expect(settled.results.map((r) => r.name).sort()).toEqual(["Ada", "Bo"]);
      // The first hand was still being played, so it is called off: the
      // blinds go back and nobody owes anybody.
      expect(settled.results.every((r) => r.cents === 0)).toBe(true);
      expect(settled.payments).toEqual([]);
    });

    it("forgets the last game's payments once the next one starts", () => {
      const { h } = room("poker", { buyIn: 2000 });
      send(h.peer, { t: "endGame" });
      expect(h.conn.last("room")!.room.settlement).not.toBeNull();
      send(h.peer, { t: "startGame" });
      expect(h.conn.last("room")!.room.settlement).toBeNull();
    });

    it("settles a game the leader closes the room on, and tells everybody with it", () => {
      const { h, p2 } = room("poker", { buyIn: 2000 });
      const knocker = peerFor("late-knock");
      send(h.peer, { t: "setPrivacy", privacy: "private" });
      // Private only now, mid-game: a knock on it waits in `awaiting`.
      send(knocker.peer, { t: "joinRoom", code: h.code, name: "Late" });
      expect(knocker.conn.last("pending")).toBeDefined();

      send(h.peer, { t: "closeRoom" });

      for (const who of [h, p2]) {
        const left = who.conn.last("left")!;
        expect(left.reason).toBe("room-closed");
        expect(left.by).toBe("Ada");
        expect(left.settlement?.gameId).toBe("poker");
        // Let go of, not hung up on: that socket carries whatever they do next.
        expect(who.conn.closed).toBe(false);
      }
      expect(knocker.conn.last("left")?.reason).toBe("room-closed");
      expect(registry.get(h.code)).toBeNull();
      expect(registry.roomOf(registry.sessionFor("p2"))).toBeNull();

      // And the socket still works: the same person can make a new room.
      send(p2.peer, { t: "createRoom", name: "Bo" });
      expect(p2.conn.last("room")!.room.code).not.toBe(h.code);
    });

    it("says nothing for a game with no stake", () => {
      const { h } = room("poker", {});
      send(h.peer, { t: "endGame" });
      expect(h.conn.last("room")!.room.settlement).toBeNull();
    });

    /** Plays a one-round LRC match to its winner, every person taking the first legal action. */
    function playToWinner(code: string, players: ReadonlyArray<{ peer: Peer; conn: FakeConnection }>) {
      const rules = GAMES.lrc.create(GAMES.lrc.parse({ target: 1 }));
      for (let turn = 0; turn < 2000; turn++) {
        clock.drain();
        const table = registry.get(code)!.debugDump().table as {
          currentSeat: number | null;
          isOver: boolean;
        } | null;
        if (!table || table.isOver) return;
        if (table.currentSeat === null) continue;
        const who = players.find((p) => p.conn.last("frame")?.frame.seat === table.currentSeat);
        if (!who) continue;
        const legal = rules.legalActions(who.conn.last("frame")!.frame.state, table.currentSeat);
        if (legal[0] === undefined) continue;
        send(who.peer, { t: "action", action: legal[0] });
      }
    }

    it("still counts somebody who lost and walked out halfway, by name", () => {
      // Money is owed by people, not seats (the user, 2026-09-28): leaving the
      // room hands the seat to a bot, but what they lost while it was theirs
      // is still theirs to pay. Three people, no bots, so nothing is scaled.
      const h = host("p1");
      const p2 = peerFor("p2");
      const p3 = peerFor("p3");
      send(p2.peer, { t: "joinRoom", code: h.code, name: "Bo" });
      send(p3.peer, { t: "joinRoom", code: h.code, name: "Cy" });
      send(h.peer, { t: "selectGame", gameId: "lrc", settings: { target: 2, chipValue: 25 }, seats: 3, difficulty: "steady" });
      send(h.peer, { t: "startGame" });

      const players = [h, p2, p3];
      const rules = GAMES.lrc.create(GAMES.lrc.parse({ target: 2 }));
      // Stepped, not drained: a drain would run on through the scorecard's
      // own twenty seconds (it deals the next round itself) and past the
      // point this test is about.
      for (let turn = 0; turn < 6000 && !h.conn.last("frame")?.frame.isRoundOver; turn++) {
        clock.advance(100);
        const current = h.conn.last("frame")?.frame.currentSeat;
        const who = players.find((p) => p.conn.last("frame")?.frame.seat === current);
        if (current == null || !who) continue;
        const legal = rules.legalActions(who.conn.last("frame")!.frame.state, current);
        if (legal[0] !== undefined) send(who.peer, { t: "action", action: legal[0] });
      }
      const won = h.conn.last("frame")!.frame.roundWinner;
      expect(won, "the first round should have been played out").not.toBeNull();

      // A guest who lost it walks out; the leader then calls the game off.
      const leaver = [p2, p3].find((p) => p.conn.last("frame")!.frame.seat !== won)!;
      const leaverName = leaver === p2 ? "Bo" : "Cy";
      send(leaver.peer, { t: "leaveRoom" });
      send(h.peer, { t: "endGame" });

      const settled = h.conn.last("room")!.room.settlement!;
      expect(settled.results.find((r) => r.name === leaverName)?.cents).toBe(-75);
      expect(settled.payments.filter((p) => p.fromName === leaverName)).toHaveLength(1);
      expect(settled.payments.reduce((n, p) => n + p.cents, 0)).toBe(150);
      expect(settled.botsLeftOut).toBe(false);
    });

    it("keeps a finished match's payments when a loser walks out before the table empties", () => {
      // The settlement is made on the winner's sheet. Leaving the room
      // afterwards releases the seat, and the last person leaving the
      // table ends the session — which must not settle again, or the one
      // who walked out counts as a bot and their debt disappears.
      const { h, p2 } = room("lrc", { target: 1, chipValue: 25 });
      playToWinner(h.code, [h, p2]);
      const onTheSheet = h.conn.last("room")!.room.settlement!;
      expect(onTheSheet.payments).toHaveLength(1);

      const loser = onTheSheet.payments[0]!.from;
      const [leaving, staying] = loser === registry.sessionFor("p2") ? [p2, h] : [h, p2];
      send(leaving.peer, { t: "leaveRoom" });
      send(staying.peer, { t: "exitGame" });

      const after = staying.conn.last("room")!.room;
      expect(after.gameRunning).toBe(false);
      expect(after.settlement).toEqual(onTheSheet);
    });

    it("settles a match played to its winner, while everyone is still at the table", () => {
      const { h, p2 } = room("lrc", { target: 1, chipValue: 25 });
      playToWinner(h.code, [h, p2]);

      const view = h.conn.last("room")!.room;
      expect(view.gameRunning, "the match is over, but nobody has left the table").toBe(true);
      const settled = view.settlement!;
      expect(settled.finished).toBe(true);
      expect(settled.stake).toBe("25¢ a chip");
      // One round, three chips each at 25¢: a person who won it is up the
      // other person's 75¢ (the bot's is left out); one who lost is down 75¢.
      const net = settled.results.reduce((n, r) => n + r.cents, 0);
      expect(net).toBe(0);
      for (const p of settled.payments) expect(p.cents).toBe(75);
    });
  });

  /**
   * Bookkeeping that nothing visible depends on until it does.
   */
  describe("not growing without end", () => {
    it("keeps an identity that is in a room, however old", () => {
      const { code } = host("tenant");
      const tenant = registry.sessionFor("tenant");

      // Plenty of strangers pass through.
      for (let i = 0; i < 200; i++) peerFor(`passer-${i}`);

      // Same token, same identity: the seat is still reclaimable.
      expect(registry.sessionFor("tenant")).toBe(tenant);
      expect(registry.get(code)).not.toBeNull();
    });

    it("knows whether anybody is connected, for the keep-awake check", () => {
      // What `KeepAwake` asks before it makes any request: a service
      // should stay awake exactly while a person is in it.
      expect(registry.hasConnections()).toBe(false);

      const { peer } = host("keeper");
      expect(registry.hasConnections()).toBe(true);

      router.onClose(peer);
      // A room outlives its last member by a minute, but nobody is IN it.
      expect(registry.size).toBe(1);
      expect(registry.hasConnections()).toBe(false);
    });

    it("counts a message in bytes rather than in UTF-16 code units", () => {
      // `String.length` undercounts every character outside the BMP by
      // half, so the cap it thought it was enforcing was up to four times
      // larger for a payload built out of them.
      const { peer, conn } = peerFor("whale");
      const huge = "🂡".repeat(40_000); // ~160KB, length 80_000
      router.onMessage(peer, JSON.stringify({ t: "rename", name: huge }));
      expect(conn.last("error")!.message).toBe("message too large");
    });

    it("cleans up a knock when its owner goes somewhere else", () => {
      // `roomOf` is null for a pending requester, so `leaveCurrentRoom`
      // used to skip them entirely: the knock on A stayed standing while
      // they joined B, and A's leader approving it later pulled them into
      // two rooms at once.
      const a = host("owner-a");
      send(a.peer, { t: "setPrivacy", privacy: "private" });
      const b = host("owner-b");

      const wanderer = peerFor("wanderer");
      send(wanderer.peer, { t: "joinRoom", code: a.code, name: "Wanderer" });
      expect(Object.keys(registry.get(a.code)!.room.pending)).toHaveLength(1);

      // Off to a different, public room.
      send(wanderer.peer, { t: "joinRoom", code: b.code, name: "Wanderer" });
      expect(Object.keys(registry.get(a.code)!.room.pending)).toHaveLength(0);

      // And A's leader approving now cannot drag them back out of B.
      send(a.peer, { t: "approve", session: registry.sessionFor("wanderer") });
      expect(registry.roomOf(registry.sessionFor("wanderer"))!.code).toBe(b.code);
    });

    it("leaves somebody in their room when the one they asked to join turns them away", () => {
      // It took them out of A first and was THEN refused by B — here, a name
      // B already has — which left them in no room at all while their screen
      // still showed A, every button on it answering "you are not in a room".
      const a = host("owner-a");
      const b = host("owner-b");
      const wanderer = peerFor("wanderer");
      send(wanderer.peer, { t: "joinRoom", code: a.code, name: "Wanderer" });
      wanderer.conn.clear();

      send(wanderer.peer, { t: "joinRoom", code: b.code, name: "Ada", reqId: "r7" });

      // Answered with the request it answers, so the screen waiting on it stops.
      expect(wanderer.conn.last("error")).toMatchObject({ code: "name-taken", reqId: "r7" });
      const session = registry.sessionFor("wanderer");
      expect(registry.roomOf(session)!.code).toBe(a.code);
      expect(registry.get(a.code)!.room.members[session]).toBeDefined();
      expect(a.conn.all("notice").map((n) => n.text)).not.toContain("Wanderer left");
    });

    it("answers a Continue from somebody with no seat", () => {
      // It returned nothing at all, so the press was simply swallowed.
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

      const watcher = peerFor("watcher");
      send(watcher.peer, { t: "joinRoom", code: h.code, name: "Watcher" });
      send(watcher.peer, { t: "enterGame", as: "spectator" });
      watcher.conn.clear();

      send(watcher.peer, { t: "nextRound" });
      expect(watcher.conn.last("error")!.code).toBe("move-refused");
    });
  });

  /* ============================================================
     Hostile input
     ============================================================ */

  describe("input nobody sane would send", () => {
    /**
     * Each plan gets its own room, so every one of them is the plan a game
     * actually starts from. (The team-index version of this test once sent
     * every value to one room, where only the last could ever be dealt, and
     * passed against the bug it was written for.)
     */
    it.each([
      [["?"]],
      [[null, null, null, null, null, null, null, null, null]],
      [[1, 2, 3]],
      [Array.from({ length: 70 }, () => null)],
    ])("does not die on a seating plan of %j", (plan) => {
      // A leader may send `arrangeSeats`, so whatever arrives in it has to
      // be refused or squared with the room — never thrown on. Somebody's
      // seat must not be lost to it either.
      const { peer, code } = host(`host-${JSON.stringify(plan).length}`);
      const { peer: guest } = peerFor(`guest-${JSON.stringify(plan).length}`);
      send(guest, { t: "joinRoom", code, name: "Bo" });
      send(peer, { t: "selectGame", gameId: "spades", settings: {}, seats: 4, difficulty: "steady" });

      send(peer, { t: "arrangeSeats", plan } as never);
      send(peer, { t: "startGame" });

      const runtime = registry.get(code)!;
      expect(runtime.hasGame).toBe(true);
      expect(runtime.room.game!.seatOwner.filter(Boolean)).toHaveLength(2);
    });

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
