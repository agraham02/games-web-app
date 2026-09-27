"use client";

/**
 * The lobby.
 *
 * The game's options are the SAME `GameOptions` the solo setup screen
 * draws, from the same spec — the lobby used to hand-roll its own copy of
 * every game's controls, and it drifted from the solo screens in labels,
 * ranges, defaults and whole options. The genuinely new parts here are the
 * roster and the join code.
 *
 * The rule the layout follows: a member who is not the leader sees the
 * same screen, with the controls they cannot use DIMMED rather than
 * missing. Hiding them would mean the lobby silently rearranges itself the
 * moment leadership moves — which it does whenever the leader's phone
 * sleeps — and would leave everyone else unable to see what the leader is
 * even choosing between.
 */

import { Check, Copy, Lock, LockOpen, Shuffle, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { defaultSettings, textOf } from "@/session/gameSetup";
import { GAMES, GAME_IDS, isGameId, onlineGames, type GameId } from "@/session/registry";
import { MIN_ROOM_PLAYERS } from "@/session/room";
import { Button } from "@/ui/primitives/Button";
import { ChoiceGroup } from "@/ui/primitives/ChoiceGroup";
import { SetupShell } from "@/ui/primitives/SetupShell";
import { GameOptions } from "@/ui/setup/GameOptions";
import type { RoomApi } from "./useRoom";
import { Roster } from "./Roster";

export function Lobby({ api }: { api: RoomApi }) {
  const room = api.room!;
  const leader = room.youAreLeader;
  const entry = room.gameId ? GAMES[room.gameId] : null;
  const teamsEnabled = entry ? entry.teams(room.settings) : false;
  // See MIN_ROOM_PLAYERS. Connected, not merely on the roster — the same
  // count the header line above the roster already shows, so the reason
  // the button is off is legible two rows higher.
  const here = room.members.filter((m) => m.connected).length;
  const enoughPeople = here >= MIN_ROOM_PLAYERS;
  // Seats only exist once there is a game to have seats. Before that the
  // plan's seat count is 0, and every row read "No seat — Will watch —
  // table full": the person who had just made the room was told it was
  // full and they would be watching.
  const hasGame = room.gameId !== null;

  return (
    <SetupShell maxWidth="max-w-md">
      <JoinCode code={room.code} />

      <section className="flex w-full flex-col gap-2">
        <header className="flex items-center justify-between">
          <span className="eyebrow">In this room</span>
          <span className="text-xs text-bone-400">
            {room.members.filter((m) => m.connected).length} of {room.members.length} here
          </span>
        </header>
        <Roster
          members={room.members}
          you={room.you}
          youAreLeader={leader}
          plan={room.gameRunning || !hasGame ? null : room.seatPlan}
          seatCount={room.seats}
          teamsEnabled={teamsEnabled}
          onPromote={api.promote}
          onKick={api.kick}
          onArrange={api.arrangeSeats}
        />
        {room.gameRunning ? null : hasGame ? (
          <p className="text-[11px] leading-relaxed text-bone-500">
            Seat 1 is dealt first, and the seats go clockwise from there — each one sits to
            the left of the seat above it.
            {teamsEnabled ? " Partners sit across, so the seat decides the team." : ""}
            {leader ? " Drag a row by its grip to move a person or a bot." : ""}
          </p>
        ) : (
          <p className="text-[11px] leading-relaxed text-bone-500">
            Pick a game to set up the seats.
          </p>
        )}
        {leader && !room.gameRunning && hasGame ? (
          <Button size="sm" onClick={api.shuffleSeats} className="self-start">
            <Shuffle size={12} /> Shuffle seats
          </Button>
        ) : null}
      </section>

      {leader && room.pending.length > 0 ? (
        <section className="flex w-full flex-col gap-2">
          <span className="eyebrow">Asking to join</span>
          {room.pending.map((p) => (
            <div
              key={p.session}
              className="flex items-center gap-3 rounded-lg bg-brass-400/10 px-3 py-2.5 ring-1 ring-brass-500/40"
            >
              <span className="flex-1 truncate text-sm font-semibold text-bone-100">{p.name}</span>
              <Button size="sm" tone="primary" onClick={() => api.approve(p.session)}>
                <Check size={12} /> Let in
              </Button>
              <Button size="sm" onClick={() => api.deny(p.session)} aria-label={`Turn ${p.name} away`}>
                <X size={12} /> Turn away
              </Button>
            </div>
          ))}
        </section>
      ) : null}

      <GamePicker api={api} />

      <div className="flex w-full flex-col gap-3">
        {room.gameRunning ? (
          <>
            {/* `openSeats` existed on the room view and was never read,
                so this button was always enabled — and at a full table it
                quietly made you a spectator instead, with only a toast
                saying so. Dimmed rather than hidden, per the rest of this
                screen, with the reason on it. */}
            <Button
              tone="primary"
              disabled={room.openSeats.length === 0}
              title={room.openSeats.length === 0 ? "Every seat is taken" : undefined}
              onClick={() => api.enterGame("player")}
            >
              {room.openSeats.length === 0 ? "Table is full" : "Join the game →"}
            </Button>
            <Button onClick={() => api.enterGame("spectator")}>Watch instead</Button>
            {leader ? (
              <Button tone="danger" onClick={api.endGame}>
                End the game for everyone
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <Button
              tone="primary"
              disabled={!leader || !room.gameId || !enoughPeople}
              onClick={api.startGame}
              title={
                !leader
                  ? "Only the party leader can start"
                  : !enoughPeople
                    ? `A room game needs ${String(MIN_ROOM_PLAYERS)} people`
                    : undefined
              }
            >
              {room.gameId ? `Start ${GAMES[room.gameId].name}` : "Pick a game first"}
            </Button>
            {enoughPeople ? null : <WaitingForPeople gameId={room.gameId} />}
          </>
        )}

        <div className="flex items-center justify-between gap-3">
          <Button
            size="sm"
            disabled={!leader}
            onClick={() => api.setPrivacy(room.privacy === "public" ? "private" : "public")}
          >
            {room.privacy === "public" ? <LockOpen size={12} /> : <Lock size={12} />}
            {room.privacy === "public" ? "Anyone with the code" : "Approval needed"}
          </Button>
          <Button size="sm" tone="danger" onClick={api.leaveRoom}>
            Leave room
          </Button>
        </div>
      </div>
    </SetupShell>
  );
}

/**
 * Why the start button is off, and what to do instead.
 *
 * A room of one is not a broken room, so this is an explanation rather than
 * an error — and it carries the alternative with it, because the honest
 * answer to "I want to play and nobody is here yet" is the solo table: the
 * same rules and the same bots, without a round trip per turn. It links
 * straight to the game already chosen rather than to the home screen, so
 * taking that answer is one tap instead of three.
 */
function WaitingForPeople({ gameId }: { gameId: GameId | null }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg bg-bone-50/4 px-4 py-3 text-center ring-1 ring-bone-50/10">
      <p className="text-xs leading-relaxed text-bone-400">
        A room game needs {MIN_ROOM_PLAYERS} people. Share the code above — or
        play on your own until somebody arrives.
      </p>
      <Link
        href={gameId ? `/play/${gameId}` : "/"}
        className="text-xs font-semibold text-brass-300 underline-offset-4 hover:underline"
      >
        {gameId ? `Play ${GAMES[gameId].name} solo →` : "Pick a game to play solo →"}
      </Link>
    </div>
  );
}

function JoinCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex w-full flex-col items-center gap-2">
      <span className="eyebrow">Room code</span>
      <div className="flex items-center gap-3">
        <span className="font-display text-4xl tracking-[0.3em] text-brass-300">{code}</span>
        <Button
          size="sm"
          aria-label="Copy room code"
          onClick={() => {
            // Best effort: clipboard access is denied outright on insecure
            // origins, which is exactly where this gets tested (a phone
            // hitting a laptop's dev server). The code is on screen in
            // 4xl type either way.
            void navigator.clipboard
              ?.writeText(code)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => {});
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </Button>
      </div>
    </div>
  );
}

function GamePicker({ api }: { api: RoomApi }) {
  const room = api.room!;
  // What a game IS cannot be changed while one is running.
  //
  // The server has refused this since it learned to (`game-already-running`),
  // because swapping gameId mid-match hands every client a different table to
  // draw against a live game's frames. But the lobby is reachable DURING a
  // match and these controls went on looking exactly as usable as ever, so
  // the leader tapped Poker, the server said no, and nothing at all appeared.
  // Dimmed rather than hidden, like the rest of this screen, with the reason
  // under them: the guard is the server's, this is the courtesy.
  const locked = !room.youAreLeader || room.gameRunning;
  const games = onlineGames();
  const offline = GAME_IDS.map((id) => GAMES[id]).filter((g) => !g.online);
  const entry = room.gameId ? GAMES[room.gameId] : null;

  return (
    <section className="flex w-full flex-col gap-3">
      <span className="eyebrow">Game</span>

      <ChoiceGroup
        label="Game"
        size="sm"
        value={room.gameId ?? ""}
        options={games.map((g) => ({ value: g.id, label: g.name }))}
        locked={locked}
        // A new game starts on its own defaults — the solo screen's values
        // (the user's call, 2026-09-26) — keeping only the bots' skill,
        // which is the room's taste rather than any one game's.
        onChange={(id) => {
          if (!isGameId(id)) return;
          const next = GAMES[id];
          api.selectGame(id, defaultSettings(next.setup), next.defaultSeats, room.difficulty);
        }}
      />
      {locked ? (
        <p className="text-[11px] text-bone-500">
          {room.gameRunning
            ? "Fixed until this game ends."
            : "Only the party leader can change the game and its rules."}
        </p>
      ) : null}
      {/*
        Games with no online table are absent above rather than shown
        disabled, and that is the one exception to this screen's
        dim-don't-hide rule: they are not unavailable to YOU, they are not
        available at all yet, and a greyed button invites a question the
        lobby cannot answer. Named in prose instead, from the same list, so
        this line cannot go stale as they are wired up.
      */}
      {offline.length > 0 ? (
        <p className="text-xs text-bone-600">
          {offline.map((g) => g.name).join(", ")}{" "}
          {offline.length === 1 ? "is" : "are"} single-player only for now.
        </p>
      ) : null}

      {entry ? (
        <>
          <p className="text-xs leading-relaxed text-bone-400">
            {textOf(entry.setup.description, room.settings)}
          </p>
          {/*
            Empty seats are filled by bots, so their skill is a real setting
            in a room even when every seat has a person in it — somebody
            stepping away hands their seat to one.
          */}
          <GameOptions
            game={entry.id}
            mode="room"
            locked={locked}
            className="mt-3"
            value={{
              settings: room.settings,
              seats: room.seats || entry.defaultSeats,
              difficulty: room.difficulty,
            }}
            onChange={(next) => api.selectGame(entry.id, next.settings, next.seats, next.difficulty)}
          />
        </>
      ) : null}
    </section>
  );
}
