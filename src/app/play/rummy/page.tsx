"use client";

/**
 * Rummy 500 — the offline shell.
 *
 * Setup screen, then `GameHost` with `OFFLINE_VIEW`. Everything that
 * draws a table lives in [table.tsx](./table.tsx), which the room's
 * online Rummy renders with a different `View` and nothing else changed.
 *
 * The layout architecture that used to be documented here moved there
 * with the components it describes.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import type { BotDifficulty } from "@/engine/types";

import { GameHost } from "@/table/GameHost";

import { handHeaderHeight } from "@/table/HandZone";
import { DifficultyPicker, botTable } from "@/ui/primitives/DifficultyPicker";
import { NumberStepper } from "@/ui/primitives/NumberStepper";
import { SeatsSlider, SetupField } from "@/ui/primitives/SetupField";
import { SetupShell } from "@/ui/primitives/SetupShell";
import { createRummy } from "@/games/rummy/rules";
import { DEFAULT_TARGET, MAX_SEATS, MIN_SEATS } from "@/games/rummy/state";
import type { RummyAction, RummyState } from "@/games/rummy/types";
import {
  OFFLINE_VIEW,
  RotateNotice,
  RummyTable,
  SHEET_PEEK_H,
  pendingLabel,
  playerViews,
  roundSummary,
  rummyScenarios,
  statsFor,
  standings,
  useRummySelection,
  useViewport,
} from "./table";

export default function RummyPlayPage() {
  const [seats, setSeats] = useState(4);
  const [target, setTarget] = useState(DEFAULT_TARGET);
  const [difficulty, setDifficulty] = useState<BotDifficulty>("steady");
  const [started, setStarted] = useState(false);
  const [gameKey, setGameKey] = useState(0);
  const { vh, short, touch } = useViewport();

  const definition = useMemo(() => createRummy({ target }), [target]);
  const { picked, pickupDepth, clearSelection, onPieceTap } = useRummySelection(OFFLINE_VIEW);

  if (!started) {
    return (
      <SetupScreen
        seats={seats}
        onSeats={setSeats}
        target={target}
        onTarget={setTarget}
        difficulty={difficulty}
        onDifficulty={setDifficulty}
        onStart={() => setStarted(true)}
      />
    );
  }

  return (
    <>
      <GameHost<RummyState, RummyAction>
        key={gameKey}
        definition={definition}
        runtime={{ seats, difficulty: botTable(seats, difficulty) }}
        gameTitle="Rummy 500"
        // The table reserves the band the hand header and the resting sheet
        // occupy, so no pod or pile is ever laid underneath them. No
        // `pileAnchor`: the default lines the piles up with the side seat
        // pods, which is exactly where they should sit.
        bottomZone={handHeaderHeight(vh) + SHEET_PEEK_H}
        players={playerViews(OFFLINE_VIEW, seats)}
        standings={standings(OFFLINE_VIEW, seats)}
        stats={statsFor}
        roundSummary={roundSummary(OFFLINE_VIEW, seats)}
        pendingLabel={pendingLabel(OFFLINE_VIEW)}
        onPieceTap={onPieceTap}
        onRematch={() => {
          clearSelection();
          setGameKey((k) => k + 1);
        }}
        onLobby={() => {
          clearSelection();
          setStarted(false);
        }}
        scenarios={rummyScenarios}
      >
        {(live) => (
          <RummyTable
            live={live}
            view={OFFLINE_VIEW}
            picked={picked}
            pickupDepth={pickupDepth}
            clearSelection={clearSelection}
          />
        )}
      </GameHost>

      {/* An OVERLAY, not a branch. Unmounting `GameHost` would take the
          whole match with it, so rotating a phone mid-round would silently
          restart the game — the layout being wrong is not a reason to
          throw away someone's score. The table keeps running underneath
          and is exactly where they left it when they rotate back. */}
      {short ? <RotateNotice touch={touch} /> : null}
    </>
  );
}

/** What each tier actually does — see `LAYOFF_ATTENTION` in bots.ts. */
const RUMMY_BLURBS = {
  casual: "Plays it safe and misses things. Good for learning the game.",
  steady: "Competent and fair. Will punish a loose discard, not every one.",
  sharp: "Knows which cards are already dead, watches the stock run down, and won't feed your melds.",
};

function SetupScreen({
  seats,
  onSeats,
  target,
  onTarget,
  difficulty,
  onDifficulty,
  onStart,
}: {
  seats: number;
  onSeats: (n: number) => void;
  target: number;
  onTarget: (n: number) => void;
  difficulty: BotDifficulty;
  onDifficulty: (d: BotDifficulty) => void;
  onStart: () => void;
}) {
  return (
    <SetupShell maxWidth="max-w-xs">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="eyebrow">New match</span>
        <h1 className="font-display text-4xl tracking-wider text-brass-300">Rummy 500</h1>
        <p className="max-w-sm text-xs leading-relaxed text-bone-400">
          Melds are sets and runs. Taking anything off the discard pile — even the
          top card — means melding it right away. First to the target wins.
        </p>
      </div>

      <div className="flex w-full flex-col gap-5">
        <SeatsSlider value={seats} min={MIN_SEATS} max={MAX_SEATS} onChange={onSeats} />

        <DifficultyPicker value={difficulty} onChange={onDifficulty} blurbs={RUMMY_BLURBS} />

        <SetupField label="Play to">
          <NumberStepper
            value={target}
            min={100}
            max={1000}
            step={25}
            label="points"
            onChange={onTarget}
          />
        </SetupField>
      </div>

      <button
        type="button"
        onClick={onStart}
        className="rounded-lg bg-linear-to-b from-brass-300 to-brass-500 px-8 py-3.5 text-sm font-extrabold text-felt-950 shadow-e2"
      >
        Deal in
      </button>

      <Link href="/" className="text-xs text-bone-400 hover:text-bone-200">
        ← Back
      </Link>
    </SetupShell>
  );
}
