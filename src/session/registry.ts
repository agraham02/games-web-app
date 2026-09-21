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
import { CHALLENGE_MS_ONLINE, DEFAULT_TARGET as BS_DEFAULT_TARGET } from "@/games/bs/state";
import { createDominoes } from "@/games/dominoes/rules";
import { createLrc } from "@/games/lrc/rules";
import { createPoker } from "@/games/poker/rules";
import { createRummy } from "@/games/rummy/rules";
import { createSpades } from "@/games/spades/rules";

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
  /** Clamps whatever arrived off the wire into something safe to build. */
  parse: (raw: RawSettings) => RawSettings;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  create: (settings: RawSettings) => GameDefinition<any, any>;
}

/* ============================================================
   Coercion helpers — every one of these assumes hostile input.
   ============================================================ */

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/**
 * A finite integer inside [min, max]. `Number.isFinite` is the load-bearing
 * part: `NaN` and `Infinity` both survive a naive `typeof v === "number"`
 * and both turn a target score into a match that never ends.
 */
function int(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export const GAMES: Record<GameId, GameEntry> = {
  spades: {
    id: "spades",
    name: "Spades",
    minSeats: 4,
    maxSeats: 4,
    defaultSeats: 4,
    online: true,
    // Always partners across; the lobby can assign who sits with whom.
    teams: () => true,
    parse: (raw) => ({
      jokers: bool(raw.jokers, false),
      twoOfSpadesHigh: bool(raw.twoOfSpadesHigh, false),
    }),
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
    defaultSeats: 4,
    online: true,
    teams: (s) => s.mode === "caribbean" && s.teams === true,
    parse: (raw) => {
      const mode = pick(raw.mode, ["classic", "caribbean"] as const, "classic");
      const caribbean = mode === "caribbean";
      return {
        mode,
        // Caribbean is a four-hand partnership game; the team flag is only
        // meaningful there.
        teams: caribbean ? bool(raw.teams, true) : false,
        keyTileBonus: caribbean ? bool(raw.keyTileBonus, true) : false,
        sixLove: caribbean ? bool(raw.sixLove, false) : false,
        target: int(raw.target, 1, 500, caribbean ? 6 : 100),
      };
    },
    create: (s) => createDominoes(s),
  },

  poker: {
    id: "poker",
    name: "Poker",
    minSeats: 2,
    maxSeats: 10,
    defaultSeats: 6,
    online: true,
    teams: () => false,
    parse: (raw) => ({
      startingStack: int(raw.startingStack, 100, 100_000, 5_000),
      bigBlind: int(raw.bigBlind, 2, 1_000, 50),
    }),
    create: (s) => createPoker(s.startingStack as number, s.bigBlind as number),
  },

  lrc: {
    id: "lrc",
    name: "Left Right Center",
    minSeats: 3,
    maxSeats: 10,
    defaultSeats: 6,
    online: true,
    teams: () => false,
    parse: (raw) => ({ target: int(raw.target, 1, 20, 3) }),
    create: (s) => createLrc(s.target as number),
  },

  rummy: {
    id: "rummy",
    name: "Rummy 500",
    minSeats: 2,
    maxSeats: 6,
    defaultSeats: 4,
    online: true,
    teams: () => false,
    parse: (raw) => ({ target: int(raw.target, 100, 2_000, 500) }),
    create: (s) => createRummy({ target: s.target as number }),
  },

  bs: {
    id: "bs",
    name: "BS",
    minSeats: 2,
    maxSeats: 6,
    defaultSeats: 4,
    online: true,
    teams: () => false,
    parse: (raw) => ({
      target: int(raw.target, 1, 9, BS_DEFAULT_TARGET),
      // A room gets a longer challenge window than a solo table, and this is
      // where that difference lives. It is generous because online the next
      // player can cut a window short simply by playing, so the only person
      // it costs anything is the one who chooses to use all of it. Clamped
      // hard at both ends: a window of zero makes the game unplayable and one
      // of an hour parks the table.
      windowMs: int(raw.windowMs, 2_000, 20_000, CHALLENGE_MS_ONLINE),
    }),
    create: (s) =>
      createBs({ target: s.target as number, windowMs: s.windowMs as number }),
  },
};

export function gameEntry(id: GameId): GameEntry {
  return GAMES[id];
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
