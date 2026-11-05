"use client";

/**
 * "It is your turn": a soft sound and a short buzz, the moment the table is
 * waiting on you (the user, 2026-11-02 — somebody's parents could not tell
 * whose turn it was).
 *
 * On the way UP only. Mounting on a turn that is already yours (a reload, a
 * seat taken back) says nothing, and neither does staying on it; it fires each
 * time the turn goes from somebody else's to yours.
 *
 * The sound goes through the table's sound channel, so the player's Sound
 * setting and the browser's wait-for-a-tap rule govern it as they do every
 * other sound. The buzz is the Vibration setting's, and is the browser's to
 * refuse: iPhones do not vibrate from a web page at all, and Chrome wants the
 * page to have been touched. Neither is an error, only no buzz.
 */

import { useEffect, useRef } from "react";
import { emitTableSound } from "./tableSounds";

/** One short pulse, ms — a tap on the shoulder, not an alarm. */
export const TURN_BUZZ_MS = 60;

export function useYourTurnCue({ yourTurn, vibration }: { yourTurn: boolean; vibration: boolean }): void {
  const was = useRef(yourTurn);
  const buzz = useRef(vibration);
  useEffect(() => {
    buzz.current = vibration;
  }, [vibration]);

  useEffect(() => {
    const rising = yourTurn && !was.current;
    was.current = yourTurn;
    if (!rising) return;
    emitTableSound({ t: "turn" });
    if (buzz.current && typeof navigator !== "undefined") navigator.vibrate?.(TURN_BUZZ_MS);
  }, [yourTurn]);
}
