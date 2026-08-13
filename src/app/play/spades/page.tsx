"use client";

/**
 * Spades — the play screen.
 *
 * The genuinely game-specific parts:
 *
 *  - **the bid pad.** Per POLICY.md, the hero's own bid/blind-choice
 *    decisions are real stakes with no table interaction attached, so
 *    they're `BlockingDialog`s (rung 6) — `BlindChoiceDialog` for a
 *    blind-eligible seat's look-or-go-blind choice, `NumericBidDialog`
 *    for an ordinary bid.
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
import { HERO, type PieceId, type SeatId } from "@/engine/types";
import { GameHost, type RoundNote } from "@/table/GameHost";
import type { GameRuntime } from "@/table/useGameRuntime";
import type { SeatView } from "@/table/SeatRing";
import { useTableStore } from "@/table/store";
import { TurnIndicator, type ScoreRow } from "@/ui/phases/PhaseScreens";
import { BlockingDialog } from "@/ui/disclosure";
import { botColour, botName } from "@/games/_shared/botIdentity";
import { createSpades } from "@/games/spades/rules";
import {
  isHiddenFromSelf,
  legalPlays,
  minLegalBid,
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
      runtime={{ seats: 4 }}
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
      <TurnIndicator label="Your turn — tap a card" show={playable} />
      <YourBidBadge state={state} />
      <BidPad live={live} held={held} onClearHeld={onClearHeld} />
    </>
  );
}

/** Rung 1: an always-visible ambient readout of the hero's own bid —
 * POLICY.md's own "current bid" example. The hero has no seat pod
 * (SeatRing only ever shows opponents), so nothing else on screen
 * carries this. */
function YourBidBadge({ state }: { state: SpadesState }) {
  const bid = state.bids[HERO];
  if (!bid) return null;
  const label = describeBid(bid);
  const detail =
    state.phase === "play" && !state.exchange
      ? `${label} · won ${state.tricksWon[HERO] ?? 0}`
      : `bid ${label}`;
  return (
    <div className="pointer-events-none absolute top-3 left-3 z-900 rounded-full bg-felt-950/70 px-3 py-1.5 text-[11px] font-bold text-brass-300 ring-1 ring-brass-400/30 backdrop-blur-sm">
      Your bid: {detail}
    </div>
  );
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
  return <NumericBidDialog live={live} />;
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

/** Rung 6 `BlockingDialog` — an ordinary forced bid, no table
 * interaction needed, so a real modal costs nothing here. */
function NumericBidDialog({ live }: { live: Live }) {
  const state = live.state;
  const floor = minLegalBid(state, HERO);
  const partnerBid = state.bids[partnerOf(HERO)];
  const submit = (action: SpadesAction) => live.submitAction(action);

  return (
    <BlockingDialog open title="Your bid">
      <div className="flex flex-col gap-4">
        {partnerBid ? (
          <p className="text-[12px] text-bone-400">
            Partner bid {describeBid(partnerBid)}
            {floor > 0 ? ` — your team needs at least ${floor} combined.` : "."}
          </p>
        ) : null}

        <div className="grid grid-cols-5 gap-1.5">
          {Array.from({ length: 13 }, (_, i) => i + 1)
            .filter((n) => n >= Math.max(1, floor))
            .map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => submit({ t: "bid", tricks: n, nil: false })}
                className="rounded-lg bg-bone-50/6 py-2.5 text-sm font-bold text-bone-100 ring-1 ring-bone-50/14 hover:bg-brass-400/15 hover:text-brass-300"
              >
                {n}
              </button>
            ))}
        </div>

        {floor === 0 ? (
          <button
            type="button"
            onClick={() => submit({ t: "bid", tricks: 0, nil: true })}
            className="rounded-lg bg-bone-50/6 py-2.5 text-sm font-bold text-bone-100 ring-1 ring-bone-50/14 hover:bg-warn/15 hover:text-warn"
          >
            Nil
          </button>
        ) : null}
      </div>
    </BlockingDialog>
  );
}

/** Rung 6 `BlockingDialog` — same reasoning as NumericBidDialog: fixed
 * choices, no card on the table involved yet. */
function BlindChoiceDialog({ live }: { live: Live }) {
  const state = live.state;
  const deficit = (state.scores[((HERO + 1) % 4) as SeatId] ?? 0) - (state.scores[HERO] ?? 0);
  const canBlindNil = minLegalBid(state, HERO) === 0;
  const submit = (action: SpadesAction) => live.submitAction(action);

  return (
    <BlockingDialog open title="Your team trails — bid blind?">
      <div className="flex flex-col gap-4">
        <p className="text-[12px] text-bone-400">
          Your team trails by {deficit} — you may bid without looking at your hand.
        </p>

        <button
          type="button"
          onClick={() => submit({ t: "look" })}
          className="rounded-lg bg-linear-to-b from-brass-300 to-brass-500 py-3 text-sm font-extrabold text-felt-950 shadow-e2"
        >
          Look at my hand
        </button>

        {canBlindNil ? (
          <button
            type="button"
            onClick={() => submit({ t: "blindNil" })}
            className="rounded-lg bg-bone-50/6 py-2.5 text-sm font-bold text-bone-100 ring-1 ring-bone-50/14 hover:bg-warn/15 hover:text-warn"
          >
            Blind Nil — ±200
          </button>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold tracking-wide text-bone-400 uppercase">
            Blind bid — min 6, doubles on success
          </span>
          <div className="grid grid-cols-4 gap-1.5">
            {Array.from({ length: 8 }, (_, i) => i + 6).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => submit({ t: "blindBid", tricks: n })}
                className="rounded-lg bg-bone-50/6 py-2 text-sm font-bold text-bone-100 ring-1 ring-bone-50/14 hover:bg-brass-400/15 hover:text-brass-300"
              >
                {n}
              </button>
            ))}
          </div>
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

function standings(state: SpadesState, _live: Live, seats: SeatView[]) {
  return [
    { seat: HERO, name: "You", total: state.scores[HERO] ?? 0 },
    ...seats.map((s) => ({ seat: s.seat, name: s.name, total: state.scores[s.seat] ?? 0 })),
  ].sort((a, b) => b.total - a.total);
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
    const overtricks = !bid.nil && won > bid.tricks ? won - bid.tricks : 0;
    rows.push({
      seat,
      name: seatName(seat),
      colour: seatColour(seat),
      detail: `${bid.nil ? describeBid(bid) : `bid ${describeBid(bid)}`} · won ${won}`,
      flag: overtricks > 0 ? `${overtricks} bag${overtricks === 1 ? "" : "s"}` : undefined,
      delta: result.deltas[seat] ?? 0,
      total: state.scores[seat] ?? 0,
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

function SetupScreen({
  jokers,
  twoOfSpadesHigh,
  onJokersChange,
  onTwoOfSpadesHighChange,
  onStart,
}: {
  jokers: boolean;
  twoOfSpadesHigh: boolean;
  onJokersChange: (v: boolean) => void;
  onTwoOfSpadesHighChange: (v: boolean) => void;
  onStart: () => void;
}) {
  return (
    <main className="felt felt-weave flex min-h-svh flex-col items-center justify-center gap-8 px-6">
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

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`flex flex-col gap-0.5 rounded-lg px-3.5 py-2.5 text-left ring-1 ${
        checked ? "bg-brass-400/18 ring-brass-400/60" : "bg-bone-50/5 ring-bone-50/12"
      }`}
    >
      <span className="flex items-center justify-between">
        <span className={`text-sm font-bold ${checked ? "text-brass-300" : "text-bone-200"}`}>
          {label}
        </span>
        <span
          className={`flex h-5 w-9 items-center rounded-full px-0.5 transition-colors ${
            checked ? "justify-end bg-brass-400" : "justify-start bg-bone-50/15"
          }`}
        >
          <span className="h-4 w-4 rounded-full bg-felt-950" />
        </span>
      </span>
      <span className="text-[11px] text-bone-500">{hint}</span>
    </button>
  );
}
