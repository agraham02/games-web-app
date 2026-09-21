"use client";

/**
 * Says out loud when the socket is not there.
 *
 * `api.status` used to be read in exactly one place — inside the
 * `connecting` branch, which only renders before the first handshake. So
 * once you were in a room, losing the connection showed nothing at all:
 * an ordinary, fully interactive lobby or table whose every button
 * queued silently into the connection's backlog. You tapped, nothing
 * happened, and nothing said why.
 *
 * Two weights, because the two cases are not alike:
 *
 *  - **Reconnecting** is usually a blip that resolves inside a second,
 *    and the table behind it is still worth looking at — the position is
 *    real, it is just not being updated. A strip, never a blocker. It
 *    also waits a beat before appearing, so the common case (a sub-second
 *    reconnect) never flashes anything at all.
 *  - **Incompatible** cannot resolve. The server refused the handshake
 *    because this page is built against a different wire, and every
 *    retry will be refused the same way. Nothing here works until the
 *    page is reloaded, so it blocks, which is the one honest option.
 */

import { useEffect, useState } from "react";
import type { ConnectionStatus } from "./connection";

/**
 * How long a connection may be away before it is worth mentioning.
 *
 * The first retry is at 250ms and most drops recover on it, so anything
 * shorter than this turns a blip into a flicker — which reads as
 * something being wrong far more than the silence did.
 */
const QUIET_MS = 1200;

export function ConnectionNotice({ status }: { status: ConnectionStatus }) {
  /**
   * The status as it stood `QUIET_MS` ago, rather than a boolean "has it
   * been a while" — which would need clearing when the status changes,
   * and clearing it means writing state from inside an effect.
   *
   * Every status change re-arms the timer, so this only ever catches up
   * to a status that has held still. Showing the strip then needs BOTH
   * halves to agree: we are reconnecting NOW, and we already were a
   * moment ago.
   */
  const [settled, setSettled] = useState<ConnectionStatus | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSettled(status), QUIET_MS);
    return () => clearTimeout(t);
  }, [status]);

  const lingering = status === "reconnecting" && settled === "reconnecting";

  if (status === "incompatible") {
    return (
      <div className="fixed inset-0 z-9500 flex items-center justify-center bg-felt-950/96 px-8 backdrop-blur-sm">
        <div className="flex max-w-xs flex-col items-center gap-4 text-center">
          <span aria-hidden className="text-4xl text-brass-300">
            ↻
          </span>
          <h2 className="font-display text-2xl font-extrabold text-bone-50">Reload to keep playing</h2>
          <p className="text-xs leading-relaxed text-bone-400">
            This page was loaded before the game was updated, so the server will not talk to it.
            Reloading fixes it — your seat is still yours.
          </p>
        </div>
      </div>
    );
  }

  if (!lingering) return null;

  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 top-0 z-9400 flex justify-center p-2"
    >
      <span className="rounded-full bg-felt-950/90 px-3 py-1 text-xs text-brass-300 shadow-lg backdrop-blur-sm">
        Reconnecting…
      </span>
    </div>
  );
}
