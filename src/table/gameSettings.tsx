"use client";

/**
 * Settings a player can change DURING a game — as opposed to a setup
 * screen's options, which are the rules of the match and are fixed once it
 * is dealt.
 *
 * These are the player's own preferences about how the table talks to
 * them (Poker's hints, first), so they are per person and per device:
 * kept in `localStorage`, never sent to the server, and never part of the
 * game's state. Two people at one online table can have different ones.
 *
 * Every game gets the mechanism through `GameHost`; a game opts in by
 * passing `settings`. A game with none shows no Settings button at all,
 * rather than an empty sheet.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { InfoSheet } from "@/ui/disclosure";
import { Toggle } from "@/ui/primitives/Toggle";

export interface GameSetting {
  key: string;
  label: string;
  /** What it changes, in a line — required, like `Toggle`'s own hint. */
  description: string;
  default: boolean;
}

export type SettingValues = Readonly<Record<string, boolean>>;

const storageKey = (gameId: string) => `table-games:settings:${gameId}`;

function defaultsOf(settings: readonly GameSetting[]): Record<string, boolean> {
  return Object.fromEntries(settings.map((s) => [s.key, s.default]));
}

/**
 * What this device saved, per game — read from `localStorage` once, on
 * first use in the browser, and kept here so every reader gets the same
 * object until something changes. Storage can be missing or refuse (a
 * private window, blocked site data), so every access is guarded and the
 * defaults simply stand.
 */
const saved = new Map<string, Readonly<Record<string, boolean>>>();
const listeners = new Set<() => void>();
const NOTHING_SAVED: Readonly<Record<string, boolean>> = {};

function savedFor(gameId: string): Readonly<Record<string, boolean>> {
  let values = saved.get(gameId);
  if (values) return values;
  const loaded: Record<string, boolean> = {};
  try {
    const raw = window.localStorage.getItem(storageKey(gameId));
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") loaded[key] = value;
    }
  } catch {
    /* Unreadable storage: nothing saved. */
  }
  values = loaded;
  saved.set(gameId, values);
  return values;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The current values, and a setter.
 *
 * `useSyncExternalStore` rather than state plus an effect: the page is
 * server-rendered first and the server has no `localStorage`, so the
 * server snapshot is "nothing saved" (the defaults) and the browser's is
 * whatever this device kept — React reconciles the two itself.
 */
export function useGameSettings(
  gameId: string,
  settings: readonly GameSetting[] = [],
): [SettingValues, (key: string, value: boolean) => void] {
  const kept = useSyncExternalStore(
    subscribe,
    () => savedFor(gameId),
    () => NOTHING_SAVED,
  );
  const values = useMemo(() => ({ ...defaultsOf(settings), ...kept }), [settings, kept]);

  const set = useCallback(
    (key: string, value: boolean) => {
      const next = { ...savedFor(gameId), [key]: value };
      saved.set(gameId, next);
      try {
        window.localStorage.setItem(storageKey(gameId), JSON.stringify(next));
      } catch {
        /* Not kept beyond this page; still applied. */
      }
      for (const listener of listeners) listener();
    },
    [gameId],
  );

  return [values, set];
}

/** The sheet itself: one toggle per setting. Rung 5 — dismissible, never blocking. */
export function SettingsSheet({
  open,
  onClose,
  settings,
  values,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  settings: readonly GameSetting[];
  values: SettingValues;
  onChange: (key: string, value: boolean) => void;
}) {
  return (
    // From the right, where the Settings button sits.
    <InfoSheet open={open} title="Settings" onClose={onClose} side="right">
      <div className="flex flex-col gap-3">
        {settings.map((s) => (
          <Toggle
            key={s.key}
            label={s.label}
            hint={s.description}
            checked={values[s.key] ?? s.default}
            onChange={(v) => onChange(s.key, v)}
          />
        ))}
      </div>
    </InfoSheet>
  );
}
