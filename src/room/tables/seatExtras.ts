"use client";

import { useMemo } from "react";
import type { SeatId } from "@/engine/types";
import { photoUrl } from "@/session/photo";
import type { RoomView } from "@/session/protocol";
import type { ChatMessage } from "@/session/chat";
import type { SeatView } from "@/table/SeatRing";

/**
 * What the room knows about each seat that the game does not, for
 * `GameHostView`'s `seatExtras`: whoever sits there, their photo and the
 * last thing they said. Built once
 * per roster rather than per seat per render, and the same for all six
 * tables.
 */
export function useSeatExtras(
  room: RoomView,
  chat: readonly ChatMessage[],
): (seat: SeatId) => Partial<SeatView> {
  const members = room.members;
  return useMemo(() => {
    const extras = new Map<SeatId, Partial<SeatView>>();
    for (const m of members) {
      if (m.seat === null) continue;
      // The last thing the person in this seat said. `SeatBubbles` decides
      // whether it is new enough to show.
      let said: ChatMessage | undefined;
      for (let i = chat.length - 1; i >= 0 && !said; i--) if (chat[i]!.session === m.session) said = chat[i];
      extras.set(m.seat, {
        ...(m.photo ? { photo: photoUrl(m.photo) } : {}),
        ...(m.weak && m.connected ? { weakLink: true } : {}),
        ...(said ? { bubble: { id: said.id, text: said.text } } : {}),
      });
    }
    return (seat) => extras.get(seat) ?? {};
  }, [members, chat]);
}
