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

import { useMemo, useState } from "react";

import { GameHost } from "@/table/GameHost";

import { botTable } from "@/ui/primitives/DifficultyPicker";
import { GameSetup, useGameSetup } from "@/ui/setup/GameSetup";
import { GAMES, clampSeats } from "@/session/registry";
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
  const [setup, setSetup] = useGameSetup("rummy");
  const [started, setStarted] = useState(false);
  const [gameKey, setGameKey] = useState(0);
  const { short, touch } = useViewport();

  const seats = clampSeats("rummy", setup.settings, setup.seats);
  const definition = useMemo(
    () => GAMES.rummy.create(GAMES.rummy.parse(setup.settings)),
    [setup.settings],
  );
  const { picked, pickupDepth, clearSelection, onPieceTap } = useRummySelection(OFFLINE_VIEW);

  if (!started) {
    return <GameSetup game="rummy" value={setup} onChange={setSetup} onStart={() => setStarted(true)} />;
  }

  return (
    <>
      <GameHost<RummyState, RummyAction>
        key={gameKey}
        definition={definition}
        runtime={{ seats, difficulty: botTable(seats, setup.difficulty) }}
        gameTitle="Rummy 500"
        // The table reserves the resting sheet's height above the band (the
        // band itself is reserved for every table), so no pod or pile is
        // ever laid underneath either. No `pileAnchor`: the default lines
        // the piles up with the side seat pods, which is exactly where they
        // should sit.
        bottomZone={SHEET_PEEK_H}
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
