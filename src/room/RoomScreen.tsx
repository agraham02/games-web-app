"use client";

/**
 * The whole online experience, as one switch.
 *
 * A room is not a sequence of pages. Membership, the lobby and the table
 * all coexist — the spec is explicit that people can move in and out of a
 * running game while the lobby carries on — so making them separate routes
 * would mean a navigation on every transition and a fresh socket on every
 * navigation. One screen that renders whichever of them is currently true
 * matches the model and keeps the connection alive across all of it.
 *
 * The URL still carries the code, because a code that cannot be sent to
 * somebody is not much of an invitation.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { PieceId } from "@/engine/types";
import { GameToaster } from "@/ui/disclosure";
import { Button } from "@/ui/primitives/Button";
import { CodeInput, TextField } from "@/ui/primitives/TextField";
import { SetupShell } from "@/ui/primitives/SetupShell";
import { Lobby } from "./Lobby";
import { tableFor } from "./tables";
import { useRoom } from "./useRoom";

const NAME_KEY = "table-games.display-name";

export function RoomScreen({ code }: { code?: string }) {
  const api = useRoom();
  const router = useRouter();

  // Cards picked up for Spades' blind-nil exchange. Held here rather than
  // in the table so that stepping out to the lobby and back does not lose
  // a half-made selection.
  const [held, setHeld] = useState<PieceId[]>([]);
  const toggleHeld = (id: PieceId) =>
    setHeld((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // Keep the address bar honest. A room reached by code, created fresh, or
  // rejoined automatically on reconnect should all end up with the code in
  // the URL so it can be copied out of it.
  useEffect(() => {
    if (api.room && api.room.code !== code) {
      router.replace(`/room/${api.room.code}`);
    }
  }, [api.room, code, router]);

  return (
    <>
      {/*
        Mounted here, not by the table: `GameToaster` normally lives inside
        `TableSurface`, and the lobby has no table. Room notices — somebody
        joined, a seat changed hands — need to reach both.
      */}
      <GameToaster />

      {api.phase === "connecting" ? (
        <Centred>
          <span className="eyebrow">
            {api.status === "reconnecting" ? "Reconnecting…" : "Connecting…"}
          </span>
        </Centred>
      ) : api.phase === "pending" ? (
        <Centred>
          <span className="eyebrow">Waiting to be let in</span>
          <p className="max-w-xs text-center text-sm text-bone-400">
            {api.pendingCode} is a private room. The party leader has to approve you.
          </p>
          <Button size="sm" onClick={() => router.push("/room")}>
            Never mind
          </Button>
        </Centred>
      ) : api.phase === "idle" ? (
        <Entry api={api} initialCode={code} />
      ) : api.room && api.room.inGame && api.frame && tableFor(api.room.gameId) ? (
        // Looked up rather than hardcoded: the room may be running any
        // game, and a table that assumed one would render the wrong one.
        // `tableFor` returning null falls through to the lobby, which is
        // the honest answer for a game with no table yet — and a test
        // stops the registry from ever offering one.
        (() => {
          const Table = tableFor(api.room.gameId)!;
          return (
            <Table
              api={api}
              room={api.room}
              frame={api.frame}
              held={held}
              onToggleHeld={toggleHeld}
              onClearHeld={() => setHeld([])}
            />
          );
        })()
      ) : (
        <Lobby api={api} />
      )}
    </>
  );
}

function Centred({ children }: { children: React.ReactNode }) {
  return (
    <main className="felt felt-weave flex h-svh flex-col items-center justify-center gap-4">
      {children}
    </main>
  );
}

/**
 * Create a room, or join one.
 *
 * A name is required for both, per the spec — there are no accounts, so a
 * name is the only thing that makes somebody addressable in a roster. It is
 * remembered locally so the second visit does not ask again.
 */
function Entry({ api, initialCode }: { api: ReturnType<typeof useRoom>; initialCode?: string }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState(initialCode?.toUpperCase() ?? "");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(NAME_KEY);
      // Deliberately an effect, and deliberately a synchronous setState in
      // one. The alternatives are both worse: a lazy `useState`
      // initializer runs during render, where `window` does not exist
      // during prerender and the build breaks; guarding that read instead
      // produces prerendered HTML with an empty field and a filled one
      // after hydration, which is a mismatch on a controlled input. Reading
      // browser storage after mount is the shape React actually documents
      // for this, and the cascade is one render on first paint.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setName(saved);
    } catch {
      // A browser with storage locked down still works; it just asks again.
    }
  }, []);

  const remember = () => {
    try {
      window.localStorage.setItem(NAME_KEY, name.trim());
    } catch {
      /* Nothing to do — the name is already in the message being sent. */
    }
  };

  const named = name.trim().length > 0;
  const joinable = named && code.length === 4;

  return (
    <SetupShell maxWidth="max-w-xs">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="eyebrow">Play together</span>
        <h1 className="font-display text-4xl tracking-wider text-brass-300">Rooms</h1>
        <p className="max-w-xs text-sm text-bone-400">
          Make a room and share the code, or type one in. Bots fill any seat
          nobody is sitting in.
        </p>
      </div>

      <TextField
        label="Your name"
        value={name}
        onChange={setName}
        placeholder="Ada"
        maxLength={20}
        error={touched && !named ? "A name is needed to join a room" : undefined}
      />

      <Button
        tone="primary"
        className="w-full"
        onClick={() => {
          setTouched(true);
          if (!named) return;
          remember();
          api.createRoom(name.trim());
        }}
      >
        Make a room
      </Button>

      <div className="flex w-full items-center gap-3">
        <span className="h-px flex-1 bg-bone-50/12" />
        <span className="eyebrow">or join one</span>
        <span className="h-px flex-1 bg-bone-50/12" />
      </div>

      <CodeInput
        value={code}
        onChange={setCode}
        error={api.error?.code === "no-such-room" ? "No room with that code" : undefined}
        onSubmit={() => {
          if (!joinable) return;
          remember();
          api.joinRoom(code, name.trim());
        }}
      />
      <Button
        className="w-full"
        disabled={!joinable}
        onClick={() => {
          setTouched(true);
          if (!joinable) return;
          remember();
          api.joinRoom(code, name.trim());
        }}
      >
        Join room
      </Button>

      {api.error && api.error.code !== "no-such-room" ? (
        <p className="text-xs font-semibold" style={{ color: "var(--color-loss)" }}>
          {api.error.message}
        </p>
      ) : null}

      <Link href="/" className="text-xs text-bone-400 underline-offset-4 hover:underline">
        ← Back
      </Link>
    </SetupShell>
  );
}
