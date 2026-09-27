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
import { useState } from "react";
import { defaultSettings, textOf } from "@/session/gameSetup";
import { GAMES, type GameId } from "@/session/registry";
import { Reveal } from "@/ui/motion";
import { Button } from "@/ui/primitives/Button";
import { SetupShell } from "@/ui/primitives/SetupShell";
import { GameOptions, fieldCount, type SetupValue } from "./GameOptions";

/** What a new setup starts on: the spec's defaults, the entry's seats. */
export function initialSetup(game: GameId): SetupValue {
  const entry = GAMES[game];
  return { settings: defaultSettings(entry.setup), seats: entry.defaultSeats, difficulty: "steady" };
}

/** A play page's setup state, starting on the game's defaults. */
export function useGameSetup(game: GameId) {
  return useState<SetupValue>(() => initialSetup(game));
}

export function GameSetup({
  game,
  value,
  onChange,
  onStart,
}: {
  game: GameId;
  value: SetupValue;
  onChange: (next: SetupValue) => void;
  onStart: () => void;
}) {
  const entry = GAMES[game];
  const wide = fieldCount(game, value, "solo") > 3;

  return (
    <SetupShell
      maxWidth={wide ? "max-w-xs md:max-w-2xl" : "max-w-xs"}
      footer={
        <>
          <Button tone="primary" className="w-full max-w-xs" onClick={onStart}>
            Deal in
          </Button>
          <Link href="/" className="text-xs text-bone-400 hover:text-bone-200">
            ← Back
          </Link>
        </>
      }
    >
      <Reveal slow className="flex w-full flex-col items-center gap-7">
        <div className="flex max-w-sm flex-col items-center gap-2 text-center">
          <span className="eyebrow">New match</span>
          <h1 className="font-display text-4xl tracking-wider text-brass-300">{entry.name}</h1>
          <p className="text-sm leading-relaxed text-bone-400">
            {textOf(entry.setup.description, value.settings)}
          </p>
        </div>
        <GameOptions game={game} mode="solo" value={value} onChange={onChange} />
      </Reveal>
    </SetupShell>
  );
}
