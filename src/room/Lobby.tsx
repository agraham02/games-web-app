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
import { GAMES, GAME_IDS, isGameId, onlineGames, teamIndexOf, type GameId } from "@/session/registry";
import { MIN_ROOM_PLAYERS, TURN_TIMER_MAX_S, TURN_TIMER_MIN_S, TURN_TIMER_STEP_S } from "@/session/room";
import { EndGameAction } from "@/table/gameSettings";
import { motion } from "motion/react";
import { Collapse, Swap, listItemMotion } from "@/ui/motion";
import { Button } from "@/ui/primitives/Button";
import { ChoiceGroup } from "@/ui/primitives/ChoiceGroup";
import { DIFFICULTY_NAMES } from "@/ui/primitives/DifficultyPicker";
import { GameThumb, seatRange } from "@/ui/primitives/GameThumb";
import { NumberStepper } from "@/ui/primitives/NumberStepper";
import { Toggle } from "@/ui/primitives/Toggle";
import { SetupShell } from "@/ui/primitives/SetupShell";
import { GameOptions } from "@/ui/setup/GameOptions";
import { readSavedSetup, saveSetup } from "@/ui/setup/savedSetup";
import { useMediaQuery } from "@/ui/useMediaQuery";
import { InviteCard } from "./InviteCard";
import { Roster } from "./Roster";
import { SettleUp } from "./SettleUp";
import type { RoomApi } from "./useRoom";

export function Lobby({ api }: { api: RoomApi }) {
  const room = api.room!;
  return (
    <SetupShell game={room.gameId ?? undefined} maxWidth="max-w-xl lg:max-w-6xl" footer={<LobbyFooter api={api} />}>
      {/* First, while there is one: after a game played for money this is
          what everybody came back to the lobby needing. It stays until the
          next game starts. */}
      {room.settlement ? <SettleUp settlement={room.settlement} you={room.you} className="w-full" /> : null}
      <InviteCard code={room.code} />
      {/* `grid-cols-1` is `minmax(0, 1fr)`: without it the one column on a
          phone is `auto`, sized to its widest content that will not wrap —
          a Spades roster row with its Team chip — and the whole lobby ran
          past the right-hand padding, off an iPhone's screen. */}
      <div className="grid w-full grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-start lg:gap-5">
        <GamePanel api={api} />
        <div className="flex min-w-0 flex-col gap-4 lg:gap-5">
          <TablePanel api={api} />
          <RoomPanel api={api} />
        </div>
      </div>
    </SetupShell>
  );
}

/**
 * One section of the lobby (the user asked for cards, 2026-10-30): it was a
 * single long column of controls, and nothing said where one thing ended and
 * the next began.
 */
function Card({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex w-full min-w-0 flex-col gap-4 rounded-2xl border border-bone-50/14 bg-bone-50/6 shadow-e2 backdrop-blur-md p-5 sm:p-6">
      <header className="-mx-5 flex min-h-6 items-center justify-between gap-3 border-b border-bone-50/10 px-5 pb-4 sm:-mx-6 sm:px-6">
        <h2 className="caps text-bone-300">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
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

  const main = room.gameRunning ? (
    <div className="flex w-full gap-2">
      {/* Dimmed rather than hidden at a full table, with the reason above
          it: `openSeats` used to go unread, and pressing this at a full
          table quietly made you a spectator. */}
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
  ) : null;

  const lead =
    room.gameRunning && leader ? (
      <EndGameAction
        onEnd={api.endGame}
        size="sm"
        tone="danger"
        label="End the game for everyone"
        question="End the game for everyone?"
        note="Everyone comes back here."
      />
    ) : leader ? (
      // Hidden, not dimmed, for everybody else: they can never press it
      // (see `hide-controls-never-usable`), and a Leave is theirs.
      <EndGameAction
        onEnd={api.closeRoom}
        size="sm"
        tone="danger"
        label="Close room"
        question="Close the room for everyone?"
        note="Everyone is sent home."
        confirmLabel="Close room"
        cancelLabel="Keep it open"
      />
    ) : (
      <span />
    );

  // A phone: what to do, then the ways out on one row under it. Wider: one
  // row, the ways out at either end and the action in the middle.
  return (
    <div className="flex w-full flex-col items-center gap-2.5 sm:grid sm:grid-cols-[1fr_minmax(0,22rem)_1fr] sm:items-center sm:gap-6">
      <div className="flex w-full flex-col items-center gap-2 sm:col-start-2 sm:row-start-1">
        {status ? (
          <p role="status" className="text-center text-xs font-medium text-bone-300">
            {status}
          </p>
        ) : null}
        {main}
      </div>
      <div className="flex w-full items-center justify-between gap-3 sm:contents">
        <div className="sm:col-start-1 sm:row-start-1 sm:justify-self-start">{lead}</div>
        <div className="sm:col-start-3 sm:row-start-1 sm:justify-self-end">
          <Button size="sm" onClick={api.leaveRoom}>
            Leave room
          </Button>
        </div>
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

  // The picker is out only while there is no game yet, or once the leader
  // asks to change it: a room made from the home carousel arrives with its
  // game, and eight tiles saying so again were most of the screen.
  const [picking, setPicking] = useState(false);
  const showPicker = entry === null || picking;
  // The rules: always out on a wide screen; on a phone, folded to the one
  // line that already says them, until asked for.
  const wide = useMediaQuery("(min-width: 1024px)");
  const [rulesOpen, setRulesOpen] = useState(false);
  // Not the game's name: it is the heading right above.
  const summary = entry
    ? [
        ...summarizeSetup(entry.setup, room.settings, "room"),
        ...(entry.setup.difficulty ? [`Bots ${DIFFICULTY_NAMES[room.difficulty]}`] : []),
      ].join(" · ")
    : "";

  return (
    <Card
      title="Game"
      aside={
        entry && !locked ? (
          <button type="button" className="text-link" aria-expanded={showPicker} onClick={() => setPicking((p) => !p)}>
            {picking ? "Keep this game" : "Change game"}
          </button>
        ) : null
      }
    >
      {locked ? (
        <p className="-mt-2 text-[11px] text-bone-500">
          {room.gameRunning ? "Fixed until this game ends." : `Only ${leaderName(room)} can change these.`}
        </p>
      ) : null}

      {entry ? (
        <div className="flex items-center gap-4">
          <span aria-hidden className="grid h-14 w-12 shrink-0 place-items-center">
            <GameThumb id={entry.id} />
          </span>
          <div className="min-w-0">
            <div className="font-title text-3xl leading-none font-light tracking-tight text-bone-50">{entry.name}</div>
            <div className="caps mt-2 text-bone-500">{seatRange(entry.id)}</div>
          </div>
        </div>
      ) : null}

      <Collapse open={showPicker}>
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
                  <span className="font-title text-[15px] leading-tight font-light">{g.name}</span>
                  <span className="text-[10px] font-semibold text-bone-500">{seatRange(g.id)}</span>
                </>
              ),
            }))}
            locked={locked}
            // A new game starts on the leader's last setup for it on this
            // device, else its own defaults — the solo screen's values (the
            // user's call, 2026-09-26) — keeping only the bots' skill, which
            // is the room's taste rather than any one game's.
            onChange={(id) => {
              if (!isGameId(id)) return;
              const next = GAMES[id];
              const kept = readSavedSetup(id);
              api.selectGame(
                id,
                kept?.settings ?? defaultSettings(next.setup),
                kept?.seats ?? next.defaultSeats,
                room.difficulty,
              );
              setPicking(false);
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
        </div>
      </Collapse>

      {/* A different game's options cross-fade in rather than jumping. */}
      {entry ? (
        <Swap swapKey={entry.id}>
          <div className="flex flex-col gap-3 border-t border-bone-50/8 pt-4">
            <p className="text-xs leading-relaxed text-bone-400">{textOf(entry.setup.description, room.settings)}</p>
            {wide ? null : (
              <div className="flex items-start gap-3">
                {rulesOpen ? null : <p className="flex-1 text-sm leading-relaxed text-bone-200">{summary}</p>}
                <button
                  type="button"
                  aria-expanded={rulesOpen}
                  onClick={() => setRulesOpen((o) => !o)}
                  className="text-link ml-auto shrink-0 pt-1"
                >
                  {rulesOpen ? (locked ? "Hide" : "Done") : locked ? "Details" : "Edit rules"}
                </button>
              </div>
            )}
            <Collapse open={wide || rulesOpen}>
              {/*
                Empty seats are filled by bots, so their skill is a real setting
                in a room even when every seat has a person in it — somebody
                stepping away hands their seat to one.
              */}
              <GameOptions
                game={entry.id}
                mode="room"
                locked={locked}
                value={{
                  settings: room.settings,
                  seats: room.seats || entry.defaultSeats,
                  difficulty: room.difficulty,
                }}
                onChange={(next) => {
                  // Only the leader's device ever writes: everybody else's
                  // form is locked and cannot reach here.
                  saveSetup(entry.id, next, { keepDifficulty: true });
                  api.selectGame(entry.id, next.settings, next.seats, next.difficulty);
                }}
              />
            </Collapse>
          </div>
        </Swap>
      ) : null}
    </Card>
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
    <Card
      title="Table"
      aside={
        <span className="text-xs text-bone-400">
          {here(room)} of {room.members.length} here
        </span>
      }
    >
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

      <Roster
        members={room.members}
        you={room.you}
        youAreLeader={leader}
        plan={room.gameRunning || !hasGame ? null : room.seatPlan}
        seatCount={room.seats}
        teamsEnabled={teamsEnabled}
        teamOf={entry ? (seat) => teamIndexOf(entry.id, seat) : undefined}
        onPromote={api.promote}
        onKick={api.kick}
        onArrange={api.arrangeSeats}
        onPhoto={api.setPhoto}
      />
      {room.gameRunning ? null : hasGame ? (
        <div className="flex items-start gap-4">
          <p className="flex-1 text-[11px] leading-relaxed text-bone-500">
            Seat 1 deals first, then clockwise.
            {teamsEnabled ? (entry?.id === "mindmeld" ? " Partners sit side by side." : " Partners sit across.") : ""}
            {leader ? " Drag a row by its grip to move it." : ""}
          </p>
          {leader ? (
            <button
              type="button"
              onClick={api.shuffleSeats}
              className="text-link inline-flex shrink-0 items-center gap-1.5"
            >
              <Shuffle size={11} /> Shuffle seats
            </button>
          ) : null}
        </div>
      ) : (
        <p className="text-[11px] leading-relaxed text-bone-500">Pick a game to set up the seats.</p>
      )}

      {here(room) >= MIN_ROOM_PLAYERS ? null : <WaitingForPeople gameId={room.gameId} />}
    </Card>
  );
}

/** How the room itself runs: who may come in, and how long a turn can take. */
function RoomPanel({ api }: { api: RoomApi }) {
  const room = api.room!;
  const leader = room.youAreLeader;
  return (
    <Card title="Room">
      <div className="flex flex-col gap-2">
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
      <TurnTimerField
        timer={room.turnTimer}
        // Like the game's options: dimmed with its real values for anybody
        // but the leader, and for the leader too while a game is running.
        locked={!leader || room.gameRunning}
        onChange={api.setTurnTimer}
      />
    </Card>
  );
}

/**
 * The turn timer (the user, 2026-09-29): on in a new room at 30 seconds,
 * 5 to 60 in steps of 5. Switching it off keeps the length, so switching it
 * back on restores it.
 */
function TurnTimerField({
  timer,
  locked,
  onChange,
}: {
  timer: RoomView["turnTimer"];
  locked: boolean;
  onChange: (change: { on?: boolean; seconds?: number }) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-bold text-bone-200">Turn timer</span>
      <Toggle
        label="Time each move"
        hint={
          timer.on
            ? "Run out and a move is made for you. Twice in a row and a bot plays for you until you are back."
            : "Everyone takes as long as they like."
        }
        checked={timer.on}
        locked={locked}
        onChange={(on) => onChange({ on })}
      />
      <Collapse open={timer.on}>
        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-xs text-bone-300">Seconds per move</span>
          <NumberStepper
            value={timer.seconds}
            min={TURN_TIMER_MIN_S}
            max={TURN_TIMER_MAX_S}
            step={TURN_TIMER_STEP_S}
            label="seconds per move"
            disabled={locked}
            size="sm"
            onChange={(seconds) => onChange({ seconds })}
          />
        </div>
      </Collapse>
    </div>
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
    <div className="flex flex-col items-center gap-2 rounded-lg bg-black/25 px-4 py-3 text-center">
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
