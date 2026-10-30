"use client";

/**
 * The room this browser is still a member of, if the SERVER says it is (a
 * closed tab, a phone that went to sleep): so the home screen can offer the
 * way back, and never a room that has since been closed or the player was
 * removed from. Rejoining is just opening the room — the seat, hand and
 * score were never given up.
 */

import { useEffect, useState } from "react";
import { REJOIN_PATH, TOKEN_HEADER, type RejoinAnswer } from "@/session/protocol";
import { roomConnectionClosed } from "@/room/connection";
import { storedSessionToken } from "@/room/entry";

export type Rejoin = RejoinAnswer["room"];

export function useRejoin(): Rejoin {
  const [rejoin, setRejoin] = useState<Rejoin>(null);

  useEffect(() => {
    const token = storedSessionToken();
    if (!token) return;
    const controller = new AbortController();
    // Asked once any room socket this tab holds has closed. Coming here FROM
    // a room hangs its socket up, which can end the game (the last real
    // player leaving), and asked sooner the server answered for the moment
    // before: "Spades in progress" for a game that was already over. Capped,
    // so a close that never finishes cannot hide the card.
    const settled = Promise.race([
      roomConnectionClosed(),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);
    settled
      .then(() => fetch(REJOIN_PATH, { headers: { [TOKEN_HEADER]: token }, signal: controller.signal }))
      .then((res) => (res.ok ? (res.json() as Promise<RejoinAnswer>) : { room: null }))
      .then((answer) => setRejoin(answer.room))
      .catch(() => {
        /* No answer, no strip: the rest of the page works as before. */
      });
    return () => controller.abort();
  }, []);

  return rejoin;
}
