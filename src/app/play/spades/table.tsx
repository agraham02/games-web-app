"use client";

/**
 * Spades' table content, shared by the offline page and by an online room.
 *
 * It lives apart from `page.tsx` for one reason: none of it is about being
 * offline. The bid pad, the exchange bar, the pod readouts and the
 * scorecard are the same whether the game is being decided in this tab or
 * on a server, and the only thing that genuinely differs is WHO is looking
 * — which seat is "you", and what everybody else is called.
 *
 * So that difference is a parameter. `SpadesView` is the whole of it, and
 * threading it explicitly rather than reading a context or a global is
 * deliberate: these components are also rendered by the offline page,
 * where there is no room and no server, and a hidden dependency on either
 * would make that impossible to see.
 */

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { PieceId, SeatId } from "@/engine/types";
import { botColour, botName } from "@/games/_shared/botIdentity";
import { partnerOf, teamOf, teammates } from "@/games/_shared/partnership";
import {
  blindVoteOpen,
  isHiddenFromSelf,
  legalPlays,
  minLegalBid,
  mustBidBlind,
} from "@/games/spades/rules";
import type { Bid, SpadesAction, SpadesState } from "@/games/spades/types";
import { BlockingDialog } from "@/ui/disclosure";
import { HeroStatusBadge, TurnIndicator, type ScoreRow } from "@/ui/phases/PhaseScreens";
import { NumberStepper } from "@/ui/primitives/NumberStepper";
import { TRANSITIONS } from "@/motion/presets";
import { HandZone } from "@/table/HandZone";
import { useTableStore } from "@/table/store";
import type { RoundNote } from "@/table/GameHost";
import type { SeatView } from "@/table/SeatRing";
import { seatCue } from "@/table/turnCue";
import type { GameRuntime } from "@/table/useGameRuntime";

type Live = GameRuntime<SpadesState, SpadesAction>;

/**
 * Who is looking at this table, and what everyone is called.
 *
 * Offline that is seat 0 and a table of bot names; online it is whatever
 * seat the server sat you in and the real names of the people in the room.
 */
export interface SpadesView {
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
export const OFFLINE_VIEW: SpadesView = {
  viewerSeat: 0,
  nameFor: botName,
  colourFor: botColour,
};

/**
 * Tapping a card. Shared so that "what a tap means" cannot drift between
 * the two screens — it is a rules question (is this card legal for me right
 * now), not a presentation one.
 */
/** How many cards a blind-nil exchange passes. */
export const EXCHANGE_PICK_LIMIT = 2;

/**
 * What picking a card up for the exchange MEANS — for both screens.
 *
 * Here rather than in either shell for the same reason `onPieceTap` is:
 * a shell owns WHERE the selection is kept (the page in its own state,
 * the room in `RoomScreen` so it survives a trip to the lobby), and that
 * is a real difference. How many cards may be held, and what picking one
 * up looks like, is not — it is one answer, and when the two shells each
 * had their own the online one lost both halves of it. Online there was
 * no highlight at all (the only feedback was a `(n/2)` counter) and a
 * third tap appended, pushing the selection to three and disabling
 * "Give" with no way to see which cards were chosen.
 */
export function toggleExchangeCard(held: readonly PieceId[], id: PieceId): PieceId[] {
  const store = useTableStore.getState();
  if (held.includes(id)) {
    store.patch(id, { highlighted: false });
    return held.filter((x) => x !== id);
  }
  // A third tap is ignored until one is put back, rather than silently
  // dropping the oldest — the player chose those two.
  if (held.length >= EXCHANGE_PICK_LIMIT) return [...held];
  store.patch(id, { highlighted: true });
  return [...held, id];
}

/** Puts every held card down. The store patch is the half easily forgotten. */
export function clearExchangeCards(held: readonly PieceId[]): void {
  const store = useTableStore.getState();
  for (const id of held) store.patch(id, { highlighted: false });
}

export function onPieceTap(
  view: SpadesView,
  id: PieceId,
  live: Live,
  toggleHeld: (id: PieceId) => void,
): void {
  if (!live.isHeroTurn) return;
  const state = live.state;
  if (state.exchange) {
    toggleHeld(id);
    return;
  }
  if (state.phase === "play" && legalPlays(state, view.viewerSeat).includes(id)) {
    live.submitAction({ t: "play", card: id });
  }
}

/* ============================================================
   Table overlays
   ============================================================ */

export function SpadesTable({
  view,
  live,
  held,
  onClearHeld,
}: {
  view: SpadesView;
  live: Live;
  held: PieceId[];
  onClearHeld: () => void;
}) {
  const state = live.state;
  const playable = live.isHeroTurn && state.phase === "play" && !state.exchange;

  return (
    <>
      {/* One row owns the band above the hand — see HandZone for why
          two independently positioned badges up here is the thing being
          fixed, not a style preference. */}
      <HandZone
        left={<YourBidBadge view={view} state={state} />}
        center={<TurnIndicator inline label="Your turn — tap a card" show={playable} />}
      />
      <BidPad view={view} live={live} held={held} onClearHeld={onClearHeld} />
    </>
  );
}

/**
 * Rung 1 ambient readout of the hero's own bid — POLICY.md's own
 * "current bid" example. The hero has no seat pod (SeatRing only ever
 * shows opponents), so nothing else on screen carries this. Thin
 * game-specific wrapper around the shared `HeroStatusBadge` (same
 * component a future Poker's "current bet" or Rummy's deadwood count
 * would use) — anchored to the LEFT, close to the hand it's describing,
 * so it never collides with `TurnIndicator`'s centred text.
 */
function YourBidBadge({ view, state }: { view: SpadesView; state: SpadesState }) {
  const bid = state.bids[view.viewerSeat];
  if (!bid) return null;
  const label = describeBid(bid);
  const detail =
    state.phase === "play" && !state.exchange
      ? `${label} · won ${state.tricksWon[view.viewerSeat] ?? 0}`
      : `bid ${label}`;
  return <HeroStatusBadge inline label="Your bid" detail={detail} side="left" />;
}

function BidPad({
  view,
  live,
  held,
  onClearHeld,
}: {
  view: SpadesView;
  live: Live;
  held: PieceId[];
  onClearHeld: () => void;
}) {
  const state = live.state;
  if (state.phase !== "bid") return null;

  // Checked before whose turn it is: the vote is open to both partners at
  // once, so it is often not "your turn" while you still have a vote.
  if (blindVoteOpen(state, view.viewerSeat) && !live.animating) {
    return state.blindVotes[view.viewerSeat] ? (
      <BlindVoteWaiting view={view} state={state} />
    ) : (
      <BlindVoteDialog view={view} live={live} />
    );
  }
  if (!live.isHeroTurn) return null;

  if (state.exchange) {
    return <ExchangeBar live={live} isGiver={state.exchange.stage === "give"} held={held} onClearHeld={onClearHeld} />;
  }
  if (isHiddenFromSelf(state, view.viewerSeat)) return <BlindChoiceDialog view={view} live={live} />;
  return <NumericBidPanel view={view} live={live} />;
}

/**
 * NOT a BlockingDialog — see this file's top doc. Mirrors Dominoes'
 * DominoTable bottom bar: an inline instruction plus a floating,
 * non-modal action row, so the hero's own hand stays tappable underneath.
 */
function ExchangeBar({
  live,
  isGiver,
  held,
  onClearHeld,
}: {
  live: Live;
  isGiver: boolean;
  held: PieceId[];
  onClearHeld: () => void;
}) {
  const label = isGiver
    ? "Choose 2 cards to give your partner, unseen"
    : "Choose 2 cards to send back to your partner";

  const confirm = () => {
    if (held.length !== 2) return;
    const cards: [PieceId, PieceId] = [held[0]!, held[1]!];
    onClearHeld();
    live.submitAction(isGiver ? { t: "exchangeGive", cards } : { t: "exchangeTake", cards });
  };

  const skip = () => {
    onClearHeld();
    live.submitAction({ t: "skipExchange" });
  };

  return (
    <>
      <TurnIndicator label={`${label} (${held.length}/2)`} show />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 z-1800 flex items-end justify-center gap-2 pb-3"
        style={{ height: 56 }}
      >
        <AnimatePresence>
          {isGiver ? (
            <ActionButton key="skip" onClick={skip} tone="quiet">
              Skip
            </ActionButton>
          ) : null}
          <ActionButton key="confirm" onClick={confirm} disabled={held.length !== 2}>
            {isGiver ? "Give" : "Send back"}
          </ActionButton>
        </AnimatePresence>
      </div>
    </>
  );
}

function ActionButton({
  onClick,
  tone = "primary",
  disabled = false,
  children,
}: {
  onClick: () => void;
  tone?: "primary" | "quiet";
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <motion.button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: disabled ? 0.4 : 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      transition={TRANSITIONS.ui}
      className={
        tone === "primary"
          ? "pointer-events-auto rounded-full bg-linear-to-b from-brass-300 to-brass-500 px-7 py-2.5 text-sm font-extrabold text-felt-950 shadow-e2 disabled:pointer-events-none"
          : "pointer-events-auto rounded-full bg-bone-50/8 px-5 py-2.5 text-sm font-semibold text-bone-200 ring-1 ring-bone-50/18"
      }
    >
      {children}
    </motion.button>
  );
}

/**
 * NOT a BlockingDialog, unlike BlindChoiceDialog below — an ordinary bid
 * is exactly the case POLICY.md's own hard rule calls out: "if the
 * player needs to compare [a decision] against their own hand, a modal
 * makes the comparison impossible." Deciding how much to bid means
 * looking at your hand, which a full-screen `<dialog>`'s blurred
 * backdrop was hiding. A floating, non-modal panel anchored above the
 * hand zone — same shape as ExchangeBar below — keeps the hand fully
 * visible and tappable underneath it.
 */
function NumericBidPanel({ view, live }: { view: SpadesView; live: Live }) {
  const state = live.state;
  const floor = minLegalBid(state, view.viewerSeat);
  const min = Math.max(1, floor);
  const partnerBid = state.bids[partnerOf(view.viewerSeat)];
  const [value, setValue] = useState(min);
  const submit = (action: SpadesAction) => live.submitAction(action);

  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-1800 flex justify-center px-4"
      style={{ bottom: "calc(var(--hand-zone, 150px) + 12px)" }}
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={TRANSITIONS.ui}
        className="pointer-events-auto flex w-[min(20rem,92vw)] flex-col items-center gap-3 rounded-2xl border border-brass-400/25 bg-linear-to-b from-felt-800/95 to-felt-900/95 p-4 shadow-e2 backdrop-blur-md"
      >
        <div className="flex flex-col items-center gap-1">
          <h3 className="font-display text-[15px] tracking-wide text-brass-300">Your bid</h3>
          {partnerBid ? (
            <p className="text-center text-[12px] text-bone-400">
              Partner bid {describeBid(partnerBid)}
              {floor > 0 ? ` — your team needs at least ${floor} combined.` : "."}
            </p>
          ) : null}
        </div>

        <NumberStepper value={value} min={min} max={13} onChange={setValue} label="tricks" />

        <button
          type="button"
          onClick={() => submit({ t: "bid", tricks: value, nil: false })}
          className="w-full rounded-lg bg-linear-to-b from-brass-300 to-brass-500 py-2.5 text-sm font-extrabold text-felt-950 shadow-e2"
        >
          Bid {value}
        </button>

        {floor === 0 ? (
          <button
            type="button"
            onClick={() => submit({ t: "bid", tricks: 0, nil: true })}
            className="w-full rounded-lg bg-bone-50/6 py-2.5 text-sm font-bold text-bone-100 ring-1 ring-bone-50/14 hover:bg-warn/15 hover:text-warn"
          >
            Nil
          </button>
        ) : null}
      </motion.div>
    </div>
  );
}

/**
 * The team's vote on going blind, cast by both partners at once when the
 * team's first bid comes up. Rung 6 `BlockingDialog` — nothing here needs
 * the table, since the hand is still hidden at this exact decision.
 *
 * With a bot for a partner, this vote IS the decision: a bot's vote always
 * defers to a person's (see `reduceBlindVote`).
 */
function BlindVoteDialog({ view, live }: { view: SpadesView; live: Live }) {
  const state = live.state;
  const me = view.viewerSeat;
  const partner = partnerOf(me);
  const deficit = (state.scores[((me + 1) % 4) as SeatId] ?? 0) - (state.scores[me] ?? 0);
  const theirs = state.blindVotes[partner];
  const vote = (blind: boolean) => live.submitAction({ t: "blindVote", seat: me, blind, defer: false });

  return (
    <BlockingDialog open title="Your team trails — go blind?">
      <div className="flex flex-col gap-4">
        <p className="text-[12px] text-bone-400">
          Your team trails by {deficit}, so you may bid without looking at your hands. You and
          your partner both vote; if you disagree, a coin decides.
        </p>
        {theirs && !theirs.defer ? (
          <p className="text-center text-[12px] font-semibold text-brass-300">
            {view.nameFor(partner)} voted {theirs.blind ? "blind" : "to look"}.
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => vote(true)}
          className="rounded-lg bg-linear-to-b from-brass-300 to-brass-500 py-3 text-sm font-extrabold text-felt-950 shadow-e2"
        >
          Go blind — doubles on success
        </button>
        <button
          type="button"
          onClick={() => vote(false)}
          className="rounded-lg bg-bone-50/6 py-2.5 text-sm font-bold text-bone-100 ring-1 ring-bone-50/14 hover:bg-bone-50/10"
        >
          Look at our hands
        </button>
      </div>
    </BlockingDialog>
  );
}

/** Non-modal: once you have voted there is nothing left to decide. */
function BlindVoteWaiting({ view, state }: { view: SpadesView; state: SpadesState }) {
  const mine = state.blindVotes[view.viewerSeat];
  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-1800 flex justify-center px-4"
      style={{ bottom: "calc(var(--hand-zone, 150px) + 12px)" }}
    >
      <p className="rounded-full border border-brass-400/25 bg-felt-900/90 px-4 py-2 text-[12px] text-bone-300 shadow-e2">
        You voted {mine?.blind ? "blind" : "to look"} — waiting for{" "}
        {view.nameFor(partnerOf(view.viewerSeat))}
      </p>
    </div>
  );
}

/**
 * The blind bid itself, once the team has voted to go blind. Rung 6
 * `BlockingDialog` for the same reason as the vote: the hand is still
 * hidden, so there is nothing on the table to compare against.
 */
function BlindChoiceDialog({ view, live }: { view: SpadesView; live: Live }) {
  const state = live.state;
  const canBlindNil = minLegalBid(state, view.viewerSeat) === 0;
  // The partner already bid blind (a Blind Nil, say), so this seat bids
  // its own blind number rather than the team's.
  const locked = mustBidBlind(state, view.viewerSeat);
  const [blindValue, setBlindValue] = useState(6);
  const submit = (action: SpadesAction) => live.submitAction(action);

  return (
    <BlockingDialog open title="Your team is going blind">
      <div className="flex flex-col gap-4">
        <p className="text-[12px] text-bone-400">
          {locked
            ? "Your partner already bid blind. Pick your own blind bid."
            : "Your team voted to go blind — bid without looking at your hand."}
        </p>

        {canBlindNil ? (
          <button
            type="button"
            onClick={() => submit({ t: "blindNil" })}
            className="rounded-lg bg-bone-50/6 py-2.5 text-sm font-bold text-bone-100 ring-1 ring-bone-50/14 hover:bg-warn/15 hover:text-warn"
          >
            Blind Nil — ±200
          </button>
        ) : null}

        <div className="flex flex-col items-center gap-2">
          <span className="text-[11px] font-semibold tracking-wide text-bone-400 uppercase">
            {locked
              ? "Your own blind bid — min 6, doubles on success"
              : "Blind bid for your TEAM — min 6, doubles on success"}
          </span>
          <NumberStepper
            value={blindValue}
            min={6}
            max={13}
            onChange={setBlindValue}
            label="tricks"
          />
          <button
            type="button"
            onClick={() => submit({ t: "blindBid", tricks: blindValue })}
            className="w-full rounded-lg bg-linear-to-b from-brass-300 to-brass-500 py-2.5 text-sm font-extrabold text-felt-950 shadow-e2"
          >
            {locked ? `Blind bid ${blindValue}` : `Bid ${blindValue} for your team`}
          </button>
          {locked ? null : (
            <p className="text-center text-[11px] text-bone-500">
              Your partner won&apos;t bid separately — their hand turns face up and your
              team&apos;s target is set to {blindValue}.
            </p>
          )}
        </div>
      </div>
    </BlockingDialog>
  );
}

function describeBid(bid: Bid): string {
  if (bid.nil) return bid.blind ? "blind nil" : "nil";
  return bid.blind ? `${bid.tricks} (blind)` : `${bid.tricks}`;
}

/* ============================================================
   GameHost slots
   ============================================================ */

function seatName(view: SpadesView, seat: SeatId): string {
  return seat === view.viewerSeat ? "You" : view.nameFor(seat);
}
function seatColour(view: SpadesView, seat: SeatId): string {
  return seat === view.viewerSeat ? "var(--color-brass-300)" : view.colourFor(seat);
}

function seatMeta(view: SpadesView, state: SpadesState, seat: SeatId): string {
  const bid = state.bids[seat];
  const score = state.scores[seat] ?? 0;
  if (!bid) return `${state.exchange ? "exchange" : "bidding…"} · ${score}`;
  const label = describeBid(bid);
  if (state.phase === "bid") return `bid ${label} · ${score}`;
  return `${label} · won ${state.tricksWon[seat] ?? 0} · ${score}`;
}

export function playerViews(view: SpadesView, state: SpadesState, live: Live): SeatView[] {
  const out: SeatView[] = [];
  // Every seat but the VIEWER's own. This counted from 1 for a long time,
  // which is the same thing exactly as long as the viewer is seat 0 —
  // and online they are not. A player at seat 1 got no pod for seat 0
  // (the party leader simply had no nameplate) and a redundant one for
  // themselves.
  for (let seat = 0; seat < 4; seat++) {
    if (seat === view.viewerSeat) continue;
    const s = seat as SeatId;
    // "Who just moved" and "who are we waiting on" — see `seatCue`. The
    // second used to have no answer, so a human's pod only lit once they
    // acted, a whole turn late.
    const cue = seatCue(live, s);
    out.push({
      seat: s,
      name: view.nameFor(s),
      colour: view.colourFor(s),
      meta: seatMeta(view, state, s),
      active: cue.active,
      thinking: cue.thinking,
      // Never for a spectator. `SPECTATOR_SEAT` is -1 and the
      // partnership maths is modular, so `partnerOf(-1)` is 1 — which
      // quietly told anyone watching that seat 1 was their partner.
      partner: isSeated(view) && s === partnerOf(view.viewerSeat),
      away: view.awayFor?.(s) ?? false,
    });
  }
  return out;
}

/** One row per TEAM, not per seat — GameEndSummary just renders
 * whatever {seat, name, total} list it's given, so merging here is all
 * grouping takes for the match-end standings (the round scorecard needs
 * its own `ScoreRow.team` grouping instead, since it also carries a
 * per-seat bid/won detail line this shape has no room for). */
export function standings(view: SpadesView, state: SpadesState, _live: Live, seats: SeatView[]) {
  const nameOf = (seat: SeatId) =>
    seat === view.viewerSeat ? "You" : (seats.find((s) => s.seat === seat)?.name ?? view.nameFor(seat));
  return ([0, 1] as const)
    .map((team) => {
      const [a, b] = teammates(team);
      return { seat: a, name: `${nameOf(a)} & ${nameOf(b)}`, total: state.scores[a] ?? 0 };
    })
    .sort((x, y) => y.total - x.total);
}

/**
 * Is the viewer actually sitting at this table?
 *
 * A spectator's seat is `SPECTATOR_SEAT` (-1), chosen so that every
 * game's `seat === viewer` comparison fails and every hand comes out
 * face-down. That works beautifully for hands and not at all for
 * ARITHMETIC: partnership maths is modular, so -1 has a partner and a
 * team like any other number, and a spectator was shown one side's
 * private numbers as though they were their own.
 */
function isSeated(view: SpadesView): boolean {
  return view.viewerSeat >= 0 && view.viewerSeat < 4;
}

export function statsFor(view: SpadesView, state: SpadesState): Array<{ label: string; value: string }> {
  if (!isSeated(view)) {
    // Watching, so there is no "my team". The round is the only one of
    // these three that means anything to somebody with no side.
    return [{ label: "Round", value: `${state.round}` }];
  }
  const [a, b] = teammates(teamOf(view.viewerSeat));
  const nilsMade = (state.nilsMade[a] ?? 0) + (state.nilsMade[b] ?? 0);
  const nilsAttempted = (state.nilsAttempted[a] ?? 0) + (state.nilsAttempted[b] ?? 0);
  return [
    { label: "Round", value: `${state.round}` },
    { label: "Bags", value: `${state.bags[view.viewerSeat] ?? 0}` },
    { label: "Nils made", value: `${nilsMade}/${nilsAttempted}` },
  ];
}

export function roundSummary(view: SpadesView, state: SpadesState) {
  const result = state.result;
  if (!result) return null;

  const rows: ScoreRow[] = [];
  for (let i = 0; i < 4; i++) {
    const seat = i as SeatId;
    const bid = result.bids[seat]!;
    const won = result.tricksWon[seat] ?? 0;
    // The TEAM's shared overtricks for the round, from `scoreRound`
    // directly — NOT `won - bid.tricks` computed per seat. Bags are a
    // team-level concept (the combined contract's combined overtricks),
    // so a naive per-seat difference over/undercounts the instant the
    // two partners' own bid/tricks don't individually line up: one
    // partner short 2 or their own bid while the other is up 4 nets out
    // to a real team bagsAdded of 2, but the old per-seat calc showed
    // "4 bags" on just the second row (and nothing on the first) — a
    // number that never matched what was actually scored.
    const overtricks = result.bagsAdded[seat] ?? 0;
    // Shown on only ONE of the two partner rows (the lower seat), not
    // both — `overtricks` is identical for a team's two rows (it's a
    // team quantity), and `ScoreRowGroup` renders each row's own `flag`
    // independently inline in its own detail line, unlike `delta`/
    // `total`, which it already reads once from the group's first row.
    // Showing the same "2 bags" flag on BOTH lines would misread as "2
    // bags each" (4 total) instead of "2 bags, shared by the team".
    const showFlag = seat === teammates(teamOf(seat))[0];
    rows.push({
      seat,
      name: seatName(view, seat),
      colour: seatColour(view, seat),
      detail: `${bid.nil ? describeBid(bid) : `bid ${describeBid(bid)}`} · won ${won}`,
      flag: showFlag && overtricks > 0 ? `${overtricks} bag${overtricks === 1 ? "" : "s"}` : undefined,
      delta: result.deltas[seat] ?? 0,
      total: state.scores[seat] ?? 0,
      // Partners' round delta/total are always identical (see
      // scoring.ts) — grouping them shows that shared score once instead
      // of twice, while each still gets its own bid/won detail line.
      team: teamOf(seat),
    });
  }

  let note: RoundNote | undefined;
  for (const team of [0, 1] as const) {
    const [a] = teammates(team);
    // A spectator has no side, so neither team is "yours" and neither is
    // an opponent — name them instead of guessing. (`teamOf(-1)` is not
    // 0 or 1, so without this BOTH teams read as "Opponents".)
    const whose = !isSeated(view)
      ? `Team ${team === 0 ? "A" : "B"}`
      : team === teamOf(view.viewerSeat)
        ? "Your team"
        : "Opponents";
    if ((result.bagPenalty[a] ?? 0) > 0) {
      note = { tone: "warn", title: "Bag penalty", body: `${whose} crossed 10 bags and lost 100 points.` };
    } else if ((result.bags[a] ?? 0) % 10 === 9) {
      note = {
        tone: "warn",
        title: "Bag warning",
        body: `${whose} are at ${result.bags[a]} bags. One more triggers the −100 penalty.`,
      };
    }
  }

  const heroDelta = result.deltas[view.viewerSeat] ?? 0;
  const title = heroDelta > 0 ? "Your team scores" : heroDelta < 0 ? "Your team sets" : "Hand complete";

  return { title, rows, note };
}

export function pendingLabel(view: SpadesView, state: SpadesState, seat: SeatId): string {
  if (state.exchange) return `${view.nameFor(seat)} pending — exchange`;
  if (state.phase === "bid") return `${view.nameFor(seat)} pending — bidding`;
  return `${view.nameFor(seat)} pending — playing`;
}

