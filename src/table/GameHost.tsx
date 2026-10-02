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

import { useEffect, useMemo, useState } from "react";
import { HERO, type GameDefinition, type PieceId, type SeatId } from "@/engine/types";
import type { Density } from "./geometry";
import type { SeatView } from "./SeatRing";
import { TableSurface } from "./TableSurface";
import { SeatRing } from "./SeatRing";
import { SeatBubbles } from "./SeatBubbles";
import { CountdownBar } from "@/ui/primitives/CountdownRing";
import { DevPanel } from "./DevPanel";
import { HeroWinFlourish } from "./HeroWinFlourish";
import { DEFAULT_DEAL_STAGGER_MS, useDevSettings } from "./devSettings";
import { handFloorOf, toastLane } from "./geometry";
import { useGeometry, useTableStore } from "./store";
import { GameToaster } from "@/ui/disclosure";
import { Button } from "@/ui/primitives/Button";
import {
  EndGameAction,
  SettingsSheet,
  TABLE_SETTINGS,
  useGameSettings,
  type GameSetting,
  type SettingValues,
} from "./gameSettings";
import { useSlamFeedback } from "./slamFeedback";
import {
  GameEndSummary,
  RoundEndScorecard,
  RoundIntro,
  type ScoreRow,
} from "@/ui/phases/PhaseScreens";
import { useGameRuntime, type GameRuntime, type GameRuntimeOptions } from "./useGameRuntime";
import { AUTO_CONTINUE_MS } from "@/session/roundEnd";
import { Settings as SettingsIcon } from "lucide-react";

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
  /** See `TableSurfaceProps.panelReserve`. Poker only. */
  panelReserve?: number;
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
  ) => { title: string; rows: ScoreRow[]; note?: RoundNote; target?: number } | null;
  /** What this game calls a round — "Hand" for poker. Default "Round". */
  roundNoun?: string;
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
  /**
   * Which seat is looking at this table. Omit offline — it defaults to the
   * hero at seat 0. `null` is a spectator, who owns no hand.
   */
  viewerSeat?: SeatId | null;
  /**
   * True when the runtime is a server's frames rather than a local
   * session. The only thing it changes is the dev panel, which is hidden.
   *
   * Not squeamishness about clutter — every control on that panel is
   * inert online and says nothing about it. `advance` and `replaceState`
   * are documented no-ops in `useOnlineRuntime` (the server owns the
   * clock and the state), `pendingReveal` is always false, and no online
   * table threads the pacing sliders through. So it renders a manual-turn
   * toggle that does not step, a state editor whose edits are discarded,
   * and five sliders that move nothing.
   *
   * A dev tool that lies is worse than no dev tool, and this is precisely
   * the one somebody reaches for when an online table looks wrong.
   */
  serverDriven?: boolean;
  /**
   * How long a room's scorecard waits before the next round deals itself
   * (`autoContinueFor`). Only read when `serverDriven`: a game on this
   * device waits for its one player.
   */
  autoContinueMs?: number;
  /**
   * The game's own in-game settings — the player's preferences, changeable
   * mid-game from the Settings button (see `gameSettings.tsx`). Every table
   * also gets `TABLE_SETTINGS` (Sound, Vibration), so the button is always
   * there.
   */
  settings?: readonly GameSetting[];
  /**
   * Buttons at the foot of the Settings sheet: an online table's "Step
   * away" and the leader's "End game" (the user's call, 2026-09-26 — they
   * used to sit on the table itself, in the corner). Offline, left out, the
   * sheet offers `EndGameAction` on `onLobby`.
   */
  menuActions?: React.ReactNode;
  /**
   * Controls for the top-right corner, beside the Settings button. One row
   * laid out here, rather than each table positioning its own box in the
   * same corner — two absolutely positioned boxes in one corner overlap
   * the moment both exist.
   */
  corner?: React.ReactNode;
  /**
   * Whether the viewer's own hand is live — full size, and answering taps.
   * Defaults to `live.isHeroTurn`, which is the right answer wherever being
   * asked to act means acting WITH the hand. BS is where it is not: in a
   * challenge window the viewer can be the seat the table is waiting on
   * with nothing to do but call or let it go, and their hand woke up for
   * a turn that was not theirs.
   */
  handActive?: (live: GameRuntime<S, A>) => boolean;
  /**
   * The seat the "…is thinking" line names. Defaults to `live.currentSeat`,
   * the seat the table's pacing waits on — which is the seat whose turn it
   * is everywhere but in BS's challenge window, where it walks the answer
   * queue one bot at a time. BS names the player whose play is under
   * challenge instead, the same seat its pods keep lit.
   */
  turnSeat?: (state: S, live: GameRuntime<S, A>) => SeatId | null;
  /**
   * When somebody ELSE deals the next round, what to say instead of the
   * button — a room's non-leaders get "Waiting for Ada to continue". Absent
   * offline, where the only person at the table always continues.
   */
  continueWaiting?: string;
  /**
   * What a room knows about each seat that no game does — the person's
   * photo — laid over whatever the game's own `players` built for it. The
   * one place a room's pods differ from a solo table's, so the six games'
   * `playerViews` need not know rooms exist. Absent offline.
   */
  seatExtras?: (seat: SeatId) => Partial<SeatView>;
  /**
   * A room's turn timer: whose move it is counting, and when the clock runs
   * out (by `Date.now()`). Another seat's goes round its pod; the viewer's
   * own, who has no pod, is a line along the very foot of the table.
   */
  turnClock?: { seat: SeatId; key: string; totalMs: number; endsAt: number } | null;
  /**
   * Under the standings on the winner's sheet — a room's settle-up, for a
   * game played for money (`SettleUp`).
   */
  summaryExtra?: React.ReactNode;
  children: (live: GameRuntime<S, A>, settings: SettingValues) => React.ReactNode;
}

/** Optional callout under a round's scores — "blocked", "nobody scored". */
export type RoundNote = { tone: "warn" | "info"; title: string; body: string };

/**
 * The offline host: it owns the game.
 *
 * Split from `GameHostView` below when rooms arrived, because a hook
 * cannot be skipped. An online table is driven by frames from a server and
 * has no local session at all — calling `useGameRuntime` "but ignoring it"
 * would deal a second, private game in the background and pace bots
 * against nobody.
 */
export function GameHost<S, A>({
  definition,
  runtime,
  ...rest
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
  return <GameHostView<S, A> definition={definition} runtime={runtime} live={live} {...rest} />;
}

/**
 * Everything a host renders, given a runtime from somewhere.
 *
 * Offline that runtime is `useGameRuntime`'s; online it is
 * `useOnlineRuntime`'s, built from server frames. Neither this component
 * nor anything below it can tell the difference, which is the whole reason
 * the online path needed no new table code.
 */
export function GameHostView<S, A>({
  definition,
  runtime,
  live,
  players,
  density,
  handZone,
  topZone,
  bottomZone,
  panelReserve,
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
  viewerSeat,
  serverDriven,
  autoContinueMs,
  settings,
  menuActions,
  corner,
  handActive,
  turnSeat,
  continueWaiting,
  seatExtras,
  turnClock,
  summaryExtra,
  roundNoun = "Round",
  children,
}: GameHostProps<S, A> & { live: GameRuntime<S, A> }) {
  const allSettings = useMemo(() => [...(settings ?? []), ...TABLE_SETTINGS], [settings]);
  const geometry = useGeometry();
  const [settingValues, setSetting] = useGameSettings(definition.id, allSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useSlamFeedback({
    sound: settingValues.sound !== false,
    vibration: settingValues.vibration !== false,
  });
  // Hints off draws no game's `dimmed` marks — see `TableState.hintsShown`.
  // A game without a Hints setting keeps them, as it always has.
  const hintsShown = settingValues.hints !== false;
  useEffect(() => {
    useTableStore.getState().setHintsShown(hintsShown);
  }, [hintsShown]);
  // Card spacing, for the hand's fan and its pan (`TableState.handFloor`).
  // A game without the setting gets the default, which is what it had.
  const handFloor = handFloorOf(settingValues.handSpacing);
  useEffect(() => {
    useTableStore.getState().setHandFloor(handFloor);
  }, [handFloor]);
  // Synced into the shared table store, not read as a prop threaded
  // through PieceLayer — the piece that actually needs this (a hero-hand
  // card, in any game) lives several components below here, and a
  // written-in-an-effect store value is this app's established answer
  // to "ambient fact every hand piece needs" (see heroHoverIndex's own
  // doc). An effect, not a render-time write, for the same tearing
  // reason every other store write in this app avoids doing it inline —
  // see useChoreographer's own comment on exactly this.
  const handLive = handActive ? handActive(live) : live.isHeroTurn;
  useEffect(() => {
    const store = useTableStore.getState();
    store.setHeroTurnActive(handLive);
    // A hover/tap-preview is meaningless once the hero's turn ends — but
    // nothing else ever cleared it. `heroHoverIndex` is a HAND INDEX, not
    // a piece id, and playing a card doesn't fire a real mouseleave (the
    // pointer never moves; the card just flies away and the rest of the
    // hand reindexes under it) — so the stored index silently kept
    // pointing at whatever card now occupies that slot, leaving it stuck
    // lifted/spread until the player happened to hover something else.
    // Turn-end is the one moment that's true for every game sharing this
    // hook, not just Spades.
    if (!handLive) store.setHeroHoverIndex(null);
  }, [handLive]);
  // The match winner takes priority, but is only ever non-null right at
  // the very end; the far more common "someone just won" moment in a
  // multi-round game is a round winner — see `roundWinner`'s doc for why
  // the two never disagree when both could apply. `winningSeats` is
  // every seat on the winning SIDE — for Dominoes/LRC that's the same
  // one seat `=== winningSeat` used to check directly; for a partnership
  // game (Spades) it's both members of the winning team, and `roundWinner`
  // never applies there (see GameRuntime.winningSeats's doc).
  //
  // `roundWinningSeats` already does the "wrap the single winner"
  // fallback internally, so this reads the same for a single-winner game
  // (Dominoes cut-throat, LRC) and correctly crowns BOTH partners when a
  // partnership game scores a round — team dominoes, the first to do so.
  const winningSeats = live.winningSeats ?? live.roundWinningSeats;
  const seatViews = players(live.state, live).map((view) => {
    const room = seatExtras?.(view.seat);
    let seen = room ? { ...view, ...room } : view;
    if (turnClock && turnClock.seat === view.seat) seen = { ...seen, timer: turnClock };
    return winningSeats?.includes(view.seat) ? { ...seen, winning: true } : seen;
  });
  // The viewer's own clock. Not a spectator's (`viewerSeat` null): they
  // have no move to make.
  const ownClock =
    turnClock && viewerSeat !== null && turnClock.seat === (viewerSeat ?? HERO) ? turnClock : null;
  const board = standings
    ? standings(live.state, live, seatViews)
    : winLoseStandings(live.state, live, seatViews, viewerSeat);

  // Who the table is waiting on, when it is not the viewer (a spectator is
  // never on turn). It names who and never what they could do. A turn
  // being played out right now is a bot's think beat; one the table is
  // merely parked on is a person who has not moved yet.
  const onTurn = turnSeat ? turnSeat(live.state, live) : live.currentSeat;
  const waitingOn =
    onTurn !== null && onTurn !== (viewerSeat === undefined ? HERO : viewerSeat)
      ? seatViews.find((v) => v.seat === onTurn)
      : undefined;
  // Offline every other seat is a bot, so it is thinking from the moment
  // its turn opens; reading the think beat there flickered "Waiting for
  // Mia" before every bot move. Online the beat is what tells a bot (which
  // has one) from a person (who does not). A seat named by `turnSeat` that
  // the pacing is NOT waiting on has already moved, so "Waiting for" would
  // be false of it; its turn is simply still the one on show.
  const turnLine = waitingOn
    ? waitingOn.thinking || !serverDriven || onTurn !== live.currentSeat
      ? `${waitingOn.name} is thinking…`
      : `Waiting for ${waitingOn.name}`
    : null;
  useEffect(() => {
    useTableStore.getState().setTurnLine(turnLine);
  }, [turnLine]);
  useEffect(() => () => useTableStore.getState().setTurnLine(null), []);

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

  // A card is read from its corner, so on a short screen a card hand may run
  // off the bottom edge and give the board what it saves; a domino needs
  // both halves, so a tile game keeps its whole hand (see `handBleed`).
  const handBleed = !Object.values(pieceVocabulary).some((m) => m.kind === "tile");

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
      panelReserve={panelReserve}
      pileAnchor={pileAnchor}
      viewerSeat={viewerSeat}
      handBleed={handBleed}
      onPieceTap={onPieceTap ? (id) => onPieceTap(id, live) : undefined}
    >
      <SeatRing players={seatViews} />
      <SeatBubbles players={seatViews} />
      {ownClock ? (
        // The very foot of the table, over the hand if need be (the user's
        // call): thin, and taps go straight through it.
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-1800 h-1">
          <CountdownBar
            key={ownClock.key}
            totalMs={ownClock.totalMs}
            endsAt={ownClock.endsAt}
            onDanger={() => {
              if (settingValues.vibration !== false) navigator.vibrate?.(60);
            }}
          />
        </div>
      ) : null}
      <HeroWinFlourish
        show={
          // A spectator has no side to celebrate, so confetti for one would
          // be confetti for a game they are not in.
          viewerSeat !== null && (winningSeats?.includes(viewerSeat ?? HERO) ?? false)
        }
      />
      <GameToaster top={geometry ? toastLane(geometry) : undefined} />

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
        eyebrow={`${roundNoun} ${live.dealingRound ?? live.round}`}
        title={gameTitle}
      />

      <RoundEndScorecard
        show={Boolean(card)}
        eyebrow={`${roundNoun} ${live.round}`}
        title={card?.title ?? ""}
        rows={card?.rows ?? []}
        note={card?.note}
        target={card?.target}
        onContinue={live.nextRound}
        waiting={continueWaiting}
        // A room's round deals itself if nobody continues; a game on this
        // device waits for its one player.
        autoContinueMs={serverDriven ? (autoContinueMs ?? AUTO_CONTINUE_MS) : undefined}
        // The chat button, which the card covers: summaries are where table
        // talk comes back (`ChatMode`), so it has to be reachable on them.
        corner={corner}
      />

      <GameEndSummary
        show={live.showSummary}
        winnerName={winnerLabel(live, seatViews, viewerSeat)}
        winnerColour={winnerColour(live, seatViews, viewerSeat)}
        subtitle={gameTitle}
        standings={board}
        stats={stats?.(live.state, live)}
        onRematch={onRematch}
        onLobby={onLobby}
        corner={corner}
      >
        {summaryExtra}
      </GameEndSummary>

      {serverDriven ? null : (
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
      )}

      {children(live, settingValues)}

      <div className="absolute top-2 right-2 z-1900 flex gap-2">
        {corner}
        {/* An icon, like the chat beside it online (the user, 2026-09-29):
            two words side by side crowded a phone's corner. */}
        <Button size="sm" aria-label="Settings" title="Settings" onClick={() => setSettingsOpen(true)}>
          <SettingsIcon size={16} aria-hidden />
        </Button>
      </div>
      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={allSettings}
        values={settingValues}
        onChange={setSetting}
        // A game on this device can always be ended from here; a room's
        // table brings its own buttons instead.
        actions={menuActions ?? (serverDriven || !onLobby ? undefined : <EndGameAction onEnd={onLobby} />)}
      />
    </TableSurface>
  );
}

/**
 * Who "You" is, which is not always seat 0.
 *
 * These three read the viewer's seat rather than assuming the hero owns
 * it — the same `HERO`-is-seat-0 assumption `playerViews` was already
 * fixed for, left behind in the shared host. Online it produced two
 * wrong endings at once: whoever happened to sit at seat 0 winning told
 * EVERYBODY "You won", and a viewer winning from any other seat got the
 * literal word "Winner", because `seatViews` deliberately omits the
 * viewer's own seat and there was nothing else to look them up in.
 *
 * `null` is a spectator, who is nobody at this table — so no seat is
 * ever "You" for them.
 */
function isViewer(viewerSeat: SeatId | null | undefined, seat: SeatId | null): boolean {
  if (seat === null) return false;
  if (viewerSeat === null) return false; // Spectator.
  return seat === (viewerSeat ?? HERO);
}

export function winnerLabel<S, A>(
  live: GameRuntime<S, A>,
  seats: SeatView[],
  viewerSeat: SeatId | null | undefined,
): string {
  if (isViewer(viewerSeat, live.winner)) return "You";
  const seat = seats.find((s) => s.seat === live.winner);
  return seat?.name ?? "Winner";
}

export function winnerColour<S, A>(
  live: GameRuntime<S, A>,
  seats: SeatView[],
  viewerSeat: SeatId | null | undefined,
): string {
  if (isViewer(viewerSeat, live.winner)) return "var(--color-brass-300)";
  return seats.find((s) => s.seat === live.winner)?.colour ?? "var(--color-brass-300)";
}

export function winLoseStandings<S, A>(
  _state: S,
  live: GameRuntime<S, A>,
  seats: SeatView[],
  viewerSeat: SeatId | null | undefined,
) {
  // A spectator is in no row of their own; everybody else gets one,
  // because `seats` omits whoever is looking.
  const mine = viewerSeat === null ? null : (viewerSeat ?? HERO);
  return [
    ...(mine === null
      ? []
      : [{ seat: mine, name: "You", total: live.winner === mine ? 1 : 0 }]),
    ...seats.map((s) => ({ seat: s.seat, name: s.name, total: live.winner === s.seat ? 1 : 0 })),
  ].sort((a, b) => b.total - a.total);
}
