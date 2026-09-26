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
 * Every game gets the mechanism through `GameHost`, and with it the
 * `TABLE_SETTINGS` every table shares (Sound and Vibration). A game adds its
 * own by passing `settings` — `hintsSetting` where hints change something.
 *
 * A `shared` setting is kept once for the whole app rather than per game:
 * turning the sound off at one table and finding it on at the next would
 * be a setting that did not stick.
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
  /** Kept once for every game rather than per game. See the file's doc. */
  shared?: boolean;
}

/** The slam's thud (Dominoes, and a caught liar in BS). */
export const SOUND_SETTING: GameSetting = {
  key: "sound",
  label: "Sound",
  description: "Sound effects, like the table slam.",
  default: true,
  shared: true,
};

/** Shakes the device with the slam, where the browser can. */
export const VIBRATION_SETTING: GameSetting = {
  key: "vibration",
  label: "Vibration",
  description: "Shake the device with the table slam, on phones that support it.",
  default: true,
  shared: true,
};

/** Every table has these; `GameHost` appends them to a game's own. */
export const TABLE_SETTINGS: readonly GameSetting[] = [SOUND_SETTING, VIBRATION_SETTING];

/**
 * A game's Hints switch. What hints MEAN is the game's own (Poker spells
 * out its labels; Spades and Dominoes dim what cannot be played), so the
 * description is too. Per game, not shared.
 */
export function hintsSetting(description: string): GameSetting {
  return { key: "hints", label: "Hints", description, default: true };
}

export type SettingValues = Readonly<Record<string, boolean>>;

const storageKey = (gameId: string) => `table-games:settings:${gameId}`;

/** The bucket `shared` settings are kept in, under the same key scheme. */
const SHARED = "*";

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
  const keptShared = useSyncExternalStore(
    subscribe,
    () => savedFor(SHARED),
    () => NOTHING_SAVED,
  );
  const values = useMemo(() => {
    const out = defaultsOf(settings);
    for (const s of settings) {
      const bucket = s.shared ? keptShared : kept;
      if (s.key in bucket) out[s.key] = bucket[s.key]!;
    }
    return out;
  }, [settings, kept, keptShared]);

  const set = useCallback(
    (key: string, value: boolean) => {
      const bucket = settings.find((s) => s.key === key)?.shared ? SHARED : gameId;
      const next = { ...savedFor(bucket), [key]: value };
      saved.set(bucket, next);
      try {
        window.localStorage.setItem(storageKey(bucket), JSON.stringify(next));
      } catch {
        /* Not kept beyond this page; still applied. */
      }
      for (const listener of listeners) listener();
    },
    [gameId, settings],
  );

  return [values, set];
}

/**
 * The sheet itself: one toggle per setting, then any `actions` (an online
 * table's Step away and End game). Rung 5 — dismissible, never blocking.
 */
export function SettingsSheet({
  open,
  onClose,
  settings,
  values,
  onChange,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  settings: readonly GameSetting[];
  values: SettingValues;
  onChange: (key: string, value: boolean) => void;
  actions?: React.ReactNode;
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
        {actions ? (
          <div className="mt-2 flex flex-col gap-2 border-t border-bone-50/10 pt-4">{actions}</div>
        ) : null}
      </div>
    </InfoSheet>
  );
}
