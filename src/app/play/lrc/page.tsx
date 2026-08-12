"use client";

/**
 * Left Right Center — the real, playable game screen.
 *
 * Composes GameHost (shared table chrome) around the lrc GameDefinition.
 * The only genuinely game-specific pieces here are the seat labels
 * (chip counts, not bids or hand sizes), the Roll button, and the dice
 * overlay — everything else (seat ring, toasts, game-end summary) comes
 * from the shared layer.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { HERO } from "@/engine/types";
import { GameHost } from "@/table/GameHost";
import type { GameRuntime } from "@/table/useGameRuntime";
import type { SeatView } from "@/table/SeatRing";
import { TurnIndicator } from "@/ui/phases/PhaseScreens";
import { DiceFace } from "@/ui/primitives/DiceFace";
import { botColour, botName } from "@/games/_shared/botIdentity";
import { lrc } from "@/games/lrc/rules";
import { rollAction } from "@/games/lrc/dice";
import { chipsHeld, diceCountFor, potSize } from "@/games/lrc/state";
import type { LrcAction, LrcState } from "@/games/lrc/types";
import { TRANSITIONS } from "@/motion/presets";

export default function LrcPlayPage() {
  const [seats, setSeats] = useState(6);
  const [started, setStarted] = useState(false);
  const [gameKey, setGameKey] = useState(0);

  if (!started) {
    return (
      <SetupScreen
        seats={seats}
        onSeatsChange={setSeats}
        onStart={() => setStarted(true)}
      />
    );
  }

  return (
    <GameHost<LrcState, LrcAction>
      key={gameKey}
      definition={lrc}
      runtime={{ seats }}
      gameTitle="Left Right Center"
      handZone={64} // just enough room for the Roll button, no hand
      players={playerViews}
      stats={(state) => [{ label: "Pot", value: `${potSize(state)} chips` }]}
      pendingLabel={pendingLabel}
      onRematch={() => setGameKey((k) => k + 1)}
      onLobby={() => setStarted(false)}
    >
      {(live) => <LrcControls live={live} />}
    </GameHost>
  );
}

/** DevPanel's game-specific line — see GameHostProps.pendingLabel. */
function pendingLabel(state: LrcState, seat: number): string {
  const chips = chipsHeld(state, seat);
  const dice = diceCountFor(state, seat);
  return `${botName(seat)} pending — ${chips} chip${chips === 1 ? "" : "s"} → ${dice} ${dice === 1 ? "die" : "dice"}`;
}

function playerViews(state: LrcState, live: GameRuntime<LrcState, LrcAction>): SeatView[] {
  const out: SeatView[] = [];
  for (let seat = 1; seat < state.seats; seat++) {
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
    const thisSeatActing = live.busy && live.lastAction?.seat === seat;
    out.push({
      seat,
      name: botName(seat),
      colour: botColour(seat),
      meta: eliminated ? "Out" : `${held} chip${held === 1 ? "" : "s"}`,
      active: thisSeatActing,
      thinking: thisSeatActing,
      eliminated,
    });
  }
  return out;
}

/**
 * A bot's move only ever animates AFTER its dice settle: `revealBotTurn`
 * prepends a real `think` event, so the choreographer holds the actual
 * chip-move animation back until that beat (which comfortably outlasts
 * the tumble) finishes. The hero's own roll had no equivalent — clicking
 * Roll called `submitAction` immediately, which pushes the chip-move
 * events to the choreographer right away, with nothing holding them
 * back the way `think` does for a bot. The tumble and the chip's actual
 * flight ran side by side instead of tumble-then-flight, which is
 * exactly the "it looks like they're happening simultaneously" gap
 * reported live. Matching bots' feel means the hero's OWN move needs
 * the same kind of held beat, sized to the tumble it's covering for.
 */
const HERO_REVEAL_MS = 90 * 6 + 110; // TUMBLE_TICK_MS * TUMBLE_TICKS + a small settle beat

/** The one game-specific slot: the Roll button and the dice it produces. */
function LrcControls({ live }: { live: GameRuntime<LrcState, LrcAction> }) {
  // Holds the hero's own roll back exactly the way a bot's `think` event
  // holds theirs: dice are resolved and shown tumbling immediately (via
  // `pendingRoll`, not `live.lastAction`, since the runtime hasn't been
  // told about this roll yet), but `submitAction` — the call that
  // actually moves the chips — doesn't fire until the tumble has had
  // time to settle. The action itself is already fully resolved the
  // instant Roll is clicked (`rollAction` already consumed the rng);
  // this only delays WHEN it's applied, not what it resolves to.
  const [pendingRoll, setPendingRoll] = useState<LrcAction | null>(null);

  useEffect(() => {
    if (!pendingRoll) return;
    // Always the full delay, regardless of manual/autoAdvance mode.
    // Manual mode only ever changes WHEN a BOT's turn is revealed
    // (immediately on a timer vs. on a click) — never how any turn's
    // own animation plays, hero's included. See useGameRuntime's
    // `advance()` for the fuller version of this reasoning; the same
    // "one gate (pendingReveal), not two (gate + skip the animation)"
    // idea applies here.
    const id = setTimeout(() => {
      live.submitAction(pendingRoll);
      setPendingRoll(null);
    }, HERO_REVEAL_MS);
    return () => clearTimeout(id);
    // Only pendingRoll identity should re-trigger this — live.submitAction
    // is a fresh closure every render but always calls through to the
    // same runtime, so depending on it here would just restart the timer
    // on every unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRoll]);

  const roll = () => {
    if (pendingRoll) return; // Already rolling — ignore a second click.
    const count = diceCountFor(live.state, HERO);
    setPendingRoll(rollAction(live.rng, count));
  };

  const showRoll = live.isHeroTurn && !pendingRoll;
  const lastRoll = pendingRoll
    ? (pendingRoll.t === "roll" ? pendingRoll.dice : null)
    : live.lastAction?.action.t === "roll"
      ? live.lastAction.action.dice
      : null;

  return (
    <>
      <TurnIndicator label="Your turn — roll" show={showRoll} />

      <DiceOverlay
        dice={lastRoll}
        // `.action`, not the `{seat, action}` wrapper: `submitAction`
        // stores the exact SAME action object `pendingRoll` already
        // held (see its own comment — only WHEN it's applied is
        // delayed, not what it resolves to), so once it fires,
        // `live.lastAction.action` is === the `pendingRoll` we were
        // already showing. Comparing the wrapper instead — a NEW object
        // every time regardless — made the tumble reset and replay a
        // second time the instant submitAction landed, even though it's
        // the same roll: the exact "dice rolled twice" bug reported
        // live. Bot rolls are unaffected — `bot.choose()` always builds
        // a genuinely new action, so this is still a real change then.
        revision={pendingRoll ?? live.lastAction?.action}
      />

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
const TUMBLE_TICK_MS = 90;
const TUMBLE_TICKS = 6;

/**
 * Transient dice display — not a Piece (see dice.ts / DiceFace.tsx for
 * why), just a self-contained overlay keyed to the last roll.
 *
 * `revision` is `live.lastAction` — a new object every roll, even when
 * two rolls produce identical dice (e.g. two "all dots"). Deriving the
 * AnimatePresence key from ITS identity, via a monotonic counter bumped
 * whenever that reference changes, is what makes the exit/enter
 * animation replay correctly on a repeat result — a key built from the
 * dice values themselves wouldn't change between two identical rolls.
 *
 * The result is already decided by the time this ever runs — `reduce`
 * is synchronous, so `dice` is the real, final roll from the moment
 * this component sees it. The tumble below is a reveal animation over
 * an already-known value, same as a slot machine: brief, deterministic
 * cycling, then landing on the true result.
 */
function DiceOverlay({
  dice,
  revision,
}: {
  dice: readonly Face[] | null;
  revision: unknown;
}) {
  // "Adjusting state during render," per React's own docs — the
  // sanctioned way to derive a monotonic id from a changing prop
  // reference, and to reset `tick` in that same instant. NOT a ref
  // mutation: calling a state setter mid-render makes React discard and
  // re-run this render immediately, so it never commits an inconsistent
  // value the way a raw ref write could. The interval below only ever
  // calls setTick from INSIDE its async callback, never synchronously
  // in the effect body — that's the distinction the lint rule cares
  // about (a synchronous setState in an effect can cascade renders;
  // one from a real async event, a timer tick, is exactly what effects
  // are for).
  const [rollId, setRollId] = useState(0);
  const [seenRevision, setSeenRevision] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  if (revision !== seenRevision) {
    setSeenRevision(revision);
    setRollId((n) => n + 1);
    setTick(0);
  }

  useEffect(() => {
    if (!dice || dice.length === 0) return;
    const id = setInterval(() => {
      setTick((t) => {
        const next = t + 1;
        if (next >= TUMBLE_TICKS) clearInterval(id);
        return next;
      });
    }, TUMBLE_TICK_MS);
    return () => clearInterval(id);
    // Re-tumble whenever a genuinely new roll arrives, not on every
    // render — rollId is exactly that signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rollId]);

  const settled = tick >= TUMBLE_TICKS;
  const shown = dice?.map((real, i) =>
    settled ? real : TUMBLE_SEQUENCE[(tick + i) % TUMBLE_SEQUENCE.length]!,
  );

  return (
    <div
      className="pointer-events-none absolute inset-x-0 flex justify-center"
      style={{ top: "38%" }}
    >
      <AnimatePresence mode="wait">
        {shown && shown.length > 0 ? (
          <motion.div
            key={rollId}
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={TRANSITIONS.ui}
            className="flex gap-2"
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

function SetupScreen({
  seats,
  onSeatsChange,
  onStart,
}: {
  seats: number;
  onSeatsChange: (n: number) => void;
  onStart: () => void;
}) {
  return (
    <main className="felt felt-weave flex min-h-svh flex-col items-center justify-center gap-8 px-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="eyebrow">New game</span>
        <h1 className="font-display text-4xl tracking-wider text-brass-300">
          Left Right Center
        </h1>
        <p className="max-w-xs text-sm text-bone-400">
          Roll, pass chips left and right, or lose them to the pot. Last
          player holding chips wins it all.
        </p>
      </div>

      <div className="flex w-full max-w-xs flex-col gap-2">
        <span className="eyebrow text-center">Players — {seats}</span>
        <input
          type="range"
          min={lrc.minSeats}
          max={lrc.maxSeats}
          value={seats}
          onChange={(e) => onSeatsChange(Number(e.target.value))}
          className="w-full accent-brass-400"
        />
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
    </main>
  );
}
