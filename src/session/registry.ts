/**
 * The catalogue of games a room can play.
 *
 * Two things did not exist before multiplayer and both are needed here.
 * The first is a machine-readable list at all: the home screen is six
 * hand-written `<Link>`s and every seat bound is a `const` inside its own
 * play page, which is fine when a human picks the game and unworkable
 * when a lobby has to offer the choice, validate what came back off a
 * socket, and know whether teams even apply.
 *
 * The second is `settings.parse`. Offline, a game's options come from its
 * own setup screen and are trustworthy by construction. Online they
 * arrive from a client, so every one of them has to be clamped before it
 * reaches a factory — a seat count of `-1` or a starting stack of
 * `Infinity` is a crash or a hang, not a rules question.
 */

import type { BotDifficulty, GameDefinition } from "@/engine/types";
import { createBs } from "@/games/bs/rules";
import { createDominoes } from "@/games/dominoes/rules";
import { createLrc } from "@/games/lrc/rules";
import { createPoker } from "@/games/poker/rules";
import { createRummy } from "@/games/rummy/rules";
import { createSpades } from "@/games/spades/rules";
import { GAME_SETUPS, parseSettings, type GameSetupSpec } from "./gameSetup";

export type GameId = "spades" | "dominoes" | "poker" | "lrc" | "rummy" | "bs";

// Also the order the home screen lists them in.
export const GAME_IDS: readonly GameId[] = [
  "spades",
  "dominoes",
  "poker",
  "lrc",
  "rummy",
  "bs",
];

/** Loose bag off the wire, before `parse` has had a look at it. */
export type RawSettings = Record<string, unknown>;

export interface GameEntry {
  id: GameId;
  name: string;
  minSeats: number;
  maxSeats: number;
  defaultSeats: number;
  /**
   * The options this game asks for — the one description the solo setup
   * screen, the lobby and `parse` all read (`gameSetup.ts`).
   */
  setup: GameSetupSpec;
  /**
   * Whether this game is playable in a ROOM.
   *
   * `src/room/tables.test.tsx` holds this list and the room's table
   * registry together, so a game can never be offered that the client
   * cannot actually draw.
   *
   * All five are true now. Rummy was the last, and the reason it took
   * longest is worth keeping: its blockers were rules-level, not wiring.
   * `currentSeat` returned `HERO` outright during a claim window,
   * `startRound` branched on `dealer === HERO`, and the claim race was
   * timed by a `setTimeout` in the play page — none of which a server
   * could adjudicate. See `openClaimWindow` for how the race became a
   * property of state instead.
   */
  online: boolean;
  /** Whether the lobby should offer team assignment for this game. */
  teams: (settings: RawSettings) => boolean;
  /** Clamps whatever arrived off the wire into something safe to build —
   * from `setup`'s own ranges and defaults, so the form cannot drift from it. */
  parse: (raw: RawSettings) => RawSettings;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  create: (settings: RawSettings) => GameDefinition<any, any>;
}

export const GAMES: Record<GameId, GameEntry> = {
  spades: {
    id: "spades",
    name: "Spades",
    minSeats: 4,
    maxSeats: 4,
    defaultSeats: 4,
    setup: GAME_SETUPS.spades,
    online: true,
    // Always partners across; the lobby can assign who sits with whom.
    teams: () => true,
    parse: (raw) => parseSettings(GAME_SETUPS.spades, raw),
    create: (s) =>
      createSpades({
        jokers: s.jokers as boolean,
        twoOfSpadesHigh: s.twoOfSpadesHigh as boolean,
      }),
  },

  dominoes: {
    id: "dominoes",
    name: "Dominoes",
    minSeats: 2,
    maxSeats: 4,
    // Block & Draw's own default; Caribbean is always four (`seatBounds`).
    defaultSeats: 3,
    setup: GAME_SETUPS.dominoes,
    online: true,
    teams: (s) => s.mode === "caribbean" && s.teams === true,
    // Caribbean's target is `games` (games won), Block & Draw's is `target`
    // (pips) — see the spec. A sender from before the split said `target`
    // for both, so a Caribbean `target` with no `games` still means games.
    parse: (raw) =>
      parseSettings(
        GAME_SETUPS.dominoes,
        raw.mode === "caribbean" && raw.games === undefined && raw.target !== undefined
          ? { ...raw, games: raw.target, target: undefined }
          : raw,
      ),
    create: (s) =>
      createDominoes({
        mode: s.mode as "classic" | "caribbean",
        teams: s.teams as boolean,
        keyTileBonus: s.keyTileBonus as boolean,
        sixLove: s.sixLove as boolean,
        target: (s.mode === "caribbean" ? s.games : s.target) as number,
      }),
  },

  poker: {
    id: "poker",
    name: "Poker",
    minSeats: 2,
    maxSeats: 10,
    defaultSeats: 6,
    setup: GAME_SETUPS.poker,
    online: true,
    teams: () => false,
    parse: (raw) => parseSettings(GAME_SETUPS.poker, raw),
    create: (s) => createPoker(s.startingStack as number, s.bigBlind as number),
  },

  lrc: {
    id: "lrc",
    name: "Left Right Center",
    minSeats: 3,
    maxSeats: 10,
    defaultSeats: 6,
    setup: GAME_SETUPS.lrc,
    online: true,
    teams: () => false,
    parse: (raw) => parseSettings(GAME_SETUPS.lrc, raw),
    create: (s) => createLrc(s.target as number),
  },

  rummy: {
    id: "rummy",
    name: "Rummy 500",
    minSeats: 2,
    maxSeats: 6,
    defaultSeats: 4,
    setup: GAME_SETUPS.rummy,
    online: true,
    teams: () => false,
    parse: (raw) => parseSettings(GAME_SETUPS.rummy, raw),
    create: (s) => createRummy({ target: s.target as number }),
  },

  bs: {
    id: "bs",
    name: "BS",
    minSeats: 2,
    maxSeats: 6,
    defaultSeats: 4,
    setup: GAME_SETUPS.bs,
    online: true,
    teams: () => false,
    // The challenge window is clamped hard at both ends by the spec: a
    // window of zero makes the game unplayable and one of an hour parks
    // the table.
    parse: (raw) => parseSettings(GAME_SETUPS.bs, raw),
    create: (s) =>
      createBs({ target: s.target as number, windowMs: s.windowMs as number }),
  },
};

export function gameEntry(id: GameId): GameEntry {
  return GAMES[id];
}

/**
 * The seats a game can really be played with under these settings.
 *
 * Usually just the entry's bounds, but a ruleset can pin them: Caribbean
 * dominoes is four-handed, full stop, while the entry says 2–4 because
 * Block & Draw is. A room set to three seats therefore started a session
 * the engine dealt FOUR hands into, and the fourth seat played on with no
 * pod and its tiles stacked in a corner. So the answer comes from the
 * definition itself — the thing that deals the hands — never from a copy.
 */
export function seatBounds(id: GameId, settings: RawSettings): { min: number; max: number } {
  const entry = GAMES[id];
  const definition = entry.create(entry.parse(settings));
  return {
    min: Math.max(entry.minSeats, definition.minSeats),
    max: Math.min(entry.maxSeats, definition.maxSeats),
  };
}

/** `seats` pulled inside `seatBounds`. `NaN` stays `NaN`, for the caller to refuse. */
export function clampSeats(id: GameId, settings: RawSettings, seats: number): number {
  const { min, max } = seatBounds(id, settings);
  return Math.min(max, Math.max(min, seats));
}

export function isGameId(v: unknown): v is GameId {
  return typeof v === "string" && (GAME_IDS as readonly string[]).includes(v);
}

/** The games a room may actually select. */
export function onlineGames(): GameEntry[] {
  return GAME_IDS.map((id) => GAMES[id]).filter((g) => g.online);
}

export function isDifficulty(v: unknown): v is BotDifficulty {
  return v === "casual" || v === "steady" || v === "sharp";
}
