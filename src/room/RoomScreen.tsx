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
import { GameToaster, announce } from "@/ui/disclosure";
import { Button } from "@/ui/primitives/Button";
import { CodeInput, TextField } from "@/ui/primitives/TextField";
import { SetupShell } from "@/ui/primitives/SetupShell";
import { ConnectionNotice } from "./ConnectionNotice";
import { readSavedName, saveName, takeEntryIntent, type EntryIntent } from "./entry";
import { Lobby } from "./Lobby";
import { tableFor } from "./tables";
import { useRoom } from "./useRoom";

export function RoomScreen({ code }: { code?: string }) {
  const api = useRoom();
  const router = useRouter();

  // Cards picked up: Spades' blind-nil exchange, and the cards a BS player
  // is about to claim. Held here rather than in the table so that stepping
  // out to the lobby and back does not lose a half-made selection.
  const [held, setHeld] = useState<PieceId[]>([]);
  const toggleHeld = (id: PieceId) =>
    setHeld((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // A selection belongs to ONE hand, and surviving a trip to the lobby is
  // the only thing it should survive.
  //
  // Nothing cleared it, so cards picked up as a round ended stayed picked
  // up into the next deal - and in BS that is not merely cosmetic: the
  // claim bar reads its wording off the selection, so it announced a claim
  // made of cards the player no longer had, and pressing Play sent ids
  // that were not in their hand. The server refused it, correctly, and the
  // player got a toast for a move they had no way to know was stale.
  // Cleared in an effect, and NOT adjusted during render.
  //
  // Adjusting during render is React's documented way to reset state when
  // a key changes, and it was the first thing tried here - but `held` is
  // not read by this component alone. The table lifts the selected pieces
  // through the placement store, so clearing it mid-render updates a
  // `Piece` while `RoomScreen` is still rendering, which React warns
  // about in the console. A frame of stale lift is the lesser problem by
  // far: before this, the selection was stale for the whole next hand.
  const handKey = `${api.room?.gameId ?? ""}:${api.room?.gameRunning ?? false}:${
    api.frame?.round ?? -1
  }`;
  useEffect(() => {
    // Clearing during render reaches into the piece store mid-render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHeld([]);
  }, [handKey]);

  useDiscardNotice();

  // What the home page asked for (see `entry.ts`): read once, then carried
  // out as soon as the server is listening. `undefined` until read; the
  // screen says what it is doing meanwhile rather than flashing a form the
  // player already filled in on the home page.
  const [intent, setIntent] = useState<EntryIntent | null | undefined>(undefined);
  /** Sent, and waiting to hear back. */
  const [acting, setActing] = useState<EntryIntent | null>(null);
  useEffect(() => {
    // Storage exists only in the browser, so this cannot be read during
    // render; and read ONCE, so a refresh does not make a second room.
    // Taken HERE, not inside the updater: React runs an updater twice in
    // StrictMode, and the second run found the intent already consumed.
    // A second run of this effect (StrictMode again) takes nothing, and the
    // updater keeps the first answer.
    const taken = takeEntryIntent();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIntent((prev) => prev ?? taken);
  }, []);
  useEffect(() => {
    if (!intent) return;
    const name = readSavedName();
    const ready =
      api.phase === "idle" ||
      // Already in a room — somebody who was still in one pressed Make or
      // Join on the home page. Joining the room you are in is a no-op.
      (api.phase === "in-room" && api.room !== null);
    if (!ready) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIntent(null);
    if (!name) return;
    if (intent.t === "join" && api.room?.code === intent.code) return;
    setActing(intent);
    if (intent.t === "make") api.createRoom(name);
    else api.joinRoom(intent.code, name);
  }, [intent, api]);
  // Done once there is an answer: the room arrived, or a refusal did.
  useEffect(() => {
    if (!acting) return;
    const arrived =
      api.room !== null && (acting.t === "make" || api.room.code === acting.code);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (arrived || api.error || api.phase === "pending") setActing(null);
  }, [acting, api.room, api.error, api.phase]);

  // Keep the address bar honest. A room reached by code, created fresh, or
  // rejoined automatically on reconnect should all end up with the code in
  // the URL so it can be copied out of it. Not while the home page's
  // intent is still in flight: the room on screen may be the one being left.
  useEffect(() => {
    if (intent || acting) return;
    if (api.room && api.room.code !== code) {
      router.replace(`/room/${api.room.code}`);
    }
  }, [api.room, code, router, intent, acting]);

  // A table of its own mounts a `GameToaster` inside `TableSurface`, so
  // this one is for the screens that have no table: the lobby, the entry
  // form, waiting to be let in. Mounting both is not harmless — sonner
  // renders every toast into every mounted `<Toaster>`, so online play
  // showed each bot move, each room notice and each announcement TWICE,
  // stacked.
  const tableShowing = Boolean(
    api.room && api.room.inGame && api.frame && tableFor(api.room.gameId),
  );

  return (
    <>
      {tableShowing ? null : <GameToaster />}

      {/* Above every branch below, because losing the socket is worth
          saying whichever screen you are on. */}
      <ConnectionNotice status={api.status} />

      {api.phase === "superseded" ? (
        // Said plainly rather than retried. Two tabs for one identity used
        // to trade the socket back and forth several times a second, each
        // closing the other, and neither screen ever settled — which read
        // as the game desyncing rather than as what it was.
        <Centred>
          <span className="eyebrow">Playing in another tab</span>
          <p className="max-w-xs text-center text-sm text-bone-400">
            You opened this room somewhere else. Your seat is still yours — carry on there, or
            bring the game back here.
          </p>
          <Button size="sm" onClick={api.resume}>
            Play here instead
          </Button>
        </Centred>
      ) : api.phase === "connecting" ? (
        <Centred>
          <span className="eyebrow">
            {api.status === "reconnecting" ? "Reconnecting…" : "Connecting…"}
          </span>
        </Centred>
      ) : (intent || acting || intent === undefined) && api.phase !== "pending" ? (
        <Centred>
          <span className="eyebrow">{intentLabel(acting ?? intent ?? null)}</span>
        </Centred>
      ) : api.phase === "pending" ? (
        <Centred>
          <span className="eyebrow">Waiting to be let in</span>
          <p className="max-w-xs text-center text-sm text-bone-400">
            {api.pendingCode} is a private room. The party leader has to approve you.
          </p>
          <Button
            size="sm"
            onClick={() => {
              // Actually withdraw, not just navigate. Leaving the request
              // standing meant a later approval dragged the player into a
              // room they had declined.
              api.withdraw();
              router.push("/room");
            }}
          >
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
              setHeld={setHeld}
            />
          );
        })()
      ) : (
        <Lobby api={api} />
      )}
    </>
  );
}

/**
 * DEV ONLY: says so when Chrome discarded this tab and reloaded it.
 *
 * Reported while testing with two windows (2026-09-26): one player's page
 * "reloaded out of nowhere" mid-game, the other's did not, and the game
 * carried on as if nothing had happened. Hot reloading was ruled out in
 * Chrome (editing the table, the runtime and the rules mid-game reloaded
 * neither window). What fits is Chrome's Memory Saver: a window hidden
 * behind another counts as hidden, a hidden tab can be discarded, and a
 * discarded tab reloads when it is looked at again. The seat, hand and
 * score all live on the server, so nothing is lost, which matches. This
 * turns the guess into an answer the next time it happens.
 */
function useDiscardNotice() {
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (!(document as Document & { wasDiscarded?: boolean }).wasDiscarded) return;
    const text = "Chrome discarded this tab to save memory, and reloaded it";
    console.info(`[dev] ${text}.`);
    // A beat later, so it lands on whichever screen (and toaster) is up.
    const t = setTimeout(() => announce(`Dev: ${text}`, "info"), 2500);
    return () => clearTimeout(t);
  }, []);
}

/** What the screen says while the home page's intent is carried out. */
function intentLabel(intent: EntryIntent | null): string {
  if (intent?.t === "make") return "Making your room…";
  if (intent?.t === "join") return `Joining ${intent.code}…`;
  return "Connecting…";
}

/** Uppercase, letters only, at most the four a join code has. */
function cleanCode(raw: string | undefined): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
}

function Centred({ children }: { children: React.ReactNode }) {
  return (
    <main className="felt felt-weave flex h-svh flex-col items-center justify-center gap-4">
      {children}
    </main>
  );
}

/**
 * Create a room, or join one — for whoever did not come through the home
 * page's own form: a shared link, a direct visit, or a refused attempt
 * (which shows its reason here).
 *
 * A name is required for both, per the spec — there are no accounts, so a
 * name is the only thing that makes somebody addressable in a roster. It is
 * remembered locally so the second visit does not ask again.
 *
 * With a code in the URL the form is about JOINING that room: Join is the
 * primary button and making a room of your own is a quiet link. It used to
 * be the same form either way, with Make the louder button right beside
 * the name, so somebody who had followed a link to join was steered
 * towards making a room instead.
 */
function Entry({ api, initialCode }: { api: ReturnType<typeof useRoom>; initialCode?: string }) {
  const [name, setName] = useState("");
  // Sanitised exactly as `CodeInput` sanitises typing, which this used
  // to skip. `/room/abcde` filled all four boxes and left Join disabled
  // forever with no error; `/room/ab-1` is length 4, so Join was ENABLED
  // and sent a code the server could only refuse.
  const [code, setCode] = useState(cleanCode(initialCode));
  const [touched, setTouched] = useState(false);
  /** Arrived with a code: this form is for joining it. */
  const joining = cleanCode(initialCode).length === 4;

  useEffect(() => {
    // Deliberately an effect, and deliberately a synchronous setState in
    // one. A lazy `useState` initializer runs during render, where `window`
    // does not exist during prerender and the build breaks; guarding that
    // read instead produces prerendered HTML with an empty field and a
    // filled one after hydration, a mismatch on a controlled input.
    const saved = readSavedName();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved) setName(saved);
  }, []);

  const named = name.trim().length > 0;
  const joinable = named && code.length === 4;

  const make = () => {
    setTouched(true);
    if (!named) return;
    saveName(name);
    api.createRoom(name.trim());
  };
  const join = () => {
    setTouched(true);
    if (!joinable) return;
    saveName(name);
    api.joinRoom(code, name.trim());
  };

  const nameField = (
    <TextField
      label="Your name"
      value={name}
      onChange={setName}
      placeholder="Ada"
      maxLength={20}
      error={touched && !named ? "A name is needed to join a room" : undefined}
    />
  );
  const codeError = api.error?.code === "no-such-room" ? "No room with that code" : undefined;

  return (
    <SetupShell maxWidth="max-w-xs">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="eyebrow">Play together</span>
        <h1 className="font-display text-4xl tracking-wider text-brass-300">
          {joining ? `Room ${code}` : "Rooms"}
        </h1>
        <p className="max-w-xs text-sm text-bone-400">
          {joining
            ? "You have been invited to a room. Pick the name everyone will see you by."
            : "Make a room and share the code, or type one in. Bots fill any seat nobody is sitting in."}
        </p>
      </div>

      {nameField}

      {joining ? (
        <>
          {codeError ? (
            <p className="text-xs font-semibold" style={{ color: "var(--color-loss)" }}>
              {codeError}
            </p>
          ) : null}
          <Button tone="primary" className="w-full" onClick={join}>
            Join room {code}
          </Button>
          <button
            type="button"
            className="text-xs text-bone-400 underline-offset-4 hover:text-bone-200 hover:underline"
            onClick={make}
          >
            or make a room of your own
          </button>
        </>
      ) : (
        <>
          <Button tone="primary" className="w-full" onClick={make}>
            Make a room
          </Button>

          <div className="flex w-full items-center gap-3">
            <span className="h-px flex-1 bg-bone-50/12" />
            <span className="eyebrow">or join one</span>
            <span className="h-px flex-1 bg-bone-50/12" />
          </div>

          <CodeInput value={code} onChange={setCode} error={codeError} onSubmit={join} />
          <Button className="w-full" disabled={!joinable} onClick={join}>
            Join room
          </Button>
        </>
      )}

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
