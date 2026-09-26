"use client";

/**
 * A server-driven table, wearing `GameRuntime`'s clothes.
 *
 * This returns the same 22-field object `useGameRuntime` does, which is the
 * entire trick: `GameHost`, `SeatRing`, `PieceLayer`, the phase screens and
 * every game's own play screen consume that interface and none of them need
 * to know whether the game is being decided in this tab or on a server.
 *
 * What it does NOT do is decide anything. Offline, the hook owns the rng,
 * runs the bots and paces the turns; here all three live on the server and
 * this is a renderer. The three fields that cannot be honestly answered
 * from a frame are documented individually below rather than quietly
 * faked — a wrong answer there would be a rules bug wearing a UI bug's
 * clothes.
 *
 * The pacing seam is unchanged and is the reason this fits at all: frames
 * carry an event list, the choreographer plays it, and `onIdle` reconciles
 * the board. Offline, `onIdle` also decides what happens next; here it does
 * not, because the next frame is already on its way.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  GameDefinition,
  GameEvent,
  PieceId,
  PieceMeta,
  PlacementMap,
  SeatId,
} from "@/engine/types";
import { createRng, type Rng } from "@/engine/rng";
import { useChoreographer } from "@/motion/useChoreographer";
import { prefersReducedMotion } from "@/motion/presets";
import { playbackMs, tailMs } from "@/motion/choreographer";
import type { FrameView, RoomView } from "@/session/protocol";
import { announce } from "@/ui/disclosure";
import { composeAnnounce } from "@/session/announce";
import { piecesNamed, redactPlacements, sentinelFor } from "@/session/redact";
import { applyEventToTable } from "@/table/applyEvent";
import { useTableStore } from "@/table/store";
import type { GameRuntime } from "@/table/useGameRuntime";

/**
 * How many frames may pile up before the client stops watching history and
 * jumps to the present.
 *
 * This is the client half of "a slow connection must not spoil the game for
 * anyone else". The server never waits, so a tab that was backgrounded, or
 * on a bad link, comes back to a queue. Playing it out would mean watching
 * three turns of catch-up while everybody else is live; skipping to the
 * newest frame costs a few animations and lands on the current board, which
 * is the one thing that actually matters.
 */
const CATCH_UP_FRAMES = 2;

/**
 * ...and only when they would take this long to WATCH, too.
 *
 * Counting frames alone skipped animations in ordinary play. BS answers
 * every play with a burst of frames that show nothing (each "Let it go",
 * each bot's decline), so three were routinely queued behind a play that
 * was still waiting for its card to land, and the NEXT play was skipped —
 * applied instantly, with no flight (found in Chrome, 2026-09-25). A queue
 * that plays out in a moment is not history nobody is waiting for.
 */
const CATCH_UP_MS = 2500;

/**
 * How long the table sits on screen, dealt-out and still, before the first
 * thing moves.
 *
 * A player who has just arrived should see the felt and the deck before
 * cards start leaving it, not join an animation already underway. It is
 * measured from the table mounting on THIS screen, which is what makes it
 * per-player: the server broadcasts a frame and moves on, each client
 * starts its own deal when its own table is up, and a slow load delays
 * only the person loading.
 *
 * Long enough for the piece layer to have measured itself and painted the
 * deck; short enough not to read as a stall. Zero under reduced motion.
 */
export const READY_BEAT_MS = 450;

const DEFAULT_END_HOLD_MS = 1200;
const DEFAULT_ROUND_HOLD_MS = 1000;
const ROUND_INTRO_HOLD_MS = 3000;

/**
 * Composing needs to know who is watching, which changes per room — so
 * unlike the offline runtime's module-level version, this is built per
 * frame from the seat names the server sent with it.
 */
function surfaceEventFor(frame: FrameView) {
  return (event: GameEvent): void => {
    if (event.t === "announce") {
      const { text, tone } = composeAnnounce(
        event,
        frame.seat,
        // A seat with no name is a bot's, and the pods call it "Bot N" —
        // "Seat 3 claimed" named nobody at the table.
        (seat) => frame.seatNames[seat] ?? `Bot ${seat + 1}`,
      );
      announce(text, tone);
    }
    applyEventToTable(event);
  };
}

/** Every adoption that jumps gets a new one — see `Placement.jump`. */
let jumpEpoch = 0;

/**
 * Adopts a frame's settled board, snapping renamed stand-ins into place.
 *
 * A face-down stand-in is named by where it sits ("#hand:2:-:3"), so the
 * settled board can give a name to a different card than the one this
 * table has been animating under it: the card that just flew from the
 * middle of a hand to the pile is, by the settled board, a card still in
 * that hand. Adopted plainly, that node flew back out of the pile (seen in
 * Chrome, BS, 2026-09-25). Every stand-in whose settled place differs from
 * where it is drawn therefore `jump`s there instead. They are identical
 * backs, so the snap cannot be seen; the real faces this viewer holds are
 * never stand-ins and always animate.
 */
function adopt(frame: FrameView): boolean {
  const store = useTableStore.getState();
  const epoch = jumpEpoch + 1;
  const shown = store.placements;
  let placements = frame.placements;
  for (const [id, settled] of Object.entries(frame.placements)) {
    if (!id.startsWith("#")) continue;
    const was = shown[id];
    if (!was) continue;
    const moved =
      was.zone !== settled.zone ||
      was.seat !== settled.seat ||
      was.group !== settled.group ||
      was.index !== settled.index;
    // Kept, too, while the piece stays put: the number is the element's key
    // (see `Placement.jump`), and a settled board never carries it, so
    // adopting one plainly would change the key and remount the piece.
    if (!moved && was.jump === undefined) continue;
    if (placements === frame.placements) placements = { ...frame.placements };
    // A fresh jump remounts; one carried forward keeps its number, or the
    // piece would remount again every frame it stays put.
    placements[id] = { ...settled, jump: moved ? epoch : was.jump };
  }
  store.reset(placements, frame.meta);
  const jumped = placements !== frame.placements;
  if (jumped) jumpEpoch = epoch;
  return jumped;
}

export interface OnlineRuntimeOptions {
  /** The newest frame, or null when no game is running. */
  frame: FrameView | null;
  /** Sends a move. The server decides whether it was legal. */
  submit: (action: unknown) => void;
  /** Asks for the next round to be dealt. */
  nextRound: () => void;
  speed?: number;
  dealStaggerMs?: number;
  /**
   * Where the table stands BEFORE the opening deal, for a game whose
   * first frame deals. See `openingPosition`.
   */
  initial?: () => OpeningPosition | null;
}

export interface OpeningPosition {
  placements: PlacementMap;
  meta: Record<PieceId, PieceMeta>;
}

/**
 * The undealt table, redacted the way the server names it.
 *
 * Offline resets the store to `placements(setup())` before the deal runs,
 * so every card is in the deck for its `deal` event to fly from. That is
 * load-bearing, not cosmetic: `applyEvent`'s `moveTo` does nothing to a
 * piece the store is not already tracking, so a deal aimed at a piece with
 * no placement is a silent no-op. Online the store was EMPTY when the
 * opening deal played, so every opponent's cards — addressed by stand-in
 * ids the store had never heard of — simply failed to move, and the hands
 * appeared whole when the batch reconciled at the end.
 *
 * Built from the client's own `definition`, exactly as offline does,
 * rather than shipped in the frame: the server's stand-ins are named by
 * SLOT (`#deck:-:-:17`), and slot numbering depends only on how many
 * pieces the pile holds, so redacting the same undealt state here
 * produces the same names. Nothing about a shuffled deck is needed or
 * revealed, because the shuffle happens inside the deal.
 */
export function openingPosition<S, A>(
  definition: GameDefinition<S, A>,
  seats: number,
  viewer: SeatId | null,
): OpeningPosition {
  const state = definition.setup({ seats, rng: createRng(1) });
  const pieces = definition.pieces(state);
  // `null` is a spectator, whom the server addresses as seat -1 so that
  // every `seat === viewer` comparison fails and every hand is face-down.
  const truth = definition.placements(state, viewer ?? -1);
  const { placements, meta: standIns } = redactPlacements(truth, pieces);

  const meta: Record<PieceId, PieceMeta> = { ...standIns };
  for (const id of Object.keys(placements)) {
    if (!(id in meta) && pieces[id]) meta[id] = pieces[id]!;
  }
  return { placements, meta };
}

export function useOnlineRuntime<S, A>(opts: OnlineRuntimeOptions): GameRuntime<S, A> | null {
  const { frame } = opts;

  const [applied, setApplied] = useState<FrameView | null>(null);
  /**
   * Who acted, published the moment their frame ARRIVES rather than when
   * it finishes animating.
   *
   * Every game lights its seat pods from `lastAction` — deliberately, so
   * the glow follows what is being SHOWN rather than `state.turn`, which
   * already names the next actor the instant `reduce` runs. Taking it off
   * `applied` made it a whole animation late: the pod lit for the person
   * who moved BEFORE the one you were watching, so the highlight read as
   * running a turn behind. `useGameRuntime` has always set this in its
   * frame handler; this is the same thing in the same place.
   */
  const [lastAction, setLastAction] = useState<FrameView["lastAction"]>(null);
  const [dealingRound, setDealingRound] = useState<number | null>(null);
  const [gameEndRevealed, setGameEndRevealed] = useState(false);
  const [roundEndRevealed, setRoundEndRevealed] = useState(false);

  /**
   * Whether THIS player's table is up and has had its beat. Frames that
   * carry a batch to play wait behind it; a bare position does not,
   * because there is nothing to watch and the board should be right at
   * once. See `READY_BEAT_MS`.
   */
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);

  /** The frame currently animating, and any newer one that arrived meanwhile. */
  const playing = useRef<FrameView | null>(null);
  const queued = useRef<FrameView[]>([]);

  // A local generator, for the one thing it is still allowed to do: a
  // game's own UI that wants a cosmetic random. It decides NOTHING —
  // anything that affects an outcome is resolved on the server, because a
  // client that rolls its own dice is a client that can choose them.
  const [rng] = useState<Rng>(() => createRng(1));

  /**
   * A settled position whose adoption is waiting on the animations of the
   * batch that produced it. See `settle`.
   */
  const pendingReset = useRef<{ frame: FrameView; timer: ReturnType<typeof setTimeout> } | null>(
    null,
  );
  /**
   * Set from a board adoption that `jump`ed a piece until React has DRAWN
   * it; the next batch waits. A jump remounts the piece where it belongs,
   * and a play of that same piece landing in the same render remounted it
   * straight onto the pile instead, so that play never flew. A fixed 60ms
   * beat was tried first and lost the race whenever the page was busy (in
   * Chrome, 4 of 67 plays), so the hold is released by an effect, which runs
   * only once the jump has been committed.
   */
  const holding = useRef(false);
  const [jumped, setJumped] = useState(0);
  const adoptBoard = (board: FrameView) => {
    if (!adopt(board)) return;
    holding.current = true;
    setJumped((n) => n + 1);
  };

  const flushReset = () => {
    const pending = pendingReset.current;
    if (!pending) return;
    pendingReset.current = null;
    clearTimeout(pending.timer);
    adoptBoard(pending.frame);
  };

  const settle = () => {
    const current = playing.current;
    if (!current) return;
    setApplied(current);

    // The board is adopted when the batch's animations have FINISHED, if
    // adopting it would pull a piece out from under one. A batch goes idle
    // when its last event is applied, with that animation still running,
    // and the settled position can name a piece differently from the batch:
    // a trick's cards are collected face down, so the position holds
    // stand-ins where the real cards are still in flight. Swapping ids
    // unmounts the card that is flying, and the collect vanished the
    // instant it began. The game state above is adopted at once, so whose
    // turn it is never waits on an animation; the next batch flushes any
    // board still pending before it touches the store (`pump`).
    flushReset();
    // Stand-ins included: the settled board names them by where they land,
    // so one dealt under any other name — a masked pile's, say — is swapped
    // out at the settle just as a real card is.
    //
    // And a name that SURVIVES can still be a different card. An opponent's
    // hand is named by slot ("#hand:2:-:3"), so after they play from the
    // middle of it, that name belongs to the card that slid into the gap.
    // Asking only whether the name was gone adopted the board the moment
    // the play was applied, and the flying card was pulled straight back
    // into the hand — in BS, every opponent's play but one from the last
    // slot (seen in Chrome, 2026-09-25). So: any piece this batch left
    // somewhere the settled board does not.
    const onTable = useTableStore.getState().placements;
    const vanishing = piecesNamed(current.events, { standIns: true }).some((id) => {
      const settled = current.placements[id];
      if (!settled) return true;
      const now = onTable[id];
      return now !== undefined && (now.zone !== settled.zone || now.seat !== settled.seat);
    });
    const tail =
      vanishing && !prefersReducedMotion()
        ? tailMs(current.events, { dealStaggerMs: opts.dealStaggerMs }) /
          Math.max(0.05, opts.speed ?? 1)
        : 0;
    if (tail > 0) {
      // And the next batch waits for it (see `pump`), so start it here.
      const timer = setTimeout(() => {
        flushReset();
        pump();
      }, tail);
      pendingReset.current = { frame: current, timer };
    } else {
      adoptBoard(current);
    }

    // The summaries are revealed by an effect on `applied` below, not by a
    // timer armed here.

    playing.current = null;
    pump();
  };

  // Read through a ref so the resolver always matches the frame being
  // played, without rebuilding the choreographer (and losing its queue)
  // every time a frame lands.
  const applyRef = useRef<(event: GameEvent) => void>(applyEventToTable);
  // Declared BEFORE the frame effect below, and that ordering is
  // load-bearing: effects run in declaration order, so on the commit that
  // delivers a frame this is current before `pump` pushes its events into
  // the choreographer and the first one is applied.
  useEffect(() => {
    applyRef.current = frame ? surfaceEventFor(frame) : applyEventToTable;
  });

  const choreographer = useChoreographer({
    apply: (event) => applyRef.current(event),
    onIdle: settle,
    speed: opts.speed,
    dealStaggerMs: opts.dealStaggerMs,
  });

  /** Starts the next queued frame, catching up first if we are behind. */
  const pump = () => {
    if (playing.current) return;
    const backlog = queued.current;
    if (backlog.length === 0) return;

    // Trimming waits for this player's table too: nothing is playing yet,
    // so there is nothing to skip, and doing it first would throw away the
    // very deal the player has not seen.
    const behindMs = backlog.reduce((ms, f) => ms + playbackMs(f.events), 0);
    if (readyRef.current && backlog.length > CATCH_UP_FRAMES && behindMs > CATCH_UP_MS) {
      // Everything but the newest is history nobody is waiting to watch.
      // Its placements are superseded by the frame we are about to apply,
      // which is a whole snapshot — so dropping them loses position, not
      // truth.
      backlog.splice(0, backlog.length - 1);
      choreographer.skip();
      flushReset();
    }

    // A piece just jumped (perhaps by the flush above); let it be drawn
    // there before anything moves it. The effect that releases the hold
    // pumps again.
    if (holding.current) return;

    // Pieces from the last batch are still in flight to where the settled
    // board renames them, and adopting that board now would swap them out
    // mid-air. It used to be adopted here at once, so the flight survived
    // only when nothing was queued behind it — and BS answers every play
    // with a quick frame, so cards "sometimes" never left the hand. The
    // pending reset's own timer starts the next batch instead.
    if (pendingReset.current) return;

    // A batch waits for the table; a bare position does not.
    if (!readyRef.current && backlog[0]!.events.length > 0) return;

    const next = backlog.shift()!;
    playing.current = next;
    // Whatever the last batch was still animating, this one starts from its
    // settled board.
    flushReset();
    setLastAction(next.lastAction);
    // Learned BEFORE the events play, not after them.
    //
    // A frame's meta describes every piece this viewer may name once the
    // batch is over, which includes any card an opponent is about to
    // reveal by playing it. `PieceLayer` draws nothing for a piece it
    // cannot describe, so waiting for the settle meant the `unmask` at
    // the head of that gesture rendered nothing, the move had no painted
    // origin, and the card appeared on the table rather than leaving a
    // hand. Merging is safe: meta names only pieces the redaction has
    // already decided this seat may identify, and it moves nothing.
    useTableStore.getState().learnMeta(next.meta);
    if (next.dealtRound !== null) setDealingRound(next.dealtRound);
    if (next.isRoundOver === false) setRoundEndRevealed(false);

    if (next.events.length > 0) choreographer.push(next.events);
    // A position rather than a step — a reconnect, or entering a running
    // game. There is nothing to animate; adopt it and move on.
    else settle();
  };

  // The last frame taken, so the same one is never queued twice. StrictMode
  // runs this effect twice on mount, and the frame present at mount is the
  // opening deal — so the first round's deal played twice. Compared by
  // identity: every message off the socket is a fresh object.
  const received = useRef<FrameView | null>(null);
  useEffect(() => {
    if (!frame || frame === received.current) return;
    received.current = frame;
    queued.current.push(frame);
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame]);

  /**
   * Catch up the moment the tab is looked at again.
   *
   * The choreographer paces on `setTimeout`, which a backgrounded tab
   * throttles to about one a second and, after a few minutes, one a
   * MINUTE. The server never waits, so frames pile up — and
   * `CATCH_UP_FRAMES` only trims them inside `pump`, which cannot run
   * until the batch currently playing has drained one throttled event at
   * a time. So a tab that had been away came back and crawled through
   * history it had already missed.
   *
   * Skipping is safe for the same reason the backlog trim is: every
   * frame is a whole snapshot, so collapsing them loses position, not
   * truth. Two tabs on one machine is the ordinary way this app gets
   * tried out, which makes this the ordinary case rather than an edge.
   */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // `skip` drains the playing batch instantly and calls `onIdle`,
      // which settles and pumps — so the trim happens on the same tick.
      if (playing.current) choreographer.skip();
      else pump();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Put the undealt table on screen BEFORE it is first painted, so the
   * deal has a deck to fly from. Once, on mount, and only when this
   * player's first frame is the opening deal — anything else (a refresh, a
   * late arrival) is a position, and the settle that follows adopts it.
   *
   * A layout effect because the store is a module-level singleton that
   * still holds whatever the last game left in it, and a passive effect
   * would paint that for a frame first.
   */
  const seeded = useRef(false);
  useLayoutEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (!frame || frame.dealtRound !== 1 || !opts.initial) return;
    const start = opts.initial();
    if (!start) return;

    const placements = { ...start.placements };
    // A card this player is about to be dealt arrives as `unmask` + `deal`
    // under its real id, and the server put it at a slot the seed has
    // just filled with a stand-in. Leaving both would strand a phantom
    // back in the deck for the length of the deal. Seed the real piece
    // there instead; the `unmask` that follows is idempotent.
    for (const event of frame.events) {
      if (event.t !== "unmask") continue;
      delete placements[event.replaces ?? sentinelFor(event.at)];
      placements[event.piece] = event.at;
    }
    useTableStore.getState().reset(placements, { ...start.meta, ...frame.meta });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * This player's table is up: hold a beat, then let the deal begin.
   *
   * Independent per player by construction. The timer is started by THIS
   * mount, so a slow load delays only whoever is loading, and the server
   * neither knows nor waits. Not started in a hidden tab: its timers are
   * throttled, so the deal would play out unseen and the player would come
   * back to a finished one, which is exactly the report.
   */
  useEffect(() => {
    if (ready) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (timer !== null) return;
      timer = setTimeout(
        () => {
          readyRef.current = true;
          setReady(true);
        },
        prefersReducedMotion() ? 0 : READY_BEAT_MS,
      );
    };
    if (document.visibilityState !== "hidden") arm();
    const onVisible = () => {
      if (document.visibilityState !== "hidden") arm();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ready]);

  useEffect(() => {
    if (ready) pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Same shape as the offline runtime's: a dependency effect, so
  // StrictMode's mount -> cleanup -> mount becomes schedule -> cancel ->
  // reschedule rather than leaving the intro stuck on screen.
  useEffect(() => {
    if (dealingRound === null) return;
    const delay = prefersReducedMotion() ? 0 : ROUND_INTRO_HOLD_MS;
    const t = setTimeout(() => setDealingRound(null), delay);
    return () => clearTimeout(t);
  }, [dealingRound]);

  /**
   * Reveals the round's or the match's summary a beat after the frame that
   * ended it has settled.
   *
   * An effect keyed on the settled frame, not a timer armed inside
   * `settle`: a reload during the break settles that frame while
   * StrictMode is mounting, its simulated unmount cancelled the timer, and
   * the remount skips a frame it has already received. The summary, and
   * with it the only way to continue, never appeared (seen in Chrome).
   * An effect is simply run again.
   */
  useEffect(() => {
    if (!applied || (!applied.isOver && !applied.isRoundOver)) return;
    const matchOver = applied.isOver;
    const delay = prefersReducedMotion()
      ? 0
      : matchOver
        ? DEFAULT_END_HOLD_MS
        : DEFAULT_ROUND_HOLD_MS;
    const t = setTimeout(() => (matchOver ? setGameEndRevealed(true) : setRoundEndRevealed(true)), delay);
    return () => clearTimeout(t);
  }, [applied]);

  // Releases the hold once a jump has been committed. See `holding`.
  useEffect(() => {
    if (!holding.current) return;
    holding.current = false;
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumped]);

  useEffect(() => {
    return () => {
      if (pendingReset.current !== null) clearTimeout(pendingReset.current.timer);
    };
  }, []);

  // The table is drawn from the FIRST frame, not from the first one to
  // finish playing. It used to wait for `applied`, which is set when a
  // batch settles, so for an opening deal the whole animation ran with
  // nothing mounted to show it and the table appeared already dealt.
  const shown = applied ?? frame;
  if (!shown) return null;
  // Until something has actually played, the table is a picture: nobody's
  // turn to act, nobody lit, nothing to tap. Without this the bid panel
  // would open over a deck that has not been dealt.
  const started = applied !== null;

  const mySeat = shown.seat;
  const myTurn = started && mySeat !== null && shown.currentSeat === mySeat;

  return {
    state: shown.state as S,
    // Identical to `state`, and that is the honest answer: the unredacted
    // state exists only on the server. The dev state editor is offline-only
    // for exactly this reason — there is nothing here it could edit that
    // the server would honour.
    rawState: shown.state as S,
    // The newest frame, still animating or not — see `GameRuntime.latest`.
    latest: (frame ?? shown).state as S,
    replaceState: () => {
      /* Server-authoritative. Nothing a client wrote here would survive. */
    },
    isHeroTurn: myTurn && !shown.isOver && !choreographer.isPlaying,
    isOver: shown.isOver,
    winner: shown.winner,
    winningSeats: shown.winningSeats,
    roundWinner: shown.isOver ? null : shown.roundWinner,
    roundWinningSeats: shown.isOver ? null : shown.roundWinningSeats,
    showSummary: shown.isOver && gameEndRevealed,
    showRoundSummary: !shown.isOver && shown.isRoundOver && roundEndRevealed,
    round: shown.round,
    dealingRound,
    nextRound: opts.nextRound,
    autoAdvance: true,
    busy: choreographer.isPlaying || !myTurn || !started,
    // Off the SETTLED frame, deliberately. `applied` lags the newest
    // frame by exactly one animation, so during a move this still names
    // the seat making it, and it only advances once that move has
    // finished being shown. Which is the pacing every pod wants.
    currentSeat: shown.isOver ? null : shown.currentSeat,
    // "A turn is on screen" until something has played, so no pod lights
    // for a seat that has not, yet, been asked to do anything.
    animating: choreographer.isPlaying || !started,
    submitAction: (action) => opts.submit(action),
    rng,
    skip: choreographer.skip,
    // Withheld by the server when the action names a piece this viewer
    // may not identify — see `safeLastAction`.
    lastAction: lastAction as { seat: SeatId; action: A } | null,
    // Both meaningless here: the server owns the clock, so there is never a
    // turn sitting locally waiting to be revealed.
    pendingReveal: false,
    advance: () => {},
  } satisfies GameRuntime<S, A> as GameRuntime<S, A>;
}

/** Convenience for a component that only needs to know where it is sitting. */
export function viewerSeatOf(frame: FrameView | null): SeatId | null {
  return frame ? frame.seat : null;
}

/**
 * "Is a bot playing somebody's seat for them?" — for `SeatView.away`.
 *
 * Two fields, and both are needed. `botSeats` alone is the wrong question:
 * a room of two at a four-seat table has two chairs a bot plays because
 * nobody ever sat in them, and marking those "away" would say two people
 * had abandoned a game they never joined. `seatNames[seat]` is non-null
 * exactly when a member OWNS the seat, so the pair says what is meant —
 * this chair has a person, and the person is not currently in it.
 *
 * Offline there is nobody to step away from a seat, so no offline view
 * supplies this and every pod answers false.
 */
export function awayFrom(frame: FrameView): (seat: SeatId) => boolean {
  const bots = new Set(frame.botSeats);
  return (seat) => bots.has(seat) && frame.seatNames[seat] != null;
}

/**
 * What a round's end says to somebody who is not the one to continue it —
 * or nothing, for the person who is. See `mayContinueRound`.
 */
export function continueWaitingFor(room: RoomView): string | undefined {
  if (room.youMayContinue) return undefined;
  const leader = room.members.find((m) => m.isLeader)?.name;
  return leader ? `Waiting for ${leader} to continue` : "Waiting for the party leader to continue";
}
