"use client";

/**
 * Spades — the play screen.
 *
 * The genuinely game-specific parts:
 *
 *  - **the bid pad.** `BlindChoiceDialog` (a blind-eligible seat's
 *    look-or-go-blind choice) is a rung-6 `BlockingDialog` — nothing to
 *    compare against yet, since the hand is still hidden at that exact
 *    decision. An ORDINARY bid is different: deciding how much to bid
 *    means looking at your own hand, so `NumericBidPanel` is a
 *    non-modal floating panel instead (POLICY.md: "never put reference
 *    information in a modal").
 *  - **the exchange bar.** The Blind Nil card exchange is DIFFERENT: it
 *    requires tapping the hero's own hand cards on the table, which a
 *    true modal dialog would block (`showModal()` traps all interaction
 *    outside itself). So this is deliberately NOT a BlockingDialog —
 *    it's the same non-modal "instruction + floating action bar" shape
 *    Dominoes uses for its own tile-then-end flow, with card selection
 *    happening by tapping the (still face-down, for the giver) hand
 *    directly.
 *  - **the bid/score readout on each pod**, and the hero's own via a
 *    small always-visible badge (rung 1, POLICY.md's own "current bid"
 *    example).
 *
 * Everything else — seat ring, toasts, scorecard, match summary, dev
 * panel, and the trick zone itself — comes from GameHost/PieceLayer
 * unchanged; Spades is the first game to actually exercise the "trick"
 * zone geometry and the `collect` event.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { HERO, type BotDifficulty, type PieceId, type SeatId } from "@/engine/types";
import { DifficultyPicker, botTable } from "@/ui/primitives/DifficultyPicker";
import { SetupShell } from "@/ui/primitives/SetupShell";
import { GameHost, type RoundNote } from "@/table/GameHost";
import type { GameRuntime } from "@/table/useGameRuntime";
import type { SeatView } from "@/table/SeatRing";
import { useTableStore } from "@/table/store";
import { HeroStatusBadge, TurnIndicator, type ScoreRow } from "@/ui/phases/PhaseScreens";
import { HandZone } from "@/table/HandZone";
import { NumberStepper } from "@/ui/primitives/NumberStepper";
import { Toggle } from "@/ui/primitives/Toggle";
import { BlockingDialog } from "@/ui/disclosure";
import { botColour, botName } from "@/games/_shared/botIdentity";
import { createSpades } from "@/games/spades/rules";
import {
  isHiddenFromSelf,
  legalPlays,
  minLegalBid,
  mustBidBlind,
  partnerOf,
  teamOf,
  teammates,
} from "@/games/spades/state";
import type { Bid, SpadesAction, SpadesState } from "@/games/spades/types";
import { TRANSITIONS } from "@/motion/presets";

type Live = GameRuntime<SpadesState, SpadesAction>;

export default function SpadesPlayPage() {
  const [jokers, setJokers] = useState(false);
  const [twoOfSpadesHigh, setTwoOfSpadesHigh] = useState(false);
  const [difficulty, setDifficulty] = useState<BotDifficulty>("steady");
  const [started, setStarted] = useState(false);
  const [gameKey, setGameKey] = useState(0);
  /** Up to 2 cards picked for the current blind-nil exchange step.
   * Meaningless outside `state.exchange` — cleared whenever that
   * closes, the same way Dominoes' `held` is cleared on release. */
  const [held, setHeld] = useState<PieceId[]>([]);

  const definition = useMemo(
    () => createSpades({ jokers, twoOfSpadesHigh }),
    [jokers, twoOfSpadesHigh],
  );

  const clearHeld = () => {
    const store = useTableStore.getState();
    for (const id of held) store.patch(id, { highlighted: false });
    setHeld([]);
  };

  const toggleHeld = (id: PieceId) => {
    const store = useTableStore.getState();
    setHeld((prev) => {
      if (prev.includes(id)) {
        store.patch(id, { highlighted: false });
        return prev.filter((x) => x !== id);
      }
      if (prev.length >= 2) return prev; // a 3rd tap is ignored until one is deselected
      store.patch(id, { highlighted: true });
      return [...prev, id];
    });
  };

  const onPieceTap = (id: PieceId, live: Live) => {
    if (!live.isHeroTurn) return;
    const state = live.state;
    if (state.exchange) {
      toggleHeld(id);
      return;
    }
    if (state.phase === "play" && legalPlays(state, HERO).includes(id)) {
      live.submitAction({ t: "play", card: id });
    }
  };

  if (!started) {
    return (
      <SetupScreen
        difficulty={difficulty}
        onDifficultyChange={setDifficulty}
        jokers={jokers}
        twoOfSpadesHigh={twoOfSpadesHigh}
        onJokersChange={setJokers}
        onTwoOfSpadesHighChange={setTwoOfSpadesHigh}
        onStart={() => setStarted(true)}
      />
    );
  }

  return (
    <GameHost<SpadesState, SpadesAction>
      key={gameKey}
      definition={definition}
      runtime={{ seats: 4, difficulty: botTable(4, difficulty) }}
      gameTitle="Spades"
      players={playerViews}
      standings={standings}
      stats={statsFor}
      roundSummary={roundSummary}
      pendingLabel={pendingLabel}
      onPieceTap={onPieceTap}
      onRematch={() => {
        clearHeld();
        setGameKey((k) => k + 1);
      }}
      onLobby={() => {
        clearHeld();
        setStarted(false);
      }}
    >
      {(live) => <SpadesTable live={live} held={held} onClearHeld={clearHeld} />}
    </GameHost>
  );
}

/* ============================================================
   Table overlays
   ============================================================ */

function SpadesTable({
  live,
  held,
  onClearHeld,
}: {
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
        left={<YourBidBadge state={state} />}
        center={<TurnIndicator inline label="Your turn — tap a card" show={playable} />}
      />
      <BidPad live={live} held={held} onClearHeld={onClearHeld} />
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
function YourBidBadge({ state }: { state: SpadesState }) {
  const bid = state.bids[HERO];
  if (!bid) return null;
  const label = describeBid(bid);
  const detail =
    state.phase === "play" && !state.exchange
      ? `${label} · won ${state.tricksWon[HERO] ?? 0}`
      : `bid ${label}`;
  return <HeroStatusBadge inline label="Your bid" detail={detail} side="left" />;
}

function BidPad({
  live,
  held,
  onClearHeld,
}: {
  live: Live;
  held: PieceId[];
  onClearHeld: () => void;
}) {
  const state = live.state;
  if (!live.isHeroTurn || state.phase !== "bid") return null;

  if (state.exchange) {
    return <ExchangeBar live={live} isGiver={state.exchange.stage === "give"} held={held} onClearHeld={onClearHeld} />;
  }
  if (isHiddenFromSelf(state, HERO)) return <BlindChoiceDialog live={live} />;
  return <NumericBidPanel live={live} />;
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
function NumericBidPanel({ live }: { live: Live }) {
  const state = live.state;
  const floor = minLegalBid(state, HERO);
  const min = Math.max(1, floor);
  const partnerBid = state.bids[partnerOf(HERO)];
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

/** Rung 6 `BlockingDialog` — same reasoning as `NumericBidPanel`'s doc
 * gives for why it ISN'T one: nothing here needs the table (the hand is
 * still hidden at this exact decision — the whole point of "blind"), so
 * a real modal costs nothing. */
function BlindChoiceDialog({ live }: { live: Live }) {
  const state = live.state;
  const deficit = (state.scores[((HERO + 1) % 4) as SeatId] ?? 0) - (state.scores[HERO] ?? 0);
  const canBlindNil = minLegalBid(state, HERO) === 0;
  // Synchronized team decision (pagat.com: "a partnership... may choose
  // not to look... after agreeing on a blind bid, the partners pick up
  // their cards" — a joint choice, not two independent ones). If the
  // partner already bid blind, "look" is off the table entirely.
  const locked = mustBidBlind(state, HERO);
  const [blindValue, setBlindValue] = useState(6);
  const submit = (action: SpadesAction) => live.submitAction(action);

  return (
    <BlockingDialog open title="Your team trails — bid blind?">
      <div className="flex flex-col gap-4">
        <p className="text-[12px] text-bone-400">
          {locked
            ? "Your partner already bid blind — your team is committed. Pick your own blind bid."
            : `Your team trails by ${deficit} — you may bid without looking at your hand.`}
        </p>

        {locked ? null : (
          <button
            type="button"
            onClick={() => submit({ t: "look" })}
            className="rounded-lg bg-linear-to-b from-brass-300 to-brass-500 py-3 text-sm font-extrabold text-felt-950 shadow-e2"
          >
            Look at my hand
          </button>
        )}

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
            className="w-full rounded-lg bg-bone-50/6 py-2.5 text-sm font-bold text-bone-100 ring-1 ring-bone-50/14 hover:bg-brass-400/15 hover:text-brass-300"
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

function seatName(seat: SeatId): string {
  return seat === HERO ? "You" : botName(seat);
}
function seatColour(seat: SeatId): string {
  return seat === HERO ? "var(--color-brass-300)" : botColour(seat);
}

function seatMeta(state: SpadesState, seat: SeatId): string {
  const bid = state.bids[seat];
  const score = state.scores[seat] ?? 0;
  if (!bid) return `${state.exchange ? "exchange" : "bidding…"} · ${score}`;
  const label = describeBid(bid);
  if (state.phase === "bid") return `bid ${label} · ${score}`;
  return `${label} · won ${state.tricksWon[seat] ?? 0} · ${score}`;
}

function playerViews(state: SpadesState, live: Live): SeatView[] {
  const out: SeatView[] = [];
  for (let seat = 1; seat < 4; seat++) {
    const s = seat as SeatId;
    const acting = live.busy && live.lastAction?.seat === s;
    out.push({
      seat: s,
      name: botName(s),
      colour: botColour(s),
      meta: seatMeta(state, s),
      active: acting,
      thinking: acting,
      partner: s === partnerOf(HERO),
    });
  }
  return out;
}

/** One row per TEAM, not per seat — GameEndSummary just renders
 * whatever {seat, name, total} list it's given, so merging here is all
 * grouping takes for the match-end standings (the round scorecard needs
 * its own `ScoreRow.team` grouping instead, since it also carries a
 * per-seat bid/won detail line this shape has no room for). */
function standings(state: SpadesState, _live: Live, seats: SeatView[]) {
  const nameOf = (seat: SeatId) =>
    seat === HERO ? "You" : (seats.find((s) => s.seat === seat)?.name ?? botName(seat));
  return ([0, 1] as const)
    .map((team) => {
      const [a, b] = teammates(team);
      return { seat: a, name: `${nameOf(a)} & ${nameOf(b)}`, total: state.scores[a] ?? 0 };
    })
    .sort((x, y) => y.total - x.total);
}

function statsFor(state: SpadesState): Array<{ label: string; value: string }> {
  const [a, b] = teammates(teamOf(HERO));
  const nilsMade = (state.nilsMade[a] ?? 0) + (state.nilsMade[b] ?? 0);
  const nilsAttempted = (state.nilsAttempted[a] ?? 0) + (state.nilsAttempted[b] ?? 0);
  return [
    { label: "Round", value: `${state.round}` },
    { label: "Bags", value: `${state.bags[HERO] ?? 0}` },
    { label: "Nils made", value: `${nilsMade}/${nilsAttempted}` },
  ];
}

function roundSummary(state: SpadesState) {
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
      name: seatName(seat),
      colour: seatColour(seat),
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
    const whose = team === teamOf(HERO) ? "Your team" : "Opponents";
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

  const heroDelta = result.deltas[HERO] ?? 0;
  const title = heroDelta > 0 ? "Your team scores" : heroDelta < 0 ? "Your team sets" : "Hand complete";

  return { title, rows, note };
}

function pendingLabel(state: SpadesState, seat: SeatId): string {
  if (state.exchange) return `${botName(seat)} pending — exchange`;
  if (state.phase === "bid") return `${botName(seat)} pending — bidding`;
  return `${botName(seat)} pending — playing`;
}

/* ============================================================
   Setup
   ============================================================ */

/** What each tier actually does — see `estimateTricks`/`choosePlay` in
 * bots.ts. */
const SPADES_BLURBS = {
  casual: "Bids near the floor and plays low — never really counts its hand.",
  steady: "Bids off a real hand-strength read, and wins tricks as cheaply as it can.",
  sharp: "Protects its own nil, and won't spend a winner overtaking a partner who already has it.",
};

function SetupScreen({
  jokers,
  twoOfSpadesHigh,
  onJokersChange,
  onTwoOfSpadesHighChange,
  difficulty,
  onDifficultyChange,
  onStart,
}: {
  jokers: boolean;
  twoOfSpadesHigh: boolean;
  onJokersChange: (v: boolean) => void;
  onTwoOfSpadesHighChange: (v: boolean) => void;
  difficulty: BotDifficulty;
  onDifficultyChange: (d: BotDifficulty) => void;
  onStart: () => void;
}) {
  return (
    <SetupShell maxWidth="max-w-xs">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="eyebrow">New match</span>
        <h1 className="font-display text-4xl tracking-wider text-brass-300">Spades</h1>
        <p className="max-w-xs text-sm text-bone-400">
          Partnership trick-taking — you and the seat across from you bid and
          play as a team. Follow suit, spades are always trump, and a bid
          made together is scored together.
        </p>
      </div>

      <div className="flex w-full max-w-xs flex-col gap-3">
        <Toggle
          label="Jokers"
          hint="Adds the Big and Little Joker, ranked above every spade."
          checked={jokers}
          onChange={onJokersChange}
        />
        <Toggle
          label="2 of spades ranks above Ace"
          hint="Within spades only — every other suit is unaffected."
          checked={twoOfSpadesHigh}
          onChange={onTwoOfSpadesHighChange}
        />
        {/* Applies to your partner too — a Spades table is 2v2, and a
            partner who plays a different game from the opponents would be
            a much stranger setting than one difficulty for the table. */}
        <DifficultyPicker
          value={difficulty}
          onChange={onDifficultyChange}
          label="Table"
          blurbs={SPADES_BLURBS}
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
    </SetupShell>
  );
}

