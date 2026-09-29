"use client";

/**
 * Spades — the play screen.
 *
 * The genuinely game-specific parts:
 *
 *  - **the bid pad.** `BlindVoteDialog` (a trailing team's vote on going
 *    blind) and `BlindChoiceDialog` (the blind bid that follows) are
 *    rung-6 `BlockingDialog`s — nothing to compare against yet, since the
 *    hand is still hidden at those exact decisions. An ORDINARY bid is
 *    different: deciding how much to bid means looking at your own
 *    hand, so `NumericBidPanel` is a
 *    non-modal floating panel instead (POLICY.md: "never put reference
 *    information in a modal").
 *  - **the exchange bar.** The Blind Nil card exchange is DIFFERENT: it
 *    requires tapping the hero's own hand cards on the table, which a
 *    true modal dialog would block (`showModal()` traps all interaction
 *    outside itself). So this is deliberately NOT a BlockingDialog —
 *    it's the same non-modal "instruction + floating action bar" shape
 *    Dominoes uses for its own tile-then-end flow, with card selection
 *    happening by tapping the (still face-down, for the giver) hand
 *    directly.
 *  - **the bid/score readout on each pod**, and the hero's own via a
 *    small always-visible badge (rung 1, POLICY.md's own "current bid"
 *    example).
 *
 * Everything else — seat ring, toasts, scorecard, match summary, dev
 * panel, and the trick zone itself — comes from GameHost/PieceLayer
 * unchanged; Spades is the first game to actually exercise the "trick"
 * zone geometry and the `collect` event.
 */

import { useMemo, useState } from "react";
import { type PieceId } from "@/engine/types";
import { botTable } from "@/ui/primitives/DifficultyPicker";
import { GameSetup, useGameSetup } from "@/ui/setup/GameSetup";
import { GameHost } from "@/table/GameHost";
import {
  OFFLINE_VIEW,
  SpadesTable,
  clearExchangeCards,
  toggleExchangeCard,
  onPieceTap as tapCard,
  pendingLabel,
  playerViews,
  roundSummary,
  standings,
  statsFor,
  SPADES_SETTINGS,
} from "./table";
import type { GameRuntime } from "@/table/useGameRuntime";
import { GAMES } from "@/session/registry";
import { SpadesAction, SpadesState } from "@/games/spades/types";

type Live = GameRuntime<SpadesState, SpadesAction>;

export default function SpadesPlayPage() {
  const [setup, setSetup] = useGameSetup("spades");
  const [started, setStarted] = useState(false);
  const [gameKey, setGameKey] = useState(0);
  /** Up to 2 cards picked for the current blind-nil exchange step.
   * Meaningless outside `state.exchange` — cleared whenever that
   * closes, the same way Dominoes' `held` is cleared on release. */
  const [held, setHeld] = useState<PieceId[]>([]);

  const definition = useMemo(
    () => GAMES.spades.create(GAMES.spades.parse(setup.settings)),
    [setup.settings],
  );

  // Both rules live in `table.tsx` now, so the room screen cannot drift
  // from this one again — which is exactly what it had done.
  const clearHeld = () => {
    clearExchangeCards(held);
    setHeld([]);
  };

  const toggleHeld = (id: PieceId) => setHeld((prev) => toggleExchangeCard(prev, id));

  // Offline is just the shared table with the offline point of view: seat
  // 0 is you, everyone else is a bot with a bot's name.
  const view = OFFLINE_VIEW;
  const onPieceTap = (id: PieceId, live: Live) => tapCard(view, id, live, toggleHeld);

  if (!started) {
    return <GameSetup game="spades" value={setup} onChange={setSetup} onStart={() => setStarted(true)} />;
  }

  return (
    <GameHost<SpadesState, SpadesAction>
      key={gameKey}
      definition={definition}
      runtime={{ seats: 4, difficulty: botTable(4, setup.difficulty) }}
      gameTitle="Spades"
      players={(state, live) => playerViews(view, state, live)}
      standings={(state, live, seats) => standings(view, state, live, seats)}
      stats={(state) => statsFor(view, state)}
      roundSummary={(state) => roundSummary(view, state)}
      pendingLabel={(state, seat) => pendingLabel(view, state, seat)}
      onPieceTap={onPieceTap}
      settings={SPADES_SETTINGS}
      onRematch={() => {
        clearHeld();
        setGameKey((k) => k + 1);
      }}
      onLobby={() => {
        clearHeld();
        setStarted(false);
      }}
    >
      {(live) => <SpadesTable view={view} live={live} held={held} onClearHeld={clearHeld} />}
    </GameHost>
  );
}
