"use client";

/**
 * "Play on another device": the phone's half of moving a seat to a desktop.
 *
 * Asks the server for four digits and shows them, large, with what to do
 * with them and how long they last. The desktop types the room's code and
 * these digits on its own join screen (`RoomEntryForm`), and from then on
 * is this player; this device is told it has been replaced and can take the
 * seat back.
 *
 * It lives in the table's Settings sheet and the lobby's Room card — the
 * two places a person already is when they decide to change screens.
 */

import { useEffect, useState } from "react";
import { Button } from "@/ui/primitives/Button";
import { cn } from "@/lib/utils";
import type { MoveCodeState } from "./useRoom";

export interface MoveDeviceProps {
  /** The room's code, which the other device needs along with the digits. */
  code: string;
  moveCode: MoveCodeState | null;
  onRequest: () => void;
  className?: string;
}

/** Seconds left on a code, counted down once a second; 0 once it has lapsed. */
function useSecondsLeft(endsAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endsAt === null) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [endsAt]);
  return endsAt === null ? 0 : Math.max(0, Math.ceil((endsAt - now) / 1000));
}

export function MoveDevice({ code, moveCode, onRequest, className }: MoveDeviceProps) {
  const left = useSecondsLeft(moveCode?.endsAt ?? null);
  const live = moveCode !== null && left > 0;

  if (!live) {
    return (
      <div className={cn("flex flex-col gap-2", className)}>
        <Button onClick={onRequest}>{moveCode ? "Get a new code" : "Play on another device"}</Button>
        <p className="text-center text-[11px] leading-relaxed text-bone-500">
          {moveCode
            ? "That code has run out."
            : "Carry on at a bigger screen: same seat, same hand. This device stops playing."}
        </p>
      </div>
    );
  }

  const minutes = Math.floor(left / 60);
  const seconds = String(left % 60).padStart(2, "0");
  return (
    <div className={cn("flex flex-col items-center gap-3 rounded-lg bg-black/25 px-4 py-4 text-center", className)}>
      <span className="eyebrow">Your code</span>
      {/* Read across a room, once, and typed: big, and spaced so each digit
          is its own. The label is the digits, for a screen reader. */}
      <span
        aria-label={`Your code is ${moveCode.pin.split("").join(" ")}`}
        className="font-title text-5xl font-light tracking-[0.3em] text-bone-50 [padding-left:0.3em]"
      >
        {moveCode.pin}
      </span>
      <p className="text-xs leading-relaxed text-bone-300">
        On the other device, open this site, choose <span className="font-semibold">Already playing on another
        device?</span>, then enter room <span className="font-semibold tracking-wider">{code}</span> and this code.
      </p>
      <p className="text-[11px] text-bone-500" role="timer">
        Works once, for {minutes}:{seconds} more.
      </p>
      <Button size="sm" onClick={onRequest}>
        New code
      </Button>
    </div>
  );
}
