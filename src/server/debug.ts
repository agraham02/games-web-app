/**
 * Introspection and fault injection, for tests and for debugging by hand.
 *
 * Both endpoints exist because of the same problem: the client's view is
 * DERIVED, and a test that asserts against it cannot tell "the server is
 * wrong" from "the server is right and the client rendered it wrong". So
 * there has to be a way to read the authoritative state directly, and a way
 * to cause a disconnect on purpose rather than hoping a real network
 * misbehaves on cue.
 *
 * Both are also, obviously, a way to read every room in the process and to
 * hang up on anybody. They are refused outright in production — not
 * password-protected, not obscured, refused — because the only safe amount
 * of this to expose on a real deployment is none.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RoomRegistry } from "./RoomRegistry";
import { log } from "./log";

export const DEBUG_PREFIX = "/debug/";

export function debugEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.ENABLE_DEBUG_ENDPOINTS === "1";
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

/**
 * Handles a debug request, or returns false so the caller can pass it on to
 * Next. Returning a boolean rather than calling `next()` keeps this usable
 * from a plain `http` server with no framework underneath it.
 */
export function handleDebugRequest(
  req: IncomingMessage,
  res: ServerResponse,
  registry: RoomRegistry,
): boolean {
  const url = req.url ?? "";
  if (!url.startsWith(DEBUG_PREFIX)) return false;

  if (!debugEnabled()) {
    json(res, 404, { error: "not found" });
    return true;
  }

  const [path] = url.split("?");
  const parts = (path ?? "").slice(DEBUG_PREFIX.length).split("/").filter(Boolean);

  // GET /debug/rooms — every room, shallowly.
  if (parts[0] === "rooms" && parts.length === 1) {
    json(res, 200, {
      rooms: registry.codes().map((code) => {
        const runtime = registry.get(code)!;
        return {
          code,
          members: Object.keys(runtime.room.members).length,
          connected: Object.values(runtime.room.members).filter((m) => m.connected).length,
          gameRunning: runtime.hasGame,
        };
      }),
    });
    return true;
  }

  // GET /debug/room/:code — the authoritative dump, unredacted. This is the
  // thing a test asserts against, precisely because it is not what any
  // client was sent.
  if (parts[0] === "room" && parts[1]) {
    const runtime = registry.get(parts[1]);
    if (!runtime) {
      json(res, 404, { error: "no such room" });
      return true;
    }
    json(res, 200, runtime.debugDump());
    return true;
  }

  // POST /debug/drop/:code/:session — hang up on one client on command.
  // Reconnection tests need a disconnect they can cause at a known moment;
  // waiting on a real network to drop at the right time is how a test suite
  // becomes flaky.
  if (parts[0] === "drop" && parts[1] && parts[2]) {
    const runtime = registry.get(parts[1]);
    if (!runtime) {
      json(res, 404, { error: "no such room" });
      return true;
    }
    const session = parts[2];
    if (!runtime.isAttached(session)) {
      json(res, 404, { error: "session not attached" });
      return true;
    }
    log.warn("fault injection: dropping a socket", { room: parts[1], session });
    runtime.dropConnection(session);
    json(res, 200, { dropped: session });
    return true;
  }

  json(res, 404, { error: "not found" });
  return true;
}
