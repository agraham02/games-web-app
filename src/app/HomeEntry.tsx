"use client";

/**
 * The ways into a room, on the home screen itself: rejoin the one you were
 * in, make one, or join one by its code.
 *
 * The name is asked for HERE, once. It used to be asked on `/room`, which
 * then asked "make or join?" a second time — with Make the louder button,
 * right beside the name, even for somebody who had just typed a code to
 * join. So a press here is the whole action: it saves the name, leaves an
 * intent for the room screen (`entry.ts`), and the room screen carries it
 * out as soon as the server is listening.
 *
 * Joining still resolves to `/room/<code>`, the same URL somebody would
 * paste from a text message, so there is one way a code becomes a room.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { REJOIN_PATH, TOKEN_HEADER, type RejoinAnswer } from "@/session/protocol";
import { roomConnectionClosed } from "@/room/connection";
import { setEntryIntent, storedSessionToken } from "@/room/entry";
import { RoomEntryForm } from "@/room/RoomEntryForm";
import { Collapse } from "@/ui/motion";

type Rejoin = RejoinAnswer["room"];

export function HomeEntry() {
  const router = useRouter();
  // Opened in, not popped in: the card pushes the form down, and it used to
  // do it in one frame under somebody's thumb. Not a space held open while
  // the server is asked either — most browsers that ask have left their
  // room, and a gap that appears and closes again is the same jump twice.
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
        /* No answer, no card: the rest of the page works as before. */
      });
    return () => controller.abort();
  }, []);

  return (
    <div className="flex w-full flex-col gap-4">
      <Collapse open={Boolean(rejoin)}>{rejoin ? <RejoinCard room={rejoin} /> : null}</Collapse>
      {/* The same form a shared link and a refused join show (`mode`), so
          the name, the buttons and their weight are learned once. With a
          room to go back to, going back is the one thing to do, and the
          form steps down (`quiet`). */}
      <RoomEntryForm
        mode="home"
        quiet={Boolean(rejoin)}
        onMake={() => {
          setEntryIntent({ t: "make" });
          router.push("/room");
        }}
        onJoin={(code) => {
          setEntryIntent({ t: "join", code });
          router.push(`/room/${code}`);
        }}
      />
    </div>
  );
}

/**
 * "You're still in room ABCD" — after closing a tab, say, and coming back.
 *
 * Shown only when the SERVER says this browser is still a member of a live
 * room (`/api/rejoin`), so a room that has since been closed, or that the
 * player was removed from, is never offered. Rejoining is just opening the
 * room: the seat, hand and score were never given up.
 */
function RejoinCard({ room }: { room: NonNullable<Rejoin> }) {
  const router = useRouter();
  const what = room.running
    ? `${room.game ?? "Game"} in progress`
    : room.game
      ? `${room.game} lobby`
      : "Lobby";

  // The whole card is the button (the user's design, 2026-09-26), and the
  // screen's primary action when it is there.
  return (
    <button
      type="button"
      onClick={() => router.push(`/room/${room.code}`)}
      className="group flex w-full items-center gap-3 rounded-xl bg-linear-to-b from-brass-300 to-brass-500 px-4 py-3 text-left shadow-e2 transition-colors hover:from-brass-200 hover:to-brass-400"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-extrabold text-felt-950">
          Back to room <span className="tracking-wider">{room.code}</span>
        </span>
        <span className="text-xs font-semibold text-felt-950/75">{what}</span>
      </span>
      <ArrowRight
        size={16}
        aria-hidden
        className="shrink-0 text-felt-950 transition-transform group-hover:translate-x-0.5"
      />
    </button>
  );
}
