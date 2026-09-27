/**
 * What each game asks before it is dealt — the ONE description of it.
 *
 * It used to be written three times: each solo setup screen, the lobby's
 * game panel, and the registry's `parse`. They drifted exactly as copies
 * do. The room played Rummy to 500 and gave nobody a way to change it
 * (solo: 250, adjustable); LRC's lobby offered a difficulty slider for a
 * game with no decisions; Dominoes' lobby let Caribbean — a four-handed
 * game — be set to three seats, which dealt a fourth, invisible player.
 * Labels, hints, ranges, steps and defaults all disagreed somewhere.
 *
 * Now each game's options are data, here. `GameOptions` draws them for the
 * solo screen and the lobby alike (`mode` is a parameter, not a second
 * screen), and `parseSettings` clamps what arrives off the wire from the
 * SAME numbers — so the form and the server cannot disagree again.
 *
 * Defaults are the solo screens' values everywhere (the user's call,
 * 2026-09-26): they are the ones with reasons written down.
 *
 * Pure: no React, no DOM. The server imports it through the registry.
 */

import type { BotDifficulty } from "@/engine/types";
import { CHALLENGE_MS_ONLINE, DEFAULT_TARGET as BS_DEFAULT_TARGET } from "@/games/bs/state";
import {
  CARIBBEAN_DEFAULT_TARGET,
  CARIBBEAN_TARGET_MAX,
  CARIBBEAN_TARGET_MIN,
  SIX_LOVE_DEFAULT_TARGET,
} from "@/games/dominoes/state";
import { LRC_DEFAULT_TARGET, LRC_TARGET_MAX, LRC_TARGET_MIN } from "@/games/lrc/rules";
import {
  DEFAULT_BIG_BLIND,
  DEFAULT_STARTING_STACK,
  MAX_BIG_BLIND,
  MAX_STARTING_STACK,
  MIN_BIG_BLIND,
  MIN_STARTING_STACK,
} from "@/games/poker/rules";
import { DEFAULT_TARGET as RUMMY_DEFAULT_TARGET } from "@/games/rummy/state";

export type OptionValue = string | number | boolean;
/** A game's settings as the form holds them — before `parseSettings`. */
export type Settings = Readonly<Record<string, unknown>>;
/** Where the options are being set: alone against bots, or in a room. */
export type SetupMode = "solo" | "room";

type When = (s: Settings) => boolean;
/** Copy that can depend on the other settings ("small blind is half — 10"). */
export type Text = string | ((s: Settings) => string);

interface OptionBase {
  key: string;
  label: string;
  hint?: Text;
  /** Only shown (and only meaningful) under these settings. */
  visibleWhen?: When;
  /** Only in one mode — BS's challenge window is a room setting. */
  mode?: SetupMode;
}

/** An open-ended number: a target score, a stack. */
export interface NumberOption extends OptionBase {
  kind: "number";
  min: number;
  max: number;
  step: number;
  default: number;
  /** What one unit is called, for the stepper's buttons ("Fewer points"). */
  unit: (n: number) => string;
  /** How the value reads, when not as a bare number. */
  format?: (n: number) => string;
}

/** A few named alternatives: a ruleset, a fixed list of targets. */
export interface ChoiceOption extends OptionBase {
  kind: "choice";
  /** A choice of RULESET — shown first, before the players, because the
   * rest of the form depends on it (Dominoes' Caribbean / Block & Draw). */
  ruleset?: boolean;
  choices: readonly { value: string | number; label: string }[];
  default: string | number;
  /**
   * What an absent value means to the PARSER, when it must differ from what
   * a new form starts on. Dominoes starts on Caribbean, but settings that
   * say nothing — the tests, the harness — have always meant Block & Draw.
   */
  parseDefault?: string | number;
}

/** An optional rule, on or off. */
export interface ToggleOption extends OptionBase {
  kind: "toggle";
  hint: Text;
  default: boolean;
  /** Not in effect otherwise — shown off, with the hint saying why. */
  availableWhen?: When;
}

export type OptionSpec = NumberOption | ChoiceOption | ToggleOption;

export interface GameSetupSpec {
  /** One or two plain sentences: what the game IS, for someone new to it. */
  description: Text;
  options: readonly OptionSpec[];
  /** What each tier actually does in this game; null where bots have no
   * decisions to be better or worse at (LRC). */
  difficulty: Record<BotDifficulty, string> | null;
  /** The Players field's line, when there is something to say. */
  seatsHint?: (s: Settings, bounds: { min: number; max: number }) => string | undefined;
  /** Couplings: the settings after `key` changed to its new value. */
  adjust?: (next: Record<string, unknown>, key: string) => Record<string, unknown>;
}

/* ============================================================
   Reading and clamping
   ============================================================ */

export function isVisible(option: OptionSpec, s: Settings, mode?: SetupMode): boolean {
  if (option.mode && mode && option.mode !== mode) return false;
  return option.visibleWhen ? option.visibleWhen(s) : true;
}

export function isAvailable(option: ToggleOption, s: Settings): boolean {
  return option.availableWhen ? option.availableWhen(s) : true;
}

export function textOf(text: Text | undefined, s: Settings): string | undefined {
  return typeof text === "function" ? text(s) : text;
}

/**
 * A finite whole number in range, or the fallback. Assumes hostile input:
 * `Number.isFinite` is the load-bearing part — `NaN` and `Infinity` both
 * survive a naive `typeof v === "number"`, and both turn a target score
 * into a match that never ends.
 */
function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/**
 * Settings safe to build a game from, whatever arrived.
 *
 * Options are read in order, so a later one's visibility can depend on an
 * earlier one's parsed value (Dominoes' mode first). A number keeps its
 * clamped value even while hidden — switching Dominoes' ruleset and back
 * must not lose the other one's target. A toggle that is hidden or not
 * available is OFF: it is not a rule of the game being built.
 */
export function parseSettings(spec: GameSetupSpec, raw: Settings): Record<string, OptionValue> {
  const out: Record<string, OptionValue> = {};
  for (const option of spec.options) {
    const value = raw[option.key];
    switch (option.kind) {
      case "number":
        out[option.key] = clampInt(value, option.min, option.max, option.default);
        break;
      case "choice": {
        const allowed = option.choices.some((c) => c.value === value);
        out[option.key] = allowed ? (value as string | number) : (option.parseDefault ?? option.default);
        break;
      }
      case "toggle": {
        const inForce = isVisible(option, out) && isAvailable(option, out);
        out[option.key] = inForce ? (typeof value === "boolean" ? value : option.default) : false;
        break;
      }
    }
  }
  return out;
}

/** What a new form starts on. */
export function defaultSettings(spec: GameSetupSpec): Record<string, OptionValue> {
  return Object.fromEntries(spec.options.map((o) => [o.key, o.default]));
}

/** One option changed: the new settings, couplings applied. */
export function withOption(
  spec: GameSetupSpec,
  s: Settings,
  key: string,
  value: OptionValue,
): Record<string, unknown> {
  const next = { ...s, [key]: value };
  return spec.adjust ? spec.adjust(next, key) : next;
}

/* ============================================================
   The games
   ============================================================ */

const plural = (one: string, many: string) => (n: number) => (n === 1 ? one : many);

const SPADES: GameSetupSpec = {
  description:
    "Partnership trick-taking — you and the seat across from you bid and play as a team. Follow suit, spades are always trump, and a bid made together is scored together.",
  options: [
    {
      kind: "toggle",
      key: "jokers",
      label: "Jokers",
      hint: "Adds a Big and a Little Joker above every spade. The 2♣ and 2♥ come out, so hands stay at thirteen.",
      default: false,
    },
    {
      kind: "toggle",
      key: "twoOfSpadesHigh",
      label: "2 of spades ranks above Ace",
      hint: "Within spades only — every other suit is unaffected.",
      default: false,
    },
  ],
  // See `estimateTricks`/`choosePlay` in bots.ts. One tier for the whole
  // table, partner included: a partner playing a different game from the
  // opponents would be a stranger setting than one difficulty for all.
  difficulty: {
    casual: "Bids near the floor and plays low — never really counts its hand.",
    steady: "Bids off a real hand read, cashes its winners, and wins tricks as cheaply as it can.",
    sharp: "Counts the cards played, remembers who is void, works a nil from either seat, and watches its bags.",
  },
  seatsHint: () => "Two teams of two — your partner sits across from you.",
};

const caribbean: When = (s) => s.mode === "caribbean";

const DOMINOES: GameSetupSpec = {
  description: (s) =>
    caribbean(s)
      ? "Four hands, the whole set dealt, and no boneyard — if you cannot go, you pass. Win the round, win a game."
      : "Block & Draw with a double-six set. Match an open end, draw when you are stuck, and go out first — the pips left in everyone else's hands are yours.",
  options: [
    {
      kind: "choice",
      key: "mode",
      label: "Rules",
      ruleset: true,
      choices: [
        { value: "caribbean", label: "Caribbean" },
        { value: "classic", label: "Block & Draw" },
      ],
      // Caribbean first: the user's choice of default (2026-09-26).
      default: "caribbean",
      parseDefault: "classic",
    },
    {
      // Two targets, not one, because they are not the same UNIT: classic
      // counts pips to 61/100/150, Caribbean counts games won. Sharing one
      // number meant flipping the ruleset and back left a match playing to
      // 10 points or to 100 games.
      kind: "choice",
      key: "target",
      label: "Play to",
      hint: "61 is the usual target at three or four players, 100 heads-up.",
      choices: [
        { value: 61, label: "61" },
        { value: 100, label: "100" },
        { value: 150, label: "150" },
      ],
      default: 100,
      visibleWhen: (s) => !caribbean(s),
    },
    {
      kind: "number",
      key: "games",
      label: "Games to win",
      hint: (s) =>
        s.sixLove === true && s.teams === true
          ? "Six love resets you, so these have to be won in a row — six runs about an hour."
          : "One game per round won. Two if you finish on the key tile.",
      min: CARIBBEAN_TARGET_MIN,
      max: CARIBBEAN_TARGET_MAX,
      step: 1,
      default: CARIBBEAN_DEFAULT_TARGET,
      unit: plural("game", "games"),
      visibleWhen: caribbean,
    },
    {
      kind: "toggle",
      key: "teams",
      label: "Partners",
      hint: "Two against two, partners across the table. You play with the seat opposite you.",
      default: false,
      visibleWhen: caribbean,
    },
    {
      kind: "toggle",
      key: "keyTileBonus",
      label: "Key tile",
      hint: "Finish on the only tile left that could have been played and the round is worth two games. Never a double.",
      default: false,
      visibleWhen: caribbean,
    },
    {
      kind: "toggle",
      key: "sixLove",
      label: "Six love",
      hint: (s) =>
        s.teams === true
          ? "Your score goes back to nothing whenever the other side wins, so you have to take them in a row."
          : "Needs partners — winning in a row is not something four separate players can realistically do.",
      default: false,
      visibleWhen: caribbean,
      availableWhen: (s) => s.teams === true,
    },
  ],
  // See `judge()` in bots.ts.
  difficulty: {
    casual: "Plays whatever's in hand, no plan behind it.",
    steady: "Sheds its heaviest tiles first — enough to punish a careless hand.",
    sharp: "Remembers what you passed on and plays to it, and squeezes a block when one's going cheap.",
  },
  seatsHint: (s, { min, max }) =>
    min === max && caribbean(s) ? "No more, no less — seven tiles each is the whole set." : undefined,
  adjust: (next, key) => {
    // Six love is won on a streak, so its target has to be short — about
    // 2^N rounds between two sides. Turning it on moves the target there,
    // and off moves it back; so does dropping partners while it sits there.
    if (key === "sixLove") {
      return { ...next, games: next.sixLove === true ? SIX_LOVE_DEFAULT_TARGET : CARIBBEAN_DEFAULT_TARGET };
    }
    if (key === "teams" && next.teams !== true && next.games === SIX_LOVE_DEFAULT_TARGET) {
      return { ...next, games: CARIBBEAN_DEFAULT_TARGET };
    }
    return next;
  },
};

const POKER: GameSetupSpec = {
  description:
    "Texas Hold'em: you get two cards of your own, five shared cards are turned face up in the middle in three steps, and there is a round of betting before the first step and after each one. Make the best hand of five, or bet so that everyone else folds. The last player with chips wins.",
  options: [
    {
      kind: "number",
      key: "startingStack",
      label: "Starting stack",
      min: MIN_STARTING_STACK,
      max: MAX_STARTING_STACK,
      step: 100,
      default: DEFAULT_STARTING_STACK,
      unit: plural("chip", "chips"),
    },
    {
      kind: "number",
      key: "bigBlind",
      label: "Big blind",
      hint: (s) =>
        `Small blind is always half — ${Math.max(1, Math.round(((s.bigBlind as number) ?? DEFAULT_BIG_BLIND) / 2))} chips.`,
      min: MIN_BIG_BLIND,
      max: MAX_BIG_BLIND,
      step: 2,
      default: DEFAULT_BIG_BLIND,
      unit: plural("chip", "chips"),
    },
  ],
  // Grounded in bots.ts's own tables (`CALL_MARGIN`, `RAISE_EDGE`,
  // `LIMPS_PREFLOP`, `BLUFF_CHANCE`), not generic copy.
  difficulty: {
    casual: "Limps into most pots and calls too wide — it pays you off, but it never folds either.",
    steady: "Raises or folds before the flop, and weighs the pot odds on every call.",
    sharp: "Plays position, values its draws properly, varies its sizing, and bluffs just enough.",
  },
};

const LRC: GameSetupSpec = {
  description:
    "Roll, pass chips left and right, or lose them to the pot. Last player holding chips wins the round — win enough rounds and you take the match.",
  options: [
    {
      kind: "number",
      key: "target",
      label: "Rounds to win",
      hint: (s) => `Each pot won is worth one round. First to ${(s.target as number) ?? LRC_DEFAULT_TARGET} takes the match.`,
      min: LRC_TARGET_MIN,
      max: LRC_TARGET_MAX,
      step: 1,
      default: LRC_DEFAULT_TARGET,
      unit: plural("round", "rounds"),
    },
  ],
  // Rolling is the only legal action and the dice are random, so a tier
  // could only change pacing — a slider would promise a difference the
  // game does not have.
  difficulty: null,
};

const RUMMY: GameSetupSpec = {
  description:
    "Melds are sets and runs. Taking anything off the discard pile — even the top card — means melding it right away. First to the target wins.",
  options: [
    {
      kind: "number",
      key: "target",
      label: "Play to",
      min: 100,
      max: 1000,
      step: 25,
      default: RUMMY_DEFAULT_TARGET,
      unit: plural("point", "points"),
    },
  ],
  // See `LAYOFF_ATTENTION` in bots.ts.
  difficulty: {
    casual: "Plays it safe and misses things. Good for learning the game.",
    steady: "Competent and fair. Will punish a loose discard, not every one.",
    sharp: "Knows which cards are already dead, watches the stock run down, and won't feed your melds.",
  },
};

const BS: GameSetupSpec = {
  description:
    "The rank climbs a card a turn. Put one to four cards face down and call them whatever the rank is — honestly or not. Anybody can call BS, and whoever is wrong swallows the pile. Empty your hand to take the round.",
  options: [
    {
      kind: "number",
      key: "target",
      label: "Rounds to win",
      min: 1,
      max: 9,
      step: 1,
      default: BS_DEFAULT_TARGET,
      unit: plural("round", "rounds"),
    },
    {
      // A room setting only. Alone against bots the window is the beat
      // between one play and the next, so it is fixed and short (five
      // seconds); in a room the next player can cut it short by playing, so
      // it can afford to be generous — and adjustable.
      kind: "number",
      key: "windowMs",
      label: "Seconds to call BS",
      min: 2_000,
      max: 20_000,
      step: 1_000,
      default: CHALLENGE_MS_ONLINE,
      unit: plural("second", "seconds"),
      format: (ms) => String(Math.round(ms / 1000)),
      mode: "room",
    },
  ],
  // See `NERVE` in bots.ts. The casual line looks backwards and is not: a
  // casual table doubts you MORE often, not less. Suspicion with nothing
  // behind it is right slightly under half the time and losing the call
  // costs the whole pile, so calling on a hunch is the beginner's move. A
  // sharp table doubts rarely and for reasons.
  difficulty: {
    casual: "Doubts you on a hunch, bluffs big, and misses the arithmetic about half the time.",
    steady: "Counts what it holds of the rank, and keeps its own lies small enough to survive.",
    sharp: "Barely calls on a feeling — but claim more than the rank can supply and it has you.",
  },
};

export const GAME_SETUPS = {
  spades: SPADES,
  dominoes: DOMINOES,
  poker: POKER,
  lrc: LRC,
  rummy: RUMMY,
  bs: BS,
} as const satisfies Record<string, GameSetupSpec>;

/**
 * A game's setup in a few words — "Caribbean · 10 games · Partners off" —
 * for the lobby's folded Game panel. Only what is in force: hidden options
 * are left out, and an unavailable rule reads as off.
 */
export function summarizeSetup(spec: GameSetupSpec, s: Settings, mode: SetupMode): string[] {
  const parts: string[] = [];
  for (const option of spec.options) {
    if (!isVisible(option, s, mode)) continue;
    const value = s[option.key];
    if (option.kind === "choice") {
      const choice = option.choices.find((c) => c.value === value) ?? option.choices.find((c) => c.value === option.default);
      if (choice) parts.push(option.ruleset ? choice.label : `${option.label} ${choice.label}`);
    } else if (option.kind === "number") {
      const n = typeof value === "number" ? value : option.default;
      parts.push(`${option.format ? option.format(n) : n} ${option.unit(n)}`);
    } else {
      const on = value === true && isAvailable(option, s);
      parts.push(`${option.label} ${on ? "on" : "off"}`);
    }
  }
  return parts;
}
