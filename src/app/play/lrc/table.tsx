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
import { emitDice, onDice } from "@/table/fx";
import { BandNote, HandZone } from "@/table/HandZone";
import { Button } from "@/ui/primitives/Button";
import { DiceFace } from "@/ui/primitives/DiceFace";
import { HeroStatusBadge, TurnIndicator, type ScoreRow } from "@/ui/phases/PhaseScreens";
import type { SeatView } from "@/table/SeatRing";
import { chipStackBadges } from "@/table/layout";
import { useGeometry, useTableStore } from "@/table/store";
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
  /** Supplied by `botFrom(frame)`: a seat nobody owns, which a bot plays. */
  botFor?: (seat: SeatId) => boolean;
}

/** Seat 0, against bots — every offline game. */
export const OFFLINE_VIEW: LrcView = {
  viewerSeat: 0,
  nameFor: botName,
  colourFor: botColour,
};

/**
 * The strip where a hand would be. LRC has no hand — the viewer's chips
 * pile up from the band above it, like everybody else's from their pod —
 * so it only needs to hold the band off the bottom edge. It was 64px, an
 * empty strip under the Roll button (the user, 2026-09-28: "a lil too
 * much white space underneath my chips and the roll button").
 *
 * A constant because both shells have to agree, and they did not: the
 * room passed `0` while `LrcControls` went on rendering a fixed 64px
 * bar, so online the button sat on top of whatever the geometry had
 * laid into the bottom band.
 */
export const LRC_HAND_ZONE = 16;

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
  return { title, rows, target: state.target };
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
      status: eliminated ? "Out" : undefined,
      stats: eliminated ? undefined : [[{ label: "Chips", value: held }]],
      active: cue.active,
      thinking: cue.thinking,
      eliminated,
      away: view.awayFor?.(seat) ?? false,
      bot: view.botFor?.(seat) ?? false,
    });
  }
  return out;
}

/**
 * The one game-specific slot: the Roll button and the dice it produces.
 *
 * Roll is the band's bar, above the viewer's chips; the band's row says
 * how many chips they hold, since the viewer has no pod to say it.
 */
export function LrcControls({ view, live }: { view: LrcView; live: Live }) {
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
    // The dice start tumbling on the press, not when the result comes back
    // (the user, 2026-10-02: no lag on your own move). What they land on is
    // still the server's; its `dice` event lands them.
    if (!prefersReducedMotion() && view.viewerSeat >= 0) {
      emitDice({ seat: view.viewerSeat, faces: null, count: diceCountFor(live.state, view.viewerSeat) });
    }
    // Empty: whatever were sent would be discarded anyway.
    live.submitAction({ t: "roll", dice: [] });
  };

  // A spectator holds no chips and rolls nothing.
  const seated = view.viewerSeat >= 0;
  const chips = seated ? chipsHeld(live.state, view.viewerSeat) : 0;

  return (
    <>
      {/* Driven by the `dice` event as the queue reaches it, not by
          `lastAction` — see the event's doc. */}
      <DiceOverlay />
      <ChipStackCounts />

      <HandZone
        bar={
          live.isHeroTurn ? (
            <>
              <BandNote>Your turn</BandNote>
              <Button shape="pill" tone="primary" onClick={roll}>
                Roll
              </Button>
            </>
          ) : undefined
        }
        left={
          seated ? (
            chips === 0 ? (
              <HeroStatusBadge label="You" detail="out this round" />
            ) : (
              <HeroStatusBadge stats={[[{ label: "Chips", value: chips }]]} />
            )
          ) : undefined
        }
        // Rolling is the bar; everybody else's turn is this line.
        center={<TurnIndicator label="" show={false} />}
        // The pot, counted: a pile of identical chips does not say how many.
        right={<HeroStatusBadge stats={[[{ label: "Pot", value: potSize(live.state) }]]} />}
      />
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
/** How long a throw tumbles waiting for its result before it gives up. */
const OPEN_TUMBLE_MAX_TICKS = 80;

/**
 * The count on every pile that has become one stack (see layout's
 * `chipPileStacks`): written on its top chip, the way a real stack is
 * counted, since a stack no longer shows how many it holds. Chrome over the
 * piece layer rather than a label on a piece: the top chip is the one that
 * leaves when the pile loses one, and a label on it would fly off with it.
 */
function ChipStackCounts() {
  const geometry = useGeometry();
  const placements = useTableStore((s) => s.placements);
  if (!geometry) return null;
  return (
    <>
      {chipStackBadges(geometry, placements).map((b) => (
        <div
          key={b.key}
          aria-hidden
          className="pointer-events-none absolute z-1100 flex items-center justify-center font-extrabold tnum text-bone-50 [text-shadow:0_1px_2px_rgb(0_0_0/0.6)]"
          style={{
            left: b.cx - b.diameter / 2,
            top: b.cy - b.diameter / 2,
            width: b.diameter,
            height: b.diameter,
            fontSize: Math.max(11, b.diameter * 0.4),
          }}
        >
          {b.count}
        </div>
      ))}
    </>
  );
}

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
  const geometry = useGeometry();
  // `open`: thrown on the press, its result not back yet — tumbling until
  // the real `dice` event lands it, under the same key so it never blinks.
  const [roll, setRoll] = useState<{ id: number; faces: Face[]; open: boolean } | null>(null);
  const [tick, setTick] = useState(TUMBLE_TICKS);

  useEffect(
    () =>
      onDice(({ faces, count }) => {
        if (faces === null) {
          setRoll((prev) => ({ id: (prev?.id ?? 0) + 1, faces: Array(count ?? 1).fill("dot"), open: true }));
          setTick(0);
          return;
        }
        setRoll((prev) => ({
          id: prev?.open ? prev.id : (prev?.id ?? 0) + 1,
          faces: faces as Face[],
          open: false,
        }));
        // Reduced motion: the result, without the tumble.
        setTick(prefersReducedMotion() ? TUMBLE_TICKS : 0);
      }),
    [],
  );

  useEffect(() => {
    if (!roll || (tick >= TUMBLE_TICKS && !roll.open)) return;
    const id = setTimeout(() => {
      // A throw whose result never came (refused, or lost) stops tumbling.
      if (roll.open && tick + 1 >= OPEN_TUMBLE_MAX_TICKS) setRoll(null);
      else setTick((t) => t + 1);
    }, TUMBLE_TICK_MS);
    return () => clearTimeout(id);
  }, [roll, tick]);

  const settled = tick >= TUMBLE_TICKS && !roll?.open;
  const shown = roll?.faces.map((real, i) =>
    settled ? real : TUMBLE_SEQUENCE[(tick + i) % TUMBLE_SEQUENCE.length]!,
  );

  // One chain with the pot, on the table's own centre: the dice end just
  // above the point the pot grows down from (layout's "center" zone). They
  // sat at 38% of the screen instead, and on a phone the pot's first chip
  // landed on the middle die. The geometry sizes the row (`zones.dice`), so
  // the dice grow with the table rather than staying 48px on every screen.
  if (!geometry) return null;
  const zone = geometry.zones.dice;
  const die = zone.h;

  return (
    <div
      className="pointer-events-none absolute grid place-items-center"
      style={{ left: zone.x, top: zone.y, width: zone.w, height: zone.h }}
    >
      <AnimatePresence initial={false}>
        {roll && shown && shown.length > 0 ? (
          <motion.div
            key={roll.id}
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={TRANSITIONS.ui}
            className="flex"
            style={{ gridArea: "1 / 1", gap: die * 0.18 }}
          >
            {shown.map((face, i) => (
              <DiceFace key={i} face={face} size={die} />
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
