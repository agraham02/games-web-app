/**
 * The `ws` adapter, and the only file in `src/server` that knows a socket
 * library exists.
 *
 * Everything above it — the router, the room runtime, the room machine —
 * talks to a `Connection` interface instead, which is what lets the whole
 * server be driven from a test with no ports open. This file's entire job
 * is to make a `WebSocket` look like one of those and to keep dead peers
 * from accumulating.
 */

import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { realClock } from "@/session/clock";
import type { ServerMessage } from "@/session/protocol";
import type { Connection } from "./RoomRuntime";
import type { RoomRegistry } from "./RoomRegistry";
import { makePeer, Router, type Peer } from "./router";
import { LinkMonitor } from "@/session/link";
import { log } from "./log";

/**
 * How often we probe for sockets that have stopped answering.
 *
 * A TCP connection that dies badly — a laptop lid closing, a phone losing
 * signal — produces no close event at all, so without this the room would
 * hold a seat for somebody the network has already forgotten. The ping is
 * what turns "gone" into "disconnected" within a bounded time, which is
 * what the bot-takeover rule needs to actually fire.
 */
const HEARTBEAT_MS = 30_000;

export const WS_PATH = "/ws";

/**
 * How often each socket's link is timed — a websocket ping, which the
 * browser answers on its own, so a busy or backgrounded page cannot skew it.
 * A few bytes each. Separate from the heartbeat above, which is about
 * whether a socket is there at all; this is about how well it is.
 */
const PROBE_MS = 3_000;

interface Tracked {
  peer: Peer;
  alive: boolean;
  link: LinkMonitor;
  /** Told when `link.weak` changes. */
  listeners: Set<() => void>;
  /** Due when the oldest unanswered probe becomes a stall (`watchStall`). */
  stallTimer: ReturnType<typeof setTimeout> | null;
}

/** Tells a socket's listeners its link changed. */
function linkChanged(entry: Tracked): void {
  for (const listener of entry.listeners) listener();
}

/**
 * Arms the one timer that notices a socket gone silent, for the moment its
 * oldest unanswered probe becomes a stall (`STALL_MS`). Re-armed whenever a
 * probe goes out or comes back, so nothing sweeps every socket to look.
 */
function watchStall(entry: Tracked): void {
  if (entry.stallTimer !== null) clearTimeout(entry.stallTimer);
  entry.stallTimer = null;
  const at = entry.link.stallAt();
  if (at === null) return;
  entry.stallTimer = setTimeout(
    () => {
      entry.stallTimer = null;
      if (entry.link.tick(realClock.now())) linkChanged(entry);
    },
    Math.max(0, at - realClock.now()),
  );
  entry.stallTimer.unref?.();
}

function unwatch(entry: Tracked): void {
  if (entry.stallTimer !== null) clearTimeout(entry.stallTimer);
  entry.stallTimer = null;
}

/** Hard transport ceiling, well above anything the protocol sends. */
const MAX_FRAME_BYTES = 128 * 1024;

/**
 * Compression, negotiated with every browser (permessage-deflate).
 *
 * A frame is a whole per-viewer snapshot — 5–8KB of JSON in a card game —
 * and almost all of it is the same as the frame before: the placements and
 * piece meta barely move between turns. With the window carried from one
 * message to the next, a turn costs 100–250 bytes on the wire instead
 * (measured 2026-10-02, every game, ~30x). That is the whole of "smaller
 * messages": delta frames would save a further 20–40% and break the rule
 * that any frame stands alone, which dropping one for a backed-up socket
 * and catching up after a reconnect both rely on.
 *
 * The full 32KB window, because the redundancy is a whole frame back: at
 * 8KB (13 bits) a Spades turn came out at 845 bytes rather than 228. The
 * cost is ~300KB of zlib state per open socket. Messages too small to gain
 * anything (a pong, a clock) go as they are.
 */
const COMPRESSION = {
  zlibDeflateOptions: { memLevel: 8, level: 6 },
  threshold: 256,
} as const;

export function attachWebSocketServer(server: HttpServer, registry: RoomRegistry): () => void {
  const wss = new WebSocketServer({
    noServer: true,
    // The router's own cap is applied to a frame `ws` has already
    // buffered and stringified, so on its own it refuses a 100MB payload
    // only after holding 100MB (which is `ws`'s default). Capping here
    // means the transport drops it without ever assembling it. Generous
    // against real traffic: what a client sends is a few hundred bytes.
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: COMPRESSION,
  });
  const router = new Router(registry, () => realClock.now());
  const tracked = new Map<WebSocket, Tracked>();

  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    // Next.js has its own upgrade handling (HMR in dev), so anything not
    // aimed at our path is left strictly alone rather than rejected.
    const url = request.url ?? "";
    if (!url.startsWith(WS_PATH)) return;

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    const connection: Connection = {
      send(message: ServerMessage) {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify(message));
      },
      close() {
        try {
          ws.close();
        } catch {
          // Already gone. Closing a closed socket is not worth a log line.
        }
      },
      bufferedAmount: () => ws.bufferedAmount,
      rttMs: () => entry.link.rttMs(),
      weak: () => entry.link.weak,
      onWeakChange(listener) {
        entry.listeners.add(listener);
        return () => entry.listeners.delete(listener);
      },
    };

    const entry: Tracked = {
      peer: makePeer(connection, realClock.now()),
      alive: true,
      link: new LinkMonitor(),
      listeners: new Set(),
      stallTimer: null,
    };
    tracked.set(ws, entry);

    ws.on("pong", (data: Buffer) => {
      entry.alive = true;
      // A timed probe carries its id; the heartbeat's own ping carries
      // nothing, and answers nothing here.
      const id = Number(data.toString());
      if (data.length === 0 || !Number.isFinite(id)) return;
      const changed = entry.link.answered(id, realClock.now());
      watchStall(entry);
      if (changed) linkChanged(entry);
    });

    ws.on("message", (data) => {
      // `ws` hands over a Buffer; everything upstream deals in strings, and
      // the router enforces its own size cap on what it is given.
      router.onMessage(entry.peer, data.toString());
    });

    ws.on("close", () => {
      unwatch(entry);
      tracked.delete(ws);
      router.onClose(entry.peer);
    });

    ws.on("error", (err: Error) => {
      log.warn("socket error", { error: err.message });
    });
  });

  const heartbeat = setInterval(() => {
    for (const [ws, entry] of tracked) {
      if (!entry.alive) {
        // Missed a whole cycle: treat it as gone rather than waiting for a
        // close event that a half-open connection will never send.
        unwatch(entry);
        tracked.delete(ws);
        router.onClose(entry.peer);
        ws.terminate();
        continue;
      }
      entry.alive = false;
      try {
        ws.ping();
      } catch {
        // Terminating here would mutate `tracked` mid-iteration; the next
        // sweep sees `alive: false` and cleans it up.
      }
    }
  }, HEARTBEAT_MS);
  // Never hold the process open just to keep pinging.
  heartbeat.unref?.();

  let probeId = 0;
  const linkTimer = setInterval(() => {
    const now = realClock.now();
    probeId++;
    for (const [ws, entry] of tracked) {
      if (ws.readyState !== ws.OPEN) continue;
      entry.link.sent(probeId, now);
      watchStall(entry);
      try {
        ws.ping(String(probeId));
      } catch {
        // Gone; the heartbeat cleans it up.
      }
    }
  }, PROBE_MS);
  linkTimer.unref?.();

  log.info("websocket server attached", { event: WS_PATH });

  return () => {
    clearInterval(heartbeat);
    clearInterval(linkTimer);
    for (const entry of tracked.values()) unwatch(entry);
    for (const ws of tracked.keys()) ws.terminate();
    tracked.clear();
    wss.close();
  };
}
