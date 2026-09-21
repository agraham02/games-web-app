"use client";

/**
 * BS — the table content, shared by the solo screen and the room.
 *
 * Everything here that decides what something MEANS lives here rather than
 * in either shell, because it is a rules question with one answer. The two
 * shells differ only in where the held selection is kept (the page in its own
 * state, the room in `RoomScreen` so it survives a trip to the lobby), and
 * that is a real difference. Which cards may be picked up, what a tap does,
 * and when a challenge may be answered are not.
 *
 * The game-specific parts:
 *
 *  - **the claim bar.** Two modes in one band (see `HandZone`'s `bar`): the
 *    cards you have picked up and what you are about to claim them as, or,
 *    while a window is open, a `BS!` button with the clock drawn round it.
 *    Non-modal throughout — choosing what to claim means looking at your own
 *    hand, and POLICY.md's first hard rule is that reference information
 *    never goes in a modal.
 *  - **the rank badge.** The one thing that is always true and always needed:
 *    what the next play has to claim. Rung 1, inline, never blocks.
 *  - **the pile rail.** Every claim so far as who / how many / what rank,
 *    which is public because it was announced out loud. Rung 4, because it
 *    is reference consulted WHILE playing.
 *
 * What is deliberately absent, and must stay absent: nothing says how many
 * of your selected cards actually match the rank, nothing marks a claim you
 * could prove impossible, and nothing hints that a bot is about to be
 * caught. An affordance merely appearing is a tell. Feedback after the
 * reveal is fine; a hint before the call is not.
 */

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import type { PieceId, SeatId } from "@/engine/types";
import { botColour, botName } from "@/games/_shared/botIdentity";
import { claimWords, rankPlural, rankPluralTitle } from "@/games/bs/cards";
import {
  MAX_PER_PLAY,
  challengeDeadlineMs,
  entitledToCall,
  livePlay,
  pileSize,
} from "@/games/bs/state";
import type { BsAction, BsState } from "@/games/bs/types";
import { HandZone, handHeaderHeight } from "@/table/HandZone";
import type { SeatView } from "@/table/SeatRing";
import { useGeometry, useTableStore } from "@/table/store";
import { seatCue } from "@/table/turnCue";
import type { GameRuntime } from "@/table/useGameRuntime";
import { PeekRail } from "@/ui/disclosure/PeekRail";
import { CountdownButton } from "@/ui/primitives/CountdownButton";
import { HeroStatusBadge, TurnIndicator, type ScoreRow } from "@/ui/phases/PhaseScreens";

type Live = GameRuntime<BsState, BsAction>;

/**
 * Who is looking at this table, and what everyone is called.
 *
 * Offline that is seat 0 and a table of bot names; online it is whatever seat
 * the server sat you in and the real names of the people in the room.
 */
export interface BsView {
  viewerSeat: SeatId;
  nameFor: (seat: SeatId) => string;
  colourFor: (seat: SeatId) => string;
  /**
   * Whether a bot is currently playing that seat for the person who owns it.
   * Optional because only a room can answer it. Supplied by `awayFrom(frame)`.
   */
  awayFor?: (seat: SeatId) => boolean;
}

/** Seat 0, against bots — every offline game. */
export const OFFLINE_VIEW: BsView = {
  viewerSeat: 0,
  nameFor: botName,
  colourFor: botColour,
};

/** Four of a rank exist, so nobody can ever honestly claim a fifth. */
export const PLAY_PICK_LIMIT = MAX_PER_PLAY;

/** Is the viewer actually sitting at this table? `SPECTATOR_SEAT` is -1. */
function isSeated(view: BsView, state: BsState): boolean {
  return view.viewerSeat >= 0 && view.viewerSeat < state.seats;
}

/**
 * May the viewer put cards down right now?
 *
 * Deliberately not `live.isHeroTurn`, which compares against `currentSeat` —
 * and during a challenge window `currentSeat` names only the seat the PACING
 * waits on. The seat on turn may play straight over the top of a window
 * (that is what stops a generous window holding up the table), so asking the
 * turn directly is the only thing that gets it right.
 */
export function canPlay(view: BsView, live: Live): boolean {
  const state = live.state;
  if (live.isOver || state.result !== null || !state.dealt) return false;
  if (state.pendingTake !== null) return false;
  if (live.animating) return false;
  return state.turn === view.viewerSeat;
}

/** Is the viewer still entitled to doubt the play on the table? */
export function canCall(view: BsView, live: Live): boolean {
  return entitledToCall(live.state, view.viewerSeat);
}

/**
 * Which of the two the action band shows - for both screens, and testable
 * without mounting a table.
 *
 * A window is the louder of the two and wins the row, because it is the one
 * that expires. But it cannot win OUTRIGHT, and that was the bug: a window
 * enrols every seat but the claimer, so the seat on turn is ALWAYS entitled
 * to call as well, and preferring `calling` unconditionally meant the player
 * on turn was never shown a Play button at all. That deletes the interrupt
 * the rules go out of their way to grant (see `canPlay`, and `legalActions`):
 * a person playing straight over an open window is the most natural thing
 * that ends one, and it is the only defence a generous window has. Worse,
 * taps were still accepted, so the player lifted cards out of their hand and
 * then had nothing to press - until they pressed "Let it go" and forfeited
 * the very challenge the band was protecting.
 *
 * Lifting a card is the signal. Until then the window owns the row; once
 * cards are up the player has plainly chosen to play, so the claim owns it.
 */
export function barMode(
  view: BsView,
  live: Live,
  heldCount: number,
): "challenge" | "claim" | null {
  const playing = canPlay(view, live);
  if (playing && heldCount > 0) return "claim";
  if (canCall(view, live)) return "challenge";
  return playing ? "claim" : null;
}

/* ============================================================
   Picking cards up
   ============================================================ */

/**
 * What picking a card up MEANS — for both screens.
 *
 * `selected` rather than `highlighted`, because these cards are literally
 * being lifted out of the hand to be put down, and `layoutPiece` gives a
 * selected piece a real lift above everything else. Spades' exchange uses
 * `highlighted` for the opposite reason: there the cards are being MARKED
 * while staying where they are.
 */
export function togglePlayCard(held: readonly PieceId[], id: PieceId): PieceId[] {
  const store = useTableStore.getState();
  if (held.includes(id)) {
    store.patch(id, { selected: false });
    return held.filter((x) => x !== id);
  }
  // A fifth tap is ignored until one is put back, rather than silently
  // dropping the oldest — the player chose those four.
  if (held.length >= PLAY_PICK_LIMIT) return [...held];
  store.patch(id, { selected: true });
  return [...held, id];
}

/** Puts every held card down. The store patch is the half easily forgotten. */
export function clearPlayCards(held: readonly PieceId[]): void {
  const store = useTableStore.getState();
  for (const id of held) store.patch(id, { selected: false });
}

export function onPieceTap(
  view: BsView,
  id: PieceId,
  live: Live,
  toggleHeld: (id: PieceId) => void,
): void {
  if (!canPlay(view, live)) return;
  // Only your own hand. Every other piece on this table is face down, and a
  // tap on one has no meaning at all.
  if (!(live.state.hands[view.viewerSeat] ?? []).includes(id)) return;
  toggleHeld(id);
}

/**
 * Re-asserts the lift on held cards after every batch settles.
 *
 * `selected` is a STORE flag, and the store is replaced wholesale at the end
 * of each batch by `reset(definition.placements(...))` — so anything a game's
 * own `placements` does not re-derive is erased there. Offline that barely
 * showed, because nothing else moves while it is your turn. In a window it
 * does: you can be picking cards up for your own turn while an opponent is
 * still deciding whether to doubt the last play, and every one of their
 * answers is a batch that wiped the selection out from under you.
 */
function useHeldLift(live: Live, held: readonly PieceId[]): void {
  useEffect(() => {
    if (held.length === 0) return;
    const store = useTableStore.getState();
    for (const id of held) {
      if (store.placements[id]?.selected) continue;
      store.patch(id, { selected: true });
    }
  }, [held, live.state]);
}

/**
 * The client's own countdown on a challenge window.
 *
 * Purely a reflex, and non-authoritative on purpose: the engine holds no
 * wall-clock at all and `GameDefinition.deadline` is what actually resolves a
 * window. This is what draws the ring, and if it fires first it only ever
 * removes its own owner from the race. Online it runs on every player's own
 * machine, which is fine for the same reason — a lagged timer can cost
 * nobody but the person it belongs to.
 *
 * The two are deliberately not tuned to agree; see `CHALLENGE_GRACE_MS`.
 */
function useChallengeCountdown(view: BsView, live: Live): void {
  const racing = canCall(view, live);
  const ms = challengeDeadlineMs(live.state);
  const seat = view.viewerSeat;
  useEffect(() => {
    if (!racing) return;
    const timer = setTimeout(() => live.submitAction({ t: "declineBs", seat }), ms);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [racing, ms, seat, live.state.plays.length]);
}

/* ============================================================
   The table
   ============================================================ */

export function BsTable({
  view,
  live,
  held,
  onClearHeld,
}: {
  view: BsView;
  live: Live;
  held: PieceId[];
  onClearHeld: () => void;
}) {
  const state = live.state;
  useHeldLift(live, held);
  useChallengeCountdown(view, live);

  // One band, one owner, two modes - see `HandZone`'s `bar`, and
  // `barMode` for which one wins and why.
  const mode = barMode(view, live, held.length);
  const bar =
    mode === "challenge" ? (
      <ChallengeBar view={view} live={live} />
    ) : mode === "claim" ? (
      <ClaimBar live={live} held={held} onClearHeld={onClearHeld} />
    ) : undefined;

  return (
    <>
      <HandZone
        bar={bar}
        left={<RankBadge state={state} />}
        center={<TurnIndicator label={turnLabel(view, state)} show={!bar} inline />}
      />
      <PileRail view={view} state={state} />
    </>
  );
}

/**
 * What the next play has to claim. Rung 1: always true, always needed, never
 * blocks anything. Not a hint — the rank is public and announced out loud, and
 * a player who could not see it could not take their turn at all.
 */
function RankBadge({ state }: { state: BsState }) {
  const pile = pileSize(state);
  return (
    <HeroStatusBadge
      label={rankPluralTitle(state.rank)}
      detail={pile === 0 ? "pile empty" : `${pile} on the pile`}
      side="left"
      inline
    />
  );
}

function turnLabel(view: BsView, state: BsState): string {
  if (state.pendingTake !== null) {
    return state.pendingTake === view.viewerSeat
      ? "You take the pile"
      : `${view.nameFor(state.pendingTake)} takes the pile`;
  }
  if (state.turn === view.viewerSeat) return "Your turn";
  return `${view.nameFor(state.turn)} to play`;
}

/* ============================================================
   The two bars
   ============================================================ */

/**
 * The window. A `BS!` with the clock drawn round it, and a way to end your own
 * wait early.
 *
 * On the second button: the standing rule here is never to offer a decline
 * when accepting is costless, because a button that only ever has one sensible
 * answer is noise. Calling BS risks the entire pile, so both branches carry
 * real weight — and this one is not really a decline at all. It submits the
 * same `declineBs` the deadline would fire a moment later, just now. It is a
 * pacing control, which is what earns it a place beside a five-second ring.
 */
function ChallengeBar({ view, live }: { view: BsView; live: Live }) {
  const state = live.state;
  const play = livePlay(state);
  const seat = view.viewerSeat;
  if (!play) return null;
  const who = play.seat === seat ? "You" : view.nameFor(play.seat);
  return (
    <>
      <span className="min-w-0 shrink truncate text-[10px] font-bold text-brass-300">
        {who} claimed {claimWords(play.cards.length, play.claimed)}
      </span>
      <CountdownButton
        // Keyed by the play, so each window gets its own fresh ring rather
        // than a reset written from inside an effect.
        key={state.plays.length}
        ms={challengeDeadlineMs(state)}
        onClick={() => live.submitAction({ t: "callBs", seat })}
      >
        BS!
      </CountdownButton>
      <button
        type="button"
        onClick={() => live.submitAction({ t: "declineBs", seat })}
        className="shrink-0 rounded-full bg-bone-50/8 px-3 py-2 text-[10px] font-bold text-bone-300 ring-1 ring-bone-50/16"
      >
        Let it go
      </button>
    </>
  );
}

/**
 * Your own turn: what you have picked up, and what you are about to call it.
 *
 * The claim is stated in words rather than left to be inferred from a count of
 * lifted cards — POLICY.md's "state the count in words". What it deliberately
 * does NOT say is how many of them are really that rank. You know; nothing
 * here needs to confirm it, and a table that confirmed it would be telling you
 * whether you were lying.
 */
function ClaimBar({
  live,
  held,
  onClearHeld,
}: {
  live: Live;
  held: PieceId[];
  onClearHeld: () => void;
}) {
  const state = live.state;
  const rank = rankPlural(state.rank);
  return (
    <>
      <span className="min-w-0 shrink truncate text-[10px] font-bold text-bone-300">
        {held.length === 0
          ? `Tap 1 to ${PLAY_PICK_LIMIT} cards to claim as ${rank}`
          : `Claiming ${claimWords(held.length, state.rank)}`}
      </span>
      {held.length > 0 && (
        <button
          type="button"
          onClick={onClearHeld}
          className="shrink-0 rounded-lg bg-bone-50/8 px-3 py-2 text-xs font-extrabold text-bone-200 ring-1 ring-bone-50/16"
        >
          Clear
        </button>
      )}
      <motion.button
        type="button"
        disabled={held.length === 0}
        onClick={() => {
          live.submitAction({ t: "play", cards: [...held] });
          onClearHeld();
        }}
        className="min-w-0 shrink-0 rounded-lg bg-linear-to-b from-brass-300 to-brass-500 px-4 py-2 text-xs font-extrabold text-felt-950 shadow-e2 disabled:opacity-40"
      >
        {held.length === 0 ? "Play" : `Play ${held.length}`}
      </motion.button>
    </>
  );
}

/* ============================================================
   The pile rail
   ============================================================ */

/**
 * Every claim on the pile, newest first.
 *
 * Rung 4, a `PeekRail`, because this is reference consulted WHILE playing:
 * deciding whether to doubt a claim of three sevens means weighing it against
 * what has already gone down, and a modal would make exactly that comparison
 * impossible.
 *
 * All of it is public. Who played, how many, and what they called it were
 * announced out loud; a person at a physical table heard every word. What is
 * NOT here is what any of those cards actually were — including the ones you
 * put in yourself. The pile is face down to everybody, and `playerView`
 * enforces it with no exception for its own contributor.
 */
function PileRail({ view, state }: { view: BsView; state: BsState }) {
  const geometry = useGeometry();
  const [snap, setSnap] = useState(0);
  const plays = [...state.plays].reverse();
  const mine = state.plays.reduce(
    (n, play) => (play.seat === view.viewerSeat ? n + play.cards.length : n),
    0,
  );
  const total = pileSize(state);
  if (!geometry) return null;

  // Both numbers come out of the same reserved terms, so the tallest snap
  // cannot overshoot the edge and carry its own grab handle off with it. And
  // the resting extent is what geometry GRANTED rather than what this page
  // asked for: a short phone cannot always give up the whole band, and
  // assuming it did is how a rail ends up sitting on the seat pods on exactly
  // one device. See `TableGeometry.reserved`.
  const headerH = handHeaderHeight(geometry.box.h);
  const offsetBottom = geometry.zones.hand.h + headerH;
  const available = Math.max(48, geometry.box.h - offsetBottom - 12);
  const peek = Math.max(56, Math.min(available, geometry.reserved.bottom - headerH || 96));
  // Two stops only: resting and open. A middle one would give a drag
  // somewhere ambiguous to land and make every gesture need a second nudge.
  const snapPoints = [peek, Math.max(peek, available)];

  return (
    <PeekRail
      snapPoints={snapPoints}
      snapIndex={snap}
      onSnapChange={setSnap}
      offsetBottom={offsetBottom}
      header={
        <div className="flex items-center justify-between">
          <span className="eyebrow">
            {total === 0
              ? "Pile empty"
              : `Pile · ${total} card${total === 1 ? "" : "s"}${mine > 0 ? ` · ${mine} yours` : ""}`}
          </span>
          <span className="text-[10px] text-bone-400">
            {snap === 0 ? "drag up ↑" : "drag down ↓"}
          </span>
        </div>
      }
    >
      {plays.length === 0 ? (
        <p className="px-1 py-2 text-xs text-bone-400">
          Nothing down yet. The first play claims {rankPlural(state.rank)}.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {plays.map((play, i) => {
            const top = i === 0;
            return (
              <li
                key={`${state.plays.length - i}-${play.seat}`}
                className={`flex items-baseline justify-between gap-2 rounded-lg px-2 py-1.5 text-xs ${
                  top ? "bg-brass-400/12 ring-1 ring-brass-400/25" : ""
                }`}
              >
                <span className="min-w-0 truncate font-bold text-bone-200">
                  {play.seat === view.viewerSeat ? "You" : view.nameFor(play.seat)}
                </span>
                <span className="shrink-0 text-bone-400">
                  {claimWords(play.cards.length, play.claimed)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </PeekRail>
  );
}

/* ============================================================
   GameHost slots
   ============================================================ */

function seatName(view: BsView, seat: SeatId): string {
  return seat === view.viewerSeat ? "You" : view.nameFor(seat);
}

function seatColour(view: BsView, seat: SeatId): string {
  return seat === view.viewerSeat ? "var(--color-brass-300)" : view.colourFor(seat);
}

/**
 * The pod's second line. A hand COUNT, which is the whole of what you are
 * allowed to know about somebody else's cards and also the most important
 * thing on the table: a player down to one or two is about to go out, and
 * that is what makes their next claim worth doubting whatever it is.
 */
function seatMeta(state: BsState, seat: SeatId): string {
  const cards = (state.hands[seat] ?? []).length;
  const rounds = state.scores[seat] ?? 0;
  return `${cards} card${cards === 1 ? "" : "s"} · ${rounds}`;
}

export function playerViews(view: BsView, state: BsState, live: Live): SeatView[] {
  const out: SeatView[] = [];
  // Every seat but the VIEWER's own — counted from 0, not from 1. The two are
  // the same thing only while the viewer is seat 0, and online they are not:
  // a player at seat 1 got no pod at all for seat 0 and a redundant one for
  // themselves.
  for (let i = 0; i < state.seats; i++) {
    const seat = i as SeatId;
    if (seat === view.viewerSeat) continue;
    // "Who just moved" and "who are we waiting on" — two questions, and
    // `seatCue` answers both. The second matters more here than in any other
    // game: during a challenge window the table walks one seat at a time
    // through everybody entitled to doubt the play, and watching that travel
    // round the ring IS the tension.
    const cue = seatCue(live, seat);
    out.push({
      seat,
      name: view.nameFor(seat),
      colour: view.colourFor(seat),
      meta: seatMeta(state, seat),
      active: cue.active,
      thinking: cue.thinking,
      winning: state.result?.winner === seat,
      away: view.awayFor?.(seat) ?? false,
    });
  }
  return out;
}

export function standings(view: BsView, state: BsState, _live: Live, seats: SeatView[]) {
  const nameOf = (seat: SeatId) =>
    seat === view.viewerSeat
      ? "You"
      : (seats.find((s) => s.seat === seat)?.name ?? view.nameFor(seat));
  return Array.from({ length: state.seats }, (_, i) => {
    const seat = i as SeatId;
    return { seat, name: nameOf(seat), total: state.scores[seat] ?? 0 };
  }).sort((a, b) => b.total - a.total);
}

export function statsFor(view: BsView, state: BsState): Array<{ label: string; value: string }> {
  const rows = [
    { label: "Round", value: `${state.round}` },
    { label: "To win", value: `${state.target}` },
  ];
  // A spectator has no hand, so a hand count would be a zero that means
  // nothing rather than a fact about anybody.
  if (isSeated(view, state)) {
    rows.push({ label: "Your cards", value: `${(state.hands[view.viewerSeat] ?? []).length}` });
  }
  return rows;
}

export function roundSummary(view: BsView, state: BsState) {
  const result = state.result;
  if (!result) return null;

  const rows: ScoreRow[] = Array.from({ length: state.seats }, (_, i) => {
    const seat = i as SeatId;
    const left = result.cardsLeft[seat] ?? 0;
    return {
      seat,
      name: seatName(view, seat),
      colour: seatColour(view, seat),
      detail: left === 0 ? "went out" : `${left} card${left === 1 ? "" : "s"} left`,
      delta: result.deltas[seat] ?? 0,
      total: state.scores[seat] ?? 0,
    };
  });

  const note = result.blocked
    ? ({
        tone: "warn",
        title: "Nobody could get out",
        body:
          "Every play was being doubted and the pile kept coming back, so the round " +
          "went to the shortest hand.",
      } as const)
    : undefined;

  const won = result.winner === view.viewerSeat;
  return {
    title: won ? "You take the round" : `${view.nameFor(result.winner)} takes the round`,
    rows,
    note,
  };
}

export function pendingLabel(view: BsView, state: BsState, seat: SeatId): string {
  if (state.pendingTake === seat) return `${view.nameFor(seat)} pending — taking the pile`;
  if (entitledToCall(state, seat)) return `${view.nameFor(seat)} pending — BS?`;
  return `${view.nameFor(seat)} pending — playing`;
}
