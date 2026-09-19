"use client";

/**
 * The lobby.
 *
 * Composed almost entirely from what the setup screens already use —
 * `SetupShell` (whose `maxWidth` prop is documented "widen for content
 * that is a list", written before any list existed), `Toggle`,
 * `NumberStepper`, `DifficultyPicker`. The genuinely new parts are the
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
import type { BotDifficulty } from "@/engine/types";
import { GAMES, GAME_IDS, onlineGames, type GameId } from "@/session/registry";
import { MIN_ROOM_PLAYERS } from "@/session/room";
import { Button } from "@/ui/primitives/Button";
import { DifficultyPicker, type DifficultyBlurbs } from "@/ui/primitives/DifficultyPicker";
import { NumberStepper } from "@/ui/primitives/NumberStepper";
import { SetupShell } from "@/ui/primitives/SetupShell";
import { Toggle } from "@/ui/primitives/Toggle";
import type { RoomApi } from "./useRoom";
import { Roster } from "./Roster";

const BLURBS: DifficultyBlurbs = {
  casual: "Opponents play honestly and miss things.",
  steady: "Opponents count what has gone and play the odds.",
  sharp: "Opponents read the table and punish mistakes.",
};

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
          teamsEnabled={teamsEnabled}
          onPromote={api.promote}
          onKick={api.kick}
          onAssignTeam={api.assignTeam}
        />
        {teamsEnabled && leader ? (
          <Button size="sm" onClick={api.randomizeTeams} className="self-start">
            <Shuffle size={12} /> Shuffle teams
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
              <Button size="sm" onClick={() => api.deny(p.session)}>
                <X size={12} />
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
  const leader = room.youAreLeader;
  const games = onlineGames();
  const offline = GAME_IDS.map((id) => GAMES[id]).filter((g) => !g.online);
  const entry = room.gameId ? GAMES[room.gameId] : null;

  const update = (gameId: GameId, settings = room.settings, seats = room.seats, diff = room.difficulty) =>
    api.selectGame(gameId, settings, seats, diff);

  return (
    <section className="flex w-full flex-col gap-3">
      <span className="eyebrow">Game</span>

      <div className="flex flex-wrap gap-2">
        {games.map((g) => (
          <button
            key={g.id}
            type="button"
            disabled={!leader}
            onClick={() => update(g.id, {}, g.defaultSeats)}
            className={`rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              room.gameId === g.id
                ? "bg-brass-400 text-felt-950"
                : "bg-bone-50/6 text-bone-300 ring-1 ring-bone-50/16"
            }`}
          >
            {g.name}
          </button>
        ))}
      </div>
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
        <div className="flex w-full flex-col gap-3">
          {entry.minSeats !== entry.maxSeats ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-bone-200">Seats</span>
              <NumberStepper
                value={room.seats || entry.defaultSeats}
                min={entry.minSeats}
                max={entry.maxSeats}
                onChange={(v) => leader && update(entry.id, room.settings, v)}
                label="seats"
              />
            </div>
          ) : null}

          {entry.id === "lrc" ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-bone-200">Rounds to win</span>
              <NumberStepper
                value={(room.settings.target as number) ?? 3}
                min={1}
                max={20}
                onChange={(v) => leader && update(entry.id, { ...room.settings, target: v })}
                label="rounds to win"
              />
            </div>
          ) : null}

          {entry.id === "dominoes" ? (
            <>
              <div className="flex flex-wrap gap-2">
                {(["classic", "caribbean"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    disabled={!leader}
                    onClick={() =>
                      update(entry.id, { ...room.settings, mode }, mode === "caribbean" ? 4 : room.seats)
                    }
                    className={`rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      (room.settings.mode ?? "classic") === mode
                        ? "bg-brass-400 text-felt-950"
                        : "bg-bone-50/6 text-bone-300 ring-1 ring-bone-50/16"
                    }`}
                  >
                    {mode === "classic" ? "Block & Draw" : "Caribbean"}
                  </button>
                ))}
              </div>
              {room.settings.mode === "caribbean" ? (
                <>
                  <Toggle
                    label="Teams"
                    hint="Partners across the table — seats 1 and 3 against 2 and 4."
                    checked={room.settings.teams === true}
                    disabled={!leader}
                    onChange={(v) => update(entry.id, { ...room.settings, teams: v })}
                  />
                  <Toggle
                    label="Key tile bonus"
                    hint="Going out on the only tile that could have been played is worth two games."
                    checked={room.settings.keyTileBonus === true}
                    disabled={!leader}
                    onChange={(v) => update(entry.id, { ...room.settings, keyTileBonus: v })}
                  />
                  <Toggle
                    label="Six love"
                    hint="Your score returns to zero whenever the other side takes a round."
                    checked={room.settings.sixLove === true}
                    disabled={!leader}
                    onChange={(v) => update(entry.id, { ...room.settings, sixLove: v })}
                  />
                </>
              ) : null}
            </>
          ) : null}

          {entry.id === "poker" ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-bone-200">Starting stack</span>
                <NumberStepper
                  value={(room.settings.startingStack as number) ?? 5000}
                  min={100}
                  max={100_000}
                  step={500}
                  onChange={(v) =>
                    leader && update(entry.id, { ...room.settings, startingStack: v })
                  }
                  label="starting stack"
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-bone-200">Big blind</span>
                <NumberStepper
                  value={(room.settings.bigBlind as number) ?? 50}
                  min={2}
                  max={1000}
                  step={10}
                  onChange={(v) => leader && update(entry.id, { ...room.settings, bigBlind: v })}
                  label="big blind"
                />
              </div>
            </>
          ) : null}

          {entry.id === "spades" ? (
            <>
              <Toggle
                label="Jokers"
                hint="Two jokers replace the twos, and beat every spade."
                checked={room.settings.jokers === true}
                disabled={!leader}
                onChange={(v) => update(entry.id, { ...room.settings, jokers: v })}
              />
              <Toggle
                label="Two of spades high"
                hint="The two of spades outranks the ace."
                checked={room.settings.twoOfSpadesHigh === true}
                disabled={!leader}
                onChange={(v) => update(entry.id, { ...room.settings, twoOfSpadesHigh: v })}
              />
            </>
          ) : null}

          {/*
            Empty seats are filled by bots, so difficulty is a real setting
            in a room even when every seat has a person in it — somebody
            stepping away hands their seat to one.
          */}
          <DifficultyPicker
            value={room.difficulty}
            blurbs={BLURBS}
            label="Bots filling empty seats"
            onChange={(v: BotDifficulty) =>
              leader && update(entry.id, room.settings, room.seats, v)
            }
          />
        </div>
      ) : null}
    </section>
  );
}
