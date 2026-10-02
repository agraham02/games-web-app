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

interface Tracked {
  peer: Peer;
  alive: boolean;
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
    };

    const entry: Tracked = { peer: makePeer(connection, realClock.now()), alive: true };
    tracked.set(ws, entry);

    ws.on("pong", () => {
      entry.alive = true;
    });

    ws.on("message", (data) => {
      // `ws` hands over a Buffer; everything upstream deals in strings, and
      // the router enforces its own size cap on what it is given.
      router.onMessage(entry.peer, data.toString());
    });

    ws.on("close", () => {
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

  log.info("websocket server attached", { event: WS_PATH });

  return () => {
    clearInterval(heartbeat);
    for (const ws of tracked.keys()) ws.terminate();
    tracked.clear();
    wss.close();
  };
}
