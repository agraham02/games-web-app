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
 *
 * There is no pile rail. BS had Rummy's bottom sheet listing every claim so
 * far, and the user removed it (2026-09-25): the game does not need it,
 * and it took height from a table that has little to spare.
 *
 * What is deliberately absent, and must stay absent: nothing says how many
 * of your selected cards actually match the rank, nothing marks a claim you
 * could prove impossible, and nothing hints that a bot is about to be
 * caught. An affordance merely appearing is a tell. Feedback after the
 * reveal is fine; a hint before the call is not.
 */

import { useEffect } from "react";
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
import { HandZone } from "@/table/HandZone";
import type { SeatView } from "@/table/SeatRing";
import { useTableStore } from "@/table/store";
import { useHeldMarks } from "@/table/useHeldMarks";
import { seatCue } from "@/table/turnCue";
import type { GameRuntime } from "@/table/useGameRuntime";
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
 * and during a challenge window `currentSeat` names the first seat still to
 * answer it. It is also what makes the hand live (`handActive`), so it has
 * to be false through a whole window: nobody plays into one.
 */
export function canPlay(view: BsView, live: Live): boolean {
  const state = live.state;
  if (live.isOver || state.result !== null || !state.dealt) return false;
  if (state.pendingTake !== null) return false;
  if (state.window !== null || live.latest.window !== null) return false;
  if (live.animating) return false;
  return state.turn === view.viewerSeat;
}

/** Is the viewer still entitled to doubt the play on the table? */
export function canCall(view: BsView, live: Live): boolean {
  // Both: the window is shown AND not already answered. A bot's call is
  // made before it animates, and the buttons stayed up through its whole
  // reveal (reported 2026-09-25) — see `GameRuntime.latest`.
  return (
    entitledToCall(live.state, view.viewerSeat) && entitledToCall(live.latest, view.viewerSeat)
  );
}

/**
 * Which of the two the action band shows - for both screens, and testable
 * without mounting a table.
 *
 * While a window is open it is the only one: nobody may play into an open
 * window (the user's rule, 2026-09-25), so `canPlay` is false for everyone
 * until it closes, the seat on turn included. That seat used to be offered
 * Play over the top of a window, and the band had to decide between the
 * two by whether cards were already lifted.
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
 * What picking a card up MEANS — for both screens. Pure: the marks on the
 * table follow from the list (`useHeldMarks`), never from inside a React
 * state updater, where a store write is a write during render.
 */
export function togglePlayCard(held: readonly PieceId[], id: PieceId): PieceId[] {
  if (held.includes(id)) return held.filter((x) => x !== id);
  // A fifth tap is ignored until one is put back, rather than silently
  // dropping the oldest — the player chose those four.
  if (held.length >= PLAY_PICK_LIMIT) return [...held];
  return [...held, id];
}

/** Puts every held card down. The store patch is the half easily forgotten. */
export function clearPlayCards(held: readonly PieceId[]): void {
  useTableStore.getState().patchMany(held, HELD_OFF);
}

/**
 * How a card picked to play is drawn: lifted AND ringed, the same as a
 * card picked for a meld in Rummy. The lift alone (18px, with nothing
 * else) was easy to miss.
 */
const HELD_MARKS = { selected: true, highlighted: true } as const;
const HELD_OFF = { selected: false, highlighted: false } as const;

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
  // Re-asserted after every batch: you can be picking cards for your own
  // turn while opponents answer a window, and each answer resets the store.
  useHeldMarks(held, HELD_MARKS, live.state);
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
  // While a play is open to challenge, the ring stays on whoever MADE it.
  // It used to follow `seatCue`, which names the seat the window is waiting
  // on — the first in its answer queue, anywhere at the table — so the
  // ring jumped straight from the player to, say, the seat across from the
  // viewer, who was neither the next nor the last to play (reported
  // 2026-09-25). The play under challenge is the thing everyone is looking
  // at; the ring says so until the window is over.
  const challenged = state.window ? (state.plays[state.window.play]?.seat ?? null) : null;
  for (let i = 0; i < state.seats; i++) {
    const seat = i as SeatId;
    if (seat === view.viewerSeat) continue;
    // Otherwise "who just moved" and "who are we waiting on", which
    // `seatCue` answers both of.
    const cue =
      challenged !== null ? { active: seat === challenged, thinking: false } : seatCue(live, seat);
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
