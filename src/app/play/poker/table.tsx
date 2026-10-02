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
  deriveStreet,
  highestStreetCommitted,
  positionBadge,
  potTotal,
  seatHoleCards,
} from "@/games/poker/state";
import { bestOfSeven, describeBest, HAND_CATEGORY_INFO, type HandCategory } from "@/games/poker/hand";
import type { PokerAction, PokerState } from "@/games/poker/types";
import { TRANSITIONS } from "@/motion/presets";
import { InfoSheet } from "@/ui/disclosure";
import { Button } from "@/ui/primitives/Button";
import { NumberStepper } from "@/ui/primitives/NumberStepper";
import { useMediaQuery } from "@/ui/useMediaQuery";
import { HeroStatusBadge, TurnIndicator, type ScoreRow } from "@/ui/phases/PhaseScreens";
import type { RoundNote } from "@/table/GameHost";
import type { GameSetting } from "@/table/gameSettings";
import { BandNote, HandZone } from "@/table/HandZone";
import type { SeatStat, SeatView } from "@/table/SeatRing";
import { seatCue } from "@/table/turnCue";
import { useGeometry } from "@/table/store";
import type { GameRuntime } from "@/table/useGameRuntime";
import { SHOWDOWN_MS } from "@/games/poker/state";

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
  /** Supplied by `botFrom(frame)`: a seat nobody owns, which a bot plays. */
  botFor?: (seat: SeatId) => boolean;
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
    const status = busted ? "Out" : folded ? "Folded" : undefined;
    const stats: SeatStat[][] | undefined = status
      ? undefined
      : [[{ label: "Stack", value: `$${stack}` }], ...(bet > 0 ? [[{ label: "Bet", value: `$${bet}` }]] : [])];

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
      status,
      stats,
      active: cue.active,
      thinking: cue.thinking,
      eliminated: busted,
      badge: positionBadge(state, seat) ?? undefined,
      away: view.awayFor?.(seat) ?? false,
      bot: view.botFor?.(seat) ?? false,
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
  const stack = state.stacks[view.viewerSeat] ?? 0;
  const heroBet = state.streetCommitted[view.viewerSeat] ?? 0;
  const betting = live.isHeroTurn && !state.pendingShowdown;

  return (
    <>
      <PotBadge state={state} hints={hints} />

      <HandZone
        bar={showdownPending ? <ShowMuckBar live={live} /> : undefined}
        panel={betting ? <BettingPanel view={view} live={live} hand={hand} hints={hints} /> : undefined}
        left={
          // Nothing for a spectator. `SPECTATOR_SEAT` is -1, which is in
          // nobody's `stacks`, so this rendered a confident "You · $0" to
          // someone with no chips and no seat — and a dealer button for a
          // position they do not hold.
          seated ? (
            <div className="flex items-center gap-1.5">
              <HeroStatusBadge
                stats={[
                  [{ label: "Stack", value: `$${stack}` }],
                  ...(heroBet > 0 ? [[{ label: "Bet", value: `$${heroBet}` }]] : []),
                ]}
              />
              {heroBadge ? <HeroPositionBadge label={heroBadge} spelled={hints} /> : null}
            </div>
          ) : undefined
        }
        center={
          // On your turn the panel above says what the decision is, the
          // amount to call included, so this says only whose turn it is —
          // it used to say "To call $20" right under a panel that said it.
          betting ? (
            <TurnIndicator show label="Your turn" />
          ) : hand ? (
            <HeroStatusBadge label="Your hand" detail={hand} />
          ) : undefined
        }
        right={<HintsButton onOpen={() => setHintsOpen(true)} />}
      />

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
 *
 * Beside it, which betting round the hand is in (the user's ask,
 * 2026-09-28). Where the pot box is too narrow for both — a landscape
 * phone's one-row chain gives it 104px — the round wraps onto its own line
 * above the pot rather than pushing into the cards either side.
 */
function PotBadge({ state, hints }: { state: PokerState; hints: boolean }) {
  const geometry = useGeometry();
  const pot = potTotal(state);
  const box = geometry?.zones.pot;
  if (!box || pot <= 0) return null;
  const round = bettingRound(state);

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-1200 flex flex-wrap items-center justify-center gap-1.5"
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    >
      <span className="rounded-full bg-felt-950/80 px-3 py-1.5 text-xs font-extrabold whitespace-nowrap text-bone-200 ring-1 ring-bone-50/15 shadow-e1">
        {round.name}
        {/* A newcomer does not know which card the turn is, and "Turn" alone
            sits a few inches from "Your turn". Said with Hints on only. */}
        {hints && round.detail ? (
          <span className="font-semibold text-bone-400"> · {round.detail}</span>
        ) : null}
      </span>
      <span className="rounded-full bg-felt-950/80 px-3 py-1.5 text-xs font-extrabold whitespace-nowrap tnum text-brass-300 ring-1 ring-brass-400/30 shadow-e1">
        Pot ${pot}
      </span>
    </div>
  );
}

/**
 * The betting round the hand is in, named as players name it. The four
 * rounds follow the shared cards (`deriveStreet`); a showdown is the hand's
 * last phase, once betting is over and hands are compared.
 */
export function bettingRound(state: PokerState): { name: string; detail?: string } {
  if (state.pendingShowdown || state.result?.showdown) return { name: "Showdown" };
  // Details kept to a few characters: on a landscape phone the pot box is
  // 104px, between the flop and the stub, and the chip must stay inside the
  // gaps either side of it.
  switch (deriveStreet(state)) {
    case "preflop":
      return { name: "Pre-flop" };
    case "flop":
      return { name: "Flop", detail: "3 cards" };
    case "turn":
      return { name: "Turn", detail: "4th card" };
    case "river":
      return { name: "River", detail: "5th card" };
  }
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
 * own stack/hand visible stays non-modal. Sizing a bet needs both.
 *
 * The band's `panel`, so the table makes room for it — it used to float
 * over the table on a `calc()` against the hand, over the flop the decision
 * is about.
 *
 * Two shapes, because the band's height is taken from the table:
 *
 *  - a laptop gets ONE row: the four figures, the sizing and the choices;
 *  - anything narrower folds it — one line of figures, one row of choices,
 *    and the sizing only once Raise is tapped (the user's call,
 *    2026-09-26). Stacked, it was ~275px on a phone, most of the table.
 *
 * Remounts fresh every time it's the hero's turn (the band only holds it
 * while `live.isHeroTurn`), so the stepper starts at the fresh legal
 * minimum and the sizing starts folded, with no effect to reset either.
 */
/**
 * How much room the betting panel needs above the band's row, reserved on
 * the table ALWAYS (`TableSurfaceProps.panelReserve`). A once-a-round panel
 * (Spades' bid) is drawn over the felt instead, but this one opens on every
 * one of the viewer's turns: drawn over the felt, it covered the flop it is
 * asking about on a landscape phone. Reserved whether or not it is open, the
 * table never moves when it does. Measured in Chrome, in the panel's three
 * shapes (see `BettingPanel`): a laptop's row, a landscape phone's row, and
 * the folded panel on a phone held upright.
 */
export function usePokerPanelReserve(): number {
  const wide = useMediaQuery("(min-width: 1024px)");
  const shortWide = useMediaQuery("(max-height: 559px) and (min-width: 640px)");
  return wide ? 104 : shortWide ? 84 : 114;
}

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
  // "the bet is $50".
  const currentBet = highestStreetCommitted(state);
  const myBet = state.streetCommitted[me] ?? 0;
  const totalBet = state.totalCommitted[me] ?? 0;
  const toCall = amountToCall(state, me);
  const pot = potTotal(state);
  const range = canBet || canRaise ? betRange(state, me) : null;
  const [amount, setAmount] = useState(range?.min ?? 0);
  const allIn = range !== null && amount >= range.max;

  const wide = useMediaQuery("(min-width: 1024px)");
  // A landscape phone is wide enough for the laptop's one row and far too
  // short for the phone's folded two: stacked, the panel and the band took
  // half of a 390px-tall screen and left the table 68px. It gets the row,
  // with the phone's one-line figures and its folded sizing.
  const shortWide = useMediaQuery("(max-height: 559px) and (min-width: 640px)");
  const row = wide || shortWide;
  const [sizing, setSizing] = useState(false);
  const sizingShown = range !== null && (wide || sizing);

  const submit = (action: PokerAction) => live.submitAction(action);
  const verb = canBet ? "Bet" : "Raise to";
  const raise = () => {
    if (!sizingShown) {
      setSizing(true);
      return;
    }
    submit(canBet ? { t: "bet", to: amount } : { t: "raise", to: amount });
  };

  // Every choice the same size and weight. Making the raise big and gold
  // and the rest small and grey was steering: the button you are shown
  // first is the one you are being told to press.
  const choice =
    "flex flex-1 flex-col items-center justify-center rounded-xl bg-bone-50/8 px-2 py-2.5 text-sm font-bold text-bone-100 ring-1 ring-bone-50/18 hover:bg-brass-400/15 hover:text-brass-300";

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={TRANSITIONS.ui}
      className={
        row
          ? "flex w-[min(64rem,96vw)] flex-row items-center gap-3 rounded-2xl border border-brass-400/25 bg-linear-to-b from-felt-800/95 to-felt-900/95 p-2.5 shadow-e2 backdrop-blur-md"
          : "flex w-full max-w-md flex-col gap-2.5 rounded-2xl border border-brass-400/25 bg-linear-to-b from-felt-800/95 to-felt-900/95 p-3 shadow-e2 backdrop-blur-md"
      }
    >
      {wide ? (
        <dl className="grid w-100 shrink-0 grid-cols-4 gap-2 text-center">
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
          <BetFigure label="Pot" value={`$${pot}`} />
          <BetFigure label="Your hand" value={hand ?? "—"} wrap />
        </dl>
      ) : (
        // The four figures folded into one line. Your own bet is on the
        // band's "You" badge right below, so it is not said twice.
        <p
          className={
            row
              ? "tnum shrink-0 text-left text-[11px] font-semibold text-bone-300"
              : "tnum text-center text-[11px] font-semibold text-bone-300"
          }
        >
          {toCall > 0 ? `To call $${toCall}` : "Nothing to call"}
          <span className="text-bone-500"> · </span>
          Pot ${pot}
          {hand ? (
            <>
              <span className="text-bone-500"> · </span>
              {hand}
            </>
          ) : null}
        </p>
      )}

      {sizingShown && range ? (
        <div className={row ? "flex shrink-0 flex-row items-center gap-2" : "flex flex-col items-center gap-2"}>
          <NumberStepper
            value={amount}
            min={range.min}
            max={range.max}
            // The buttons move by the big blind and land on its multiples
            // ($154 → $160 → $180); any other amount is typed. The rules
            // take any whole dollar from the minimum raise up — stepping
            // $20 at a time was the stepper, never the game.
            step={state.bigBlind}
            snap
            editable
            onChange={setAmount}
            label="chips"
            format={(v) => `$${v}`}
            size="sm"
          />
          <div className={row ? "flex w-auto flex-col gap-1" : "flex w-full gap-1.5"}>
            {betPresets(pot, range).map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => setAmount(preset.to)}
                className={
                  row
                    ? "flex-1 rounded-full bg-bone-50/6 px-2.5 py-0.5 text-[10px] font-bold text-bone-300 ring-1 ring-bone-50/14 hover:bg-brass-400/15 hover:text-brass-300"
                    : "flex-1 rounded-full bg-bone-50/6 px-2.5 py-1.5 text-[10px] font-bold text-bone-300 ring-1 ring-bone-50/14 hover:bg-brass-400/15 hover:text-brass-300"
                }
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className={row ? "flex flex-1 gap-2" : "flex gap-2"}>
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
          <button type="button" onClick={raise} className={choice}>
            <span>{sizingShown ? `${verb} $${amount}` : canBet ? "Bet…" : "Raise…"}</span>
            {sizingShown && allIn ? (
              <span className="text-[10px] font-semibold text-warn">all in</span>
            ) : hints ? (
              <ChoiceNote>{sizingShown ? "others must match it" : "choose how much"}</ChoiceNote>
            ) : null}
          </button>
        ) : null}
      </div>
    </motion.div>
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
// `SHOWDOWN_MS`, shared with the session, which mucks a little after this
// for a page that is not running its timers.

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
      <BandNote>Show your hand?</BandNote>
      <Button shape="pill" onClick={() => live.submitAction({ t: "muck" })}>
        Muck
      </Button>
      <Button shape="pill" tone="primary" onClick={() => live.submitAction({ t: "show" })}>
        Show
      </Button>
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
