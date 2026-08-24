"use client";

/**
 * A room by its code — the shareable link.
 *
 * The code only pre-fills the join field; it does not join on its own.
 * Landing straight in a stranger's room from a pasted URL, under whatever
 * name happened to be in storage, is not something anyone asked for — and
 * a private room would have queued the request without ever showing why.
 */

import { use } from "react";
import { RoomScreen } from "@/room/RoomScreen";

export default function RoomCodePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  return <RoomScreen code={code} />;
}
