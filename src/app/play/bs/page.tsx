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
import Link from "next/link";
import { type BotDifficulty, type PieceId } from "@/engine/types";
import { createBs } from "@/games/bs/rules";
import { CHALLENGE_MS_SOLO, DEFAULT_TARGET, MAX_SEATS, MIN_SEATS } from "@/games/bs/state";
import type { BsAction, BsState } from "@/games/bs/types";
import { GameHost } from "@/table/GameHost";
import type { GameRuntime } from "@/table/useGameRuntime";
import { DifficultyPicker, botTable } from "@/ui/primitives/DifficultyPicker";
import { NumberStepper } from "@/ui/primitives/NumberStepper";
import { SetupShell } from "@/ui/primitives/SetupShell";
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

const DEFAULT_SEATS = 4;

export default function BsPlayPage() {
  const [seats, setSeats] = useState(DEFAULT_SEATS);
  const [target, setTarget] = useState(DEFAULT_TARGET);
  const [difficulty, setDifficulty] = useState<BotDifficulty>("steady");
  const [started, setStarted] = useState(false);
  const [gameKey, setGameKey] = useState(0);
  /** The cards lifted out of the hand for the next claim, 1 to 4 of them. */
  const [held, setHeld] = useState<PieceId[]>([]);

  const definition = useMemo(
    () => createBs({ target, windowMs: CHALLENGE_MS_SOLO }),
    [target],
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
    return (
      <SetupScreen
        seats={seats}
        target={target}
        difficulty={difficulty}
        onSeatsChange={setSeats}
        onTargetChange={setTarget}
        onDifficultyChange={setDifficulty}
        onStart={() => setStarted(true)}
      />
    );
  }

  return (
    <GameHost<BsState, BsAction>
      key={gameKey}
      definition={definition}
      runtime={{ seats, difficulty: botTable(seats, difficulty) }}
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

/* ============================================================
   Setup
   ============================================================ */

/**
 * What each tier actually does — see `NERVE` in bots.ts.
 *
 * The middle line is the one worth reading twice, because it looks backwards:
 * a casual table doubts you MORE often, not less. Suspicion with nothing
 * behind it is right slightly under half the time and losing the call costs
 * the whole pile, so calling on a hunch is the beginner's move. A sharp table
 * doubts rarely and for reasons.
 */
const BS_BLURBS = {
  casual: "Doubts you on a hunch, bluffs big, and misses the arithmetic about half the time.",
  steady: "Counts what it holds of the rank, and keeps its own lies small enough to survive.",
  sharp: "Barely calls on a feeling — but claim more than the rank can supply and it has you.",
};

function SetupScreen({
  seats,
  target,
  difficulty,
  onSeatsChange,
  onTargetChange,
  onDifficultyChange,
  onStart,
}: {
  seats: number;
  target: number;
  difficulty: BotDifficulty;
  onSeatsChange: (v: number) => void;
  onTargetChange: (v: number) => void;
  onDifficultyChange: (d: BotDifficulty) => void;
  onStart: () => void;
}) {
  return (
    <SetupShell maxWidth="max-w-xs">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="eyebrow">New match</span>
        <h1 className="font-display text-4xl tracking-wider text-brass-300">BS</h1>
        <p className="max-w-xs text-sm text-bone-400">
          The rank climbs a card a turn. Put one to four cards face down and
          call them whatever the rank is — honestly or not. Anybody can call
          BS, and whoever is wrong swallows the pile. Empty your hand to take
          the round.
        </p>
      </div>

      <div className="flex w-full max-w-xs flex-col gap-3">
        <NumberStepper
          value={seats}
          min={MIN_SEATS}
          max={MAX_SEATS}
          label="players"
          onChange={onSeatsChange}
        />
        <NumberStepper
          value={target}
          min={1}
          max={9}
          label="rounds to win"
          onChange={onTargetChange}
        />
        <DifficultyPicker
          value={difficulty}
          onChange={onDifficultyChange}
          label="Table"
          blurbs={BS_BLURBS}
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
