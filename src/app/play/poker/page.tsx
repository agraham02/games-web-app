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

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { HERO, type BotDifficulty, type SeatId } from "@/engine/types";
import { botColour, botName } from "@/games/_shared/botIdentity";
import { parseCard } from "@/games/_shared/cards";
import {
  createPoker,
  DEFAULT_BIG_BLIND,
  DEFAULT_STARTING_STACK,
  legalActions,
  MAX_BIG_BLIND,
  MAX_SEATS,
  MAX_STARTING_STACK,
  MIN_BIG_BLIND,
  MIN_SEATS,
  MIN_STARTING_STACK,
} from "@/games/poker/rules";
import {
  amountToCall,
  betRange,
  positionBadge,
  potTotal,
  seatHoleCards,
} from "@/games/poker/state";
import { bestOfSeven, HAND_CATEGORY_INFO, type HandCategory } from "@/games/poker/hand";
import type { PokerAction, PokerState } from "@/games/poker/types";
import { GameHost } from "@/table/GameHost";
import { HandZone } from "@/table/HandZone";
import type { SeatView } from "@/table/SeatRing";
import type { GameRuntime } from "@/table/useGameRuntime";
import { InfoSheet } from "@/ui/disclosure";
import { DifficultyPicker, botTable } from "@/ui/primitives/DifficultyPicker";
import { NumberStepper } from "@/ui/primitives/NumberStepper";
import { SetupShell } from "@/ui/primitives/SetupShell";
import { HeroStatusBadge, TurnIndicator, type ScoreRow } from "@/ui/phases/PhaseScreens";
import { TRANSITIONS } from "@/motion/presets";

type Live = GameRuntime<PokerState, PokerAction>;

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
      players={playerViews}
      standings={standings}
      stats={(state) => [
        { label: "Hand", value: `${state.hand}` },
        { label: "Blinds", value: `${state.smallBlind}/${state.bigBlind}` },
      ]}
      roundSummary={roundSummary}
      pendingLabel={pendingLabel}
      onRematch={() => setGameKey((k) => k + 1)}
      onLobby={() => setStarted(false)}
    >
      {(live) => <PokerControls live={live} />}
    </GameHost>
  );
}

function standings(state: PokerState, _live: Live, seats: SeatView[]) {
  return [
    { seat: HERO, name: "You", total: state.stacks[HERO] ?? 0 },
    ...seats.map((s) => ({ seat: s.seat, name: s.name, total: state.stacks[s.seat] ?? 0 })),
  ].sort((a, b) => b.total - a.total);
}

/**
 * `RoundEndScorecard`'s content — every seat DEALT INTO the hand that
 * just ended (`state.folded`'s keys are fixed for the hand's whole
 * lifetime and not reset until the next `startRound`, so this is still
 * readable here even after `result` has settled).
 */
function roundSummary(state: PokerState) {
  const result = state.result;
  if (!result) return null;

  const name = (seat: SeatId) => (seat === HERO ? "You" : botName(seat));
  const colour = (seat: SeatId) => (seat === HERO ? "var(--color-brass-300)" : botColour(seat));

  const rows: ScoreRow[] = Object.keys(state.folded)
    .map(Number)
    .map((seat) => ({
      seat,
      name: name(seat),
      colour: colour(seat),
      detail: result.winningSeats.includes(seat)
        ? "won"
        : state.folded[seat]
          ? "folded"
          : undefined,
      delta: result.deltas[seat] ?? 0,
      total: state.stacks[seat] ?? 0,
    }))
    .sort((a, b) => b.total - a.total);

  const winners = result.winningSeats.map(name);
  const title =
    winners.length === 1
      ? `${winners[0]} ${winners[0] === "You" ? "win" : "wins"} the pot`
      : `${winners.join(" & ")} split the pot`;

  return { title, rows };
}

/** DevPanel's game-specific line — see GameHostProps.pendingLabel. */
function pendingLabel(state: PokerState, seat: SeatId): string {
  if (state.pendingShowdown) return `${botName(seat)} pending — show or muck`;
  const toCall = amountToCall(state, seat);
  return `${botName(seat)} pending — ${toCall > 0 ? `to call ${toCall}` : "checks or bets"}`;
}

function playerViews(state: PokerState, live: Live): SeatView[] {
  const out: SeatView[] = [];
  for (let seat = 1; seat < state.seats; seat++) {
    const inHand = seat in state.folded;
    // Busted from the whole MATCH, not merely folded this hand — see
    // `isAllIn`'s own caution in state.ts: a 0 stack mid-hand usually
    // means all-in, not out. `!inHand` is what tells the two apart here.
    const busted = !inHand && (state.stacks[seat] ?? 0) === 0;
    const folded = inHand && state.folded[seat];
    const stack = state.stacks[seat] ?? 0;
    const bet = state.streetCommitted[seat] ?? 0;

    const meta = busted ? "Out" : folded ? "Folded" : bet > 0 ? `$${stack} · bet $${bet}` : `$${stack}`;

    // Deliberately keyed off `lastAction`, not `currentSeat`/`toAct` —
    // see LRC's own doc on this exact pattern: `state.toAct[0]` already
    // names the NEXT actor the instant a decision is computed, before
    // its `think` beat has actually played, which would jump the glow
    // to the wrong pod during the pause.
    const thisSeatActing = live.busy && live.lastAction?.seat === seat;

    out.push({
      seat,
      name: botName(seat),
      colour: botColour(seat),
      meta,
      active: thisSeatActing,
      thinking: thisSeatActing,
      eliminated: busted,
      badge: positionBadge(state, seat) ?? undefined,
    });
  }
  return out;
}

/* ============================================================
   The hero-facing controls: HandZone chrome, the betting panel,
   the show-or-muck bar, and the hand-rankings sheet.
   ============================================================ */

function PokerControls({ live }: { live: Live }) {
  const state = live.state;
  const [hintsOpen, setHintsOpen] = useState(false);

  const showdownPending = Boolean(state.pendingShowdown) && live.isHeroTurn;
  useShowdownCountdown(live, showdownPending);

  const heroBadge = positionBadge(state, HERO);
  const toCall = amountToCall(state, HERO);
  const stack = state.stacks[HERO] ?? 0;
  const heroBet = state.streetCommitted[HERO] ?? 0;

  return (
    <>
      <HandZone
        bar={showdownPending ? <ShowMuckBar live={live} /> : undefined}
        left={
          <div className="flex items-center gap-1.5">
            <HeroStatusBadge
              inline
              label="You"
              detail={`$${stack}${heroBet > 0 ? ` · bet $${heroBet}` : ""}`}
            />
            {heroBadge ? <HeroPositionBadge label={heroBadge} /> : null}
          </div>
        }
        center={
          <TurnIndicator
            inline
            show={live.isHeroTurn && !showdownPending}
            label={toCall > 0 ? `To call $${toCall}` : "Check or bet"}
          />
        }
        right={<HintsButton onOpen={() => setHintsOpen(true)} />}
      />

      {live.isHeroTurn && !state.pendingShowdown ? <BettingPanel live={live} /> : null}

      <HandRankingsSheet open={hintsOpen} onClose={() => setHintsOpen(false)} state={state} />
    </>
  );
}

/**
 * Dealer/small-blind/big-blind marker for the HERO's own position.
 * `SeatRing` never renders a pod for seat 0, so `PositionBadge` there
 * (the identical small chip, for every OTHER seat) has no hero
 * equivalent to hook into — this is that equivalent, living next to
 * `HeroStatusBadge` instead of on a pod.
 */
function HeroPositionBadge({ label }: { label: "D" | "SB" | "BB" }) {
  const title = label === "D" ? "Dealer" : label === "SB" ? "Small blind" : "Big blind";
  return (
    <span
      title={title}
      aria-label={title}
      className="flex h-4 min-w-4 items-center justify-center rounded-full bg-brass-400 px-1 text-[9px] leading-none font-extrabold text-felt-950"
    >
      {label}
    </span>
  );
}

function HintsButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-1 rounded-full bg-felt-950/78 px-2.5 py-1.5 text-[10px] font-bold text-bone-300 ring-1 ring-bone-50/12 hover:bg-brass-400/20 hover:text-brass-300"
    >
      <span aria-hidden>♦</span>
      <span className="truncate">Hands</span>
    </button>
  );
}

/* ============================================================
   Betting: fold/check/call plus bet/raise sizing
   ============================================================ */

/**
 * NOT a `BlockingDialog` — POLICY.md's ladder table literally lists
 * "fold/call/raise" under that rung, but the actual working convention
 * (Spades' `NumericBidPanel`, justified by POLICY's own "never put
 * reference info in a modal" rule) is that any decision needing your
 * own stack/hand visible stays non-modal. Sizing a bet needs both. Same
 * free-floating shape as `NumericBidPanel` — not `HandZone`'s `bar`
 * slot, which is sized for a single compact row and this needs more.
 *
 * Remounts fresh every time it's the hero's turn (the parent only
 * renders it while `live.isHeroTurn`), so the slider's own local state
 * starting at the fresh legal minimum needs no effect to reset it —
 * the same reasoning `NumericBidPanel` relies on.
 */
function BettingPanel({ live }: { live: Live }) {
  const state = live.state;
  const legal = legalActions(state, HERO);
  const canFold = legal.some((a) => a.t === "fold");
  const canCheck = legal.some((a) => a.t === "check");
  const canCall = legal.some((a) => a.t === "call");
  const canBet = legal.some((a) => a.t === "bet");
  const canRaise = legal.some((a) => a.t === "raise");

  const toCall = amountToCall(state, HERO);
  const range = canBet || canRaise ? betRange(state, HERO) : null;
  const [amount, setAmount] = useState(range?.min ?? 0);

  const submit = (action: PokerAction) => live.submitAction(action);
  const submitBet = () => {
    if (!range) return;
    submit(canBet ? { t: "bet", to: amount } : { t: "raise", to: amount });
  };

  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-1800 flex justify-center px-4"
      style={{ bottom: "calc(var(--hand-zone, 150px) + 12px)" }}
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={TRANSITIONS.ui}
        className="pointer-events-auto flex w-[min(22rem,92vw)] flex-col gap-3 rounded-2xl border border-brass-400/25 bg-linear-to-b from-felt-800/95 to-felt-900/95 p-4 shadow-e2 backdrop-blur-md"
      >
        {range ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-[11px] text-bone-400">
              <span>{canBet ? "Bet" : "Raise to"}</span>
              <span className="tnum font-bold text-brass-300">${amount}</span>
            </div>
            <input
              type="range"
              min={range.min}
              max={range.max}
              step={Math.max(1, Math.round(state.bigBlind / 2))}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              className="w-full accent-brass-400"
              disabled={range.min === range.max}
            />
            <div className="flex gap-1.5">
              {betPresets(potTotal(state), range).map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setAmount(preset.to)}
                  className="flex-1 rounded-full bg-bone-50/6 py-1.5 text-[10px] font-bold text-bone-200 ring-1 ring-bone-50/14 hover:bg-brass-400/15 hover:text-brass-300"
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={submitBet}
              className="w-full rounded-lg bg-linear-to-b from-brass-300 to-brass-500 py-2.5 text-sm font-extrabold text-felt-950 shadow-e2"
            >
              {amount >= range.max
                ? `${canBet ? "Bet" : "Raise to"} $${amount} — all in`
                : `${canBet ? "Bet" : "Raise to"} $${amount}`}
            </button>
          </div>
        ) : null}

        <div className="flex gap-2">
          {canFold ? (
            <button
              type="button"
              onClick={() => submit({ t: "fold" })}
              className="flex-1 rounded-full bg-bone-50/8 py-2.5 text-sm font-semibold text-bone-200 ring-1 ring-bone-50/18"
            >
              Fold
            </button>
          ) : null}
          {canCheck ? (
            <button
              type="button"
              onClick={() => submit({ t: "check" })}
              className="flex-1 rounded-full bg-bone-50/8 py-2.5 text-sm font-semibold text-bone-200 ring-1 ring-bone-50/18"
            >
              Check
            </button>
          ) : null}
          {canCall ? (
            <button
              type="button"
              onClick={() => submit({ t: "call" })}
              className="flex-1 rounded-full bg-bone-50/8 py-2.5 text-sm font-semibold text-bone-200 ring-1 ring-bone-50/18"
            >
              Call ${toCall}
            </button>
          ) : null}
        </div>
      </motion.div>
    </div>
  );
}

function betPresets(pot: number, range: { min: number; max: number }) {
  const clamp = (n: number) => Math.max(range.min, Math.min(range.max, Math.round(n)));
  return [
    { label: "½ pot", to: clamp(pot * 0.5) },
    { label: "Pot", to: clamp(pot) },
    { label: "All in", to: range.max },
  ];
}

/* ============================================================
   Show or muck
   ============================================================ */

/** Real convention: a hand is mucked by default unless actively shown —
 * same shape as Rummy's `CLAIM_MS`/`useClaimCountdown`, minus the
 * depleting-ring polish (`ClaimRing`) that window earns from being the
 * one deliberately loud moment in that game; here a plain timed bar is
 * enough for a decision that carries no real stakes either way. */
const SHOWDOWN_MS = 5000;

function useShowdownCountdown(live: Live, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => live.submitAction({ t: "muck" }), SHOWDOWN_MS);
    return () => clearTimeout(t);
    // `live` is rebuilt every render; keying on `active` alone is what
    // keeps this a single timer per decision rather than one restarted
    // on every frame — same shape as Rummy's own `useClaimCountdown`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

function ShowMuckBar({ live }: { live: Live }) {
  return (
    <>
      <span className="min-w-0 shrink truncate text-[10px] font-bold text-brass-300">
        Show your hand?
      </span>
      <button
        type="button"
        onClick={() => live.submitAction({ t: "muck" })}
        className="rounded-full bg-bone-50/8 px-4 py-2 text-xs font-bold text-bone-200 ring-1 ring-bone-50/18"
      >
        Muck
      </button>
      <button
        type="button"
        onClick={() => live.submitAction({ t: "show" })}
        className="rounded-full bg-linear-to-b from-brass-300 to-brass-500 px-4 py-2 text-xs font-extrabold text-felt-950 shadow-e2"
      >
        Show
      </button>
    </>
  );
}

/* ============================================================
   Hand-rankings reference sheet
   ============================================================ */

/**
 * Rung 5 `InfoSheet` — on-demand reference, non-modal (POLICY.md's hard
 * rule: never put reference info in a modal — a player wants this open
 * while still looking at their own cards). Opened from `HandZone`'s
 * `right` slot, the same spot Rummy's `SortMenu` occupies.
 */
function HandRankingsSheet({
  open,
  onClose,
  state,
}: {
  open: boolean;
  onClose: () => void;
  state: PokerState;
}) {
  const hole = seatHoleCards(state, HERO).map(parseCard);
  const community = state.communityOrder.map(parseCard);
  // Poker's named categories aren't meaningfully defined on 2 cards
  // alone — nothing highlights until the flop gives a real 5-card read.
  const current: HandCategory | null =
    hole.length + community.length >= 5 ? bestOfSeven([...hole, ...community]).category : null;

  return (
    <InfoSheet open={open} title="Hand rankings" onClose={onClose}>
      <ul className="flex flex-col gap-1.5">
        {HAND_CATEGORY_INFO.map((entry) => {
          const highlighted = entry.category === current;
          return (
            <li
              key={entry.category}
              className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 ${
                highlighted ? "bg-brass-400/20 ring-1 ring-brass-400/50" : "bg-bone-50/4"
              }`}
            >
              <span
                className={`text-sm font-semibold ${highlighted ? "text-brass-300" : "text-bone-100"}`}
              >
                {entry.name}
              </span>
              <span className="text-right text-[11px] text-bone-400">{entry.example}</span>
            </li>
          );
        })}
      </ul>
      {current === null ? (
        <p className="mt-3 text-center text-[11px] text-bone-500">
          Your current hand highlights here once the flop is dealt.
        </p>
      ) : null}
    </InfoSheet>
  );
}

/* ============================================================
   Setup
   ============================================================ */

/** What each tier actually does — see `bots.ts`'s `PREFLOP_FLOOR`/
 * `USES_POT_ODDS`/`BLUFF_CHANCE` tables. */
const POKER_BLURBS = {
  casual: "Plays face value and rarely folds a made pair — no eye for the pot.",
  steady: "Weighs pot odds before calling, and tightens up before the flop.",
  sharp: "Reads draws and pot odds, varies its bet sizing, and bluffs just enough to keep you honest.",
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
