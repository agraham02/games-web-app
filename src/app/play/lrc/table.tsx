"use client";

/**
 * LRC's table content, shared by the offline page and by an online room.
 *
 * The roll button here does NOT resolve the dice — see `LrcControls`. That
 * is the one place this game differs from the others in the set, and it is
 * the reason LRC was the last of them to go online.
 */

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { SeatId } from "@/engine/types";
import { botColour, botName } from "@/games/_shared/botIdentity";
import { chipsHeld, diceCountFor } from "@/games/lrc/state";
import type { LrcAction, LrcState } from "@/games/lrc/types";
import { DURATION, TRANSITIONS, prefersReducedMotion } from "@/motion/presets";
import { onDice } from "@/table/fx";
import { DiceFace } from "@/ui/primitives/DiceFace";
import { TurnIndicator, type ScoreRow } from "@/ui/phases/PhaseScreens";
import type { SeatView } from "@/table/SeatRing";
import { seatCue } from "@/table/turnCue";
import type { GameRuntime } from "@/table/useGameRuntime";
import { potSize } from "@/games/lrc/state";

type Live = GameRuntime<LrcState, LrcAction>;

/** Who is looking at this table, and what everyone is called. */
export interface LrcView {
  viewerSeat: SeatId;
  nameFor: (seat: SeatId) => string;
  colourFor: (seat: SeatId) => string;
  /**
   * Whether a bot is currently playing that seat for the person who owns
   * it. Optional because only a room can answer it — offline there is
   * nobody to step away. Supplied by `awayFrom(frame)`.
   */
  awayFor?: (seat: SeatId) => boolean;
}

/** Seat 0, against bots — every offline game. */
export const OFFLINE_VIEW: LrcView = {
  viewerSeat: 0,
  nameFor: botName,
  colourFor: botColour,
};

/**
 * Vertical room the Roll button needs. There is no hand in LRC — the
 * strip is the button and nothing else.
 *
 * A constant because both shells have to agree, and they did not: the
 * room passed `0` while `LrcControls` went on rendering a fixed 64px
 * bar, so online the button sat on top of whatever the geometry had
 * laid into the bottom band.
 */
export const LRC_HAND_ZONE = 64;

/**
 * The HUD numbers. Shared for the same reason as the hand zone — the two
 * shells each hand-rolled this and had already drifted, the room's copy
 * having quietly lost the pot.
 */
export function statsFor(state: LrcState) {
  return [
    { label: "Round", value: `${state.round}` },
    { label: "Target", value: `${state.target} rounds` },
    { label: "Pot", value: `${potSize(state)} chips` },
  ];
}

export function standings(view: LrcView, state: LrcState, _live: Live, seats: SeatView[]) {
  // Built from the real seat range and named by COMPARISON, never by
  // prepending the viewer.
  //
  // `SPECTATOR_SEAT` is -1 and -1 is an ordinary number: prepending
  // `{ seat: viewerSeat, name: "You" }` gave a spectator a row for a seat
  // that does not exist, scored 0, sorted in among the real ones. The same
  // -1 class that put a partner badge on a spectator's table.
  const nameOf = (seat: SeatId) =>
    seat === view.viewerSeat
      ? "You"
      : (seats.find((s) => s.seat === seat)?.name ?? view.nameFor(seat));
  return Array.from({ length: state.seats }, (_, i) => {
    const seat = i as SeatId;
    return { seat, name: nameOf(seat), total: state.scores[seat] ?? 0 };
  }).sort((a, b) => b.total - a.total);
}

/**
 * `RoundEndScorecard`'s content — without this the round-hold pause
 * (`useGameRuntime`'s `showRoundSummary`) elapses and the scorecard's
 * `show` stays false forever (`GameHost` only builds `card` when a
 * `roundSummary` prop is supplied), which stalls the match: nothing
 * ever calls `nextRound()`, since that only happens from the
 * scorecard's own "Next round" button.
 */
export function roundSummary(view: LrcView, state: LrcState) {
  const result = state.result;
  if (!result) return null;

  const name = (seat: number) => (seat === view.viewerSeat ? "You" : view.nameFor(seat));
  const rows: ScoreRow[] = [];
  for (let seat = 0; seat < state.seats; seat++) {
    rows.push({
      seat,
      name: name(seat),
      colour: seat === view.viewerSeat ? "var(--color-brass-300)" : view.colourFor(seat),
      detail: seat === result.winner ? "took the pot" : "out",
      delta: seat === result.winner ? 1 : 0,
      total: state.scores[seat] ?? 0,
    });
  }
  rows.sort((a, b) => b.total - a.total);

  const title = `${name(result.winner)} ${result.winner === view.viewerSeat ? "take" : "takes"} the pot`;
  return { title, rows };
}

/** DevPanel's game-specific line — see GameHostProps.pendingLabel. */
export function pendingLabel(view: LrcView, state: LrcState, seat: number): string {
  const chips = chipsHeld(state, seat);
  const dice = diceCountFor(state, seat);
  return `${view.nameFor(seat)} pending — ${chips} chip${chips === 1 ? "" : "s"} → ${dice} ${dice === 1 ? "die" : "dice"}`;
}

export function playerViews(view: LrcView, state: LrcState, live: Live): SeatView[] {
  const out: SeatView[] = [];
  // Every seat but the VIEWER's own. This counted from 1 for a long time,
  // which is the same thing exactly as long as the viewer is seat 0 —
  // and online they are not. A player at seat 1 got no pod for seat 0
  // (the party leader simply had no nameplate) and a redundant one for
  // themselves.
  for (let seat = 0; seat < state.seats; seat++) {
    if (seat === view.viewerSeat) continue;
    const held = chipsHeld(state, seat);
    const eliminated = held === 0;
    // Deliberately NOT `state.turn === seat`: `state.turn` already
    // points at whoever goes next the instant the PREVIOUS roll is
    // computed — that's necessary for `reduce` itself, but it means the
    // published `state` names the next actor before their dice have
    // been revealed at all (before REVEAL_HOLD_MS elapses in automatic
    // play, or indefinitely in manual mode). Highlighting off `state.turn`
    // made the glow jump to the next pod before anything about their
    // turn had actually happened — same shape of bug as the game-end
    // summary appearing early, just on the seat ring instead. `lastAction`
    // only changes at the moment a roll is genuinely revealed, so keying
    // off it keeps the glow on whoever just acted for the whole pending
    // gap, and only moves it once the next roll is truly shown.
    const cue = seatCue(live, seat);
    out.push({
      seat,
      name: view.nameFor(seat),
      colour: view.colourFor(seat),
      meta: eliminated ? "Out" : `${held} chip${held === 1 ? "" : "s"}`,
      active: cue.active,
      thinking: cue.thinking,
      eliminated,
      away: view.awayFor?.(seat) ?? false,
    });
  }
  return out;
}

/** The one game-specific slot: the Roll button and the dice it produces. */
export function LrcControls({ live }: { live: Live }) {
  // The dice are NOT rolled here any more. They used to be — the screen
  // resolved them with `live.rng`, showed the tumble, and held the submit
  // back for its length so the chips would not move under the dice.
  //
  // That is a cheat vector the moment a second person is watching: a
  // client that authors its own roll can choose it. The roll is now
  // resolved by whoever owns the game (the session offline, the server
  // online) via `completeAction`, and the beat that used to come from
  // delaying the submit is the engine's own `dice` event — which the chips
  // wait behind, and which obeys skip and reduced motion as a client-side
  // `setTimeout` never did. The dice shown are the real, decided ones.
  const roll = () => {
    if (live.busy) return; // Mid-roll — ignore a second click.
    // Empty: whatever were sent would be discarded anyway.
    live.submitAction({ t: "roll", dice: [] });
  };

  const showRoll = live.isHeroTurn;

  return (
    <>
      <TurnIndicator label="Your turn — roll" show={showRoll} />

      {/* Driven by the `dice` event as the queue reaches it, not by
          `lastAction` — see the event's doc. */}
      <DiceOverlay />

      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 z-1800 flex justify-center pb-4"
        style={{ height: 64 }}
      >
        <AnimatePresence>
          {showRoll ? (
            <motion.button
              type="button"
              onClick={roll}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={TRANSITIONS.ui}
              className="pointer-events-auto rounded-full bg-linear-to-b from-brass-300 to-brass-500 px-8 py-3 text-sm font-extrabold text-felt-950 shadow-e2"
            >
              Roll
            </motion.button>
          ) : null}
        </AnimatePresence>
      </div>
    </>
  );
}

type Face = "L" | "R" | "C" | "dot";

/** Fixed cycle, not Math.random(): this is cosmetic tumble animation,
 * not a game outcome, but a deterministic sequence looks exactly as
 * "rolly" as a random one and keeps the whole app's no-Math.random rule
 * simple to reason about — every cycling die is doing this same walk,
 * just starting from a different offset. */
const TUMBLE_SEQUENCE: readonly Face[] = ["dot", "L", "C", "R"];
const TUMBLE_TICK_MS = 100;
/**
 * Derived from `DURATION.diceTumble`, the same number the choreographer
 * holds the queue for, so the dice cannot still be tumbling when the chips
 * they decided start to move. It was a separate hand-tuned count once, and
 * that is how the two drifted apart.
 */
const TUMBLE_TICKS = Math.max(1, Math.round((DURATION.diceTumble * 1000) / TUMBLE_TICK_MS));

/**
 * Transient dice display — not a Piece (see dice.ts / DiceFace.tsx for
 * why), just an overlay that shows the latest roll.
 *
 * It tumbles when the `dice` event is APPLIED — the moment the queue
 * reaches the roll — through the same one-shot channel the slam uses, so
 * it is in step with the chips behind it by construction. It used to key
 * off `lastAction`, which lands when a turn ARRIVES: a bot's dice tumbled
 * during its thinking beat, and a person's arrived late behind the
 * previous roll's exit while the chips were already flying.
 *
 * The result is already decided when this runs; the tumble is a reveal
 * over a known value, same as a slot machine. Each roll mounts under its
 * own key and the old one fades out UNDERNEATH it (a one-cell grid), so a
 * new roll never waits for the last one to leave before it appears.
 */
function DiceOverlay() {
  const [roll, setRoll] = useState<{ id: number; faces: Face[] } | null>(null);
  const [tick, setTick] = useState(TUMBLE_TICKS);

  useEffect(
    () =>
      onDice(({ faces }) => {
        setRoll((prev) => ({ id: (prev?.id ?? 0) + 1, faces: faces as Face[] }));
        // Reduced motion: the result, without the tumble.
        setTick(prefersReducedMotion() ? TUMBLE_TICKS : 0);
      }),
    [],
  );

  useEffect(() => {
    if (!roll || tick >= TUMBLE_TICKS) return;
    const id = setTimeout(() => setTick((t) => t + 1), TUMBLE_TICK_MS);
    return () => clearTimeout(id);
  }, [roll, tick]);

  const settled = tick >= TUMBLE_TICKS;
  const shown = roll?.faces.map((real, i) =>
    settled ? real : TUMBLE_SEQUENCE[(tick + i) % TUMBLE_SEQUENCE.length]!,
  );

  return (
    <div
      className="pointer-events-none absolute inset-x-0 grid place-items-center"
      style={{ top: "38%" }}
    >
      <AnimatePresence initial={false}>
        {roll && shown && shown.length > 0 ? (
          <motion.div
            key={roll.id}
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={TRANSITIONS.ui}
            className="flex gap-2"
            style={{ gridArea: "1 / 1" }}
          >
            {shown.map((face, i) => (
              <DiceFace key={i} face={face} size={48} />
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/**
 * No difficulty control here, deliberately, and it is the only game
 * without one: LRC has no decision in it. Rolling is the only legal
 * action and the dice are random, so `lrcBots`' three tiers differ in
 * PACING alone (see that file). A slider that changes how fast an
 * opponent rolls and nothing else is worse than no slider — it promises
 * a difference the game cannot have.
 */
