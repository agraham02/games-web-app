"use client";

/**
 * Spades — the play screen.
 *
 * The genuinely game-specific parts:
 *
 *  - **the bid pad.** `BlindChoiceDialog` (a blind-eligible seat's
 *    look-or-go-blind choice) is a rung-6 `BlockingDialog` — nothing to
 *    compare against yet, since the hand is still hidden at that exact
 *    decision. An ORDINARY bid is different: deciding how much to bid
 *    means looking at your own hand, so `NumericBidPanel` is a
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
import Link from "next/link";
import { type BotDifficulty, type PieceId } from "@/engine/types";
import { DifficultyPicker, botTable } from "@/ui/primitives/DifficultyPicker";
import { SetupShell } from "@/ui/primitives/SetupShell";
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
} from "./table";
import type { GameRuntime } from "@/table/useGameRuntime";
import { Toggle } from "@/ui/primitives/Toggle";
import { createSpades } from "@/games/spades/rules";
import { SpadesAction, SpadesState } from "@/games/spades/types";

type Live = GameRuntime<SpadesState, SpadesAction>;

export default function SpadesPlayPage() {
  const [jokers, setJokers] = useState(false);
  const [twoOfSpadesHigh, setTwoOfSpadesHigh] = useState(false);
  const [difficulty, setDifficulty] = useState<BotDifficulty>("steady");
  const [started, setStarted] = useState(false);
  const [gameKey, setGameKey] = useState(0);
  /** Up to 2 cards picked for the current blind-nil exchange step.
   * Meaningless outside `state.exchange` — cleared whenever that
   * closes, the same way Dominoes' `held` is cleared on release. */
  const [held, setHeld] = useState<PieceId[]>([]);

  const definition = useMemo(
    () => createSpades({ jokers, twoOfSpadesHigh }),
    [jokers, twoOfSpadesHigh],
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
    return (
      <SetupScreen
        difficulty={difficulty}
        onDifficultyChange={setDifficulty}
        jokers={jokers}
        twoOfSpadesHigh={twoOfSpadesHigh}
        onJokersChange={setJokers}
        onTwoOfSpadesHighChange={setTwoOfSpadesHigh}
        onStart={() => setStarted(true)}
      />
    );
  }

  return (
    <GameHost<SpadesState, SpadesAction>
      key={gameKey}
      definition={definition}
      runtime={{ seats: 4, difficulty: botTable(4, difficulty) }}
      gameTitle="Spades"
      players={(state, live) => playerViews(view, state, live)}
      standings={(state, live, seats) => standings(view, state, live, seats)}
      stats={(state) => statsFor(view, state)}
      roundSummary={(state) => roundSummary(view, state)}
      pendingLabel={(state, seat) => pendingLabel(view, state, seat)}
      onPieceTap={onPieceTap}
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

/* ============================================================
   Setup
   ============================================================ */

/** What each tier actually does — see `estimateTricks`/`choosePlay` in
 * bots.ts. */
const SPADES_BLURBS = {
  casual: "Bids near the floor and plays low — never really counts its hand.",
  steady: "Bids off a real hand read, cashes its winners, and wins tricks as cheaply as it can.",
  sharp: "Counts the cards played, remembers who is void, works a nil from either seat, and watches its bags.",
};

function SetupScreen({
  jokers,
  twoOfSpadesHigh,
  onJokersChange,
  onTwoOfSpadesHighChange,
  difficulty,
  onDifficultyChange,
  onStart,
}: {
  jokers: boolean;
  twoOfSpadesHigh: boolean;
  onJokersChange: (v: boolean) => void;
  onTwoOfSpadesHighChange: (v: boolean) => void;
  difficulty: BotDifficulty;
  onDifficultyChange: (d: BotDifficulty) => void;
  onStart: () => void;
}) {
  return (
    <SetupShell maxWidth="max-w-xs">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="eyebrow">New match</span>
        <h1 className="font-display text-4xl tracking-wider text-brass-300">Spades</h1>
        <p className="max-w-xs text-sm text-bone-400">
          Partnership trick-taking — you and the seat across from you bid and
          play as a team. Follow suit, spades are always trump, and a bid
          made together is scored together.
        </p>
      </div>

      <div className="flex w-full max-w-xs flex-col gap-3">
        <Toggle
          label="Jokers"
          hint="Adds the Big and Little Joker, ranked above every spade."
          checked={jokers}
          onChange={onJokersChange}
        />
        <Toggle
          label="2 of spades ranks above Ace"
          hint="Within spades only — every other suit is unaffected."
          checked={twoOfSpadesHigh}
          onChange={onTwoOfSpadesHighChange}
        />
        {/* Applies to your partner too — a Spades table is 2v2, and a
            partner who plays a different game from the opponents would be
            a much stranger setting than one difficulty for the table. */}
        <DifficultyPicker
          value={difficulty}
          onChange={onDifficultyChange}
          label="Table"
          blurbs={SPADES_BLURBS}
        />
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

