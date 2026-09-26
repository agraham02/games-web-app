"use client";

/**
 * Left Right Center — the real, playable game screen.
 *
 * Composes GameHost (shared table chrome) around the lrc GameDefinition.
 * The only genuinely game-specific pieces here are the seat labels
 * (chip counts, not bids or hand sizes), the Roll button, and the dice
 * overlay — everything else (seat ring, toasts, game-end summary) comes
 * from the shared layer.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { NumberStepper } from "@/ui/primitives/NumberStepper";
import { SeatsSlider, SetupField } from "@/ui/primitives/SetupField";
import { SetupShell } from "@/ui/primitives/SetupShell";
import { GameHost } from "@/table/GameHost";
import {
  LRC_HAND_ZONE,
  statsFor,
  LrcControls,
  OFFLINE_VIEW,
  pendingLabel,
  playerViews,
  roundSummary,
  standings,
} from "./table";
import {
  createLrc,
  lrc,
  LRC_DEFAULT_TARGET,
  LRC_TARGET_MAX,
  LRC_TARGET_MIN,
} from "@/games/lrc/rules";
import type { LrcAction, LrcState } from "@/games/lrc/types";

export default function LrcPlayPage() {
  const [seats, setSeats] = useState(6);
  const [target, setTarget] = useState(LRC_DEFAULT_TARGET);
  const [started, setStarted] = useState(false);
  const [gameKey, setGameKey] = useState(0);

  const definition = useMemo(() => createLrc(target), [target]);

  if (!started) {
    return (
      <SetupScreen
        seats={seats}
        target={target}
        onSeatsChange={setSeats}
        onTargetChange={setTarget}
        onStart={() => setStarted(true)}
      />
    );
  }

  return (
    <GameHost<LrcState, LrcAction>
      key={gameKey}
      definition={definition}
      runtime={{ seats }}
      gameTitle="Left Right Center"
      handZone={LRC_HAND_ZONE}
      players={(state, live) => playerViews(OFFLINE_VIEW, state, live)}
      standings={(state, live, seats) => standings(OFFLINE_VIEW, state, live, seats)}
      stats={statsFor}
      roundSummary={(state) => roundSummary(OFFLINE_VIEW, state)}
      pendingLabel={(state, seat) => pendingLabel(OFFLINE_VIEW, state, seat)}
      onRematch={() => setGameKey((k) => k + 1)}
      onLobby={() => setStarted(false)}
    >
      {(live) => <LrcControls live={live} />}
    </GameHost>
  );
}

function SetupScreen({
  seats,
  target,
  onSeatsChange,
  onTargetChange,
  onStart,
}: {
  seats: number;
  target: number;
  onSeatsChange: (n: number) => void;
  onTargetChange: (n: number) => void;
  onStart: () => void;
}) {
  return (
    <SetupShell maxWidth="max-w-xs">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="eyebrow">New match</span>
        <h1 className="font-display text-4xl tracking-wider text-brass-300">
          Left Right Center
        </h1>
        <p className="max-w-xs text-sm text-bone-400">
          Roll, pass chips left and right, or lose them to the pot. Last
          player holding chips wins the round — win enough rounds and you
          take the match.
        </p>
      </div>

      <div className="flex w-full flex-col gap-5">
        <SeatsSlider
          value={seats}
          min={lrc.minSeats}
          max={lrc.maxSeats}
          onChange={onSeatsChange}
        />
        <SetupField
          label="Rounds to win"
          hint={`Each pot won is worth one round. First to ${target} takes the match.`}
        >
          <NumberStepper
            value={target}
            min={LRC_TARGET_MIN}
            max={LRC_TARGET_MAX}
            onChange={onTargetChange}
            label={target === 1 ? "round" : "rounds"}
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
