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
import Link from "next/link";
import { type BotDifficulty } from "@/engine/types";
import { createPoker, DEFAULT_BIG_BLIND, DEFAULT_STARTING_STACK, MAX_BIG_BLIND, MAX_SEATS, MAX_STARTING_STACK, MIN_BIG_BLIND, MIN_SEATS, MIN_STARTING_STACK } from "@/games/poker/rules";
import type { PokerAction, PokerState } from "@/games/poker/types";
import { GameHost } from "@/table/GameHost";
import {
  OFFLINE_VIEW,
  PokerControls,
  pendingLabel,
  playerViews,
  roundSummary,
  standings,
} from "./table";
import { DifficultyPicker, botTable } from "@/ui/primitives/DifficultyPicker";
import { NumberStepper } from "@/ui/primitives/NumberStepper";
import { SetupShell } from "@/ui/primitives/SetupShell";


export default function PokerPlayPage() {
  const [seats, setSeats] = useState(6);
  const [difficulty, setDifficulty] = useState<BotDifficulty>("steady");
  const [startingStack, setStartingStack] = useState(DEFAULT_STARTING_STACK);
  const [bigBlind, setBigBlind] = useState(DEFAULT_BIG_BLIND);
  const [started, setStarted] = useState(false);
  const [gameKey, setGameKey] = useState(0);

  const definition = useMemo(
    () => createPoker(startingStack, bigBlind),
    [startingStack, bigBlind],
  );

  if (!started) {
    return (
      <SetupScreen
        seats={seats}
        onSeats={setSeats}
        difficulty={difficulty}
        onDifficulty={setDifficulty}
        startingStack={startingStack}
        onStartingStack={setStartingStack}
        bigBlind={bigBlind}
        onBigBlind={setBigBlind}
        onStart={() => setStarted(true)}
      />
    );
  }

  return (
    <GameHost<PokerState, PokerAction>
      key={gameKey}
      definition={definition}
      runtime={{ seats, difficulty: botTable(seats, difficulty) }}
      gameTitle="Poker"
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
      {(live) => <PokerControls view={OFFLINE_VIEW} live={live} />}
    </GameHost>
  );
}

/* ============================================================
   Setup
   ============================================================ */

/** What each tier actually does — grounded in `bots.ts`'s own tables
 * (`CALL_MARGIN`, `RAISE_EDGE`, `LIMPS_PREFLOP`, `BLUFF_CHANCE`), not
 * generic copy. `blurbs` is a required prop precisely so this stays
 * true of the code underneath it. */
const POKER_BLURBS = {
  casual: "Limps into most pots and calls too wide — it pays you off, but it never folds either.",
  steady: "Raises or folds before the flop, and weighs the pot odds on every call.",
  sharp: "Plays position, values its draws properly, varies its sizing, and bluffs just enough.",
};

function SetupScreen({
  seats,
  onSeats,
  difficulty,
  onDifficulty,
  startingStack,
  onStartingStack,
  bigBlind,
  onBigBlind,
  onStart,
}: {
  seats: number;
  onSeats: (n: number) => void;
  difficulty: BotDifficulty;
  onDifficulty: (d: BotDifficulty) => void;
  startingStack: number;
  onStartingStack: (n: number) => void;
  bigBlind: number;
  onBigBlind: (n: number) => void;
  onStart: () => void;
}) {
  return (
    <SetupShell>
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="eyebrow">New match</span>
        <h1 className="font-display text-4xl font-extrabold text-bone-50">Poker</h1>
        <p className="max-w-sm text-xs leading-relaxed text-bone-400">
          No-limit Texas Hold&apos;em. Fixed blinds, real side pots — a
          short stack going all-in only ever risks what they have left.
          Last seat standing with chips wins the match.
        </p>
      </div>

      <div className="flex w-full max-w-sm flex-col gap-5">
        <label className="flex flex-col gap-2">
          <span className="flex items-center justify-between text-xs font-bold text-bone-200">
            Players <span className="tnum text-brass-300">{seats}</span>
          </span>
          <input
            type="range"
            min={MIN_SEATS}
            max={MAX_SEATS}
            value={seats}
            onChange={(e) => onSeats(Number(e.target.value))}
            className="w-full accent-brass-400"
          />
        </label>

        <DifficultyPicker value={difficulty} onChange={onDifficulty} blurbs={POKER_BLURBS} />

        <div className="flex flex-col items-center gap-2">
          <span className="text-xs font-bold text-bone-200">Starting stack</span>
          <NumberStepper
            value={startingStack}
            min={MIN_STARTING_STACK}
            max={MAX_STARTING_STACK}
            step={100}
            label="chips"
            onChange={onStartingStack}
          />
        </div>

        <div className="flex flex-col items-center gap-2">
          <span className="text-xs font-bold text-bone-200">Big blind</span>
          <NumberStepper
            value={bigBlind}
            min={MIN_BIG_BLIND}
            max={MAX_BIG_BLIND}
            step={2}
            label="chips"
            onChange={onBigBlind}
          />
          <span className="text-center text-[11px] text-bone-500">
            Small blind is always half — {Math.max(1, Math.round(bigBlind / 2))} chips.
          </span>
        </div>
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
