"use client";

/**
 * Poker's table content, shared by the offline page and by an online room.
 *
 * Same split as Spades', and for the same reason: the betting panel, the
 * pot badge, the show/muck bar and the pod readouts are the same whether
 * the hand is being dealt in this tab or on a server. The only thing that
 * genuinely differs is who is looking, so that is a parameter.
 */

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import type { SeatId } from "@/engine/types";
import { botColour, botName } from "@/games/_shared/botIdentity";
import { parseCard } from "@/games/_shared/cards";
import { isHiddenCard, legalActions } from "@/games/poker/rules";
import {
  amountToCall,
  betRange,
  highestStreetCommitted,
  positionBadge,
  potTotal,
  seatHoleCards,
} from "@/games/poker/state";
import { bestOfSeven, describeBest, HAND_CATEGORY_INFO, type HandCategory } from "@/games/poker/hand";
import type { PokerAction, PokerState } from "@/games/poker/types";
import { TRANSITIONS } from "@/motion/presets";
import { InfoSheet } from "@/ui/disclosure";
import { NumberStepper } from "@/ui/primitives/NumberStepper";
import { HeroStatusBadge, TurnIndicator, type ScoreRow } from "@/ui/phases/PhaseScreens";
import type { RoundNote } from "@/table/GameHost";
import type { GameSetting } from "@/table/gameSettings";
import { HandZone } from "@/table/HandZone";
import type { SeatView } from "@/table/SeatRing";
import { seatCue } from "@/table/turnCue";
import { useGeometry } from "@/table/store";
import type { GameRuntime } from "@/table/useGameRuntime";

type Live = GameRuntime<PokerState, PokerAction>;

/** Who is looking at this table, and what everyone is called. */
export interface PokerView {
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
export const OFFLINE_VIEW: PokerView = {
  viewerSeat: 0,
  nameFor: botName,
  colourFor: botColour,
};

export function standings(view: PokerView, state: PokerState, _live: Live, seats: SeatView[]) {
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
    return { seat, name: nameOf(seat), total: state.stacks[seat] ?? 0 };
  }).sort((a, b) => b.total - a.total);
}

/**
 * `RoundEndScorecard`'s content — every seat DEALT INTO the hand that
 * just ended (`state.folded`'s keys are fixed for the hand's whole
 * lifetime and not reset until the next `startRound`, so this is still
 * readable here even after `result` has settled).
 */
export function roundSummary(view: PokerView, state: PokerState) {
  const result = state.result;
  if (!result) return null;

  const name = (seat: SeatId) => (seat === view.viewerSeat ? "You" : view.nameFor(seat));
  const colour = (seat: SeatId) => (seat === view.viewerSeat ? "var(--color-brass-300)" : view.colourFor(seat));

  // The hand a seat made, named — but only when this viewer can see both
  // of its cards. A winner's are always shown; a loser who mucked keeps
  // theirs hidden. Hidden is not ABSENT: the view keeps a masked hand under
  // placeholder ids, so "has two cards" is not the test. Parsing the
  // placeholders gave a loser a hand they never held — "Full house, Jacks
  // and NaNs", the board's jacks plus two unreadable cards.
  const handOf = (seat: SeatId): string | null => {
    if (!result.showdown) return null;
    const hole = seatHoleCards(state, seat);
    if (hole.length < 2 || hole.some(isHiddenCard)) return null;
    return describeBest([...hole, ...state.communityOrder].map(parseCard));
  };

  const rows: ScoreRow[] = Object.keys(state.folded)
    .map(Number)
    .map((seat) => {
      const won = result.winningSeats.includes(seat);
      // At the showdown and not a winner: they LOST, whether or not they
      // showed. Mucking a beaten hand used to read as "folded", which is a
      // different thing — a fold is giving up before the end.
      const lost = !won && result.showdownSeats.includes(seat);
      const hand = won || lost ? handOf(seat) : null;
      const status = won ? "won" : lost ? "lost" : state.folded[seat] ? "folded" : undefined;
      return {
        seat,
        name: name(seat),
        colour: colour(seat),
        detail: status && hand ? `${status} · ${hand}` : status,
        // Net, not the payout: a winner who put in $20 of a $50 pot is up
        // $30, and a player who put in $20 and lost is down $20 — which
        // the payout showed as +50 and +0.
        delta: result.net[seat] ?? 0,
        total: state.stacks[seat] ?? 0,
      };
    })
    .sort((a, b) => b.total - a.total);

  const winners = result.winningSeats.map(name);
  const solo = result.winningSeats.length === 1 ? result.winningSeats[0]! : null;
  const soloHand = solo !== null ? handOf(solo) : null;
  const verb = winners[0] === "You" ? "win" : "wins";
  const title =
    solo === null
      ? `${winners.join(" & ")} split the pot`
      : soloHand
        ? `${winners[0]} ${verb} with ${soloHand}`
        : `${winners[0]} ${verb} the pot`;
  // Why it ended, in plain words — the thing a newcomer cannot infer, and
  // the thing they asked for: winning at a showdown against somebody who
  // never showed their cards read as winning for no reason at all.
  const possessive = (seat: SeatId) => (seat === view.viewerSeat ? "your" : `${name(seat)}'s`);
  const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  let note: RoundNote | undefined;
  if (!result.showdown) {
    note = {
      tone: "info",
      title: "No showdown",
      body: `Everyone else folded, so ${winners[0] === "You" ? "you win" : `${winners[0]} wins`} without showing any cards.`,
    };
  } else if (solo === null) {
    note = { tone: "info", title: "A tie", body: "The best hands were equal, so the pot is shared." };
  } else {
    const losers = result.showdownSeats.filter((s) => !result.winningSeats.includes(s));
    const shown = losers.flatMap((s) => {
      const hand = handOf(s);
      return hand ? [`${possessive(s)} ${hand}`] : [];
    });
    const hidden = losers.filter((s) => !handOf(s));
    const sentences: string[] = [];
    if (soloHand && shown.length > 0) {
      sentences.push(`${capital(possessive(solo))} ${soloHand} beats ${listOf(shown)}.`);
    }
    if (hidden.length > 0) {
      const who = listOf(hidden.map((s) => (s === view.viewerSeat ? "You" : name(s))));
      const theirs = hidden.length === 1 && hidden[0] === view.viewerSeat ? "your" : "their";
      sentences.push(
        `${who} didn't show ${theirs} cards. At the end, a player who can't win may keep them hidden — so ${theirs === "your" ? "yours" : "theirs"} lost to ${solo === view.viewerSeat ? "yours" : `${name(solo)}'s`}.`,
      );
    }
    note = {
      tone: "info",
      title: solo === view.viewerSeat ? "Why you won" : `Why ${name(solo)} won`,
      body: sentences.join(" ") || "Theirs was the best hand at the showdown.",
    };
  }

  return { title, rows, note };
}

/** "A", "A and B", "A, B and C". */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** DevPanel's game-specific line — see GameHostProps.pendingLabel. */
export function pendingLabel(view: PokerView, state: PokerState, seat: SeatId): string {
  if (state.pendingShowdown) return `${view.nameFor(seat)} pending — show or muck`;
  const toCall = amountToCall(state, seat);
  return `${view.nameFor(seat)} pending — ${toCall > 0 ? `to call ${toCall}` : "checks or bets"}`;
}

export function playerViews(view: PokerView, state: PokerState, live: Live): SeatView[] {
  const out: SeatView[] = [];
  // Every seat but the VIEWER's own. This counted from 1 for a long time,
  // which is the same thing exactly as long as the viewer is seat 0 —
  // and online they are not. A player at seat 1 got no pod for seat 0
  // (the party leader simply had no nameplate) and a redundant one for
  // themselves.
  for (let seat = 0; seat < state.seats; seat++) {
    if (seat === view.viewerSeat) continue;
    const inHand = seat in state.folded;
    // Busted from the whole MATCH, not merely folded this hand — see
    // `isAllIn`'s own caution in state.ts: a 0 stack mid-hand usually
    // means all-in, not out. `!inHand` is what tells the two apart here.
    const busted = !inHand && (state.stacks[seat] ?? 0) === 0;
    const folded = inHand && state.folded[seat];
    const stack = state.stacks[seat] ?? 0;
    const bet = state.streetCommitted[seat] ?? 0;

    // Two lines rather than "$4837 · bet $362" on one: that is wider than a
    // pod, and the bet — the part that matters mid-hand — was the part cut off.
    const meta = busted
      ? "Out"
      : folded
        ? "Folded"
        : bet > 0
          ? [`$${stack}`, `bet $${bet}`]
          : `$${stack}`;

    // Deliberately keyed off `lastAction`, not `currentSeat`/`toAct` —
    // see LRC's own doc on this exact pattern: `state.toAct[0]` already
    // names the NEXT actor the instant a decision is computed, before
    // its `think` beat has actually played, which would jump the glow
    // to the wrong pod during the pause.
    const cue = seatCue(live, seat);

    out.push({
      seat,
      name: view.nameFor(seat),
      colour: view.colourFor(seat),
      meta,
      active: cue.active,
      thinking: cue.thinking,
      eliminated: busted,
      badge: positionBadge(state, seat) ?? undefined,
      away: view.awayFor?.(seat) ?? false,
    });
  }
  return out;
}

/* ============================================================
   The hero-facing controls: HandZone chrome, the betting panel,
   the show-or-muck bar, and the hand-rankings sheet.
   ============================================================ */

/**
 * Poker's in-game settings — see `gameSettings.tsx` for the shared
 * mechanism every game can add to. Hints are ON by default: they exist for
 * somebody who does not know the game yet, and that person does not know
 * to go looking for them either.
 */
export const POKER_SETTINGS: readonly GameSetting[] = [
  {
    key: "hints",
    label: "Hints",
    description: "Explains each choice under its button, and spells out the dealer and blind markers.",
    default: true,
  },
];

/** This viewer's best hand so far, in words — or null when they hold none. */
function heroHand(state: PokerState, seat: SeatId): string | null {
  if (seat < 0 || state.folded[seat] !== false) return null;
  const hole = seatHoleCards(state, seat);
  if (hole.length < 2 || hole.some(isHiddenCard)) return null;
  return describeBest([...hole, ...state.communityOrder].map(parseCard));
}

export function PokerControls({
  view,
  live,
  hints = true,
}: {
  view: PokerView;
  live: Live;
  /** The player's Hints setting. */
  hints?: boolean;
}) {
  const state = live.state;
  const [hintsOpen, setHintsOpen] = useState(false);
  // Always on, not a hint: what you are holding is the first thing a
  // player needs to know, and a newcomer cannot read it off the cards.
  const hand = heroHand(state, view.viewerSeat);

  const showdownPending = Boolean(state.pendingShowdown) && live.isHeroTurn;
  useShowdownCountdown(live, showdownPending);

  // See `isSeated` in Spades' table: a spectator's -1 makes every
  // `seat === viewer` comparison fail (which is the point, for hands) but
  // is a perfectly ordinary index everywhere else.
  const seated = view.viewerSeat >= 0;
  const heroBadge = positionBadge(state, view.viewerSeat);
  const toCall = amountToCall(state, view.viewerSeat);
  const stack = state.stacks[view.viewerSeat] ?? 0;
  const heroBet = state.streetCommitted[view.viewerSeat] ?? 0;

  return (
    <>
      <PotBadge state={state} />

      <HandZone
        bar={showdownPending ? <ShowMuckBar live={live} /> : undefined}
        left={
          // Nothing for a spectator. `SPECTATOR_SEAT` is -1, which is in
          // nobody's `stacks`, so this rendered a confident "You · $0" to
          // someone with no chips and no seat — and a dealer button for a
          // position they do not hold.
          seated ? (
            <div className="flex items-center gap-1.5">
              <HeroStatusBadge
                inline
                label="You"
                detail={`$${stack}${heroBet > 0 ? ` · bet $${heroBet}` : ""}`}
              />
              {heroBadge ? <HeroPositionBadge label={heroBadge} spelled={hints} /> : null}
            </div>
          ) : undefined
        }
        center={
          live.isHeroTurn && !showdownPending ? (
            <TurnIndicator inline show label={toCall > 0 ? `To call $${toCall}` : "Check or bet"} />
          ) : hand ? (
            <HeroStatusBadge inline label="Your hand" detail={hand} />
          ) : undefined
        }
        right={<HintsButton onOpen={() => setHintsOpen(true)} />}
      />

      {live.isHeroTurn && !state.pendingShowdown ? (
        <BettingPanel view={view} live={live} hand={hand} hints={hints} />
      ) : null}

      <HandRankingsSheet view={view} open={hintsOpen} onClose={() => setHintsOpen(false)} state={state} />
    </>
  );
}

/**
 * The pot total — plain text, not a chip pile. An earlier version placed
 * a decorative fanned pile of chip pieces in the `"pot"` zone; a live
 * playtest reported it overlapping the community row above it on an
 * ordinary pot, so it was dropped for this instead (see rules.ts's own
 * header doc). No piece is involved, so this reads the same `"pot"`
 * zone's box straight off table geometry rather than going through
 * `placements()`/`PieceLayer` — geometry.ts still anchors that box below
 * `community` with a real gap, so the two can't overlap by construction
 * regardless of viewport.
 */
function PotBadge({ state }: { state: PokerState }) {
  const geometry = useGeometry();
  const pot = potTotal(state);
  const box = geometry?.zones.pot;
  if (!box || pot <= 0) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-1200 flex items-center justify-center"
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    >
      <span className="rounded-full bg-felt-950/80 px-3 py-1.5 text-xs font-extrabold tnum text-brass-300 ring-1 ring-brass-400/30 shadow-e1">
        Pot ${pot}
      </span>
    </div>
  );
}

/**
 * Dealer/small-blind/big-blind marker for the view.viewerSeat's own position.
 * `SeatRing` never renders a pod for seat 0, so `PositionBadge` there
 * (the identical small chip, for every OTHER seat) has no hero
 * equivalent to hook into — this is that equivalent, living next to
 * `HeroStatusBadge` instead of on a pod.
 */
function HeroPositionBadge({ label, spelled }: { label: "D" | "SB" | "BB"; spelled: boolean }) {
  const title = label === "D" ? "Dealer" : label === "SB" ? "Small blind" : "Big blind";
  // With hints on, the word itself rather than two letters nobody new can
  // read: "BB" means nothing until somebody has told you.
  if (spelled) {
    return (
      <span className="rounded-full bg-brass-400 px-2 py-0.5 text-[10px] leading-none font-extrabold text-felt-950">
        {title}
      </span>
    );
  }
  return (
    <span
      title={title}
      aria-label={title}
      className="flex h-4 min-w-4 items-center justify-center rounded-full bg-brass-400 px-1 text-[9px] leading-none font-extrabold text-felt-950"
    >
      {label}
    </span>
  );
}

function HintsButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-1 rounded-full bg-felt-950/78 px-2.5 py-1.5 text-[10px] font-bold text-bone-300 ring-1 ring-bone-50/12 hover:bg-brass-400/20 hover:text-brass-300"
    >
      <span aria-hidden>♦</span>
      <span className="truncate">Hands</span>
    </button>
  );
}

/* ============================================================
   Betting: fold/check/call plus bet/raise sizing
   ============================================================ */

/**
 * NOT a `BlockingDialog` — POLICY.md's ladder table literally lists
 * "fold/call/raise" under that rung, but the actual working convention
 * (Spades' `NumericBidPanel`, justified by POLICY's own "never put
 * reference info in a modal" rule) is that any decision needing your
 * own stack/hand visible stays non-modal. Sizing a bet needs both. Same
 * free-floating shape as `NumericBidPanel` — not `HandZone`'s `bar`
 * slot, which is sized for a single compact row and this needs more.
 *
 * Remounts fresh every time it's the hero's turn (the parent only
 * renders it while `live.isHeroTurn`), so the stepper's own local state
 * starting at the fresh legal minimum needs no effect to reset it —
 * the same reasoning `NumericBidPanel` relies on.
 */
function BettingPanel({
  view,
  live,
  hand,
  hints,
}: {
  view: PokerView;
  live: Live;
  hand: string | null;
  hints: boolean;
}) {
  const state = live.state;
  const me = view.viewerSeat;
  const legal = legalActions(state, me);
  const canFold = legal.some((a) => a.t === "fold");
  const canCheck = legal.some((a) => a.t === "check");
  const canCall = legal.some((a) => a.t === "call");
  const canBet = legal.some((a) => a.t === "bet");
  const canRaise = legal.some((a) => a.t === "raise");

  // The two numbers a player actually reasons with: what the bet IS, and
  // what they have already put in. The call amount is the difference, and
  // showing only the difference ("Call $50" after a raise to $100) read as
  // "the bet is $50". Both used to be missing from the panel entirely.
  const currentBet = highestStreetCommitted(state);
  const myBet = state.streetCommitted[me] ?? 0;
  const totalBet = state.totalCommitted[me] ?? 0;
  const toCall = amountToCall(state, me);
  const range = canBet || canRaise ? betRange(state, me) : null;
  const [amount, setAmount] = useState(range?.min ?? 0);
  const allIn = range !== null && amount >= range.max;

  const submit = (action: PokerAction) => live.submitAction(action);
  const verb = canBet ? "Bet" : "Raise to";

  // Every choice the same size and weight. Making the raise big and gold
  // and the rest small and grey was steering: the button you are shown
  // first is the one you are being told to press.
  const choice =
    "flex flex-1 flex-col items-center justify-center rounded-xl bg-bone-50/8 px-2 py-2.5 text-sm font-bold text-bone-100 ring-1 ring-bone-50/18 hover:bg-brass-400/15 hover:text-brass-300";

  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-1800 flex justify-center px-4"
      style={{ bottom: "calc(var(--hand-zone, 150px) + 2px)" }}
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={TRANSITIONS.ui}
        // ONE row on anything wider than a tablet. Stacked, the panel was
        // ~275px tall and grew up from the hand into the middle of the
        // table: on a laptop it sat over the flop, hiding the very cards
        // the decision is about. A 1366x650 window leaves only ~120px
        // between the board and the hero's cards, so the bar has to fit in
        // that, not merely be shorter. A phone keeps the stack — it has the
        // height, and not the width.
        className="pointer-events-auto flex w-[min(24rem,94vw)] flex-col gap-3 rounded-2xl border border-brass-400/25 bg-linear-to-b from-felt-800/95 to-felt-900/95 p-4 shadow-e2 backdrop-blur-md lg:w-[min(64rem,96vw)] lg:flex-row lg:items-center lg:gap-3 lg:p-2.5"
      >
        <dl className="grid grid-cols-4 gap-2 text-center lg:w-[25rem] lg:shrink-0">
          <BetFigure label="Current bet" value={currentBet > 0 ? `$${currentBet}` : "None"} strong />
          {/* This round only, which is the number a call is measured against —
              so the whole hand's worth, which already sits in the pot, is
              said underneath rather than seeming to have vanished at the flop. */}
          <BetFigure
            label="Your bet"
            value={`$${myBet}`}
            // Only when it differs: on the first round of betting the two
            // are the same number, and saying it twice reads as two things.
            sub={totalBet !== myBet ? `Total bet $${totalBet}` : undefined}
            strong
          />
          <BetFigure label="Pot" value={`$${potTotal(state)}`} />
          <BetFigure label="Your hand" value={hand ?? "—"} wrap />
        </dl>

        {range ? (
          <div className="flex flex-col items-center gap-2 lg:shrink-0 lg:flex-row">
            {/* Dropped on the bar, where every pixel of height is table: the
                button beside it already says "Raise to $X". */}
            <span className="text-[11px] font-semibold tracking-wide text-bone-400 uppercase lg:hidden">
              {verb}
            </span>
            <NumberStepper
              value={amount}
              min={range.min}
              max={range.max}
              step={state.bigBlind}
              onChange={setAmount}
              label="chips"
              format={(v) => `$${v}`}
              size="sm"
            />
            <div className="flex w-full gap-1.5 lg:w-auto lg:flex-col lg:gap-1">
              {betPresets(potTotal(state), range).map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setAmount(preset.to)}
                  className="flex-1 rounded-full bg-bone-50/6 px-2.5 py-1.5 text-[10px] font-bold text-bone-300 ring-1 ring-bone-50/14 hover:bg-brass-400/15 hover:text-brass-300 lg:py-0.5"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex gap-2 lg:flex-1">
          {canFold ? (
            <button type="button" onClick={() => submit({ t: "fold" })} className={choice}>
              <span>Fold</span>
              {hints ? <ChoiceNote>give up this hand</ChoiceNote> : null}
            </button>
          ) : null}
          {canCheck ? (
            <button type="button" onClick={() => submit({ t: "check" })} className={choice}>
              <span>Check</span>
              {hints ? <ChoiceNote>pass — no bet</ChoiceNote> : null}
            </button>
          ) : null}
          {canCall ? (
            <button type="button" onClick={() => submit({ t: "call" })} className={choice}>
              <span>Call ${toCall}</span>
              {/* Only when it says something the amount does not: with
                  nothing of yours in yet this round, the call IS the bet,
                  and "Call $362 · matches $362" just repeats itself. Once
                  you have chips in — a blind, or a bet somebody raised
                  over — the two differ, and that is when it helps. */}
              {myBet > 0 || hints ? (
                <ChoiceNote>
                  {myBet > 0 ? `matches $${currentBet}` : "match the bet"}
                  {hints ? " to stay in" : ""}
                </ChoiceNote>
              ) : null}
            </button>
          ) : null}
          {range ? (
            <button
              type="button"
              onClick={() => submit(canBet ? { t: "bet", to: amount } : { t: "raise", to: amount })}
              className={choice}
            >
              <span>
                {verb} ${amount}
              </span>
              {allIn ? (
                <span className="text-[10px] font-semibold text-warn">all in</span>
              ) : hints ? (
                <ChoiceNote>others must match it</ChoiceNote>
              ) : null}
            </button>
          ) : null}
        </div>
      </motion.div>
    </div>
  );
}

/** The quiet line under a choice — what it means, or what it matches. */
function ChoiceNote({ children }: { children: React.ReactNode }) {
  return <span className="text-[10px] font-semibold text-bone-400">{children}</span>;
}

function BetFigure({
  label,
  value,
  sub,
  strong,
  wrap,
}: {
  label: string;
  value: string;
  /** A second, quieter figure underneath — like the call button's own. */
  sub?: string;
  strong?: boolean;
  /** For words rather than a number ("Two pair, Kings and 10s"). */
  wrap?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-felt-950/50 px-2 py-1.5 ring-1 ring-bone-50/8">
      <dt className="text-[10px] font-semibold tracking-wide text-bone-400 uppercase">{label}</dt>
      <dd
        className={`tnum font-extrabold ${
          strong ? "text-lg text-brass-300" : wrap ? "text-[11px] leading-tight text-bone-100" : "text-sm text-bone-200"
        }`}
      >
        {value}
      </dd>
      {sub ? <dd className="tnum text-[10px] font-semibold text-bone-400">{sub}</dd> : null}
    </div>
  );
}

function betPresets(pot: number, range: { min: number; max: number }) {
  const clamp = (n: number) => Math.max(range.min, Math.min(range.max, Math.round(n)));
  return [
    { label: "½ pot", to: clamp(pot * 0.5) },
    { label: "Pot", to: clamp(pot) },
    { label: "All in", to: range.max },
  ];
}

/* ============================================================
   Show or muck
   ============================================================ */

/** Real convention: a hand is mucked by default unless actively shown —
 * same shape as Rummy's `CLAIM_MS`/`useClaimCountdown`, minus the
 * depleting-ring polish (`ClaimRing`) that window earns from being the
 * one deliberately loud moment in that game; here a plain timed bar is
 * enough for a decision that carries no real stakes either way. */
const SHOWDOWN_MS = 5000;

function useShowdownCountdown(live: Live, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => live.submitAction({ t: "muck" }), SHOWDOWN_MS);
    return () => clearTimeout(t);
    // `live` is rebuilt every render; keying on `active` alone is what
    // keeps this a single timer per decision rather than one restarted
    // on every frame — same shape as Rummy's own `useClaimCountdown`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

function ShowMuckBar({ live }: { live: Live }) {
  return (
    <>
      <span className="min-w-0 shrink truncate text-[10px] font-bold text-brass-300">
        Show your hand?
      </span>
      <button
        type="button"
        onClick={() => live.submitAction({ t: "muck" })}
        className="rounded-full bg-bone-50/8 px-4 py-2 text-xs font-bold text-bone-200 ring-1 ring-bone-50/18"
      >
        Muck
      </button>
      <button
        type="button"
        onClick={() => live.submitAction({ t: "show" })}
        className="rounded-full bg-linear-to-b from-brass-300 to-brass-500 px-4 py-2 text-xs font-extrabold text-felt-950 shadow-e2"
      >
        Show
      </button>
    </>
  );
}

/* ============================================================
   Hand-rankings reference sheet
   ============================================================ */

/**
 * Rung 5 `InfoSheet` — on-demand reference, non-modal (POLICY.md's hard
 * rule: never put reference info in a modal — a player wants this open
 * while still looking at their own cards). Opened from `HandZone`'s
 * `right` slot, the same spot Rummy's `SortMenu` occupies.
 */
function HandRankingsSheet({
  view,
  open,
  onClose,
  state,
}: {
  view: PokerView;
  open: boolean;
  onClose: () => void;
  state: PokerState;
}) {
  const hole = seatHoleCards(state, view.viewerSeat).map(parseCard);
  const community = state.communityOrder.map(parseCard);
  // Poker's named categories aren't meaningfully defined on 2 cards
  // alone — nothing highlights until the flop gives a real 5-card read.
  const current: HandCategory | null =
    hole.length + community.length >= 5 ? bestOfSeven([...hole, ...community]).category : null;

  return (
    // From the right, where the Hands button sits.
    <InfoSheet open={open} title="Hand rankings" onClose={onClose} side="right">
      <ul className="flex flex-col gap-1.5">
        {HAND_CATEGORY_INFO.map((entry) => {
          const highlighted = entry.category === current;
          return (
            <li
              key={entry.category}
              className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 ${
                highlighted ? "bg-brass-400/20 ring-1 ring-brass-400/50" : "bg-bone-50/4"
              }`}
            >
              <span
                className={`text-sm font-semibold ${highlighted ? "text-brass-300" : "text-bone-100"}`}
              >
                {entry.name}
              </span>
              <span className="text-right text-[11px] text-bone-400">{entry.example}</span>
            </li>
          );
        })}
      </ul>
      {current === null ? (
        <p className="mt-3 text-center text-[11px] text-bone-500">
          Your current hand highlights here once the flop is dealt.
        </p>
      ) : null}

      {/* Reference, so always here rather than behind the Hints setting. */}
      <h4 className="mt-5 mb-2 font-display text-[13px] tracking-wide text-brass-300">Table words</h4>
      <dl className="flex flex-col gap-1.5">
        {GLOSSARY.map(([term, meaning]) => (
          <div key={term} className="rounded-lg bg-bone-50/4 px-3 py-2">
            <dt className="text-sm font-semibold text-bone-100">{term}</dt>
            <dd className="text-[11px] text-bone-400">{meaning}</dd>
          </div>
        ))}
      </dl>
    </InfoSheet>
  );
}

/** Plain-words meanings for the words a poker table uses without explaining. */
const GLOSSARY: ReadonlyArray<readonly [string, string]> = [
  ["Dealer (D)", "Marks who deals this hand. It moves one seat each hand, and whoever holds it acts last after the flop."],
  ["Small blind (SB) and big blind (BB)", "The two players left of the dealer must put chips in before seeing their cards, so every hand has something to win."],
  ["Current bet", "What everyone still in has to have put in this round. Each round — before the flop, the flop, the turn, the river — starts again at nothing."],
  ["Check", "Stay in without putting chips in. Only possible when nobody has bet this round."],
  ["Call", "Put in just enough to match the current bet."],
  ["Bet / Raise to", "Put chips in, or more than the current bet; everyone else must match it or fold."],
  ["Fold", "Give up the hand. You lose what you have already put in, but nothing more."],
  ["All in", "Putting in every chip you have. You can only win as much from each player as you put in yourself."],
  ["Side pot", "When someone is all in, the chips they could not match go into a separate pot they cannot win."],
];
