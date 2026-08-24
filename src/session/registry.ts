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
import { createDominoes } from "@/games/dominoes/rules";
import { createLrc } from "@/games/lrc/rules";
import { createPoker } from "@/games/poker/rules";
import { createRummy } from "@/games/rummy/rules";
import { createSpades } from "@/games/spades/rules";

export type GameId = "spades" | "dominoes" | "poker" | "lrc" | "rummy";

export const GAME_IDS: readonly GameId[] = ["spades", "dominoes", "poker", "lrc", "rummy"];

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
   * Two different things make this false. Dominoes and LRC have no
   * online TABLE yet — the engine and the server handle them fine, but a
   * room could not draw them, so offering them would deal a real game onto
   * a screen showing a different one. `src/room/tables.test.tsx` holds the
   * two lists together so that cannot silently happen again.
   *
   * Rummy 500 is false for a deeper reason, and will stay false longer:
   * `currentSeat` returns `HERO` outright while a claim window is open,
   * `startRound` branches on `dealer === HERO`, and the claim race is
   * timed by a `setTimeout` in the play page rather than by anything the
   * server could adjudicate. Those are rules-level seat-0 assumptions, not
   * a wiring gap. It stays fully playable offline.
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
    online: false,
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
    online: false,
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
    online: false,
    teams: () => false,
    parse: (raw) => ({ target: int(raw.target, 100, 2_000, 500) }),
    create: (s) => createRummy({ target: s.target as number }),
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
