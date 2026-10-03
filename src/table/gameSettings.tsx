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
 *
 * Most are on/off. A `choice` setting picks one of a few values instead,
 * drawn as a row of choices (Card spacing, the first).
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { InfoSheet } from "@/ui/disclosure";
import { Button } from "@/ui/primitives/Button";
import { ChoiceGroup } from "@/ui/primitives/ChoiceGroup";
import { Toggle } from "@/ui/primitives/Toggle";
import type { HandSpacing } from "./geometry";

interface SettingBase {
  key: string;
  label: string;
  /** What it changes, in a line — required, like `Toggle`'s own hint. */
  description: string;
  /** Kept once for every game rather than per game. See the file's doc. */
  shared?: boolean;
}

/** On or off. */
export interface ToggleSetting extends SettingBase {
  kind?: "toggle";
  default: boolean;
}

/** One of a few values, stored as its `value`. */
export interface ChoiceSetting extends SettingBase {
  kind: "choice";
  choices: readonly { value: string; label: string }[];
  default: string;
}

export type GameSetting = ToggleSetting | ChoiceSetting;
export type SettingValue = boolean | string;

/** Whether `value` is one this setting can hold: anything else kept is ignored. */
function fits(setting: GameSetting, value: unknown): value is SettingValue {
  return setting.kind === "choice"
    ? typeof value === "string" && setting.choices.some((c) => c.value === value)
    : typeof value === "boolean";
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

/**
 * How condensed the hand is: how much of each card shows before the hand
 * scrolls sideways instead (the user, 2026-09-29: "letting the user decide
 * how condensed they want their card hand to be"). Shared, because it is
 * about the player's phone and thumb rather than any one game, and offered
 * by every game whose hand can outgrow a phone (Spades, Rummy, BS, and
 * Dominoes' rack), where it changes something. Poker's two cards and LRC's
 * chips never fill a screen, so it would be a setting that does nothing. `HAND_FLOORS` says what each one means; the
 * default is the default floor, so a player who never opens Settings sees
 * what everybody saw before the setting existed.
 */
export const HAND_SPACING_SETTING: ChoiceSetting = {
  kind: "choice",
  key: "handSpacing",
  label: "Card spacing",
  description: "How much of each card or tile in your hand shows. More spacing scrolls sideways.",
  choices: [
    { value: "fit", label: "Fit all" },
    { value: "comfortable", label: "Comfortable" },
    { value: "roomy", label: "Roomy" },
  ] satisfies readonly { value: HandSpacing; label: string }[],
  default: "comfortable" satisfies HandSpacing,
  shared: true,
};

/** Every table has these; `GameHost` appends them to a game's own. */
export const TABLE_SETTINGS: readonly GameSetting[] = [SOUND_SETTING, VIBRATION_SETTING];

/**
 * A game's Hints switch for dimming what cannot be played (Spades and
 * Dominoes), so the description is the game's own. Per game, not shared.
 *
 * OFF by default (the user's call, 2026-09-26): working out what is
 * playable is the game, so the table does not answer it unless asked.
 * Poker's Hints means something else — it spells out its button labels
 * for a newcomer — and declares its own setting, which stays on.
 */
export function hintsSetting(description: string): GameSetting {
  return { key: "hints", label: "Hints", description, default: false };
}

export type SettingValues = Readonly<Record<string, SettingValue>>;

const storageKey = (gameId: string) => `table-games:settings:${gameId}`;

/** The bucket `shared` settings are kept in, under the same key scheme. */
const SHARED = "*";

function defaultsOf(settings: readonly GameSetting[]): Record<string, SettingValue> {
  return Object.fromEntries(settings.map((s) => [s.key, s.default]));
}

/**
 * What this device saved, per game — read from `localStorage` once, on
 * first use in the browser, and kept here so every reader gets the same
 * object until something changes. Storage can be missing or refuse (a
 * private window, blocked site data), so every access is guarded and the
 * defaults simply stand.
 */
const saved = new Map<string, Readonly<Record<string, SettingValue>>>();
const listeners = new Set<() => void>();
const NOTHING_SAVED: Readonly<Record<string, SettingValue>> = {};

function savedFor(gameId: string): Readonly<Record<string, SettingValue>> {
  let values = saved.get(gameId);
  if (values) return values;
  const loaded: Record<string, SettingValue> = {};
  try {
    const raw = window.localStorage.getItem(storageKey(gameId));
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "boolean" || typeof value === "string") loaded[key] = value;
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
): [SettingValues, (key: string, value: SettingValue) => void] {
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
      if (fits(s, bucket[s.key])) out[s.key] = bucket[s.key]!;
    }
    return out;
  }, [settings, kept, keptShared]);

  const set = useCallback(
    (key: string, value: SettingValue) => {
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
 * The way out of a game played on this device, at the foot of its Settings
 * sheet: back to the game's setup screen, where "← Back" goes home.
 *
 * There was none (the user, 2026-09-27). A solo game could be left only by
 * finishing it or by the browser's back button. Asked twice, because
 * nothing is saved; the first press says what the second one does. The
 * question closes with the sheet, which unmounts what is in it.
 *
 * A room's leader ends the game for EVERYONE, and settles up a game played
 * for money, so their button asks too — in the Settings sheet and in the
 * lobby — with its own words (`label`, `question`, `note`) and look (`tone`,
 * `size`). Closing a room asks the same way, in its own words again
 * (`confirmLabel`, `cancelLabel`).
 */
export function EndGameAction({
  onEnd,
  label = "End game",
  question = "End this game?",
  note = "It is not saved.",
  confirmLabel = "End game",
  cancelLabel = "Keep playing",
  tone,
  size,
}: {
  onEnd: () => void;
  label?: string;
  question?: string;
  note?: string;
  /** The button that does it, once asked. */
  confirmLabel?: string;
  /** The button that thinks better of it. */
  cancelLabel?: string;
  tone?: "danger";
  size?: "sm";
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button tone={tone} size={size} onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  }
  return (
    <div role="group" aria-label={question} className="flex flex-col gap-2">
      <p className="text-center text-xs text-bone-300">
        {question} {note}
      </p>
      <div className="flex gap-2">
        <Button size={size} className="flex-1" onClick={() => setAsking(false)}>
          {cancelLabel}
        </Button>
        <Button tone="danger" size={size} className="flex-1" onClick={onEnd}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * The sheet itself: a toggle or a row of choices per setting, then any `actions` (an online
 * table's Step away and End game, a solo game's `EndGameAction`). Rung 5 —
 * dismissible, never blocking.
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
  onChange: (key: string, value: SettingValue) => void;
  actions?: React.ReactNode;
}) {
  return (
    // From the right, where the Settings button sits.
    <InfoSheet open={open} title="Settings" onClose={onClose} side="right">
      <div className="flex flex-col gap-3">
        {settings.map((s) =>
          s.kind === "choice" ? (
            <ChoiceSettingRow key={s.key} setting={s} value={values[s.key]} onChange={(v) => onChange(s.key, v)} />
          ) : (
            <Toggle
              key={s.key}
              label={s.label}
              hint={s.description}
              checked={typeof values[s.key] === "boolean" ? (values[s.key] as boolean) : s.default}
              onChange={(v) => onChange(s.key, v)}
            />
          ),
        )}
        {actions ? (
          <div className="mt-2 flex flex-col gap-2 border-t border-bone-50/10 pt-4">{actions}</div>
        ) : null}
      </div>
    </InfoSheet>
  );
}

/** A `choice` setting in the sheet: its name, the row of choices, what it does. */
function ChoiceSettingRow({
  setting,
  value,
  onChange,
}: {
  setting: ChoiceSetting;
  value: SettingValue | undefined;
  onChange: (value: string) => void;
}) {
  const current = typeof value === "string" ? value : setting.default;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-semibold text-bone-100">{setting.label}</span>
      <ChoiceGroup label={setting.label} size="sm" fill value={current} options={setting.choices} onChange={onChange} />
      <span className="text-xs text-bone-400">{setting.description}</span>
    </div>
  );
}
