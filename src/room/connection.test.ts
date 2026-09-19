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
