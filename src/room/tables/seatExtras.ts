"use client";

import { useMemo } from "react";
import type { SeatId } from "@/engine/types";
import { photoUrl } from "@/session/photo";
import type { RoomView } from "@/session/protocol";
import type { SeatView } from "@/table/SeatRing";

/**
 * What the room knows about each seat that the game does not, for
 * `GameHostView`'s `seatExtras`: whoever sits there, their photo. Built once
 * per roster rather than per seat per render, and the same for all six
 * tables.
 */
export function useSeatExtras(room: RoomView): (seat: SeatId) => Partial<SeatView> {
  const members = room.members;
  return useMemo(() => {
    const photos = new Map<SeatId, string>();
    for (const m of members) if (m.seat !== null && m.photo) photos.set(m.seat, photoUrl(m.photo));
    return (seat) => {
      const photo = photos.get(seat);
      return photo ? { photo } : {};
    };
  }, [members]);
}
