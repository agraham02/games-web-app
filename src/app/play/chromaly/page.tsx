"use client";

/**
 * Chromaly — the solo play screen.
 *
 * Thin by design. Everything that draws or decides lives in `table.tsx`, so
 * the room screen and this one cannot drift apart; what is left here is the
 * setup, the offline point of view (seat 0 is you, everyone else is a bot with
 * a bot's name), and where the held selection is kept.
 */

import { useMemo, useState } from "react";
import { type PieceId } from "@/engine/types";
import type { ChromalyAction, ChromalyState } from "@/games/chromaly/types";
import { GAMES, clampSeats } from "@/session/registry";
import { GameHost } from "@/table/GameHost";
import type { GameRuntime } from "@/table/useGameRuntime";
import { botTable } from "@/ui/primitives/DifficultyPicker";
import { GameSetup, useGameSetup } from "@/ui/setup/GameSetup";
import {
  CHROMALY_SETTINGS,
  ChromalyTable,
  OFFLINE_VIEW,
  canAct,
  canJump,
  clearPlayCards,
  onPieceTap as tapCard,
  pendingLabel,
  playerViews,
  roundSummary,
  standings,
  statsFor,
  togglePlayCard,
  turnSeat,
} from "./table";
import { chromalyScenarios } from "./scenarios";

type Live = GameRuntime<ChromalyState, ChromalyAction>;

export default function ChromalyPlayPage() {
  const [setup, setSetup] = useGameSetup("chromaly");
  const [started, setStarted] = useState(false);
  const [gameKey, setGameKey] = useState(0);
  /** The cards lifted out of the hand: a pair, or a wild waiting on its colour. */
  const [held, setHeld] = useState<PieceId[]>([]);

  const seats = clampSeats("chromaly", setup.settings, setup.seats);
  const definition = useMemo(
    () => GAMES.chromaly.create(GAMES.chromaly.parse(setup.settings)),
    [setup.settings],
  );

  const clearHeld = () => {
    clearPlayCards(held);
    setHeld([]);
  };
  const view = OFFLINE_VIEW;
  // Through the shared rule, which needs the position: a wild or a 7 is
  // always picked alone, because it has a choice to make.
  const pickUp = (live: Live) => (id: PieceId) =>
    setHeld((prev) => togglePlayCard(prev, id, live.state, view.viewerSeat));

  if (!started) {
    return <GameSetup game="chromaly" value={setup} onChange={setSetup} onStart={() => setStarted(true)} />;
  }

  return (
    <GameHost<ChromalyState, ChromalyAction>
      key={gameKey}
      definition={definition}
      settings={CHROMALY_SETTINGS}
      runtime={{ seats, difficulty: botTable(seats, setup.difficulty) }}
      gameTitle="Chromaly"
      players={(state, live) => playerViews(view, state, live)}
      standings={(state, live, pods) => standings(view, state, live, pods)}
      stats={(state) => statsFor(view, state)}
      roundSummary={(state) => roundSummary(view, state)}
      pendingLabel={(state, seat) => pendingLabel(view, state, seat)}
      onPieceTap={(id, live) => tapCard(view, id, live, pickUp(live))}
      handActive={(live) => canAct(view, live) || canJump(view, live)}
      turnSeat={turnSeat}
      scenarios={chromalyScenarios}
      onRematch={() => {
        clearHeld();
        setGameKey((k) => k + 1);
      }}
      onLobby={() => {
        clearHeld();
        setStarted(false);
      }}
    >
      {(live) => (
        <ChromalyTable view={view} live={live} held={held} onPick={pickUp(live)} onClearHeld={clearHeld} />
      )}
    </GameHost>
  );
}
