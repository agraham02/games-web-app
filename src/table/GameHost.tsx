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

import { useEffect, useMemo } from "react";
import { HERO, type GameDefinition, type PieceId, type SeatId } from "@/engine/types";
import type { Density } from "./geometry";
import type { SeatView } from "./SeatRing";
import { TableSurface } from "./TableSurface";
import { SeatRing } from "./SeatRing";
import { DevPanel } from "./DevPanel";
import { HeroWinFlourish } from "./HeroWinFlourish";
import { DEFAULT_DEAL_STAGGER_MS, useDevSettings } from "./devSettings";
import { useTableStore } from "./store";
import { GameToaster } from "@/ui/disclosure";
import {
  GameEndSummary,
  RoundEndScorecard,
  RoundIntro,
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
  /** Additive felt-treatment knobs — see TableSurfaceProps. */
  topZone?: number;
  bottomZone?: number;
  pileAnchor?: number;
  /** Dev-only one-shot rigs, handed the live runtime so a game can build
   *  a state that is otherwise only reachable by waiting for it. */
  scenarios?: (live: GameRuntime<S, A>) => ReadonlyArray<{ label: string; run: () => void }>;
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
  topZone,
  bottomZone,
  pileAnchor,
  scenarios,
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
    // The store keeps the intuitive "higher = faster" multiplier (see
    // its own doc); useChoreographer wants the raw ms it's actually
    // built around, so the conversion happens right at this boundary.
    dealStaggerMs: DEFAULT_DEAL_STAGGER_MS / devSettings.dealSpeed,
  });
  // Synced into the shared table store, not read as a prop threaded
  // through PieceLayer — the piece that actually needs this (a hero-hand
  // card, in any game) lives several components below here, and a
  // written-in-an-effect store value is this app's established answer
  // to "ambient fact every hand piece needs" (see heroHoverIndex's own
  // doc). An effect, not a render-time write, for the same tearing
  // reason every other store write in this app avoids doing it inline —
  // see useChoreographer's own comment on exactly this.
  useEffect(() => {
    const store = useTableStore.getState();
    store.setHeroTurnActive(live.isHeroTurn);
    // A hover/tap-preview is meaningless once the hero's turn ends — but
    // nothing else ever cleared it. `heroHoverIndex` is a HAND INDEX, not
    // a piece id, and playing a card doesn't fire a real mouseleave (the
    // pointer never moves; the card just flies away and the rest of the
    // hand reindexes under it) — so the stored index silently kept
    // pointing at whatever card now occupies that slot, leaving it stuck
    // lifted/spread until the player happened to hover something else.
    // Turn-end is the one moment that's true for every game sharing this
    // hook, not just Spades.
    if (!live.isHeroTurn) store.setHeroHoverIndex(null);
  }, [live.isHeroTurn]);
  // The match winner takes priority, but is only ever non-null right at
  // the very end; the far more common "someone just won" moment in a
  // multi-round game is a round winner — see `roundWinner`'s doc for why
  // the two never disagree when both could apply. `winningSeats` is
  // every seat on the winning SIDE — for Dominoes/LRC that's the same
  // one seat `=== winningSeat` used to check directly; for a partnership
  // game (Spades) it's both members of the winning team, and `roundWinner`
  // never applies there (see GameRuntime.winningSeats's doc), so the
  // fallback to `[roundWinner]` only ever actually fires for a
  // single-winner game.
  const winningSeats = live.winningSeats ?? (live.roundWinner !== null ? [live.roundWinner] : null);
  const seatViews = players(live.state, live).map((view) =>
    winningSeats?.includes(view.seat) ? { ...view, winning: true } : view,
  );
  const board = (standings ?? winLoseStandings)(live.state, live, seatViews);

  // `pieces` is contractually fixed once `setup` has run (see its own
  // doc — the runtime calls it once and caches it), so rebuilding a
  // 52-entry map on every render just to hand it to the dev panel would
  // quietly undo that. Keyed on the definition, which is the only thing
  // that can change it.
  const pieceVocabulary = useMemo(
    () => definition.pieces(live.rawState),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [definition],
  );

  const pendingSeat = live.pendingReveal ? definition.currentSeat(live.state) : null;
  // Built only while it is actually showing: a game's scorecard reads
  // `state.result`, which is null for most of a round.
  const card = live.showRoundSummary ? roundSummary?.(live.state, live, seatViews) : null;

  return (
    <TableSurface
      seats={runtime.seats}
      density={density}
      handZone={handZone}
      topZone={topZone}
      bottomZone={bottomZone}
      pileAnchor={pileAnchor}
      onPieceTap={onPieceTap ? (id) => onPieceTap(id, live) : undefined}
    >
      <SeatRing players={seatViews} />
      <HeroWinFlourish show={winningSeats?.includes(HERO) ?? false} />
      <GameToaster />

      {/* Was already a finished component (see /lab/phases) but nothing
          actually rendered it on a real table — `dealingRound` is
          published the instant a round's deal is DISPATCHED, not once
          `state`/`round` catch up (that only happens after the whole
          deal has finished animating, far too late for an intro meant
          to appear as the deal begins). Self-clears on its own hold, so
          this is genuinely "a brief title card over the deal," not a
          mask blocking it — see useGameRuntime's own doc. */}
      <RoundIntro
        show={live.dealingRound !== null}
        eyebrow={`Round ${live.dealingRound ?? live.round}`}
        title={gameTitle}
      />

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
        // Every game gets the state editor for free — it works off the
        // game's own declared piece vocabulary and needs no per-game
        // code. `rawState`, not `live.state`, because the editor has to
        // edit what is actually there rather than the hero's redacted
        // view of it.
        debugState={live.rawState}
        pieces={pieceVocabulary}
        onDebugStateChange={(next) => live.replaceState(next as S)}
        scenarios={scenarios?.(live)}
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
