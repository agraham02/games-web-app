"use client";

/**
 * A game's options, drawn from its spec (`session/gameSetup.ts`) — the
 * same component on the solo setup screen and in a room's lobby.
 *
 * The two used to be separate screens that drifted: different labels,
 * different order, different controls for the same question (a slider for
 * players alone, a stepper for seats in a room), different defaults, and
 * options one had that the other did not. What legitimately differs is a
 * parameter: `mode` (BS's challenge window exists only in a room) and
 * `locked` (anyone but a room's leader sees the real values and cannot
 * change them).
 *
 * Always in the same order, so a player who has set up one game has
 * learned where everything is in the others: the ruleset, the players,
 * the match (targets, stakes), the optional rules, and the bots.
 */

import { useMemo } from "react";
import type { BotDifficulty } from "@/engine/types";
import {
  isAvailable,
  isVisible,
  textOf,
  withOption,
  type ChoiceOption,
  type NumberOption,
  type OptionSpec,
  type SetupMode,
  type ToggleOption,
} from "@/session/gameSetup";
import { GAMES, seatBounds, type GameId } from "@/session/registry";
import { ChoiceGroup } from "@/ui/primitives/ChoiceGroup";
import { DifficultyPicker } from "@/ui/primitives/DifficultyPicker";
import { NumberStepper } from "@/ui/primitives/NumberStepper";
import { SeatsSlider, SetupField } from "@/ui/primitives/SetupField";
import { Toggle } from "@/ui/primitives/Toggle";
import { cn } from "@/lib/utils";
import { Collapse } from "@/ui/motion";

/** Everything a game is set up with before the deal. */
export interface SetupValue {
  settings: Readonly<Record<string, unknown>>;
  seats: number;
  difficulty: BotDifficulty;
}

export interface GameOptionsProps {
  game: GameId;
  mode: SetupMode;
  value: SetupValue;
  onChange: (next: SetupValue) => void;
  /** Shown, not changeable: a room's settings, for anyone but the leader. */
  locked?: boolean;
  className?: string;
}

/** How many fields a game shows — past three, wide screens use two columns. */
export function fieldCount(game: GameId, value: SetupValue, mode: SetupMode): number {
  const spec = GAMES[game].setup;
  const visible = spec.options.filter((o) => isVisible(o, value.settings, mode));
  const toggles = visible.some((o) => o.kind === "toggle") ? 1 : 0;
  const others = visible.filter((o) => o.kind !== "toggle").length;
  return others + toggles + 1 /* players */ + (spec.difficulty ? 1 : 0);
}

export function GameOptions({ game, mode, value, onChange, locked = false, className }: GameOptionsProps) {
  const spec = GAMES[game].setup;
  const { settings } = value;
  const bounds = useMemo(() => seatBounds(game, settings), [game, settings]);
  const seats = Math.min(bounds.max, Math.max(bounds.min, value.seats));

  const visible = spec.options.filter((o) => isVisible(o, settings, mode));
  const rulesets = visible.filter((o): o is ChoiceOption => o.kind === "choice" && o.ruleset === true);
  const match = visible.filter((o) => o.kind !== "toggle" && !(o.kind === "choice" && o.ruleset));
  const toggles = visible.filter((o): o is ToggleOption => o.kind === "toggle");
  const twoColumns = fieldCount(game, value, mode) > 3;

  const set = (key: string, next: string | number | boolean) =>
    onChange({ ...value, settings: withOption(spec, settings, key, next) });

  const field = (option: OptionSpec) => {
    if (option.kind === "number") {
      return <NumberField key={option.key} option={option} settings={settings} locked={locked} onSet={set} />;
    }
    if (option.kind === "choice") {
      return <ChoiceField key={option.key} option={option} settings={settings} locked={locked} onSet={set} />;
    }
    return null;
  };

  const seatsHint = spec.seatsHint?.(settings, bounds);

  // Two columns by the panel's OWN width (a container query), not the
  // window's: the solo screen widens for a long form, the lobby's column
  // never does, and one breakpoint on the viewport would be wrong for one
  // of them.
  return (
    <div className={cn("@container w-full", className)}>
      <div
        className={cn(
          "*:mb-6 *:break-inside-avoid *:last:mb-0",
          twoColumns && "@xl:columns-2 @xl:gap-10",
        )}
      >
        {rulesets.map(field)}

        {bounds.min === bounds.max ? (
          <SetupField label="Players" value={bounds.min} hint={seatsHint} />
        ) : (
          <div>
            <SeatsSlider
              value={seats}
              min={bounds.min}
              max={bounds.max}
              locked={locked}
              onChange={(n) => onChange({ ...value, seats: n })}
            />
            {seatsHint ? <p className="mt-2 text-center text-[11px] text-bone-500">{seatsHint}</p> : null}
          </div>
        )}

        {match.map(field)}

        {/* Its own height, opening and closing: Caribbean's three rules
            arrive and leave with the ruleset, and used to jump the form. */}
        <Collapse open={toggles.length > 0}>
          <SetupField label="Optional rules">
            <div className="flex flex-col gap-2">
              {toggles.map((option) => (
                <Toggle
                  key={option.key}
                  label={option.label}
                  hint={textOf(option.hint, settings) ?? ""}
                  checked={settings[option.key] === true}
                  unavailable={!isAvailable(option, settings)}
                  locked={locked}
                  onChange={(on) => set(option.key, on)}
                />
              ))}
            </div>
          </SetupField>
        </Collapse>

        {spec.difficulty ? (
          <DifficultyPicker
            value={value.difficulty}
            blurbs={spec.difficulty}
            locked={locked}
            onChange={(difficulty) => onChange({ ...value, difficulty })}
          />
        ) : null}
      </div>
    </div>
  );
}

interface FieldProps<O> {
  option: O;
  settings: Readonly<Record<string, unknown>>;
  locked: boolean;
  onSet: (key: string, value: string | number | boolean) => void;
}

function NumberField({ option, settings, locked, onSet }: FieldProps<NumberOption>) {
  const current = typeof settings[option.key] === "number" ? (settings[option.key] as number) : option.default;
  return (
    <SetupField label={option.label} hint={textOf(option.hint, settings)}>
      <NumberStepper
        value={current}
        min={option.min}
        max={option.max}
        step={option.step}
        label={option.unit(current)}
        format={option.format}
        disabled={locked}
        onChange={(n) => onSet(option.key, n)}
      />
    </SetupField>
  );
}

function ChoiceField({ option, settings, locked, onSet }: FieldProps<ChoiceOption>) {
  const raw = settings[option.key];
  const current = option.choices.some((c) => c.value === raw) ? raw : option.default;
  return (
    <SetupField label={option.label} hint={textOf(option.hint, settings)}>
      <ChoiceGroup
        label={option.label}
        value={String(current)}
        options={option.choices.map((c) => ({ value: String(c.value), label: c.label }))}
        locked={locked}
        fill
        onChange={(picked) => {
          const choice = option.choices.find((c) => String(c.value) === picked);
          if (choice) onSet(option.key, choice.value);
        }}
      />
    </SetupField>
  );
}
