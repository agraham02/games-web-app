// @vitest-environment jsdom

/**
 * The socket wrapper, on its own.
 *
 * `RoomScreen.test.tsx` drives this through the screen, which is the
 * right level for "does the lobby send what it claims to". It is the
 * wrong level for anything on a timer: `waitFor` polls on real timers, so
 * faking them around a rendered component deadlocks the test rather than
 * failing it. The connection is a plain class over the global
 * `WebSocket`, so here there is nothing to render and nothing to race.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@/session/protocol";
import { RoomConnection } from "./connection";

const sockets: FakeSocket[] = [];

class FakeSocket {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    sockets.push(this);
  }
  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  count(t: string): number {
    return this.sent.filter((m) => m.t === t).length;
  }
}

describe("timing the round trip", () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("probes soon after connecting, timed, and keeps the quickest answer", () => {
    const connection = new RoomConnection("token-rtt");
    connection.connect();
    const socket = sockets[sockets.length - 1]!;
    socket.onopen?.();
    // An ordinary connection, before anything is known.
    expect(connection.oneWayMs()).toBe(75);

    vi.advanceTimersByTime(300);
    const ping = socket.sent.find((m) => m.t === "ping")!;
    expect(typeof ping.sent).toBe("number");

    const answer = (rtt: number) => {
      vi.spyOn(performance, "now").mockReturnValue((ping.sent as number) + rtt);
      socket.onmessage?.({ data: JSON.stringify({ t: "pong", sent: ping.sent }) });
      vi.restoreAllMocks();
    };
    answer(240);
    expect(connection.oneWayMs()).toBe(120);
    answer(600); // a slow one: the quickest still stands
    expect(connection.oneWayMs()).toBe(120);
  });

  it("never believes a round trip worth more than a second each way", () => {
    const connection = new RoomConnection("token-rtt-2");
    connection.connect();
    const socket = sockets[sockets.length - 1]!;
    socket.onopen?.();
    vi.advanceTimersByTime(300);
    const ping = socket.sent.find((m) => m.t === "ping")!;
    vi.spyOn(performance, "now").mockReturnValue((ping.sent as number) + 9_000);
    socket.onmessage?.({ data: JSON.stringify({ t: "pong", sent: ping.sent }) });
    vi.restoreAllMocks();
    expect(connection.oneWayMs()).toBe(1_000);
  });
});

describe("the keepalive", () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function connected() {
    const connection = new RoomConnection("token-abc");
    connection.connect();
    const socket = sockets[sockets.length - 1]!;
    socket.onopen?.();
    return { connection, socket };
  }

  it("says hello first, and only then starts ticking", () => {
    const { socket } = connected();
    expect(socket.sent[0]).toMatchObject({ t: "hello", protocol: PROTOCOL_VERSION });
    expect(socket.count("ping")).toBe(0);
  });

  it("keeps a quiet socket warm", () => {
    // A game of Rummy where somebody is thinking is a quiet socket, and a
    // quiet socket is what proxies, load balancers and free hosting tiers
    // reap — typically at 60 seconds. Losing it is survivable, since the
    // client reconnects and reclaims its seat, but it is a visible stall
    // for no reason at all.
    const { socket } = connected();
    vi.advanceTimersByTime(60_000);
    expect(socket.count("ping")).toBeGreaterThan(0);
    // Comfortably under a 60s idle timeout, and nowhere near the router's
    // 120-per-10-seconds budget.
    expect(socket.count("ping")).toBeLessThan(5);
  });

  it("does not queue pings while the socket is down", () => {
    // `send` deliberately holds messages composed before the socket was
    // ready, which is right for a real action and wrong for a heartbeat:
    // a sleeping tab would wake and deliver a burst of stale pings into
    // the rate limiter.
    const { socket } = connected();
    socket.readyState = 3;
    socket.sent.length = 0;
    vi.advanceTimersByTime(300_000);
    expect(socket.count("ping")).toBe(0);
  });

  it("stops ticking once the connection is closed for good", () => {
    const { connection, socket } = connected();
    connection.close();
    socket.sent.length = 0;
    socket.readyState = 1;
    vi.advanceTimersByTime(300_000);
    expect(socket.count("ping")).toBe(0);
  });
});

/**
 * Two tabs, one identity, one socket.
 *
 * `localStorage` is per-ORIGIN and not per-tab, so a second tab is the
 * same person rather than a second player. The server replaces the old
 * socket with the new one — correctly, since the seat belongs to the
 * person — and the old tab used to read that close as the network
 * dropping and reconnect, which closed the tab that had just taken over,
 * which reconnected. Measured at roughly four round trips a second, for
 * as long as both tabs were open, and at any instant one of them was
 * holding a dead socket. That looks exactly like the game desyncing.
 */
describe("a remount in the middle of a move", () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("is told the turn clock with what is left of it, and not one from a game that has ended", () => {
    // The server says a clock only when it changes, so a page that mounted
    // mid-move (from `/room` to `/room/ABCD`) showed no ring for that move.
    const connection = new RoomConnection("token-clock");
    connection.connect();
    const socket = sockets[sockets.length - 1]!;
    socket.onopen?.();
    const deliver = (m: unknown) => socket.onmessage?.({ data: JSON.stringify(m) });
    const now = vi.spyOn(performance, "now").mockReturnValue(10_000);
    deliver({ t: "hello", session: "me", protocol: PROTOCOL_VERSION, inRoom: true });
    deliver({ t: "room", room: { code: "ABCD", gameRunning: true } });
    deliver({ t: "frame", frame: { seq: 3 } });
    deliver({ t: "turnClock", clock: { seat: 1, key: "turn:3:1", totalMs: 30_000, endsInMs: 20_000 } });

    now.mockReturnValue(16_000);
    const seen: { t: string; clock?: unknown }[] = [];
    connection.subscribe({ onMessage: (m) => seen.push(m), onStatus: () => {} });
    expect(seen.find((m) => m.t === "turnClock")?.clock).toEqual({
      seat: 1,
      key: "turn:3:1",
      totalMs: 30_000,
      endsInMs: 14_000,
    });

    deliver({ t: "room", room: { code: "ABCD", gameRunning: false } });
    const later: { t: string }[] = [];
    connection.subscribe({ onMessage: (m) => later.push(m), onStatus: () => {} });
    expect(later.some((m) => m.t === "turnClock")).toBe(false);
  });
});

describe("being replaced by another tab", () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function connected() {
    const connection = new RoomConnection("token-abc");
    connection.connect();
    const socket = sockets[sockets.length - 1]!;
    socket.onopen?.();
    return { connection, socket };
  }

  /** Delivers a server message to the client under test. */
  function deliver(socket: FakeSocket, message: unknown): void {
    socket.onmessage?.({ data: JSON.stringify(message) });
  }

  it("replays a knock to a remount, and forgets one the server has dropped", () => {
    // A client-side navigation remounts everything above this class, and
    // the "waiting to be let in" screen was not cached - so going
    // anywhere and coming back lost it while the leader still had the
    // request on their list.
    //
    // The other half matters as much: the server drops its `awaiting`
    // entry when the socket that knocked closes, so a knock that survived
    // a RECONNECT was one nobody could ever answer. `hello` saying "you
    // are not in a room" is where that is found out.
    const { connection, socket } = connected();
    deliver(socket, { t: "hello", session: "me", protocol: PROTOCOL_VERSION, inRoom: false });
    deliver(socket, { t: "pending", code: "ABCD" });

    const seen: { t: string }[] = [];
    connection.subscribe({ onMessage: (m) => seen.push(m), onStatus: () => {} });
    expect(seen.filter((m) => m.t === "pending")).toHaveLength(1);

    // The socket comes back and the server does not know us.
    deliver(socket, { t: "hello", session: "me", protocol: PROTOCOL_VERSION, inRoom: false });

    const later: { t: string }[] = [];
    connection.subscribe({ onMessage: (m) => later.push(m), onStatus: () => {} });
    expect(later.filter((m) => m.t === "pending")).toHaveLength(0);
  });

  it("stands down instead of fighting for the socket", () => {
    const { connection, socket } = connected();
    const opened = sockets.length;

    deliver(socket, { t: "superseded" });
    socket.close();

    expect(connection.status).toBe("superseded");

    // The whole point: no retry, however long we wait.
    vi.advanceTimersByTime(300_000);
    expect(sockets.length, "a superseded tab must not reconnect").toBe(opened);
  });

  it("still reconnects when the close was an ordinary drop", () => {
    // The control. Standing down must be caused by the server SAYING so,
    // not by any close at all, or a flaky network would strand the tab.
    const { connection, socket } = connected();
    const opened = sockets.length;

    socket.close();

    expect(connection.status).toBe("reconnecting");
    vi.advanceTimersByTime(300_000);
    expect(sockets.length).toBeGreaterThan(opened);
  });

  it("comes back when the player asks for it", () => {
    const { connection, socket } = connected();
    const opened = sockets.length;

    deliver(socket, { t: "superseded" });
    socket.close();
    connection.resume();

    expect(sockets.length).toBe(opened + 1);
    sockets[sockets.length - 1]!.onopen?.();
    expect(connection.status).toBe("open");
  });

  it("keeps the room it was in, so resuming lands back at the table", () => {
    // The seat was never given up — only the socket changed hands — so
    // dropping the cached roster would send a returning player to a
    // create-or-join screen for a room they are still sitting in.
    const { connection, socket } = connected();
    deliver(socket, { t: "room", room: { code: "ABCD", gameRunning: true } });
    deliver(socket, { t: "superseded" });
    socket.close();

    expect(connection.lastRoom).not.toBeNull();
  });
});

/**
 * A cached room that outlives the server.
 *
 * The replay cache is what stops a client-side navigation stranding the
 * page on "Connecting…". It also outlives the SERVER, though: restart
 * the process and a reconnecting client used to be greeted with nothing
 * but its own identity, and went on rendering a complete, interactive
 * lobby for a room that no longer existed — whose every button then
 * failed silently, because nothing surfaced a `no-room` error either.
 */
describe("a room that is no longer there", () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function connected() {
    const connection = new RoomConnection("token-abc");
    connection.connect();
    const socket = sockets[sockets.length - 1]!;
    socket.onopen?.();
    return { connection, socket };
  }

  function deliver(socket: FakeSocket, message: unknown): void {
    socket.onmessage?.({ data: JSON.stringify(message) });
  }

  it("drops the cached room when the server says we are in none", () => {
    const { connection, socket } = connected();
    deliver(socket, { t: "room", room: { code: "ABCD", gameRunning: true } });
    expect(connection.lastRoom).not.toBeNull();

    // The reconnect after a restart: same identity, no room.
    deliver(socket, { t: "hello", session: "me", protocol: PROTOCOL_VERSION, inRoom: false });

    expect(connection.lastRoom, "a room that is gone must not be replayed").toBeNull();
    expect(connection.lastFrame).toBeNull();
  });

  it("keeps it when the server says we are still in one", () => {
    const { connection, socket } = connected();
    deliver(socket, { t: "room", room: { code: "ABCD", gameRunning: true } });
    deliver(socket, { t: "hello", session: "me", protocol: PROTOCOL_VERSION, inRoom: true });
    expect(connection.lastRoom).not.toBeNull();
  });

  it("stops retrying a wire it cannot speak", () => {
    // Every retry is refused identically, so retrying only hides the one
    // message that would have explained it.
    const { connection, socket } = connected();
    const opened = sockets.length;

    deliver(socket, { t: "error", code: "protocol-mismatch", message: "protocol 1 required" });
    socket.close();

    expect(connection.status).toBe("incompatible");
    vi.advanceTimersByTime(300_000);
    expect(sockets.length).toBe(opened);
  });
});

/**
 * Leaving the room's page without closing the tab — the back gesture, a
 * link home.
 *
 * The socket used to stay open, which told the server the player was still
 * at the table: their seat stayed theirs, the bots played on to their turn,
 * and a game nobody real was left in was never ended. Now the connection
 * hangs up once no page is listening, which the server already treats as
 * leaving.
 */
describe("a page that is no longer listening", () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const quiet = () => ({ onMessage: () => {}, onStatus: () => {} });

  function listening() {
    const connection = new RoomConnection("token-abc");
    const off = connection.subscribe(quiet());
    connection.connect();
    const socket = sockets[sockets.length - 1]!;
    socket.onopen?.();
    return { connection, socket, off };
  }

  function deliver(socket: FakeSocket, message: unknown): void {
    socket.onmessage?.({ data: JSON.stringify(message) });
  }

  it("hangs up once the last page has let go", () => {
    const { connection, socket, off } = listening();
    off();
    expect(socket.readyState, "not in the same tick: a remount may be on its way").toBe(1);
    vi.advanceTimersByTime(0);
    expect(socket.readyState).toBe(3);
    expect(connection.status).toBe("closed");
    // Closed by us, so it stays closed.
    vi.advanceTimersByTime(300_000);
    expect(sockets).toHaveLength(1);
  });

  it("stays up through a remount", () => {
    // StrictMode's unmount-and-remount, and `/room` giving way to
    // `/room/ABCD`: both let go and take hold again in one commit.
    const { connection, socket, off } = listening();
    off();
    connection.subscribe(quiet());
    vi.advanceTimersByTime(1_000);
    expect(socket.readyState).toBe(1);
    expect(connection.status).toBe("open");
    // ...and says nothing: nobody is leaving.
    expect(socket.count("bye")).toBe(0);
  });

  it("says bye before hanging up, so leaving the lobby is immediate", () => {
    // A bare close looks like a phone locking, which the server gives the
    // lobby grace to come back from; `bye` says it was on purpose.
    const { socket, off } = listening();
    deliver(socket, { t: "hello", session: "me", protocol: PROTOCOL_VERSION, inRoom: true });
    off();
    vi.advanceTimersByTime(0);
    expect(socket.count("bye")).toBe(1);
    expect(socket.sent.at(-1)?.t).toBe("bye");
    expect(socket.readyState).toBe(3);
  });

  it("says nothing on behalf of an identity the server never confirmed", () => {
    const { socket, off } = listening();
    off();
    vi.advanceTimersByTime(0);
    expect(socket.count("bye")).toBe(0);
  });

  it("forgets what it heard, so the next page asks the server afresh", () => {
    const { connection, socket, off } = listening();
    deliver(socket, { t: "hello", session: "me", protocol: PROTOCOL_VERSION, inRoom: true });
    deliver(socket, { t: "room", room: { code: "ABCD", gameRunning: true } });
    deliver(socket, { t: "frame", frame: { seq: 7 } });
    off();
    vi.advanceTimersByTime(0);

    // A table that has moved on without them is not replayed, and neither
    // is a `hello` — replaying one would say "not in a room" before the
    // server could say otherwise, and flash the entry form.
    const replayed: { t: string }[] = [];
    connection.subscribe({ onMessage: (m) => replayed.push(m), onStatus: () => {} });
    expect(replayed).toEqual([]);
  });

  it("does not let the old socket's late close take down the new one", () => {
    // A real socket reports its close some time after `close()`, and a
    // page that left and came straight back has a new socket by then. The
    // old close used to null the new one, whose sends then queued forever;
    // the old socket's last frames refilled the cache that was just emptied.
    const { connection, socket, off } = listening();
    socket.close = () => {
      socket.readyState = 3;
    };
    off();
    vi.advanceTimersByTime(0);

    connection.subscribe(quiet());
    connection.connect();
    const fresh = sockets[1]!;
    fresh.onopen?.();
    deliver(socket, { t: "frame", frame: { seq: 9 } });
    socket.onclose?.();

    expect(connection.status).toBe("open");
    expect(connection.lastFrame, "the old socket's frame is not the new page's").toBeNull();
    connection.send({ t: "ping" });
    expect(fresh.count("ping")).toBe(1);
  });

  it("says when the socket it let go of has finished closing", async () => {
    // The home page waits on this before asking the server whether this
    // browser is still in a room — asked sooner, it heard about the table
    // as it was before the leaving.
    const { connection, socket, off } = listening();
    socket.close = () => {
      socket.readyState = 3;
    };
    let closed = false;
    off();
    void connection.whenClosed().then(() => {
      closed = true;
    });
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    expect(closed, "not while the close is in flight").toBe(false);

    socket.onclose?.();
    await Promise.resolve();
    expect(closed).toBe(true);
    await expect(new RoomConnection("t").whenClosed(), "a tab with no socket").resolves.toBeUndefined();
  });

  it("dials again when a page comes back", () => {
    const { connection, off } = listening();
    off();
    vi.advanceTimersByTime(0);

    connection.subscribe(quiet());
    connection.connect();
    expect(sockets).toHaveLength(2);
    sockets[1]!.onopen?.();
    expect(connection.status).toBe("open");
    expect(sockets[1]!.sent[0]).toMatchObject({ t: "hello" });
  });
});
