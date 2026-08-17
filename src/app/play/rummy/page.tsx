"use client";

/**
 * Rummy 500.
 *
 * LAYOUT ARCHITECTURE — read this before adding anything to the screen.
 *
 * Two genuinely different things share this display and they are built
 * with different tools. The PIECE LAYER (cards) is the one absolutely
 * positioned canvas, exactly as CLAUDE.md mandates. EVERYTHING ELSE —
 * badges, turn cues, action bars, the sheet's header, dialogs — is
 * ordinary layout flow inside as few positioned containers as possible.
 *
 * Concretely there are three, and only three, positioned regions here,
 * each anchored to real table geometry that moves per viewport:
 *
 *   1. `HandZone`  — the band directly above the hand. ONE row that owns
 *                    that whole band, with two modes: ambient readouts,
 *                    or the action bar for your current selection. Two
 *                    things cannot collide there because only one thing
 *                    is ever in it.
 *   2. `PeekRail`  — the board sheet, resting at a peek height the table
 *                    geometry has already reserved via `bottomZone`.
 *   3. `PanSurface`— invisible, click-through, purely geometric.
 *
 * The alternative — a pile of independently `position: absolute`
 * siblings each computing its own `calc()` against `--hand-zone` and
 * each carrying its own z-index — is what produced a badge reading as
 * "inside" the sheet, a popover over the hand, a menu clipped off-screen
 * and a running series of z-index bumps. A z-index bump is a symptom: it
 * means two things share space and are being told who wins, instead of
 * being laid out so they never share it.
 *
 * DISCLOSURE (see ui/disclosure/POLICY.md). Rummy is the game that
 * policy's three-tier pattern was written for. Tier 1 is the ambient
 * meld strip on each seat pod; tier 2 is the board sheet; tier 3 is
 * selecting a card and watching the board filter to what it can join.
 * The deal-size prompt and the meld/discard bar are NOT modals — a
 * decision made while looking at your own hand never is.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { HERO, type PieceId, type SeatId } from "@/engine/types";
import { botColour, botName } from "@/games/_shared/botIdentity";
import {
  contributorOf,
  isValidMeld,
  orderExtensions,
  meldDisplayOrder,
  meldLabel,
} from "@/games/rummy/cards";
import { createRummy, seatColour, seatTag } from "@/games/rummy/rules";
import {
  DEFAULT_TARGET,
  MAX_SEATS,
  MIN_SEATS,
  HAND_SORTS,
  contributedValue,
  handValue,
  sortHand,
  validDealSizes,
  type HandSort,
} from "@/games/rummy/state";
import type { RummyAction, RummyState } from "@/games/rummy/types";
import { GameHost, type RoundNote } from "@/table/GameHost";
import { HandZone, HAND_HEADER_H } from "@/table/HandZone";
import { PanSurface } from "@/table/PanSurface";
import type { SeatView } from "@/table/SeatRing";
import { baseSize, layoutPiece } from "@/table/layout";
import {
  discardMaxScroll,
  handFanMaxScroll,
  isPortraitTable,
  pileAssembly,
  pileAssemblyHorizontal,
} from "@/table/geometry";
import {
  useGeometry,
  useSetDiscardScroll,
  useSetHandOrder,
  useSetHandScroll,
  useTableStore,
} from "@/table/store";
import type { GameRuntime } from "@/table/useGameRuntime";
import { PeekRail } from "@/ui/disclosure/PeekRail";
import { CardFace } from "@/ui/primitives/CardFace";
import { NumberStepper } from "@/ui/primitives/NumberStepper";
import { HeroStatusBadge, TurnIndicator, type ScoreRow } from "@/ui/phases/PhaseScreens";
import { TRANSITIONS } from "@/motion/presets";

type Live = GameRuntime<RummyState, RummyAction>;

/**
 * The sheet's resting height, reserved out of the table's own ring.
 * Tall enough for a row of real mini card faces plus the header and
 * grab handle — the peek row shows cards, not text labels.
 */
const SHEET_PEEK_H = 140;
/** How long the hero has to answer a claim before it passes to the bots. */
const CLAIM_MS = 5000;

/* ---- Board-sheet card sizing. TUNE THESE TWO. ---------------------
   `PEEK_CARD` is the resting row; `EXPANDED_CARD` is the base size the
   opened sheet starts from before it shrinks to fit more melds. If you
   change PEEK_CARD.h, raise SHEET_PEEK_H above to match, or the row
   clips. ------------------------------------------------------------ */
const PEEK_CARD = { w: 40, h: 56, gap: 3 };
const EXPANDED_CARD = { w: 46, h: 64, gap: 5 };

/* Spacing INSIDE the board sheet, in px. `sameOwner` is the gap between
   two melds belonging to the same player — the one to change if melds
   read as crowded or as drifting apart. `betweenOwners` separates the
   player clusters themselves and should stay clearly larger, or the
   grouping stops reading as grouping. (Card-to-card spacing within one
   meld is `gap` from the two size constants above.) */
const MELD_GAP = { sameOwner: 14, betweenOwners: 26 };

/**
 * Cards shrink toward a floor as the board fills up, so three melds do
 * not read as a mostly-empty sheet and eighteen still fit. Applied to
 * the card AND the gaps together — scaling only one leaves the layout
 * wrong at both extremes.
 */
function expandedCardSize(meldCount: number) {
  const scale = Math.max(0.62, Math.min(1, 1.16 - (meldCount - 1) * 0.05));
  return {
    w: Math.round(EXPANDED_CARD.w * scale),
    h: Math.round(EXPANDED_CARD.h * scale),
    gap: Math.max(2, Math.round(EXPANDED_CARD.gap * scale)),
  };
}

export default function RummyPlayPage() {
  const [seats, setSeats] = useState(4);
  const [target, setTarget] = useState(DEFAULT_TARGET);
  const [started, setStarted] = useState(false);
  const [gameKey, setGameKey] = useState(0);

  const definition = useMemo(() => createRummy({ target }), [target]);

  // `picked` is the meld being built; `pickupDepth` is how deep into the
  // discard pile a staged pickup reaches. Both live here rather than in
  // engine state: neither has happened yet, and "nothing has happened
  // yet" is exactly what lets Cancel genuinely mean it.
  const [picked, setPicked] = useState<PieceId[]>([]);
  const [pickupDepth, setPickupDepth] = useState<number | null>(null);

  const clearSelection = useCallback(() => {
    paintSelection([], []);
    setPicked([]);
    setPickupDepth(null);
  }, []);

  const onPieceTap = (id: PieceId, live: Live) => {
    if (!live.isHeroTurn) return;
    const state = live.state;
    const placement = useTableStore.getState().placements[id];
    if (!placement) return;

    const staged = pickupDepth === null ? [] : state.discard.slice(state.discard.length - pickupDepth);

    // ---- the discard pile
    if (placement.zone === "discard" && state.phase === "draw" && !state.claimWindow) {
      // A card already inside the staged range toggles its membership in
      // the meld — the cards riding along above the deepest one join
      // your hand either way, so whether each is USED in the mandatory
      // meld is a real, separate choice. (This is the bug that made a
      // pickup of A♦…2♦ unmeldable: requiring the whole pickup to form
      // one valid meld is far stricter than the rule, which only asks
      // that the DEEPEST card be melded.)
      if (staged.includes(id)) {
        const deepest = staged[0]!;
        if (id === deepest) return; // The obligation card is never optional.
        const next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
        setPicked(next);
        paintSelection(staged, next);
        return;
      }

      // Anything deeper re-stages the pickup at that depth.
      //
      // The deepest card is pre-picked because the RULES require it in
      // the meld — that is a constraint, not a suggestion. Nothing else
      // is, deliberately: an earlier version pre-filled a working meld
      // from `findCompletion`, which quietly played the hand for you.
      // Finding the meld is the game.
      const depth = state.discard.length - placement.index;
      const range = state.discard.slice(placement.index);
      setPickupDepth(depth);
      setPicked([range[0]!]);
      paintSelection(range, [range[0]!]);
      return;
    }

    // ---- the stock. Unambiguous and free, so it draws outright.
    if (placement.zone === "deck" && state.phase === "draw" && !state.claimWindow) {
      live.submitAction({ t: "drawStock" });
      return;
    }

    // ---- your own hand
    if (placement.zone === "hand" && (placement.seat ?? HERO) === HERO) {
      const next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
      setPicked(next);
      paintSelection(staged, next);
    }
  };

  if (!started) {
    return (
      <SetupScreen
        seats={seats}
        onSeats={setSeats}
        target={target}
        onTarget={setTarget}
        onStart={() => setStarted(true)}
      />
    );
  }

  return (
    <GameHost<RummyState, RummyAction>
      key={gameKey}
      definition={definition}
      runtime={{ seats }}
      gameTitle="Rummy 500"
      // The table reserves the band the hand header and the resting
      // sheet occupy, so no pod or pile can ever be laid underneath
      // them. No `pileAnchor` — the default lines the piles up with the
      // side seat pods, which is exactly where they should sit.
      bottomZone={HAND_HEADER_H + SHEET_PEEK_H}
      players={playerViews(seats)}
      standings={standings(seats)}
      stats={statsFor}
      roundSummary={roundSummary(seats)}
      pendingLabel={pendingLabel}
      onPieceTap={onPieceTap}
      onRematch={() => {
        clearSelection();
        setGameKey((k) => k + 1);
      }}
      onLobby={() => {
        clearSelection();
        setStarted(false);
      }}
    >
      {(live) => (
        <RummyTable
          live={live}
          picked={picked}
          pickupDepth={pickupDepth}
          clearSelection={clearSelection}
        />
      )}
    </GameHost>
  );
}

/* ============================================================
   Selection helpers
   ============================================================ */

/**
 * Repaints the two selection flags from scratch.
 *
 * `selected` marks the staged pickup range — "these would join your
 * hand". `highlighted` marks the cards chosen for the meld itself, and
 * is what draws the ring. A card can carry both.
 *
 * Called from event handlers only, never from inside a `setState`
 * updater: React runs updater functions DURING RENDER, so a store write
 * in one is a "cannot update a component while rendering a different
 * component" error. That is exactly the bug this shape replaces.
 */
function paintSelection(staged: readonly PieceId[], picked: readonly PieceId[]) {
  const { placements, patchMany } = useTableStore.getState();
  patchMany(Object.keys(placements), { selected: false, highlighted: false });
  // The staged pile range gets `selected` only — it is drawn as ONE ring
  // around the whole run (see `StagedRing`), because that is what it is:
  // a single block of cards that moves together. Per-card rings read as
  // several separate selections.
  if (staged.length) patchMany(staged, { selected: true });
  // Individual cards chosen for the meld DO get their own ring, since
  // each is an independent choice.
  if (picked.length) patchMany(picked, { selected: true, highlighted: true });
}

/**
 * One ring around the entire staged pickup.
 *
 * Drawn here rather than as a per-piece flag because the thing being
 * outlined is the RANGE, not the cards: taking from the discard pile
 * always takes everything from your chosen card to the top, as one
 * block. Ringing each card individually said "five selections" where
 * the truth is "one selection, five cards deep".
 *
 * Positioned by asking `layoutPiece` where the real pieces actually are
 * and taking their bounding box, so it tracks the fan through
 * compression, panning and orientation without a second copy of that
 * maths.
 */
function StagedRing({ state, depth }: { state: RummyState; depth: number | null }) {
  const geometry = useGeometry();
  const placements = useTableStore((s) => s.placements);
  const discardScroll = useTableStore((s) => s.discardScroll);
  if (!geometry || depth === null || depth <= 0) return null;

  const staged = state.discard.slice(state.discard.length - depth);
  const base = baseSize(geometry);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const id of staged) {
    const p = placements[id];
    if (!p) continue;
    const t = layoutPiece(p, geometry, {
      kind: "card",
      discardScroll: discardScroll ?? undefined,
    });
    // `layoutPiece` returns the top-left of the fixed base box, scaled
    // about its centre — so the drawn footprint is the base box shrunk
    // toward that centre by `scale`.
    const w = base.w * t.scale;
    const h = base.h * t.scale;
    const cx = t.x + base.w / 2;
    const cy = t.y + base.h / 2;
    minX = Math.min(minX, cx - w / 2);
    maxX = Math.max(maxX, cx + w / 2);
    minY = Math.min(minY, cy - h / 2);
    maxY = Math.max(maxY, cy + h / 2);
  }

  if (minX === Infinity) return null;
  const pad = 6;

  // Clipped to the fan's own region, because a staged range can easily
  // reach past it: the cards themselves fade out at that boundary (see
  // `FanSlot.visible`), and a brass ring left tracking their true
  // positions would carry on alone under a seat pod or the board sheet
  // — outlining nothing, in a place with nothing to outline. Stopping
  // it at the edge reads correctly instead: the selection continues off
  // in the direction there is more pile to pan to.
  const fan = pileAssembly(geometry, state.discard.length).fan;
  const left = Math.max(minX - pad, fan.x - pad);
  const top = Math.max(minY - pad, fan.y - pad);
  const right = Math.min(maxX + pad, fan.x + fan.w + pad);
  const bottom = Math.min(maxY + pad, fan.y + fan.h + pad);
  if (right <= left || bottom <= top) return null;

  return (
    <motion.div
      aria-hidden
      className="pointer-events-none absolute z-1400 rounded-xl"
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      style={{
        left,
        top,
        width: right - left,
        height: bottom - top,
        // A solid brass rule plus an outer glow and a dark inner halo,
        // rather than a thin translucent ring. This sits over a busy
        // fan of card faces on felt, and a 2px semi-transparent line
        // simply disappears into it.
        border: "3px solid var(--color-brass-300)",
        boxShadow:
          "0 0 0 2px rgb(0 0 0 / 0.45), 0 0 18px 3px rgb(212 175 106 / 0.55), inset 0 0 14px rgb(212 175 106 / 0.28)",
      }}
    />
  );
}

/* ============================================================
   The table
   ============================================================ */

function RummyTable({
  live,
  picked,
  pickupDepth,
  clearSelection,
}: {
  live: Live;
  /** The meld being built, and how deep a staged pickup reaches. Both
   *  live on the page, since `onPieceTap` is a GameHost prop. */
  picked: PieceId[];
  pickupDepth: number | null;
  clearSelection: () => void;
}) {
  const state = live.state;
  const [snap, setSnap] = useState(0);

  const [sortMode, setSortMode] = useState<HandSort>("smart");

  usePanWiring();
  useClearOnTurnEnd(live.isHeroTurn, clearSelection);
  useClaimCountdown(live);
  useCloseSheetOnTurnEnd(live.isHeroTurn, setSnap);
  useHandSort(state.hands[HERO] ?? [], sortMode);

  const claiming = state.claimWindow !== null;
  const heroTurn = live.isHeroTurn;
  // The stock runs dry and never reshuffles, which is deliberate — but
  // once it does there is no deck piece left on the felt to tap, so a
  // player who does not want the discard pile had no way to resolve the
  // draw at all and simply could not act. The rule already covers it
  // ("a seat facing an empty stock skips drawing"); it just needed a
  // surface.
  const stockDry =
    heroTurn && state.phase === "draw" && !claiming && state.stock.length === 0;

  const bar = heroTurn
    ? claiming
      ? <ClaimBar live={live} />
      : state.dealSizePending !== null
        ? <DealSizeBar live={live} />
        : pickupDepth !== null
          ? (
              <PickupBar
                live={live}
                depth={pickupDepth}
                picked={picked}
                onCancel={clearSelection}
              />
            )
          : stockDry
            ? <DryStockBar live={live} />
            : picked.length > 0
              ? <MeldBar live={live} picked={picked} onClear={clearSelection} />
              : null
    : null;

  return (
    <>
      <HandZone
        bar={bar}
        left={<HandStatus state={state} />}
        center={<TurnIndicator inline show={heroTurn} label={turnLabel(state)} />}
        right={<SortMenu mode={sortMode} onMode={setSortMode} />}
      />

      <StockBadge state={state} />

      <PanSurfaces state={state} />
      <StagedRing state={state} depth={pickupDepth} />
      <BoardSheet
        live={live}
        picked={picked}
        snap={snap}
        onSnap={setSnap}
        onExtended={clearSelection}
      />
    </>
  );
}

/**
 * Publishes the hero's chosen hand order to the table store, where the
 * piece layer reads it. Recomputed when the hand's CONTENTS change, not
 * on every render — a hand joined into a key is cheap and stable, and
 * re-sorting on identity alone would fire on every publish.
 */
function useHandSort(hand: readonly PieceId[], mode: HandSort) {
  const setHandOrder = useSetHandOrder();
  const key = hand.join(",");
  useEffect(() => {
    const ordered = sortHand(key ? key.split(",") : [], mode);
    const order: Record<PieceId, number> = {};
    ordered.forEach((id, i) => (order[id] = i));
    setHandOrder(order);
  }, [key, mode, setHandOrder]);

  useEffect(() => () => setHandOrder(null), [setHandOrder]);
}

/**
 * The board is reference, not a place to park. Once your turn is over
 * there is nothing left to compare against your hand, so the sheet gets
 * out of the way on its own rather than leaving the player to close it.
 */
function useCloseSheetOnTurnEnd(isHeroTurn: boolean, setSnap: (n: number) => void) {
  const was = useRef(isHeroTurn);
  useEffect(() => {
    if (was.current && !isHeroTurn) setSnap(0);
    was.current = isHeroTurn;
  }, [isHeroTurn, setSnap]);
}

/**
 * Shown when the stock is dry and the hero still has to resolve a draw.
 *
 * The wording matters more than it looks. "Stock is empty · Play on"
 * read as the only thing available, and a player pressed it without
 * realising the discard pile was still theirs to take — losing the
 * draw. The pile is named FIRST, and the button says what it gives up.
 */
function DryStockBar({ live }: { live: Live }) {
  return (
    <>
      <span className="min-w-0 shrink truncate text-[10px] font-bold text-bone-300">
        No stock left — take from the pile, or:
      </span>
      <BarButton tone="quiet" onClick={() => live.submitAction({ t: "drawStock" })}>
        Skip the draw
      </BarButton>
    </>
  );
}

/** Clears a staged pickup or selection the moment the turn is gone. */
function useClearOnTurnEnd(isHeroTurn: boolean, clear: () => void) {
  const was = useRef(isHeroTurn);
  useEffect(() => {
    if (was.current && !isHeroTurn) clear();
    was.current = isHeroTurn;
  }, [isHeroTurn, clear]);
}

/**
 * The claim window's five-second reflex.
 *
 * Purely a page-level timer — the engine has no concept of it existing
 * (`reduce` holds no wall-clock at all). If the hero does not answer,
 * this submits `passClaim` and the bots get their shot, which is the
 * same thing that would have happened had they never been eligible.
 */
function useClaimCountdown(live: Live) {
  const open = live.state.claimWindow !== null;
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => live.submitAction({ t: "passClaim" }), CLAIM_MS);
    return () => clearTimeout(t);
    // `live` is rebuilt every render; keying on the window's own
    // existence is what keeps this a single timer per window rather than
    // one restarted on every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/**
 * Publishes the two pan values and renders their gesture surfaces.
 *
 * Setting them at all is what opts this game into compress-then-pan;
 * every other game leaves them null and keeps the fan it always had.
 */
function usePanWiring() {
  const setDiscardScroll = useSetDiscardScroll();
  const setHandScroll = useSetHandScroll();
  useEffect(() => {
    setDiscardScroll(0);
    setHandScroll(0);
    // Back to null on unmount, so leaving Rummy hands every other game
    // back its own plain, unfloored fan.
    return () => {
      setDiscardScroll(null);
      setHandScroll(null);
    };
  }, [setDiscardScroll, setHandScroll]);
}

function PanSurfaces({ state }: { state: RummyState }) {
  const geometry = useGeometry();
  const discardScroll = useTableStore((s) => s.discardScroll);
  const handScroll = useTableStore((s) => s.handScroll);
  const setDiscardScroll = useSetDiscardScroll();
  const setHandScroll = useSetHandScroll();

  if (!geometry || discardScroll === null || handScroll === null) return null;

  const assembly = pileAssembly(geometry, state.discard.length);
  const handCount = (state.hands[HERO] ?? []).length;

  return (
    <>
      <PanSurface
        within={assembly.fan}
        axis={isPortraitTable(geometry.pileRegion) ? "y" : "x"}
        range={discardMaxScroll(geometry, state.discard.length)}
        value={discardScroll}
        onChange={setDiscardScroll}
      />
      <PanSurface
        within={geometry.zones.hand}
        axis="x"
        range={handFanMaxScroll(geometry, handCount)}
        value={handScroll}
        onChange={setHandScroll}
      />
    </>
  );
}

function turnLabel(state: RummyState): string {
  if (state.claimWindow) return "Claim it?";
  if (state.dealSizePending !== null) return "Your deal";
  // An out player is still in the round — they draw one each lap and
  // choose again. Naming that state stops it reading as a stuck turn.
  if ((state.hands[HERO] ?? []).length === 0) return "You're out — draw one";
  if (state.phase === "draw") return "Draw — pile or stock";
  if (state.mandatory) return "Meld the card you took";
  return "Meld or discard";
}

/* ============================================================
   The band above the hand — ambient mode
   ============================================================ */

function HandStatus({ state }: { state: RummyState }) {
  const held = handValue(state, HERO);
  const board = contributedValue(state, HERO);
  return (
    <HeroStatusBadge
      inline
      label="You"
      detail={`${state.scores[HERO] ?? 0} · +${board} / −${held}`}
    />
  );
}

/**
 * The stock count, parked directly over the stock itself.
 *
 * Absolutely positioned and `pointer-events-none`, so it annotates the
 * pile without joining its layout — the deck's own position comes from
 * `pileAssemblyHorizontal` and must not shift because a label appeared
 * next to it. This is the same geometry-anchored badge pattern
 * Dominoes' boneyard counter uses.
 *
 * It sat in the hand row before, which put a fact about a pile at the
 * far end of the screen from the pile.
 */
function StockBadge({ state }: { state: RummyState }) {
  const geometry = useGeometry();
  const discardPan = useTableStore((s) => s.discardScroll !== null);
  if (!geometry) return null;

  const { deckX, deckY } = pileAssemblyHorizontal(
    geometry,
    discardPan ? state.discard.length : 0,
  );
  const width = geometry.card.w * 2;

  return (
    <div
      className="pointer-events-none absolute z-1200 text-center"
      style={{ left: deckX - width / 2, top: deckY - geometry.card.h / 2 - 24, width }}
    >
      <span className="rounded-full bg-felt-950/80 px-2 py-1 text-[10px] font-bold text-bone-300 ring-1 ring-bone-50/12">
        {state.stock.length > 0 ? `${state.stock.length} in stock` : "stock empty"}
      </span>
    </div>
  );
}

/**
 * Hand sort. Lives in the slot the stock count used to occupy — a
 * control that acts on the hand, next to the hand.
 *
 * The popover opens UPWARD, because down is the player's own cards.
 */
function SortMenu({ mode, onMode }: { mode: HandSort; onMode: (m: HandSort) => void }) {
  const [open, setOpen] = useState(false);
  const current = HAND_SORTS.find((s) => s.id === mode);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[10px] font-bold ring-1 ${
          open
            ? "bg-brass-400/20 text-brass-300 ring-brass-400/50"
            : "bg-felt-950/78 text-bone-300 ring-bone-50/12"
        }`}
      >
        <span aria-hidden>⇅</span>
        <span className="truncate">{current?.label ?? "Sort"}</span>
      </button>

      <AnimatePresence>
        {open ? (
          <>
            {/* A full-screen catcher so tapping anywhere else closes the
                menu, without the menu itself being a modal. */}
            <div className="fixed inset-0 z-1750" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: 6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97 }}
              transition={TRANSITIONS.ui}
              className="absolute right-0 bottom-full z-1800 mb-2 w-52 overflow-hidden rounded-xl border border-brass-400/25 bg-linear-to-b from-felt-800/97 to-felt-900 shadow-e2 backdrop-blur-md"
            >
              {HAND_SORTS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    onMode(option.id);
                    setOpen(false);
                  }}
                  className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left ${
                    option.id === mode ? "bg-brass-400/15" : "hover:bg-bone-50/6"
                  }`}
                >
                  <span
                    className={`text-[11px] font-bold ${
                      option.id === mode ? "text-brass-300" : "text-bone-100"
                    }`}
                  >
                    {option.label}
                  </span>
                  <span className="text-[10px] leading-tight text-bone-500">{option.hint}</span>
                </button>
              ))}
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* ============================================================
   The band above the hand — action mode
   ============================================================ */

function BarButton({
  children,
  onClick,
  tone = "primary",
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "primary" | "quiet";
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`min-w-0 shrink truncate rounded-lg px-3 py-2 text-xs font-extrabold disabled:opacity-40 ${
        tone === "primary"
          ? "bg-linear-to-b from-brass-300 to-brass-500 text-felt-950 shadow-e2"
          : "bg-bone-50/8 text-bone-200 ring-1 ring-bone-50/16"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Reads the current hand selection and offers exactly what it supports.
 * Non-modal by policy: this is a decision made while looking at your own
 * cards, so it must never cover or block them.
 */
function MeldBar({
  live,
  picked,
  onClear,
}: {
  live: Live;
  picked: PieceId[];
  onClear: () => void;
}) {
  const state = live.state;
  const canLay = picked.length >= 3 && isValidMeld(picked);
  const canDiscard = picked.length === 1 && state.phase === "meld" && !state.mandatory;

  // There is deliberately NO "add to meld" button here.
  //
  // Offering one the moment a single card is selected announces that the
  // card fits something on the board — which is the deduction the player
  // is meant to be making. Laying off is done by tapping the card and
  // then tapping the meld in the board sheet; if it fits, it goes. The
  // board is there to be read, not summarised.
  return (
    <>
      <BarButton tone="quiet" onClick={onClear}>
        Clear
      </BarButton>
      {canLay ? (
        <BarButton
          onClick={() => {
            live.submitAction({ t: "layNewMeld", cards: picked });
            onClear();
          }}
        >
          Meld {meldLabel(picked)}
        </BarButton>
      ) : null}
      {canDiscard ? (
        <BarButton
          tone={canLay ? "quiet" : "primary"}
          onClick={() => {
            live.submitAction({ t: "discard", card: picked[0]! });
            onClear();
          }}
        >
          Discard
        </BarButton>
      ) : null}
    </>
  );
}

/**
 * A staged discard pickup: nothing has happened, and Cancel means it.
 *
 * That is the whole reason a pickup is staged rather than drawn outright
 * — every pickup, at every depth including a bare top card, forces a
 * brand-new meld, so tapping into the pile to SEE what one would require
 * has to be free.
 */
function PickupBar({
  live,
  depth,
  picked,
  onCancel,
}: {
  live: Live;
  depth: number;
  picked: PieceId[];
  onCancel: () => void;
}) {
  const state = live.state;
  const pile = state.discard;
  const taken = pile.slice(pile.length - depth);
  const deepest = taken[0]!;

  // The meld is what the player PICKED, not the whole pickup. Everything
  // taken joins the hand regardless; only the deepest card carries the
  // obligation to be melded. Requiring the entire pickup to form one
  // valid meld — which this used to do — made a perfectly legal dig
  // impossible: taking A♦ off the bottom of a pile that also holds K♠,
  // Q♦, Q♥ and 2♦ is exactly how you meld Q♦-K♦-A♦ with a king from
  // hand, and no arrangement of all six cards is a meld.
  const ready = picked.length >= 3 && isValidMeld(picked) && picked.includes(deepest);

  return (
    <>
      <BarButton tone="quiet" onClick={onCancel}>
        Cancel
      </BarButton>
      <span className="min-w-0 shrink truncate text-[10px] font-bold text-bone-300">
        {pickupHint(depth, picked, ready)}
      </span>
      <BarButton
        disabled={!ready}
        onClick={() => {
          // Two engine calls, deliberately: `layNewMeld` validates the
          // cards are already in hand, so the draw genuinely has to
          // happen first. `submitAction` reads live state fresh each
          // time, so the second correctly sees the first's result. The
          // card visibly lands in the hand for a beat before flying to
          // the board — accepted, and made fast by the choreographer's
          // `offset: 0` handling rather than papered over.
          live.submitAction({ t: "drawDiscard", depth });
          live.submitAction({ t: "layNewMeld", cards: picked });
          onCancel();
        }}
      >
        Create meld
      </BarButton>
    </>
  );
}

/** POLICY.md: state the count in words rather than making someone count. */
function pickupHint(depth: number, picked: readonly PieceId[], ready: boolean): string {
  const n = `${depth} card${depth === 1 ? "" : "s"}`;
  if (ready) return `${n} · ${meldLabel(picked)}`;
  if (picked.length < 3) return `${n} · tap ${3 - picked.length} more`;
  return `${n} · not a meld yet`;
}

function ClaimBar({ live }: { live: Live }) {
  const window_ = live.state.claimWindow!;
  return (
    <>
      <span className="min-w-0 shrink truncate text-[10px] font-bold text-brass-300">
        {window_.discard} fits a meld
      </span>
      <BarButton onClick={() => live.submitAction({ t: "claim" })}>Claim</BarButton>
      <BarButton tone="quiet" onClick={() => live.submitAction({ t: "passClaim" })}>
        Pass
      </BarButton>
      <motion.span
        aria-hidden
        className="h-1 shrink-0 rounded-full bg-brass-400"
        initial={{ width: 48 }}
        animate={{ width: 0 }}
        transition={{ duration: CLAIM_MS / 1000, ease: "linear" }}
      />
    </>
  );
}

/**
 * The dealer's own hand-size choice. Non-modal for the same reason the
 * meld bar is: it is a decision about the table you are looking at.
 */
function DealSizeBar({ live }: { live: Live }) {
  const sizes = validDealSizes(live.state.seats);
  const [size, setSize] = useState(sizes[Math.floor(sizes.length / 2)] ?? 7);
  return (
    <>
      <span className="shrink-0 text-[10px] font-bold text-bone-300">Deal</span>
      <NumberStepper
        value={size}
        min={sizes[0]!}
        max={sizes[sizes.length - 1]!}
        step={2}
        label="cards"
        onChange={setSize}
      />
      <BarButton onClick={() => live.submitAction({ t: "chooseDealSize", size })}>Deal</BarButton>
    </>
  );
}

/* ============================================================
   The board sheet — POLICY.md rung 4
   ============================================================ */

function BoardSheet({
  live,
  picked,
  snap,
  onSnap,
  onExtended,
}: {
  live: Live;
  picked: PieceId[];
  snap: number;
  onSnap: (n: number) => void;
  onExtended: () => void;
}) {
  const geometry = useGeometry();
  const state = live.state;
  const [rejected, setRejected] = useState<number | null>(null);
  const dealing = live.dealingRound !== null;
  if (!geometry) return null;

  const handH = geometry.zones.hand.h;
  // BOTH numbers come from the identical set of reserved terms. If the
  // tallest snap failed to subtract a band that `offsetBottom` adds, the
  // sheet would overshoot the top of the viewport and take its own grab
  // handle with it — the "can't close it" bug.
  const offsetBottom = handH + HAND_HEADER_H;
  const available = Math.max(48, geometry.box.h - offsetBottom - 12);
  // The RESTING height is what geometry actually granted, not what this
  // page asked for. A short landscape phone cannot give up the full
  // band, and assuming it did is how a sheet ends up resting on top of
  // the seat pods on exactly one device — see `TableGeometry.reserved`.
  const peek = Math.max(
    72,
    Math.min(available, geometry.reserved.bottom - HAND_HEADER_H || SHEET_PEEK_H),
  );
  // TWO stops only: resting and fully open. A middle stop earns its
  // place when the content is long enough that a half view is a
  // different task from a full one; here it just gives a drag somewhere
  // ambiguous to land, and every gesture needs a second nudge to reach
  // what it was actually going for.
  const snapPoints = [peek, available];

  // Any selection at all means a lay-off is POSSIBLE to attempt. Which
  // melds it actually fits is deliberately not shown — the board is
  // there to be read. Tapping a meld attempts it; the engine is the only
  // thing that decides, and it says so after the attempt, never before.
  const canAttempt = picked.length >= 1 && !state.mandatory && state.phase === "meld";
  const byOwner = groupByOwner(state);

  const tryExtend = (meldId: number) => {
    const meld = state.melds.find((m) => m.id === meldId);
    // Several cards at once, in whatever order actually works — see
    // `orderExtensions`. Selecting a 9 and a 10 for a J-Q-K run and
    // being made to place them one at a time, correct end first, is
    // busywork the player can already see through.
    const order = meld ? orderExtensions(meld.cards, picked) : null;
    if (!order) {
      setRejected(meldId);
      window.setTimeout(() => setRejected(null), 400);
      return;
    }
    // `submitAction` re-reads live state each call, so each extend sees
    // the one before it — the same property the two-step pickup relies
    // on.
    for (const card of order) live.submitAction({ t: "extendMeld", meldId, card });
    onExtended();
  };

  return (
    <PeekRail
      snapPoints={snapPoints}
      snapIndex={snap}
      onSnapChange={onSnap}
      offsetBottom={offsetBottom}
      header={
        <div className="flex items-center justify-between">
          <span className="eyebrow">
            {canAttempt
              ? `Lay off ${picked.length} — tap a meld`
              : `Board · ${state.melds.length} melds`}
          </span>
          <span className="text-[10px] text-bone-400">
            {snap === 0 ? "drag up ↑" : "drag down ↓"}
          </span>
        </div>
      }
    >
      {dealing ? (
        // `live.state` only catches up once a whole deal has finished
        // animating, so through the round-end sweep it still describes
        // the round that just ended. Showing the previous board while
        // its cards are visibly being swept away reads as the clear
        // having failed.
        <p className="py-2 text-[11px] text-bone-500">Dealing…</p>
      ) : state.melds.length === 0 ? (
        <p className="py-2 text-[11px] text-bone-500">Nothing melded yet.</p>
      ) : (
        <BoardBody
          groups={byOwner}
          collapsed={snap === 0}
          meldCount={state.melds.length}
          onMeldTap={canAttempt ? tryExtend : undefined}
          rejected={rejected}
        />
      )}
    </PeekRail>
  );
}

interface SheetCard {
  id: PieceId;
  /** Who this specific card scores for — not always the meld's owner. */
  contributor: SeatId;
}

interface SheetMeld {
  id: number;
  owner: SeatId;
  cards: SheetCard[];
}

interface OwnerGroup {
  seat: SeatId;
  name: string;
  colour: string;
  melds: SheetMeld[];
}

function groupByOwner(state: RummyState): OwnerGroup[] {
  const map = new Map<SeatId, OwnerGroup>();
  for (const meld of state.melds) {
    let g = map.get(meld.owner);
    if (!g) {
      g = {
        seat: meld.owner,
        name: meld.owner === HERO ? "You" : botName(meld.owner),
        colour: seatColour(meld.owner),
        melds: [],
      };
      map.set(meld.owner, g);
    }
    // Display order, NOT the stored append-only log — extension order is
    // real data the log has to preserve, and rendering it directly is
    // what made a run hit at its low end read as scrambled.
    g.melds.push({
      id: meld.id,
      owner: meld.owner,
      cards: meldDisplayOrder(meld.cards).map((id) => ({
        id,
        contributor: contributorOf(meld, id),
      })),
    });
  }
  return [...map.values()].sort((a, b) => a.seat - b.seat);
}

/**
 * A card in the sheet, tagged with who played it when that is not the
 * player the meld is filed under. Melds are owned for scoring only —
 * any seat may hit any meld — so a single run can genuinely carry three
 * different people's cards, and the group heading cannot say so.
 */
function SheetCardFace({
  card,
  w,
  h,
  owner,
}: {
  card: SheetCard;
  w: number;
  h: number;
  /** The meld's owner — the chip is shown only when they disagree. */
  owner: SeatId;
}) {
  // Tagging every card in a player's own meld with that same player's
  // initials repeats what the group heading already said, on every
  // card. The chip is worth its space only where it CONTRADICTS the
  // grouping — a card someone else hit onto this meld, which is the one
  // thing the heading cannot tell you.
  const foreign = card.contributor !== owner;
  return (
    <span className="relative inline-block shrink-0">
      <CardFace card={card.id} w={w} h={h} detail="index" />
      {foreign ? (
        <span
          // INSIDE the card's own footprint, not hanging off it. The
          // sheet's rows are overflow containers, and an overflow
          // container clips both axes — a chip poking above the card had
          // its top sliced off.
          className="absolute rounded-full px-1 font-bold text-felt-950"
          style={{
            top: 2,
            right: 2,
            background: seatColour(card.contributor),
            fontSize: Math.max(6, Math.round(w * 0.24)),
            lineHeight: 1.35,
            boxShadow: "0 1px 2px rgb(0 0 0 / 0.4)",
          }}
        >
          {seatTag(card.contributor)}
        </span>
      ) : null}
    </span>
  );
}

function OwnerChip({ group }: { group: OwnerGroup }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span
        className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold text-felt-950"
        style={{ background: group.colour }}
      >
        {group.name.slice(0, 2).toUpperCase()}
      </span>
      <span className="text-[11px] font-semibold text-bone-200">{group.name}</span>
    </span>
  );
}

/**
 * The board, grouped by OWNER — one cluster per player, not a repeated
 * avatar chip per meld.
 *
 * Each meld is ONE horizontal row that never wraps. Wrapping a seven
 * card run into three stacked rows inside a fixed-width grid cell is
 * what made the sheet grow downward and leave tall empty boxes; a run
 * reads as a run when it is laid out like one.
 *
 * No panel behind each meld. The cards are already objects with edges —
 * a dark rounded box around them added a second, competing edge and a
 * lot of empty area around short melds.
 *
 * COLLAPSED is a single line, every owner inline, scrolling sideways.
 * At rest the sheet is a strip, and a strip that grows a row per player
 * is not a strip — it pushes the table up as the board fills, which is
 * the opposite of what a peek is for. Growing into rows is what
 * OPENING it is for.
 */
function BoardBody({
  groups,
  collapsed,
  meldCount,
  onMeldTap,
  rejected,
}: {
  groups: OwnerGroup[];
  collapsed: boolean;
  meldCount: number;
  /** Present only while a lay-off is possible to ATTEMPT. */
  onMeldTap?: (meldId: number) => void;
  rejected: number | null;
}) {
  const { w, h, gap } = collapsed ? PEEK_CARD : expandedCardSize(meldCount);

  const melds = (group: OwnerGroup) =>
    group.melds.map((m) => (
      <MeldRow
        key={m.id}
        meld={m}
        w={w}
        h={h}
        gap={gap}
        onTap={onMeldTap}
        rejected={rejected === m.id}
      />
    ));

  if (collapsed) {
    return (
      <div
        // `pt-2` is not decoration: the owner chips sit slightly proud of
        // their cards, and an `overflow-x` container clips the other axis
        // too (per the CSS Overflow spec, one axis set to a non-visible
        // value promotes the other) — without the padding the chips get
        // their tops sliced off.
        className="flex items-start overflow-x-auto pt-2 pb-1"
        style={{ gap: MELD_GAP.betweenOwners }}
      >
        {groups.map((group) => (
          <div
            key={group.seat}
            className="flex shrink-0 items-center"
            style={{ gap: MELD_GAP.sameOwner }}
          >
            <OwnerChip group={group} />
            {melds(group)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col pt-2 pb-2" style={{ gap: MELD_GAP.betweenOwners }}>
      {groups.map((group) => (
        <div key={group.seat} className="flex flex-col" style={{ gap: gap * 0.8 }}>
          <OwnerChip group={group} />
          {/* `items-start` so a short meld sits at the top of the row
              rather than floating in the middle of the tallest one. */}
          <div
            className="flex flex-wrap items-start"
            style={{ gap: MELD_GAP.sameOwner }}
          >
            {melds(group)}
          </div>
        </div>
      ))}
    </div>
  );
}

function MeldRow({
  meld,
  w,
  h,
  gap,
  onTap,
  rejected,
}: {
  meld: SheetMeld;
  w: number;
  h: number;
  gap: number;
  onTap?: (meldId: number) => void;
  rejected: boolean;
}) {
  const interactive = Boolean(onTap);
  return (
    <motion.div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? () => onTap!(meld.id) : undefined}
      // A refused lay-off shakes. Feedback AFTER an attempt is a
      // different thing from a hint before one: it answers what the
      // player just asked, without answering what they have not.
      animate={rejected ? { x: [0, -5, 5, -3, 3, 0] } : { x: 0 }}
      transition={{ duration: 0.35 }}
      className={`flex shrink-0 flex-nowrap items-start rounded-md ${
        interactive ? "cursor-pointer" : ""
      } ${rejected ? "ring-1 ring-red-400/70" : ""}`}
      style={{ gap }}
    >
      {meld.cards.map((c) => (
        <SheetCardFace key={c.id} card={c} w={w} h={h} owner={meld.owner} />
      ))}
    </motion.div>
  );
}

/* ============================================================
   GameHost slots
   ============================================================ */

function playerViews(seats: number) {
  return (state: RummyState, live: Live): SeatView[] => {
    const views: SeatView[] = [];
    for (let s = 1; s < seats; s++) {
      const acting = live.busy && live.lastAction?.seat === s;
      views.push({
        seat: s,
        name: botName(s),
        colour: botColour(s),
        meta: `${(state.hands[s] ?? []).length} cards · ${state.scores[s] ?? 0}`,
        active: acting || live.state.turn === s,
        thinking: acting,
        // POLICY.md tier 1: a compressed, always-visible summary of what
        // this player has down. Costs nothing and answers "roughly
        // what's out there?" without opening anything.
        melds: state.melds.filter((m) => m.owner === s).map((m) => meldLabel(m.cards)),
      });
    }
    return views;
  };
}

function standings(seats: number) {
  return (state: RummyState) =>
    Array.from({ length: seats }, (_, s) => ({
      seat: s,
      name: s === HERO ? "You" : botName(s),
      total: state.scores[s] ?? 0,
    })).sort((a, b) => b.total - a.total);
}

function statsFor(state: RummyState) {
  return [
    { label: "Round", value: String(state.round) },
    { label: "Melds down", value: String(state.melds.length) },
    { label: "Dealt", value: `${state.dealSize} cards` },
  ];
}

function roundSummary(seats: number) {
  return (state: RummyState): { title: string; rows: ScoreRow[]; note?: RoundNote } | null => {
    const result = state.result;
    if (!result) return null;

    const rows: ScoreRow[] = Array.from({ length: seats }, (_, s) => ({
      seat: s,
      name: s === HERO ? "You" : botName(s),
      colour: s === HERO ? "var(--color-brass-300)" : botColour(s),
      detail: `+${result.contributed[s] ?? 0} board · −${result.handPenalty[s] ?? 0} held`,
      delta: result.deltas[s] ?? 0,
      total: state.scores[s] ?? 0,
      flag: result.wentOut === s ? "went out" : undefined,
    }));

    const note: RoundNote | undefined = result.blocked
      ? {
          tone: "warn",
          title: "Round blocked",
          body: "Nobody made progress for several laps, so the round was called. Everyone scores what they had.",
        }
      : undefined;

    return {
      title:
        result.wentOut === HERO
          ? "You went out"
          : result.wentOut !== null
            ? `${botName(result.wentOut)} went out`
            : "Round complete",
      rows,
      note,
    };
  };
}

function pendingLabel(state: RummyState, seat: SeatId): string {
  const what =
    state.dealSizePending !== null ? "dealing" : state.phase === "draw" ? "drawing" : "melding";
  return `${botName(seat)} pending — ${what}`;
}

/* ============================================================
   Setup
   ============================================================ */

function SetupScreen({
  seats,
  onSeats,
  target,
  onTarget,
  onStart,
}: {
  seats: number;
  onSeats: (n: number) => void;
  target: number;
  onTarget: (n: number) => void;
  onStart: () => void;
}) {
  return (
    <main className="felt felt-weave flex min-h-svh flex-col items-center justify-center gap-7 px-6 py-10">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="eyebrow">New match</span>
        <h1 className="font-display text-4xl font-extrabold text-bone-50">Rummy 500</h1>
        <p className="max-w-sm text-xs leading-relaxed text-bone-400">
          Melds are sets and runs. Taking anything off the discard pile — even the
          top card — means melding it right away. First to the target wins.
        </p>
      </div>

      <div className="flex w-full max-w-sm flex-col gap-5">
        <label className="flex flex-col gap-2">
          <span className="flex items-center justify-between text-xs font-bold text-bone-200">
            Players <span className="tnum text-brass-300">{seats}</span>
          </span>
          <input
            type="range"
            min={MIN_SEATS}
            max={MAX_SEATS}
            value={seats}
            onChange={(e) => onSeats(Number(e.target.value))}
            className="w-full accent-brass-400"
          />
        </label>

        <div className="flex flex-col items-center gap-2">
          <span className="text-xs font-bold text-bone-200">Play to</span>
          <NumberStepper
            value={target}
            min={100}
            max={1000}
            step={25}
            label="points"
            onChange={onTarget}
          />
        </div>
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
