/**
 * A setup the player has used before, remembered on this device.
 *
 * Every game's setup used to start from the defaults on every visit, which
 * for a game with a dozen optional rules means setting the same dozen again
 * each time. Kept in `localStorage`, per game, never sent anywhere: a room's
 * leader seeds the lobby from their own device's copy (`Lobby.tsx`).
 *
 * The same shape as `table/gameSettings.tsx` on purpose — a module-level
 * cache read once and `useSyncExternalStore`, rather than state plus an
 * effect. The page is server-rendered first and the server has no
 * `localStorage`, so its snapshot is "nothing saved"; React reconciles that
 * with the browser's. Storage can also be missing or refuse (a private
 * window), so an in-memory copy stands in and the page still behaves.
 *
 * What is kept is never trusted. A save may be from an older version of the
 * game's options, or edited by hand, so everything read goes back through
 * the game's own `parse` and the seat bounds — the same clamps a message off
 * a socket gets.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { defaultSettings, type Settings } from "@/session/gameSetup";
import { GAMES, clampSeats, isDifficulty, isGameId, type GameId } from "@/session/registry";
import type { SetupValue } from "./GameOptions";

const storageKey = (game: GameId) => `table-games:setup:${game}`;

/** What a new setup starts on: the spec's defaults, the entry's seats. */
export function defaultSetup(game: GameId): SetupValue {
  const entry = GAMES[game];
  return { settings: defaultSettings(entry.setup), seats: entry.defaultSeats, difficulty: "steady" };
}

/**
 * Whatever was saved, made safe to build a game from.
 *
 * Starts from the defaults so an option added since the save simply takes its
 * default, then lets `parse` clamp the rest. A `volatile` option is never
 * taken from a save at all.
 */
export function sanitizeSetup(game: GameId, raw: unknown): SetupValue {
  const entry = GAMES[game];
  const base = defaultSetup(game);
  if (typeof raw !== "object" || raw === null) return base;
  const saved = raw as { settings?: unknown; seats?: unknown; difficulty?: unknown };

  const kept: Record<string, unknown> = { ...base.settings };
  if (typeof saved.settings === "object" && saved.settings !== null) {
    const incoming = saved.settings as Settings;
    for (const option of entry.setup.options) {
      if (!option.volatile && option.key in incoming) kept[option.key] = incoming[option.key];
    }
    // A rule added since the save takes the value of the preset the save
    // names, not the option's own default: a saved Crazy is still Crazy when
    // Crazy gains a rule (the user's own save, 2026-10-30).
    const p = entry.setup.presets;
    const named = p && typeof kept[p.key] === "string" ? p.values[kept[p.key] as string] : undefined;
    if (named) {
      for (const [key, value] of Object.entries(named)) if (!(key in incoming)) kept[key] = value;
    }
  }
  const settings = entry.parse(kept);
  const seats =
    typeof saved.seats === "number" && Number.isFinite(saved.seats)
      ? clampSeats(game, settings, Math.round(saved.seats))
      : base.seats;
  return {
    settings,
    seats,
    difficulty: isDifficulty(saved.difficulty) ? saved.difficulty : base.difficulty,
  };
}

/** True when `value` is what a new setup would start on. */
export function isDefaultSetup(game: GameId, value: SetupValue): boolean {
  const now = sanitizeSetup(game, value);
  const fresh = defaultSetup(game);
  return (
    now.seats === fresh.seats &&
    now.difficulty === fresh.difficulty &&
    GAMES[game].setup.options.every((o) => (now.settings[o.key] ?? o.default) === (fresh.settings[o.key] ?? o.default))
  );
}

/* ============================================================
   Storage
   ============================================================ */

/** The JSON each game was saved as — read once, then the source of truth. */
const kept = new Map<GameId, string | null>();
const listeners = new Set<() => void>();

function rawFor(game: GameId): string | null {
  if (!kept.has(game)) {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(storageKey(game));
    } catch {
      /* Unreadable storage: nothing saved. */
    }
    kept.set(game, raw);
  }
  return kept.get(game) ?? null;
}

function parseRaw(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function write(game: GameId, value: SetupValue | null): void {
  const json = value ? JSON.stringify(value) : null;
  kept.set(game, json);
  try {
    if (json) window.localStorage.setItem(storageKey(game), json);
    else window.localStorage.removeItem(storageKey(game));
  } catch {
    /* Not kept beyond this page; still applied. */
  }
  for (const listener of listeners) listener();
}

/** The saved setup for a game on this device, or null. Browser only. */
export function readSavedSetup(game: string): SetupValue | null {
  if (!isGameId(game)) return null;
  const raw = parseRaw(rawFor(game));
  return raw === null ? null : sanitizeSetup(game, raw);
}

/**
 * Remember a setup. `keepDifficulty` is for the lobby, whose bots' skill is
 * the room's taste rather than the game's — it saves the rules and the seats
 * and leaves the solo difficulty as it was.
 */
export function saveSetup(game: GameId, value: SetupValue, opts: { keepDifficulty?: boolean } = {}): void {
  const next = sanitizeSetup(game, value);
  if (opts.keepDifficulty) next.difficulty = readSavedSetup(game)?.difficulty ?? next.difficulty;
  write(game, next);
}

/** Forget a game's saved setup; the next one starts on the defaults. */
export function forgetSetup(game: GameId): void {
  write(game, null);
}

/** Test seam: drop the in-memory copy so the next read goes to storage. */
export function resetSavedSetupCache(): void {
  kept.clear();
}

/**
 * A game's setup on this device: what was saved, else the defaults. Writing
 * saves it. The server snapshot is the defaults, so the first paint matches
 * what the server rendered.
 */
export function useSavedSetup(game: GameId): [SetupValue, (next: SetupValue) => void] {
  const raw = useSyncExternalStore(
    subscribe,
    () => rawFor(game),
    () => null,
  );
  const value = useMemo(() => {
    const parsed = parseRaw(raw);
    return parsed === null ? defaultSetup(game) : sanitizeSetup(game, parsed);
  }, [game, raw]);
  const set = useCallback((next: SetupValue) => saveSetup(game, next), [game]);
  return [value, set];
}
