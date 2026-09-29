"use client";

/**
 * The lobby.
 *
 * Three parts, in the order a person needs them: how others get in (the
 * invite), what is being played (Game), and who sits where (Table) — two
 * panels side by side on a wide screen, stacked on a phone with the game
 * first. Under everything, a footer that stays in reach: what Start is
 * waiting for, in words, and the buttons.
 *
 * The game's options are the SAME `GameOptions` the solo setup screen
 * draws, from the same spec — the lobby used to hand-roll its own copy of
 * every game's controls, and it drifted from the solo screens in labels,
 * ranges, defaults and whole options.
 *
 * The rule the layout follows: a member who is not the leader sees the
 * same screen, with the controls they cannot use DIMMED rather than
 * missing. Hiding them would mean the lobby silently rearranges itself the
 * moment leadership moves — which it does whenever the leader's phone
 * sleeps — and would leave everyone else unable to see what the leader is
 * even choosing between.
 *
 * Start is the exception: only the leader has it. Dimmed, it was the one
 * control here that somebody else could never use at any point, and it sat
 * in the footer's best spot saying nothing a dimmed button can say (the
 * user, 2026-09-27). The line above it says who they are waiting on.
 */

import { Check, Shuffle, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { defaultSettings, summarizeSetup, textOf } from "@/session/gameSetup";
import type { RoomView } from "@/session/protocol";
import { GAMES, GAME_IDS, isGameId, onlineGames, type GameId } from "@/session/registry";
import { MIN_ROOM_PLAYERS } from "@/session/room";
import { EndGameAction } from "@/table/gameSettings";
import { motion } from "motion/react";
import { Collapse, Swap, listItemMotion } from "@/ui/motion";
import { Button } from "@/ui/primitives/Button";
import { ChoiceGroup } from "@/ui/primitives/ChoiceGroup";
import { DIFFICULTY_NAMES } from "@/ui/primitives/DifficultyPicker";
import { GameThumb, seatRange } from "@/ui/primitives/GameThumb";
import { SetupShell } from "@/ui/primitives/SetupShell";
import { GameOptions } from "@/ui/setup/GameOptions";
import { useMediaQuery } from "@/ui/useMediaQuery";
import { InviteCard } from "./InviteCard";
import { Roster } from "./Roster";
import { SettleUp } from "./SettleUp";
import type { RoomApi } from "./useRoom";

export function Lobby({ api }: { api: RoomApi }) {
  const room = api.room!;
  return (
    <SetupShell maxWidth="max-w-md lg:max-w-4xl" footer={<LobbyFooter api={api} />}>
      {/* First, while there is one: after a game played for money this is
          what everybody came back to the lobby needing. It stays until the
          next game starts. */}
      {room.settlement ? <SettleUp settlement={room.settlement} you={room.you} className="max-w-md" /> : null}
      <InviteCard code={room.code} />
      <div className="grid w-full gap-9 lg:grid-cols-2 lg:items-start lg:gap-12">
        <GamePanel api={api} />
        <TablePanel api={api} />
      </div>
    </SetupShell>
  );
}

const leaderName = (room: RoomView) => room.members.find((m) => m.isLeader)?.name ?? "the party leader";
const here = (room: RoomView) => room.members.filter((m) => m.connected).length;

/**
 * What Start is waiting for, in words — or null when nothing is.
 *
 * The button used to say it only through `title`, which a phone never
 * shows: a dimmed "Start Spades" and no reason. See MIN_ROOM_PLAYERS for
 * why the count is of people connected, not merely on the roster.
 */
export function lobbyStatus(room: RoomView): string | null {
  if (room.gameRunning) {
    const open = room.openSeats.length;
    return open > 0 ? `A game is on — ${open} seat${open === 1 ? "" : "s"} free` : "A game is on — every seat is taken";
  }
  // The leader's own button already says "Pick a game first".
  if (!room.gameId) return room.youAreLeader ? null : `${leaderName(room)} is choosing a game`;
  const missing = MIN_ROOM_PLAYERS - here(room);
  if (missing > 0) return `Waiting for ${missing} more ${missing === 1 ? "person" : "people"}`;
  return room.youAreLeader ? null : `Waiting for ${leaderName(room)} to start`;
}

function LobbyFooter({ api }: { api: RoomApi }) {
  const room = api.room!;
  const leader = room.youAreLeader;
  const status = lobbyStatus(room);
  const ready = leader && room.gameId !== null && here(room) >= MIN_ROOM_PLAYERS;
  const full = room.openSeats.length === 0;

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-2.5">
      {status ? (
        <p role="status" className="text-center text-xs font-semibold text-bone-300">
          {status}
        </p>
      ) : null}
      {room.gameRunning ? (
        <div className="flex w-full gap-2">
          {/* Dimmed rather than hidden at a full table, with the reason
              above it: `openSeats` used to go unread, and pressing this at
              a full table quietly made you a spectator. */}
          <Button tone="primary" className="flex-[1.4]" disabled={full} onClick={() => api.enterGame("player")}>
            {full ? "Table is full" : "Join the game →"}
          </Button>
          <Button className="flex-1" onClick={() => api.enterGame("spectator")}>
            Watch instead
          </Button>
        </div>
      ) : leader ? (
        <Button tone="primary" className="w-full" disabled={!ready} onClick={api.startGame}>
          {room.gameId ? `Start ${GAMES[room.gameId].name}` : "Pick a game first"}
        </Button>
      ) : null}
      <div className="flex w-full items-center justify-between gap-3">
        {room.gameRunning && leader ? (
          <EndGameAction
            onEnd={api.endGame}
            size="sm"
            tone="danger"
            label="End the game for everyone"
            question="End the game for everyone?"
            note="Everyone comes back here."
          />
        ) : (
          <span />
        )}
        <Button size="sm" onClick={api.leaveRoom}>
          Leave room
        </Button>
      </div>
    </div>
  );
}

function GamePanel({ api }: { api: RoomApi }) {
  const room = api.room!;
  // What a game IS cannot be changed while one is running.
  //
  // The server has refused this since it learned to (`game-already-running`),
  // because swapping gameId mid-match hands every client a different table to
  // draw against a live game's frames. But the lobby is reachable DURING a
  // match and these controls went on looking exactly as usable as ever, so
  // the leader tapped Poker, the server said no, and nothing at all appeared.
  // Dimmed rather than hidden, like the rest of this screen, with the reason
  // over them: the guard is the server's, this is the courtesy.
  const locked = !room.youAreLeader || room.gameRunning;
  const games = onlineGames();
  const offline = GAME_IDS.map((id) => GAMES[id]).filter((g) => !g.online);
  const entry = room.gameId ? GAMES[room.gameId] : null;

  // On a phone a chosen game folds to one line, so the Table below it is in
  // reach. The leader's starts open — it is theirs to set; anybody else's
  // opens on request. Side by side on a wide screen, nothing folds.
  const wide = useMediaQuery("(min-width: 1024px)");
  const [open, setOpen] = useState(() => room.youAreLeader && !room.gameRunning);
  const folded = entry !== null && !wide && !open;
  const summary = entry
    ? [
        entry.name,
        ...summarizeSetup(entry.setup, room.settings, "room"),
        ...(entry.setup.difficulty ? [`Bots ${DIFFICULTY_NAMES[room.difficulty]}`] : []),
      ].join(" · ")
    : "";

  return (
    <section className="flex w-full flex-col gap-3">
      <header className="flex items-center justify-between gap-3">
        <span className="eyebrow">Game</span>
        {entry && !wide ? (
          <button
            type="button"
            aria-expanded={!folded}
            onClick={() => setOpen((o) => !o)}
            className="text-xs font-semibold text-brass-300 underline-offset-4 hover:underline"
          >
            {folded ? (locked ? "Details" : "Change") : locked ? "Hide" : "Done"}
          </button>
        ) : null}
      </header>
      {locked ? (
        <p className="text-[11px] text-bone-500">
          {room.gameRunning ? "Fixed until this game ends." : `Only ${leaderName(room)} can change these.`}
        </p>
      ) : null}

      {folded && entry ? (
        <div className="flex items-center gap-3">
          <span aria-hidden className="flex h-11 w-8 shrink-0 items-center justify-center">
            <GameThumb id={entry.id} size="sm" />
          </span>
          <p className="text-sm leading-relaxed text-bone-200">{summary}</p>
        </div>
      ) : null}

      <Collapse open={!folded}>
        <div className="flex flex-col gap-3">
          {/* The home page's pictures, not a row of names (the user,
              2026-09-27): a domino says "Dominoes" faster than the word. */}
          <ChoiceGroup
            label="Game"
            size="sm"
            variant="tiles"
            value={room.gameId ?? ""}
            options={games.map((g) => ({
              value: g.id,
              name: `${g.name}, ${seatRange(g.id)}`,
              label: (
                <>
                  <span aria-hidden className="flex h-11 items-center justify-center">
                    <GameThumb id={g.id} size="sm" />
                  </span>
                  <span className="font-display text-[13px] leading-tight tracking-wide">{g.name}</span>
                  <span className="text-[10px] font-semibold text-bone-500">{seatRange(g.id)}</span>
                </>
              ),
            }))}
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
          {/*
            Games with no online table are absent above rather than shown
            disabled, and that is the one exception to this screen's
            dim-don't-hide rule: they are not unavailable to YOU, they are not
            available at all yet, and a greyed button invites a question the
            lobby cannot answer. Named in prose instead, from the same list.
          */}
          {offline.length > 0 ? (
            <p className="text-xs text-bone-600">
              {offline.map((g) => g.name).join(", ")} {offline.length === 1 ? "is" : "are"} single-player only
              for now.
            </p>
          ) : null}

          {/* A different game's options cross-fade in rather than jumping. */}
          {entry ? (
            <Swap swapKey={entry.id}>
              <p className="text-xs leading-relaxed text-bone-400">{textOf(entry.setup.description, room.settings)}</p>
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
            </Swap>
          ) : null}
        </div>
      </Collapse>
    </section>
  );
}

function TablePanel({ api }: { api: RoomApi }) {
  const room = api.room!;
  const leader = room.youAreLeader;
  const entry = room.gameId ? GAMES[room.gameId] : null;
  const teamsEnabled = entry ? entry.teams(room.settings) : false;
  // Seats only exist once there is a game to have seats. Before that the
  // plan's seat count is 0, and every row read "No seat — Will watch —
  // table full": the person who had just made the room was told it was
  // full and they would be watching.
  const hasGame = room.gameId !== null;

  return (
    <section className="flex w-full flex-col gap-3">
      {/* Pinned to the top of the table they are asking to join — the toast
          that announces them is gone in two seconds. */}
      {leader && room.pending.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="eyebrow">Asking to join</span>
          {room.pending.map((p) => (
            <motion.div
              key={p.session}
              {...listItemMotion}
              className="flex items-center gap-3 rounded-lg bg-brass-400/10 px-3 py-2.5 ring-1 ring-brass-500/40"
            >
              <span className="flex-1 truncate text-sm font-semibold text-bone-100">{p.name}</span>
              <Button size="sm" tone="primary" onClick={() => api.approve(p.session)}>
                <Check size={12} /> Let in
              </Button>
              <Button size="sm" onClick={() => api.deny(p.session)} aria-label={`Turn ${p.name} away`}>
                <X size={12} /> Turn away
              </Button>
            </motion.div>
          ))}
        </div>
      ) : null}

      <header className="flex items-center justify-between">
        <span className="eyebrow">Table</span>
        <span className="text-xs text-bone-400">
          {here(room)} of {room.members.length} here
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
          Seat 1 is dealt first, and the seats go clockwise from there — each one sits to the left of the seat
          above it.
          {teamsEnabled ? " Partners sit across, so the seat decides the team." : ""}
          {leader ? " Drag a row by its grip to move a person or a bot." : ""}
        </p>
      ) : (
        <p className="text-[11px] leading-relaxed text-bone-500">Pick a game to set up the seats.</p>
      )}
      {leader && !room.gameRunning && hasGame ? (
        <Button size="sm" onClick={api.shuffleSeats} className="self-start">
          <Shuffle size={12} /> Shuffle seats
        </Button>
      ) : null}

      {here(room) >= MIN_ROOM_PLAYERS ? null : <WaitingForPeople gameId={room.gameId} />}

      <div className="mt-2 flex flex-col gap-2">
        <span className="text-xs font-bold text-bone-200">Who can join</span>
        <ChoiceGroup
          label="Who can join"
          size="sm"
          fill
          value={room.privacy}
          options={[
            { value: "public", label: "Anyone with the code" },
            { value: "private", label: "Only people I let in" },
          ]}
          locked={!leader}
          onChange={(privacy) => api.setPrivacy(privacy)}
        />
      </div>
    </section>
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
        A room game needs {MIN_ROOM_PLAYERS} people. Send the link above — or play on your own until somebody
        arrives.
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
