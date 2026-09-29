"use client";

/**
 * Poker (No-Limit Texas Hold'em) — the real, playable game screen.
 *
 * Composes GameHost (shared table chrome) around the poker
 * GameDefinition, the same shape every other game here follows. The
 * genuinely game-specific pieces are: the betting panel (fold/check/call
 * plus bet/raise sizing), the show-or-muck bar for a genuine showdown,
 * the dealer/blind position badge (both on opponent pods, via
 * `SeatView.badge`, and the hero's own — SeatRing never renders a pod
 * for seat 0), and the hand-rankings reference sheet. Everything else —
 * the seat ring, toasts, round/game summaries, the community-card row
 * and pot pile — comes from the shared layer or `src/games/poker/rules.ts`.
 */

import { useMemo, useState } from "react";
import type { PokerAction, PokerState } from "@/games/poker/types";
import { GameHost } from "@/table/GameHost";
import {
  OFFLINE_VIEW,
  POKER_SETTINGS,
  PokerControls,
  pendingLabel,
  playerViews,
  roundSummary,
  standings,
  usePokerPanelReserve,
} from "./table";
import { botTable } from "@/ui/primitives/DifficultyPicker";
import { GameSetup, useGameSetup } from "@/ui/setup/GameSetup";
import { GAMES, clampSeats } from "@/session/registry";

export default function PokerPlayPage() {
  const [setup, setSetup] = useGameSetup("poker");
  const [started, setStarted] = useState(false);
  const [gameKey, setGameKey] = useState(0);
  const panelReserve = usePokerPanelReserve();

  const seats = clampSeats("poker", setup.settings, setup.seats);
  const definition = useMemo(
    () => GAMES.poker.create(GAMES.poker.parse(setup.settings)),
    [setup.settings],
  );

  if (!started) {
    return <GameSetup game="poker" value={setup} onChange={setSetup} onStart={() => setStarted(true)} />;
  }

  return (
    <GameHost<PokerState, PokerAction>
      settings={POKER_SETTINGS}
      key={gameKey}
      definition={definition}
      runtime={{ seats, difficulty: botTable(seats, setup.difficulty) }}
      gameTitle="Poker"
      roundNoun="Hand"
      panelReserve={panelReserve}
      players={(state, live) => playerViews(OFFLINE_VIEW, state, live)}
      standings={(state, live, seats) => standings(OFFLINE_VIEW, state, live, seats)}
      stats={(state) => [
        { label: "Hand", value: `${state.hand}` },
        { label: "Blinds", value: `${state.smallBlind}/${state.bigBlind}` },
      ]}
      roundSummary={(state) => roundSummary(OFFLINE_VIEW, state)}
      pendingLabel={(state, seat) => pendingLabel(OFFLINE_VIEW, state, seat)}
      onRematch={() => setGameKey((k) => k + 1)}
      onLobby={() => setStarted(false)}
    >
      {(live, prefs) => <PokerControls view={OFFLINE_VIEW} live={live} hints={prefs.hints !== false} />}
    </GameHost>
  );
}
