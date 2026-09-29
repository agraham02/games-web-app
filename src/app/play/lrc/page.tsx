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
import { GameSetup, useGameSetup } from "@/ui/setup/GameSetup";
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
import type { LrcAction, LrcState } from "@/games/lrc/types";
import { GAMES, clampSeats } from "@/session/registry";

export default function LrcPlayPage() {
  const [setup, setSetup] = useGameSetup("lrc");
  const [started, setStarted] = useState(false);
  const [gameKey, setGameKey] = useState(0);

  const seats = clampSeats("lrc", setup.settings, setup.seats);
  const definition = useMemo(
    () => GAMES.lrc.create(GAMES.lrc.parse(setup.settings)),
    [setup.settings],
  );

  if (!started) {
    return <GameSetup game="lrc" value={setup} onChange={setSetup} onStart={() => setStarted(true)} />;
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
      {(live) => <LrcControls view={OFFLINE_VIEW} live={live} />}
    </GameHost>
  );
}
