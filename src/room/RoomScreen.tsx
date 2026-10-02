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
 *
 * Every screen that is not the lobby or a table is either the entry form
 * (`RoomEntryForm`) or a `RoomStatusScreen`. A change of screen fades the
 * new one in (`Reveal`, keyed by which screen it is); the old one goes at
 * once, as a route does, so the next screen is never held back by the
 * last one's exit.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { PieceId } from "@/engine/types";
import { CODE_LENGTH } from "@/session/room";
import { GameToaster, announce } from "@/ui/disclosure";
import { Reveal } from "@/ui/motion";
import { Button } from "@/ui/primitives/Button";
import { SetupShell } from "@/ui/primitives/SetupShell";
import { cleanCode } from "@/ui/primitives/TextField";
import { ConnectionNotice } from "./ConnectionNotice";
import { readSavedName, takeEntryIntent, type EntryIntent } from "./entry";
import { Lobby } from "./Lobby";
import { RoomEntryForm, type RoomEntryMode } from "./RoomEntryForm";
import { readSavedPhoto } from "./photo";
import { RoomStatusScreen } from "./RoomStatusScreen";
import { SettleUp } from "./SettleUp";
import { tableFor } from "./tables";
import { useRoom, type RoomApi } from "./useRoom";
import { statusLane } from "@/table/geometry";
import { useGeometry } from "@/table/store";

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

  // A leave the player asked for goes home. It used to land on the entry
  // form at the same URL — the invitation to the room just left, "You have
  // been invited to a room", which is the one place they had chosen not to
  // be. `replace`, so Back does not return to it either.
  //
  // Closing the room yourself is a leave you asked for, too — unless it
  // leaves money to square up, which everybody (the leader included) is
  // shown before going anywhere.
  const farewell = api.farewell;
  const closedWithMoney =
    api.phase === "idle" && farewell?.reason === "room-closed" && Boolean(farewell.settlement);
  const leaving =
    api.phase === "idle" &&
    (farewell?.reason === "left" ||
      (farewell?.reason === "room-closed" && farewell.byYou === true && !closedWithMoney));
  useEffect(() => {
    if (leaving) router.replace("/");
  }, [leaving, router]);

  // A photo taken earlier in this session goes with the player to the next
  // room (the user, 2026-09-29: for the session, never beyond). Once per
  // room: taking it down again in this room clears the saved one too.
  const carriedTo = useRef<string | null>(null);
  const room = api.room;
  const setPhoto = api.setPhoto;
  useEffect(() => {
    if (!room || carriedTo.current === room.code) return;
    carriedTo.current = room.code;
    const me = room.members.find((m) => m.session === room.you);
    const saved = readSavedPhoto();
    if (me && !me.photo && saved) setPhoto(saved);
  }, [room, setPhoto]);

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
  const geometry = useGeometry();

  // Which screen is up — the key a new screen fades in on. Checked in this
  // order because more than one can be true at once: a cached room while
  // superseded, an intent in flight while idle.
  const screen: Screen =
    api.phase === "superseded"
      ? "superseded"
      : api.phase === "connecting"
        ? "connecting"
        : (intent || acting || intent === undefined) && api.phase !== "pending"
          ? "acting"
          : api.phase === "pending"
            ? "pending"
            : api.phase === "idle"
              ? leaving
                ? "leaving"
                : closedWithMoney
                  ? "closed"
                  : "entry"
              : tableShowing
                ? "table"
                : "lobby";

  return (
    <>
      {/* Above the lobby's sticky footer, never on its Leave room. */}
      {tableShowing ? null : <GameToaster />}

      {/* Above every screen below, because losing the socket is worth
          saying whichever one you are on. */}
      <ConnectionNotice
        status={api.status}
        top={tableShowing && geometry ? statusLane(geometry) : undefined}
        idle={tableShowing && Boolean(api.room?.members.find((m) => m.session === api.room?.you)?.idle)}
        onResume={api.resumeSeat}
      />

      {screen === "table" ? (
        // Looked up rather than hardcoded: the room may be running any
        // game, and a table that assumed one would render the wrong one.
        // `tableFor` returning null falls through to the lobby, which is
        // the honest answer for a game with no table yet — and a test
        // stops the registry from ever offering one. Not faded in: the
        // table has its own arrival, the deal.
        (() => {
          const Table = tableFor(api.room!.gameId)!;
          return (
            <Table
              api={api}
              room={api.room!}
              frame={api.frame!}
              held={held}
              onToggleHeld={toggleHeld}
              onClearHeld={() => setHeld([])}
              setHeld={setHeld}
            />
          );
        })()
      ) : (
        <Reveal key={screen}>
          {screen === "superseded" ? (
            // Said plainly rather than retried. Two tabs for one identity
            // used to trade the socket back and forth several times a
            // second, each closing the other, and neither screen ever
            // settled — which read as the game desyncing rather than as
            // what it was.
            <RoomStatusScreen
              title="Playing in another tab"
              line="You opened this room somewhere else. Your seat is still yours — carry on there, or bring the game back here."
              action={
                <Button size="sm" onClick={api.resume}>
                  Play here instead
                </Button>
              }
            />
          ) : screen === "connecting" ? (
            <RoomStatusScreen
              title={api.status === "reconnecting" ? "Reconnecting…" : "Connecting…"}
              waiting
            />
          ) : screen === "acting" ? (
            <RoomStatusScreen title={intentLabel(acting ?? intent ?? null)} waiting />
          ) : screen === "pending" ? (
            <RoomStatusScreen
              title="Waiting to be let in"
              line={`${api.pendingCode ?? "This"} is a private room. The party leader has to approve you.`}
              waiting
              // The action is the way home: a knock left standing would let
              // a later approval drag the player into a room they declined.
              home={false}
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    api.withdraw();
                    router.replace("/");
                  }}
                >
                  Never mind
                </Button>
              }
            />
          ) : screen === "leaving" ? (
            <RoomStatusScreen title="Leaving the room…" />
          ) : screen === "closed" ? (
            // The room and its lobby are gone, and with them the SettleUp
            // that said who owes whom — so it is said here, once, for
            // everybody who was in it.
            <RoomStatusScreen
              title="Room closed"
              line={farewell?.byYou ? "You closed the room." : `${farewell?.by ?? "The leader"} closed the room.`}
              action={
                <SettleUp
                  settlement={farewell!.settlement!}
                  you={farewell?.you ?? ""}
                  className="w-full max-w-xs text-left"
                />
              }
            />
          ) : screen === "entry" ? (
            <EntryScreen api={api} urlCode={code} />
          ) : (
            <Lobby api={api} />
          )}
        </Reveal>
      )}
    </>
  );
}

type Screen =
  | "superseded"
  | "connecting"
  | "acting"
  | "pending"
  | "leaving"
  | "closed"
  | "entry"
  | "table"
  | "lobby";

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

/**
 * What the last way in ran into, sorted by where it belongs: under the
 * name, under the code, or above the whole form.
 *
 * A refusal about a FIELD (a name already taken, a code with no room) goes
 * under that field, where the fix is. Anything about the room itself —
 * turned away, removed, full — is the form's `notice`, and it names the
 * room, because by now the player may have seen three.
 */
function refusalOf(api: RoomApi): { notice?: string; name?: string; code?: string } {
  const error = api.error;
  if (error) {
    const text = sentence(error.message);
    if (error.code === "name-required" || error.code === "name-taken") return { name: text };
    if (error.code === "no-such-room") return { code: "No room with that code" };
    return { notice: text };
  }
  const farewell = api.farewell;
  const room = farewell?.code ? `room ${farewell.code}` : "the room";
  switch (farewell?.reason) {
    case "denied":
      return { notice: `The leader of ${room} didn't let you in. Ask again, or make your own room.` };
    case "kicked":
      return { notice: `You were removed from ${room}.` };
    case "room-closed":
      return {
        notice: farewell?.by ? `${farewell.by} closed ${room}.` : `${sentence(room)} has closed.`,
      };
    default:
      return {};
  }
}

/** The wire's refusals are lower-case sentence fragments (`ERROR_TEXT`). */
function sentence(text: string): string {
  const s = text.trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/**
 * The entry screen: somebody who did not come through the home page's own
 * form — a shared link, a direct visit — or whose way in did not work.
 *
 * A name is required either way, per the spec — there are no accounts, so
 * a name is the only thing that makes somebody addressable in a roster. It
 * is remembered locally so the second visit does not ask again.
 */
function EntryScreen({ api, urlCode }: { api: RoomApi; urlCode?: string }) {
  const refusal = refusalOf(api);
  const invited = cleanCode(urlCode);
  const mode: RoomEntryMode =
    refusal.notice || refusal.code ? "retry" : invited.length === CODE_LENGTH ? "invite" : "home";
  // Worth asking again only where the answer could change: a knock that was
  // turned down. Not a room you were removed from, or one that has closed.
  const reason = api.farewell?.reason;
  const initialCode =
    reason === "denied"
      ? (api.farewell?.code ?? "")
      : reason === "kicked" || reason === "room-closed"
        ? ""
        : invited;

  return (
    <SetupShell maxWidth="max-w-xs">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="eyebrow">Play together</span>
        <h1 className="font-display text-4xl tracking-wider text-brass-300">
          {mode === "invite" ? `Room ${invited}` : "Rooms"}
        </h1>
        {mode === "retry" ? null : (
          <p className="max-w-xs text-sm text-bone-400">
            {mode === "invite"
              ? "You have been invited to a room. Pick the name everyone will see you by."
              : "Make a room and share the code, or type one in. Bots fill any seat nobody is sitting in."}
          </p>
        )}
      </div>

      <RoomEntryForm
        mode={mode}
        initialCode={initialCode}
        notice={refusal.notice}
        errors={{ name: refusal.name, code: refusal.code }}
        onMake={(name) => api.createRoom(name)}
        onJoin={(code, name) => api.joinRoom(code, name)}
      />

      <Link href="/" className="text-xs text-bone-400 underline-offset-4 hover:underline">
        ← Back
      </Link>
    </SetupShell>
  );
}
