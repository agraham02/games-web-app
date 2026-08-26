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
