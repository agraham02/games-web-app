"use client";

/**
 * BS — the solo play screen.
 *
 * Thin by design. Everything that draws or decides lives in `table.tsx`, so
 * the room screen and this one cannot drift apart; what is left here is the
 * setup, the offline point of view (seat 0 is you, everyone else is a bot with
 * a bot's name), and where the held selection is kept.
 *
 * The one number this screen owns that the room does not: the challenge
 * window is five seconds here and ten in a room. Alone against bots the table
 * really is waiting on you and nothing else, so the window IS the beat between
 * one play and the next; in a room the next player can cut it short simply by
 * playing, so it can afford to be generous.
 */

import { useMemo, useState } from "react";
import { type PieceId } from "@/engine/types";
import { CHALLENGE_MS_SOLO } from "@/games/bs/state";
import type { BsAction, BsState } from "@/games/bs/types";
import { GAMES, clampSeats } from "@/session/registry";
import { GameHost } from "@/table/GameHost";
import type { GameRuntime } from "@/table/useGameRuntime";
import { botTable } from "@/ui/primitives/DifficultyPicker";
import { GameSetup, useGameSetup } from "@/ui/setup/GameSetup";
import {
  BsTable,
  OFFLINE_VIEW,
  canPlay,
  clearPlayCards,
  onPieceTap as tapCard,
  pendingLabel,
  playerViews,
  roundSummary,
  standings,
  statsFor,
  togglePlayCard,
} from "./table";

type Live = GameRuntime<BsState, BsAction>;

export default function BsPlayPage() {
  const [setup, setSetup] = useGameSetup("bs");
  const [started, setStarted] = useState(false);
  const [gameKey, setGameKey] = useState(0);
  /** The cards lifted out of the hand for the next claim, 1 to 4 of them. */
  const [held, setHeld] = useState<PieceId[]>([]);

  const seats = clampSeats("bs", setup.settings, setup.seats);
  // The window is not an option here (the room's `windowMs` is room-only in
  // the spec) — it is fixed, for the reason in the file's doc.
  const definition = useMemo(
    () => GAMES.bs.create({ ...GAMES.bs.parse(setup.settings), windowMs: CHALLENGE_MS_SOLO }),
    [setup.settings],
  );

  // Both rules live in `table.tsx`, so the room screen cannot drift from this
  // one — which is exactly what Dominoes' two screens had already done once.
  const clearHeld = () => {
    clearPlayCards(held);
    setHeld([]);
  };
  const toggleHeld = (id: PieceId) => setHeld((prev) => togglePlayCard(prev, id));

  const view = OFFLINE_VIEW;
  const onPieceTap = (id: PieceId, live: Live) => tapCard(view, id, live, toggleHeld);

  if (!started) {
    return <GameSetup game="bs" value={setup} onChange={setSetup} onStart={() => setStarted(true)} />;
  }

  return (
    <GameHost<BsState, BsAction>
      key={gameKey}
      definition={definition}
      runtime={{ seats, difficulty: botTable(seats, setup.difficulty) }}
      gameTitle="BS"
      players={(state, live) => playerViews(view, state, live)}
      standings={(state, live, pods) => standings(view, state, live, pods)}
      stats={(state) => statsFor(view, state)}
      roundSummary={(state) => roundSummary(view, state)}
      pendingLabel={(state, seat) => pendingLabel(view, state, seat)}
      onPieceTap={onPieceTap}
      handActive={(live) => canPlay(view, live)}
      onRematch={() => {
        clearHeld();
        setGameKey((k) => k + 1);
      }}
      onLobby={() => {
        clearHeld();
        setStarted(false);
      }}
    >
      {(live) => <BsTable view={view} live={live} held={held} onClearHeld={clearHeld} />}
    </GameHost>
  );
}
