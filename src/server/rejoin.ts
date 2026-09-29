/**
 * "Am I still in a room?" — for the home page's Rejoin card.
 *
 * Closing a tab frees nothing: the seat, hand and score stay the player's,
 * and opening the room again reclaims them (the socket's `hello` does it).
 * What was missing was the home page knowing there was anything to go back
 * to. It asks here, over plain HTTP rather than the socket, because a
 * socket's `hello` ATTACHES — it would mark the player back at the table,
 * taking their seat back from the bot while they are still looking at the
 * home page.
 *
 * The answer is the server's, so a room that has since been reaped, or
 * that the player was removed from, simply is not offered. The token rides
 * in a header, never the URL, so it stays out of access logs.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { REJOIN_PATH, TOKEN_HEADER, type RejoinAnswer } from "@/session/protocol";
import { GAMES } from "@/session/registry";
import type { RoomRegistry } from "./RoomRegistry";

export { REJOIN_PATH, TOKEN_HEADER, type RejoinAnswer };

/** Answers `GET /api/rejoin`, or returns false so the caller passes it on. */
export function handleRejoinRequest(
  req: IncomingMessage,
  res: ServerResponse,
  registry: RoomRegistry,
): boolean {
  const [path] = (req.url ?? "").split("?");
  if (path !== REJOIN_PATH) return false;

  if (req.method !== "GET") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "use GET" }));
    return true;
  }

  const header = req.headers?.[TOKEN_HEADER];
  const token = Array.isArray(header) ? header[0] : header;
  const session = token ? registry.peekSession(token) : null;
  const runtime = session ? registry.roomOf(session) : null;
  const room = runtime && session && runtime.room.members[session] ? runtime.room : null;

  const answer: RejoinAnswer = {
    room: room
      ? {
          code: room.code,
          game: room.gameId ? GAMES[room.gameId].name : null,
          running: runtime!.hasGame,
        }
      : null,
  };
  // Per person and changing by the second: never cached anywhere.
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(answer));
  return true;
}
