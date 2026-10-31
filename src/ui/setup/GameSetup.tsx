"use client";

/**
 * The solo setup screen — one component for all six games.
 *
 * There were six `SetupScreen`s, one per play page, each with its own
 * header, its own hand-written "Deal in" (the same class string six
 * times), its own "← Back", and its own order of options: difficulty
 * before the target in Rummy, after it in BS, last in Dominoes; called
 * "Opponents" in three games and "Table" in two. The options are the
 * game's spec now (`GameOptions`), and this is the frame around them.
 */

import Link from "next/link";
import { textOf } from "@/session/gameSetup";
import { GAMES, type GameId } from "@/session/registry";
import { Reveal } from "@/ui/motion";
import { Button } from "@/ui/primitives/Button";
import { SetupShell } from "@/ui/primitives/SetupShell";
import { GameCredit } from "@/ui/GameCredit";
import { GameOptions, fieldCount, type SetupValue } from "./GameOptions";
import { defaultSetup, isDefaultSetup, useSavedSetup } from "./savedSetup";

/**
 * A play page's setup state: what this device last used for the game, else
 * its defaults, and every change is remembered (`savedSetup.ts`).
 */
export function useGameSetup(game: GameId) {
  return useSavedSetup(game);
}

export function GameSetup({
  game,
  value,
  onChange,
  onStart,
  startDisabled = false,
  startLabel = "Deal in",
}: {
  game: GameId;
  value: SetupValue;
  onChange: (next: SetupValue) => void;
  onStart: () => void;
  /** A game that must load something first (Mind Meld's bot) holds the button. */
  startDisabled?: boolean;
  startLabel?: string;
}) {
  const entry = GAMES[game];
  const wide = fieldCount(game, value, "solo") > 3;

  return (
    <SetupShell
      game={game}
      maxWidth={wide ? "max-w-xs md:max-w-2xl" : "max-w-xs"}
      footer={
        <>
          <Button tone="primary" className="w-full max-w-xs" onClick={onStart} disabled={startDisabled}>
            {startLabel}
          </Button>
          {/* One row, so the button appearing as the form is edited does not
              push "Deal in" up the screen. */}
          <div className="flex items-center gap-6">
            <Link href="/" className="text-link">
              ← Back
            </Link>
            {isDefaultSetup(game, value) ? null : (
              <button type="button" className="text-link" onClick={() => onChange(defaultSetup(game))}>
                Reset to defaults
              </button>
            )}
          </div>
        </>
      }
    >
      <Reveal slow className="flex w-full flex-col items-center gap-7">
        <div className="flex w-full flex-col gap-4">
          <span className="caps text-brass-300">New match</span>
          <h1 className="font-title text-[clamp(2.6rem,10vw,3.8rem)] leading-[0.98] font-light tracking-tight text-bone-50 text-balance">
            {entry.name}
          </h1>
          <p className="text-sm leading-[1.8] font-light text-bone-300 text-pretty">
            {textOf(entry.setup.description, value.settings)}
          </p>
          <div className="mt-2 h-px w-full bg-linear-to-r from-brass-400/50 to-transparent" />
        </div>
        <div className="w-full rounded-md border border-bone-50/10 p-5">
          <GameOptions game={game} mode="solo" value={value} onChange={onChange} />
        </div>
        <GameCredit game={game} className="w-full" />
      </Reveal>
    </SetupShell>
  );
}
