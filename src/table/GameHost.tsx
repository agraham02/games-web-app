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

import { HERO, type GameDefinition, type SeatId } from "@/engine/types";
import type { Density } from "./geometry";
import type { SeatView } from "./SeatRing";
import { TableSurface } from "./TableSurface";
import { SeatRing } from "./SeatRing";
import { DevPanel } from "./DevPanel";
import { HeroWinFlourish } from "./HeroWinFlourish";
import { useDevSettings } from "./devSettings";
import { GameToaster } from "@/ui/disclosure";
import { GameEndSummary } from "@/ui/phases/PhaseScreens";
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
  /** DevPanel's one line of game-specific context about the pending
   * turn — e.g. LRC's "Mia pending — 4 chips → 3 dice". Called only
   * while a turn is actually pending. Optional; the panel still works
   * (just with a generic "Turn pending" line) without it. */
  pendingLabel?: (state: S, seat: SeatId, live: GameRuntime<S, A>) => string;
  onRematch?: () => void;
  onLobby?: () => void;
  children: (live: GameRuntime<S, A>) => React.ReactNode;
}

export function GameHost<S, A>({
  definition,
  runtime,
  players,
  density,
  handZone,
  gameTitle,
  standings,
  stats,
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
  });
  const seatViews = players(live.state, live).map((view) =>
    live.winner === view.seat ? { ...view, winning: true } : view,
  );
  const board = (standings ?? winLoseStandings)(live.state, live, seatViews);

  const pendingSeat = live.pendingReveal ? definition.currentSeat(live.state) : null;

  return (
    <TableSurface seats={runtime.seats} density={density} handZone={handZone}>
      <SeatRing players={seatViews} />
      <HeroWinFlourish show={live.isOver && live.winner === HERO} />
      <GameToaster />

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
