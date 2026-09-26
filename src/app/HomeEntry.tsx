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
import { Button } from "@/ui/primitives/Button";
import { CodeInput, TextField } from "@/ui/primitives/TextField";
import { CODE_LENGTH } from "@/session/room";
import { REJOIN_PATH, TOKEN_HEADER, type RejoinAnswer } from "@/session/protocol";
import { readSavedName, saveName, setEntryIntent, storedSessionToken } from "@/room/entry";

export function HomeEntry() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [touched, setTouched] = useState(false);
  const named = name.trim().length > 0;
  const complete = code.length === CODE_LENGTH;

  useEffect(() => {
    // After mount, not in a lazy initializer: the page is prerendered, and
    // a filled field in the browser against an empty one in the HTML is a
    // hydration mismatch on a controlled input.
    const saved = readSavedName();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved) setName(saved);
  }, []);

  const make = () => {
    setTouched(true);
    if (!named) return;
    saveName(name);
    setEntryIntent({ t: "make" });
    router.push("/room");
  };

  const join = () => {
    setTouched(true);
    if (!named || !complete) return;
    saveName(name);
    setEntryIntent({ t: "join", code });
    router.push(`/room/${code}`);
  };

  return (
    <div className="flex w-full flex-col gap-4">
      <RejoinCard />

      <TextField
        label="Your name"
        value={name}
        onChange={setName}
        placeholder="Ada"
        maxLength={20}
        error={touched && !named ? "A name is needed to play in a room" : undefined}
      />

      <Button tone="primary" className="w-full py-4 text-base" onClick={make}>
        Make a room
      </Button>

      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-bone-50/12" />
        <span className="eyebrow">or join one</span>
        <span className="h-px flex-1 bg-bone-50/12" />
      </div>

      <CodeInput value={code} onChange={setCode} onSubmit={join} />
      <Button className="w-full" disabled={!complete} onClick={join}>
        Join room
      </Button>
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
function RejoinCard() {
  const router = useRouter();
  const [room, setRoom] = useState<RejoinAnswer["room"]>(null);

  useEffect(() => {
    const token = storedSessionToken();
    if (!token) return;
    const controller = new AbortController();
    fetch(REJOIN_PATH, { headers: { [TOKEN_HEADER]: token }, signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<RejoinAnswer>) : { room: null }))
      .then((answer) => setRoom(answer.room))
      .catch(() => {
        /* No answer, no card: the rest of the page works as before. */
      });
    return () => controller.abort();
  }, []);

  if (!room) return null;
  const what = room.running
    ? `${room.game ?? "Game"} in progress`
    : room.game
      ? `${room.game} lobby`
      : "Lobby";

  // The whole card is the button (the user's design, 2026-09-26).
  return (
    <button
      type="button"
      onClick={() => router.push(`/room/${room.code}`)}
      className="group flex w-full items-center gap-3 rounded-xl bg-brass-400/10 px-4 py-3 text-left ring-1 ring-brass-500/40 transition-colors hover:bg-brass-400/16 hover:ring-brass-400/70"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-semibold text-bone-100">
          Last room: <span className="tracking-wider text-brass-300">{room.code}</span>
          <span className="text-bone-500"> · </span>
          {what}
        </span>
        <span className="text-xs text-bone-400">
          <span className="hidden pointer-fine:inline">Click</span>
          <span className="pointer-fine:hidden">Tap</span> to rejoin
        </span>
      </span>
      <ArrowRight
        size={16}
        aria-hidden
        className="shrink-0 text-brass-300 transition-transform group-hover:translate-x-0.5"
      />
    </button>
  );
}
