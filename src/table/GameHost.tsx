"use client";

/**
 * Composes the shared table chrome around any GameDefinition — the
 * "compose the existing phase shells; only the slot content is new"
 * step CLAUDE.md already describes for adding a game. It didn't have a
 * concrete home until now because nothing had driven a real game yet.
 *
 * `children` is a render-prop, not plain JSX: the game-specific slot
 * (LRC's Roll button, a future game's bid pad) needs the live
 * `GameRuntime` — whose turn it is, whether input is accepted, how to
 * submit an action — and a render prop is the plainest way to hand that
 * down without a bespoke context provider for one hook's output.
 */

import { HERO, type GameDefinition, type PieceId, type SeatId } from "@/engine/types";
import type { Density } from "./geometry";
import type { SeatView } from "./SeatRing";
import { TableSurface } from "./TableSurface";
import { SeatRing } from "./SeatRing";
import { DevPanel } from "./DevPanel";
import { HeroWinFlourish } from "./HeroWinFlourish";
import { useDevSettings } from "./devSettings";
import { GameToaster } from "@/ui/disclosure";
import {
  GameEndSummary,
  RoundEndScorecard,
  type ScoreRow,
} from "@/ui/phases/PhaseScreens";
import { useGameRuntime, type GameRuntime, type GameRuntimeOptions } from "./useGameRuntime";

export interface GameHostProps<S, A> {
  definition: GameDefinition<S, A>;
  /** Setup-only: seats/seed/difficulty. Pacing fields (speed,
   * autoAdvance, turnHoldMs, endHoldMs) are owned by the embedded
   * DevPanel/devSettings, not the caller — see that module's doc for
   * why (surviving a rematch). Pass them here and they're just
   * overwritten. */
  runtime: GameRuntimeOptions;
  /** Cosmetic seat identity — name/colour/meta per bot seat. The host
   * doesn't compute this itself: player identity is flavour, not rules,
   * and a future account system would source it differently than a
   * bot-name table would. */
  players: (state: S, live: GameRuntime<S, A>) => SeatView[];
  density?: Density;
  /** Games with no hand of hidden pieces (LRC has none) pass 0 to
   * reclaim the bottom strip for their own controls. */
  handZone?: number;
  gameTitle: string;
  /** How this game ranks players at the end — LRC has only win/lose, a
   * scored game would report real point totals. Falls back to a plain
   * win/lose ranking if omitted. */
  standings?: (
    state: S,
    live: GameRuntime<S, A>,
    seats: SeatView[],
  ) => Array<{ seat: number; name: string; total: number }>;
  stats?: (state: S, live: GameRuntime<S, A>) => Array<{ label: string; value: string }>;
  /** Scorecard between rounds, for games played as a match. Omit for a
   * single-round game — nothing renders and the runtime never asks. */
  roundSummary?: (
    state: S,
    live: GameRuntime<S, A>,
    seats: SeatView[],
  ) => { title: string; rows: ScoreRow[]; note?: RoundNote } | null;
  /** Taps on a piece — the hero picking a card or tile off the table.
   * Only pieces in the hero's hand or explicitly `highlighted` are
   * clickable at all; see PieceLayer. Handed the live runtime for the
   * same reason `children` is: the handler almost always needs to submit
   * an action, and the runtime is not in scope where the prop is
   * written. */
  onPieceTap?: (id: PieceId, live: GameRuntime<S, A>) => void;
  /** DevPanel's one line of game-specific context about the pending
   * turn — e.g. LRC's "Mia pending — 4 chips → 3 dice". Called only
   * while a turn is actually pending. Optional; the panel still works
   * (just with a generic "Turn pending" line) without it. */
  pendingLabel?: (state: S, seat: SeatId, live: GameRuntime<S, A>) => string;
  onRematch?: () => void;
  onLobby?: () => void;
  children: (live: GameRuntime<S, A>) => React.ReactNode;
}

/** Optional callout under a round's scores — "blocked", "nobody scored". */
export type RoundNote = { tone: "warn" | "info"; title: string; body: string };

export function GameHost<S, A>({
  definition,
  runtime,
  players,
  density,
  handZone,
  gameTitle,
  standings,
  stats,
  roundSummary,
  onPieceTap,
  pendingLabel,
  onRematch,
  onLobby,
  children,
}: GameHostProps<S, A>) {
  const devSettings = useDevSettings();
  const live = useGameRuntime(definition, {
    ...runtime,
    autoAdvance: !devSettings.manualMode,
    speed: devSettings.speed,
    turnHoldMs: devSettings.turnHoldMs,
    endHoldMs: devSettings.endHoldMs,
    roundHoldMs: devSettings.roundHoldMs,
  });
  // The match winner takes priority, but is only ever non-null right at
  // the very end; the far more common "someone just won" moment in a
  // multi-round game is a round winner — see `roundWinner`'s doc for why
  // the two never disagree when both could apply.
  const winningSeat = live.winner ?? live.roundWinner;
  const seatViews = players(live.state, live).map((view) =>
    winningSeat === view.seat ? { ...view, winning: true } : view,
  );
  const board = (standings ?? winLoseStandings)(live.state, live, seatViews);

  const pendingSeat = live.pendingReveal ? definition.currentSeat(live.state) : null;
  // Built only while it is actually showing: a game's scorecard reads
  // `state.result`, which is null for most of a round.
  const card = live.showRoundSummary ? roundSummary?.(live.state, live, seatViews) : null;

  return (
    <TableSurface
      seats={runtime.seats}
      density={density}
      handZone={handZone}
      onPieceTap={onPieceTap ? (id) => onPieceTap(id, live) : undefined}
    >
      <SeatRing players={seatViews} />
      <HeroWinFlourish show={winningSeat === HERO} />
      <GameToaster />

      <RoundEndScorecard
        show={Boolean(card)}
        eyebrow={`Round ${live.round}`}
        title={card?.title ?? ""}
        rows={card?.rows ?? []}
        note={card?.note}
        onContinue={live.nextRound}
      />

      <GameEndSummary
        show={live.showSummary}
        winnerName={winnerLabel(live, seatViews)}
        winnerColour={winnerColour(live, seatViews)}
        subtitle={gameTitle}
        standings={board}
        stats={stats?.(live.state, live)}
        onRematch={onRematch}
        onLobby={onLobby}
      />

      <DevPanel
        pendingReveal={live.pendingReveal}
        advance={live.advance}
        pendingLabel={
          pendingSeat !== null ? pendingLabel?.(live.state, pendingSeat, live) : null
        }
      />

      {children(live)}
    </TableSurface>
  );
}

function winnerLabel<S, A>(live: GameRuntime<S, A>, seats: SeatView[]): string {
  if (live.winner === 0) return "You";
  const seat = seats.find((s) => s.seat === live.winner);
  return seat?.name ?? "Winner";
}

function winnerColour<S, A>(live: GameRuntime<S, A>, seats: SeatView[]): string {
  if (live.winner === 0) return "var(--color-brass-300)";
  return seats.find((s) => s.seat === live.winner)?.colour ?? "var(--color-brass-300)";
}

function winLoseStandings<S, A>(_state: S, live: GameRuntime<S, A>, seats: SeatView[]) {
  return [
    { seat: 0, name: "You", total: live.winner === 0 ? 1 : 0 },
    ...seats.map((s) => ({ seat: s.seat, name: s.name, total: live.winner === s.seat ? 1 : 0 })),
  ].sort((a, b) => b.total - a.total);
}
