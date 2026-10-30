"use client";

/**
 * Mind Meld — the solo play screen.
 *
 * Thin by design, like Chromaly's: everything that draws lives in `table.tsx`.
 * What is here is the setup, the offline point of view (seat 0 is you, your
 * partner and every other pair are bots), and the one thing only a solo game
 * needs - waiting for the bot's word list. Online the server holds the brain,
 * so a room never sees this.
 */

import { useMemo, useState } from "react";
import { useBrain } from "@/games/mindmeld/clientBrain";
import type { MindMeldAction, MindMeldState } from "@/games/mindmeld/types";
import { GAMES, clampSeats } from "@/session/registry";
import { GameHost } from "@/table/GameHost";
import { botTable } from "@/ui/primitives/DifficultyPicker";
import { GameSetup, useGameSetup } from "@/ui/setup/GameSetup";
import {
  MINDMELD_HAND_ZONE,
  MINDMELD_SETTINGS,
  MindMeldTable,
  OFFLINE_VIEW,
  pendingLabel,
  playerViews,
  roundSummary,
  standings,
  statsFor,
} from "./table";

export default function MindMeldPlayPage() {
  const [setup, setSetup] = useGameSetup("mindmeld");
  const [started, setStarted] = useState(false);
  const [gameKey, setGameKey] = useState(0);
  const brain = useBrain();

  const seats = clampSeats("mindmeld", setup.settings, setup.seats);
  const definition = useMemo(
    () => GAMES.mindmeld.create(GAMES.mindmeld.parse(setup.settings)),
    [setup.settings],
  );
  const view = OFFLINE_VIEW;

  if (!started) {
    return (
      <GameSetup
        game="mindmeld"
        value={setup}
        onChange={setSetup}
        onStart={() => setStarted(true)}
        // The bot's words are a 1.6 MB download, once. A slow link costs a moment
        // here; a failed one plays on the small built-in list instead.
        startDisabled={brain === "loading"}
        startLabel={brain === "loading" ? "Warming up your partner…" : "Deal in"}
      />
    );
  }

  return (
    <GameHost<MindMeldState, MindMeldAction>
      key={gameKey}
      definition={definition}
      settings={MINDMELD_SETTINGS}
      runtime={{ seats, difficulty: botTable(seats, setup.difficulty) }}
      gameTitle="Mind Meld"
      handZone={MINDMELD_HAND_ZONE}
      seatPairs
      players={(state, live) => playerViews(view, state, live)}
      standings={(state, live, pods) => standings(view, state, live, pods)}
      stats={(state) => statsFor(view, state)}
      roundSummary={(state) => roundSummary(view, state)}
      pendingLabel={(state, seat) => pendingLabel(view, state, seat)}
      // Everyone thinks at once, so the table is never waiting on "your turn".
      handActive={() => false}
      turnSeat={() => null}
      onRematch={() => setGameKey((k) => k + 1)}
      onLobby={() => setStarted(false)}
    >
      {(live, settings) => <MindMeldTable view={view} live={live} settings={settings} />}
    </GameHost>
  );
}
