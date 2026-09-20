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
 * DISCLOSURE (see ui/disclosure/POLICY.md). The board sheet is the ONE
 * place melds live. Each pod used to carry an ambient micro-strip of its
 * owner's melds as well, and it was cut: it restated, in truncated text,
 * what the sheet shows properly in real card faces, and a meld filed
 * under a player is not even a fact about that player — any seat may hit
 * any meld. Two views of the same thing, one of them worse.
 *
 * The deal-size prompt and the meld/discard bar are NOT modals — a
 * decision made while looking at your own hand never is.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { HERO, type PieceId, type SeatId } from "@/engine/types";
import { botColour, botName } from "@/games/_shared/botIdentity";
import {
  MIN_MELD,
  contributorOf,
  isDeadMeld,
  laidCards,
  isValidMeld,
  orderExtensions,
  meldDisplayOrder,
  meldLabel,
} from "@/games/rummy/cards";
import {
  HAND_SORTS,
  claimDeadlineMs,
  claimReactions,
  inClaimRace,
  contributedValue,
  handValue,
  sortHand,
  validDealSizes,
  type HandSort,
} from "@/games/rummy/state";
import type { RummyAction, RummyState } from "@/games/rummy/types";
import type { RoundNote } from "@/table/GameHost";
import { HandZone, handHeaderHeight } from "@/table/HandZone";
import { PanSurface } from "@/table/PanSurface";
import type { SeatView } from "@/table/SeatRing";
import { seatCue } from "@/table/turnCue";
import { baseSize, layoutPiece } from "@/table/layout";
import {
  discardMaxScroll,
  handFanMaxScroll,
  isPortraitTable,
  isShortViewport,
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
import { CardBack, CardFace } from "@/ui/primitives/CardFace";
import { CountdownButton } from "@/ui/primitives/CountdownButton";
import { NumberStepper } from "@/ui/primitives/NumberStepper";
import { HeroStatusBadge, TurnIndicator, type ScoreRow } from "@/ui/phases/PhaseScreens";
import { TRANSITIONS } from "@/motion/presets";


/* ============================================================
   Who is looking
   ============================================================ */

/**
 * The viewer, and what everyone at this table is called.
 *
 * Identical in shape to the other four games' `View`, and here for the
 * same reason: offline the answer is "seat 0, and everybody else is a
 * bot", which was hardcoded through this file as `HERO` and `botName`.
 * Online it comes off the room's roster, and the seat is whichever chair
 * the person actually sits in.
 *
 * Rummy needed this more than the others did. Its board sheet tags every
 * card on the table with its contributor's initials, so a wrong answer
 * here is not a cosmetic slip — it is somebody else's name on your meld.
 */
export interface RummyView {
  /** The seat this screen belongs to, or null for a spectator. */
  viewerSeat: SeatId | null;
  nameFor: (seat: SeatId) => string;
  colourFor: (seat: SeatId) => string;
  /**
   * Whether a bot is currently playing that seat for the person who owns
   * it. Optional because only a room can answer it — offline there is
   * nobody to step away. Supplied by `awayFrom(frame)`.
   */
  awayFor?: (seat: SeatId) => boolean;
}

/** One human at seat 0, everyone else a bot — the single-player table. */
export const OFFLINE_VIEW: RummyView = {
  viewerSeat: HERO,
  nameFor: (seat) => (seat === HERO ? "You" : botName(seat)),
  colourFor: (seat) => (seat === HERO ? "var(--color-brass-300)" : botColour(seat)),
};

/**
 * The seat this viewer is playing, for the many places that need "my
 * hand" and cannot sensibly answer for a spectator.
 *
 * `-1` matches no seat anywhere, which is exactly a spectator's
 * entitlement: every hand reads as somebody else's.
 */
export function mySeat(view: RummyView): SeatId {
  return view.viewerSeat ?? -1;
}

/** Initials for the board sheet's contributor chips. */
export function tagFor(view: RummyView, seat: SeatId): string {
  return seat === view.viewerSeat ? "YOU" : view.nameFor(seat).slice(0, 2).toUpperCase();
}

type Live = GameRuntime<RummyState, RummyAction>;

/**
 * The sheet's resting height, reserved out of the table's own ring.
 * Tall enough for a row of real mini card faces plus the header and
 * grab handle — the peek row shows cards, not text labels.
 */
export const SHEET_PEEK_H = 140;

/**
 * How long a completed set sits face up before it turns over, in ms.
 *
 * The flip used to be instantaneous, computed straight from state, and it
 * read as the card being rejected rather than as the meld closing — you
 * never saw the fourth card join. The card has to land, be read, and
 * *then* the meld is finished with. This is the pause that makes it one
 * gesture in two beats instead of one confusing event.
 */
const DEAD_MELD_FLIP_DELAY = 1600;
/** The turn itself. Long enough to read as a hand turning cards over. */
const DEAD_MELD_FLIP_MS = 0.55;

/**
 * The live viewport, and whether it is too short for this table.
 *
 * Read from `window` rather than from geometry because it is an INPUT to
 * `resolveTable`, not an output of it — `bottomZone` depends on it.
 *
 * Starts at a tall default so the server render and the first client
 * render agree; the effect corrects it before paint.
 */
export function useViewport(): { vh: number; short: boolean; touch: boolean } {
  const [vp, setVp] = useState({ vh: 900, touch: false });
  useEffect(() => {
    const read = () =>
      setVp({
        vh: window.innerHeight,
        // Chooses the WORDING only. "Rotate your device" is nonsense
        // advice for someone who has just made a desktop window short.
        touch: window.matchMedia("(pointer: coarse)").matches,
      });
    read();
    window.addEventListener("resize", read);
    window.addEventListener("orientationchange", read);
    return () => {
      window.removeEventListener("resize", read);
      window.removeEventListener("orientationchange", read);
    };
  }, []);
  return { ...vp, short: isShortViewport({ h: vp.vh }) };
}

/* ---- Board-sheet card sizing. TUNE THESE TWO. ---------------------
   `PEEK_CARD` is the resting row; `EXPANDED_CARD` is the base size the
   opened sheet starts from before it shrinks to fit more melds. If you
   change PEEK_CARD.h, raise SHEET_PEEK_H above to match, or the row
   clips. ------------------------------------------------------------ */
const PEEK_CARD = { w: 40, h: 56, gap: 3 };
// The OPEN sheet has a whole screen to work with and was still drawing
// cards barely bigger than the resting strip's — it read as a peek that
// had simply got taller. Sized for the space it actually has now; the
// sheet scrolls at every snap, so more melds cost scrolling rather than
// ever-smaller cards.
const EXPANDED_CARD = { w: 66, h: 92, gap: 6 };

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
function expandedCardSize(meldCount: number, availableW: number) {
  // Shallower falloff and a higher floor than the first pass. The panel
  // scrolls, so shrinking is only worth doing while it buys a whole extra
  // meld per row — past that it costs legibility for nothing.
  const byCount = Math.max(0.72, Math.min(1, 1.12 - (meldCount - 1) * 0.035));
  // ...and then capped by the width actually on offer, so the SHORTEST
  // legal meld always fits the panel without scrolling. A side rail is
  // ~176px where a bottom sheet is most of the screen, and a card size
  // tuned for one clips in the other — which is the bug this whole
  // landscape pass exists to fix, and it would have come straight back
  // rotated ninety degrees.
  const widest = (availableW - EXPANDED_CARD.gap * (MIN_MELD - 1)) / MIN_MELD;
  const scale = Math.min(byCount, Math.max(0.5, widest / EXPANDED_CARD.w));
  return {
    w: Math.round(EXPANDED_CARD.w * scale),
    h: Math.round(EXPANDED_CARD.h * scale),
    gap: Math.max(2, Math.round(EXPANDED_CARD.gap * scale)),
  };
}

/**
 * Rummy declines to lay out on a short viewport rather than growing a
 * second layout for it.
 *
 * The honest reason: this game has more chrome than any other here — a
 * hand strip, a header band above it, and a board sheet — and on a
 * landscape phone those three left the table 86px tall. A side-rail
 * variant was built and measured (86 → 223px, which does work) and then
 * scrapped: a second layout to maintain, for a way nobody wants to hold a
 * phone to play cards. `isShortViewport` is the whole gate.
 */
export function RotateNotice({ touch }: { touch: boolean }) {
  return (
    <div className="fixed inset-0 z-9500 flex items-center justify-center bg-felt-950/96 px-8 backdrop-blur-sm">
      <div className="flex max-w-xs flex-col items-center gap-4 text-center">
        <span aria-hidden className="text-4xl text-brass-300">
          {touch ? "↻" : "↕"}
        </span>
        <h2 className="font-display text-2xl font-extrabold text-bone-50">
          {touch ? "Rotate your device" : "Make the window taller"}
        </h2>
        <p className="text-xs leading-relaxed text-bone-400">
          Rummy needs the height: your hand, the board and the piles all have to
          be readable at once, and there is not enough room for them here. Your
          game is still running — nothing has been lost.
        </p>
      </div>
    </div>
  );
}

/* ============================================================
   Dev scenarios
   ============================================================ */

/**
 * Rigs for the two things in this game you otherwise have to wait for.
 *
 * Both are genuinely hard to reach on purpose. A claim window needs a bot
 * to discard into a live meld, which happens about once every twelve
 * rounds against `steady` (see `LAYOFF_ATTENTION`); a dead meld needs all
 * four of one rank to reach the board. Testing either by playing until it
 * happens is not a loop anyone can iterate in.
 *
 * These build the state directly rather than driving actions, because the
 * point is to land ON the interesting state, not to reproduce the path to
 * it. Every card is MOVED, never invented — `take` pulls it out of
 * whatever pile currently holds it, so the 52-card accounting the engine's
 * own sweep depends on still holds afterwards.
 */
export function rummyScenarios(live: Live) {
  const build = (pick: (s: RummyState) => RummyState) => () => {
    const next = pick(live.rawState);
    live.replaceState(next);
  };

  return [
    {
      label: "Rummy! window",
      run: build((state) => {
        const s = takeCards(state, ["S5", "S6", "S7", "S8"]);
        const meldId = s.nextMeldId;
        // A meld owned by seat 1 that S8 completes, and S8 sitting on top
        // of the discard as though seat 1 had just thrown it. The hero is
        // eligible (they are not the discarder), so this is exactly the
        // state `openClaimWindow` produces.
        return {
          ...s,
          turn: HERO,
          phase: "draw",
          mandatory: null,
          melds: [...s.melds, { id: meldId, owner: 1, cards: ["S5", "S6", "S7"], hitBy: {} }],
          nextMeldId: meldId + 1,
          discard: [...s.discard, "S8"],
          claimWindow: {
            discard: "S8",
            discarder: 1,
            meldId,
            // Every eligible seat, exactly as `openClaimWindow` builds
            // it — the hero included, since they are not the discarder.
            pending: claimReactions({ ...s, melds: [...s.melds] }, "S8", 1),
          },
        };
      }),
    },
    {
      label: "3 aces + 4th in a run",
      run: build((state) => {
        const s = takeCards(state, ["SA", "HA", "CA", "DA", "D2", "D3"]);
        const id = s.nextMeldId;
        // The reported edge case: three aces as a set, the fourth ace
        // committed to a run. The SET is closed — nothing can ever join
        // it — while the run is still live and takes a 4.
        return {
          ...s,
          turn: HERO,
          phase: "meld",
          mandatory: null,
          melds: [
            ...s.melds,
            { id, owner: HERO, cards: ["SA", "HA", "CA"], hitBy: {} },
            { id: id + 1, owner: 1, cards: ["DA", "D2", "D3"], hitBy: {} },
          ],
          nextMeldId: id + 2,
        };
      }),
    },
    {
      label: "Set of 3 + 4th in hand",
      run: build((state) => {
        const s = takeCards(state, ["S7", "H7", "D7", "C7"]);
        const meldId = s.nextMeldId;
        // Three sevens down and the fourth in your hand: lay it off and
        // watch the meld sit face up, then turn over.
        return {
          ...s,
          turn: HERO,
          phase: "meld",
          mandatory: null,
          hands: { ...s.hands, [HERO]: [...(s.hands[HERO] ?? []), "C7"] },
          melds: [...s.melds, { id: meldId, owner: HERO, cards: ["S7", "H7", "D7"], hitBy: {} }],
          nextMeldId: meldId + 1,
        };
      }),
    },
  ];
}

/**
 * Removes `cards` from wherever they currently are — any hand, the stock,
 * the discard, or an existing meld — so a scenario can place them
 * somewhere else without duplicating them.
 *
 * The 52-card invariant is not decoration: `startRound`'s sweep collects
 * every card by walking exactly these collections, so a duplicate would
 * survive into the next round's deck and the engine's own tests would
 * start failing on a state the dev panel created.
 */
function takeCards(state: RummyState, cards: readonly PieceId[]): RummyState {
  const drop = new Set(cards);
  const hands: RummyState["hands"] = {};
  for (const [seat, hand] of Object.entries(state.hands)) {
    hands[Number(seat)] = (hand ?? []).filter((id) => !drop.has(id));
  }
  return {
    ...state,
    hands,
    stock: state.stock.filter((id) => !drop.has(id)),
    discard: state.discard.filter((id) => !drop.has(id)),
    melds: state.melds
      .map((m) => ({
        ...m,
        cards: m.cards.filter((id) => !drop.has(id)),
        hitBy: Object.fromEntries(
          Object.entries(m.hitBy).filter(([id]) => !drop.has(id)),
        ) as typeof m.hitBy,
      }))
      // A meld stripped below three cards is no longer a meld.
      .filter((m) => m.cards.length >= MIN_MELD),
  };
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

export function RummyTable({
  live,
  view,
  picked,
  pickupDepth,
  clearSelection,
}: {
  live: Live;
  /** Who is looking, and what everybody at this table is called. */
  view: RummyView;
  /** The meld being built, and how deep a staged pickup reaches. Both
   *  come from `useRummySelection`, since `onPieceTap` is a GameHost
   *  prop and has to be built where the host is. */
  picked: PieceId[];
  pickupDepth: number | null;
  clearSelection: () => void;
}) {
  const state = live.state;
  const seat = mySeat(view);
  const [snap, setSnap] = useState(0);

  const [sortMode, setSortMode] = useState<HandSort>("smart");

  usePanWiring();
  useClearOnTurnEnd(live.isHeroTurn, clearSelection);
  useClaimCountdown(live, seat);
  useCloseSheetOnTurnEnd(live.isHeroTurn, setSnap);
  useHandSort(state.hands[seat] ?? [], sortMode);

  // Open to me specifically, not merely open. A window can be running for
  // three other seats while this viewer has no part in it — they
  // discarded the card, or cannot use it — and the bar must not appear
  // for a race they are not in.
  const claiming = inClaimRace(state, seat);
  // `isHeroTurn` compares against `currentSeat`, which during a claim
  // names only the seat the PACING waits on. Being entitled to claim is
  // its own answer and has to be ORed in, or a viewer further down the
  // queue watches the bar and cannot press it.
  const heroTurn = live.isHeroTurn || claiming;
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
      ? <ClaimBar live={live} seat={seat} />
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
        left={<HandStatus state={state} seat={seat} />}
        center={<TurnIndicator inline show={heroTurn} label={turnLabel(state, seat)} />}
        right={<SortMenu mode={sortMode} onMode={setSortMode} />}
      />

      <StockBadge state={state} />

      <PanSurfaces state={state} seat={seat} />
      <StagedRing state={state} depth={pickupDepth} />
      <BoardSheet
        view={view}
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
 * Which melds are currently drawn face DOWN.
 *
 * A meld goes dead the instant its fourth suit lands, but it must not
 * flip then — see `DEAD_MELD_FLIP_DELAY`. So deadness is a fact about
 * state and flippedness is a fact about elapsed time, and they are kept
 * as separate things rather than one derived from the other.
 *
 * Keyed on the set of dead meld ids as a string, so this settles exactly
 * when a meld actually completes rather than on every render. Ids that
 * disappear (the round-end sweep) drop out, which is what stops a fresh
 * meld inheriting the previous round's flip.
 */
function useFlippedMelds(melds: RummyState["melds"]): ReadonlySet<number> {
  const [flipped, setFlipped] = useState<ReadonlySet<number>>(new Set());
  // Against the WHOLE board, not each meld's own cards — a three-ace set
  // is dead the moment the fourth ace lands anywhere, including inside
  // somebody's run. See `isDeadMeld`.
  const laid = laidCards(melds);
  const deadKey = melds
    .filter((m) => isDeadMeld(m.cards, laid))
    .map((m) => m.id)
    .join(",");

  useEffect(() => {
    if (!deadKey) return;
    const pending = deadKey.split(",").map(Number);
    const t = setTimeout(
      () => setFlipped((prev) => new Set([...prev, ...pending])),
      DEAD_MELD_FLIP_DELAY,
    );
    return () => clearTimeout(t);
  }, [deadKey]);

  // Intersected at READ time rather than pruned by a second write. Ids
  // vanish when the round-end sweep clears the board, and a state update
  // in an effect just to forget them would be a cascading render for
  // something a filter answers for free — the difference matters because
  // this runs on a page that also animates a whole table.
  const alive = new Set(melds.map((m) => m.id));
  return new Set([...flipped].filter((id) => alive.has(id)));
}

/**
 * The claim window's reflex, for the seat this screen belongs to.
 *
 * Purely a client-side timer — the engine holds no wall-clock at all. If
 * this player does not answer in time, it submits `passClaim` for them
 * and they drop out of the race, which is the same thing that happens
 * when somebody else simply gets there first.
 *
 * Online this runs on every human's own machine, and that is fine
 * precisely because it is not authoritative: the server decides who
 * actually got the card, and a passed claim only ever removes the passer.
 * The worst a lagged timer can do is cost its own owner a card.
 */
function useClaimCountdown(live: Live, seat: SeatId) {
  const racing = inClaimRace(live.state, seat);
  const ms = claimDeadlineMs(live.state, seat);
  useEffect(() => {
    if (!racing) return;
    const t = setTimeout(() => live.submitAction({ t: "passClaim", seat }), ms);
    return () => clearTimeout(t);
    // `live` is rebuilt every render; keying on whether this seat is in
    // the race (and on its deadline) is what keeps this a single timer
    // per window rather than one restarted on every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [racing, ms, seat]);
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

function PanSurfaces({ state, seat }: { state: RummyState; seat: SeatId }) {
  const geometry = useGeometry();
  const discardScroll = useTableStore((s) => s.discardScroll);
  const handScroll = useTableStore((s) => s.handScroll);
  const setDiscardScroll = useSetDiscardScroll();
  const setHandScroll = useSetHandScroll();

  if (!geometry || discardScroll === null || handScroll === null) return null;

  const assembly = pileAssembly(geometry, state.discard.length);
  const handCount = (state.hands[seat] ?? []).length;

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

function turnLabel(state: RummyState, seat: SeatId): string {
  if (state.claimWindow) return "Claim it?";
  if (state.dealSizePending !== null) return "Your deal";
  // An out player is still in the round — they draw one each lap and
  // choose again. Naming that state stops it reading as a stuck turn.
  if ((state.hands[seat] ?? []).length === 0) return "You're out — draw one";
  if (state.phase === "draw") return "Draw — pile or stock";
  if (state.mandatory) return "Meld the card you took";
  return "Meld or discard";
}

/* ============================================================
   The band above the hand — ambient mode
   ============================================================ */

function HandStatus({ state, seat }: { state: RummyState; seat: SeatId }) {
  const held = handValue(state, seat);
  const board = contributedValue(state, seat);
  return (
    <HeroStatusBadge
      inline
      label="You"
      detail={`${state.scores[seat] ?? 0} · +${board} / −${held}`}
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

/**
 * The claim bar. ONE button and a clock.
 *
 * "Rummy!" rather than "Claim" because that is what you say at the table,
 * and the word is the whole reason the mechanic feels like anything.
 *
 * There is deliberately no Pass button, and the reason is that passing is
 * never right. Claiming costs literally nothing: `reduceClaim` moves the
 * card hand → board in one step, so no deadwood is added; the points land
 * in the claimer's `contributedValue`; and `advanceTurn` resumes from the
 * DISCARDER's seat, so it does not spend your own turn either. A button
 * whose only function is to decline free points is not a choice, it is a
 * trap — and offering it implies a cost the rules do not have.
 *
 * Declining is still expressible, because it has to be: letting the ring
 * run out submits `passClaim` (see `useClaimCountdown`), which is also
 * what happens when a bot simply gets there first. The engine keeps the
 * action; the screen just stops advertising it.
 */
function ClaimBar({ live, seat }: { live: Live; seat: SeatId }) {
  const window_ = live.state.claimWindow!;
  const ms = claimDeadlineMs(live.state, seat);
  return (
    <>
      <span className="min-w-0 shrink truncate text-[10px] font-bold text-brass-300">
        {window_.discard} fits a meld
      </span>
      {/* The ring lives in `CountdownButton` now — BS races after every
          single play, and a second copy of this would have become a second
          opinion about how a losable chance should read. */}
      <CountdownButton
        key={window_.discard}
        ms={ms}
        onClick={() => live.submitAction({ t: "claim", seat })}
      >
        Rummy!
      </CountdownButton>
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
  view,
  live,
  picked,
  snap,
  onSnap,
  onExtended,
}: {
  view: RummyView;
  live: Live;
  picked: PieceId[];
  snap: number;
  onSnap: (n: number) => void;
  onExtended: () => void;
}) {
  const geometry = useGeometry();
  const state = live.state;
  const [rejected, setRejected] = useState<number | null>(null);
  const flipped = useFlippedMelds(state.melds);
  const dealing = live.dealingRound !== null;
  if (!geometry) return null;

  const handH = geometry.zones.hand.h;
  const headerH = handHeaderHeight(geometry.box.h);
  // BOTH numbers come from the identical set of reserved terms. If the
  // tallest snap failed to subtract a band that `offsetBottom` adds, the
  // rail would overshoot the far edge and take its own grab handle with
  // it — the "can't close it" bug. Applies to either edge: a side rail
  // still stops above the hand.
  const offsetBottom = handH + headerH;
  // The RESTING extent is what geometry actually GRANTED, not what this
  // page asked for. A short phone cannot always give up the full band,
  // and assuming it did is how a rail ends up resting on top of the seat
  // pods on exactly one device — see `TableGeometry.reserved`.
  const available = Math.max(48, geometry.box.h - offsetBottom - 12);
  const peek = Math.max(
    72,
    Math.min(available, geometry.reserved.bottom - headerH || SHEET_PEEK_H),
  );
  // TWO stops only: resting and fully open. A middle stop earns its
  // place when the content is long enough that a half view is a
  // different task from a full one; here it just gives a drag somewhere
  // ambiguous to land, and every gesture needs a second nudge to reach
  // what it was actually going for.
  const snapPoints = [peek, Math.max(peek, available)];
  // What the panel's own content box is actually offered, once the grab
  // handle and padding are paid for. Drives the meld card size, so cards
  // fit the rail rather than the rail clipping the cards.
  const contentW = Math.max(96, geometry.zones.hand.w - 28);

  // Any selection at all means a lay-off is POSSIBLE to attempt. Which
  // melds it actually fits is deliberately not shown — the board is
  // there to be read. Tapping a meld attempts it; the engine is the only
  // thing that decides, and it says so after the attempt, never before.
  const canAttempt = picked.length >= 1 && !state.mandatory && state.phase === "meld";
  const byOwner = groupByOwner(view, state, flipped);

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
          view={view}
          groups={byOwner}
          collapsed={snap === 0}
          meldCount={state.melds.length}
          availableW={contentW}
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
  /** All four of the rank are down and the meld has now turned over. */
  dead: boolean;
  /**
   * Dead, but still face up — the beat between the fourth card landing
   * and the meld turning over.
   *
   * A third state rather than a second flag on `dead`, because it is the
   * only moment the player can still READ what just completed. Turning
   * the cards over is the meld saying "finished with"; this is it saying
   * "look at this first".
   */
  closing: boolean;
}

interface OwnerGroup {
  seat: SeatId;
  name: string;
  colour: string;
  melds: SheetMeld[];
}

function groupByOwner(view: RummyView, state: RummyState, flipped: ReadonlySet<number>): OwnerGroup[] {
  const map = new Map<SeatId, OwnerGroup>();
  const laid = laidCards(state.melds);
  for (const meld of state.melds) {
    let g = map.get(meld.owner);
    if (!g) {
      g = {
        seat: meld.owner,
        name: view.nameFor(meld.owner),
        colour: view.colourFor(meld.owner),
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
      // Dead is a fact about the cards; FLIPPED is a fact about how long
      // they have been that way. Only the second one turns a card over;
      // the gap between them is the ring.
      dead: flipped.has(meld.id),
      closing: isDeadMeld(meld.cards, laid) && !flipped.has(meld.id),
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
  view,
  card,
  w,
  h,
  owner,
  dead,
}: {
  view: RummyView;
  card: SheetCard;
  w: number;
  h: number;
  /** The meld's owner — the chip is shown only when they disagree. */
  owner: SeatId;
  /** The whole meld is closed and gets turned over. */
  dead?: boolean;
}) {
  // Tagging every card in a player's own meld with that same player's
  // initials repeats what the group heading already said, on every
  // card. The chip is worth its space only where it CONTRADICTS the
  // grouping — a card someone else hit onto this meld, which is the one
  // thing the heading cannot tell you.
  //
  // A dead meld keeps its chips: whose cards they were still decides
  // whose score they land in, and that is exactly the fact the flipped
  // face would otherwise take away.
  const foreign = card.contributor !== owner;
  return (
    <span className="relative block shrink-0">
      <FlipFace card={card.id} w={w} h={h} down={Boolean(dead)} />
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
            background: view.colourFor(card.contributor),
            fontSize: Math.max(6, Math.round(w * 0.24)),
            lineHeight: 1.35,
            boxShadow: "0 1px 2px rgb(0 0 0 / 0.4)",
          }}
        >
          {tagFor(view, card.contributor)}
        </span>
      ) : null}
    </span>
  );
}

/**
 * One ring around a meld that has just closed, for the beat before it
 * turns over.
 *
 * ONE ring around the whole run, not one per card — the same reasoning as
 * `StagedRing`: the thing being outlined is the meld, and four separate
 * outlines would read as four things rather than one finished set.
 *
 * It exists to buy the player a look. All four of a rank going down is
 * the one board event that destroys information — a second later those
 * cards are face down and there is no way to ask what they were. The
 * pulse is quick and shallow on purpose: enough to pull the eye to the
 * sheet, not so much that it competes with whatever else is moving.
 *
 * Exits by fading and expanding slightly, so it reads as releasing the
 * meld rather than snapping off it — and it leaves exactly as the flip
 * starts, which makes the two one gesture.
 */
function ClosingRing() {
  return (
    <motion.span
      aria-hidden
      className="pointer-events-none absolute rounded-xl"
      style={{
        inset: -4,
        border: "2px solid var(--color-closed)",
        boxShadow: "0 0 14px 1px rgb(121 198 242 / 0.45)",
      }}
      initial={{ opacity: 0, scale: 0.985 }}
      animate={{ opacity: [0.45, 1, 0.45], scale: [1, 1.012, 1] }}
      // The exit carries its OWN transition, and it has to. A component's
      // `transition` prop applies to every state INCLUDING exit, so the
      // repeating pulse above was being used to animate the exit too —
      // a `repeat: Infinity` exit never completes, `AnimatePresence` never
      // unmounts the element, and the ring pulsed on forever behind cards
      // that had already turned over.
      exit={{
        opacity: 0,
        scale: 1.05,
        transition: { duration: 0.26, ease: "easeOut" },
      }}
      transition={{
        opacity: { duration: 0.52, repeat: Infinity, ease: "easeInOut" },
        scale: { duration: 0.52, repeat: Infinity, ease: "easeInOut" },
      }}
    />
  );
}

/**
 * A card that can turn over in place.
 *
 * A real 3D flip rather than a crossfade: the meld closing is a physical
 * gesture at a table and reads as one. `rotateY` is a transform, so this
 * stays on the compositor like everything else that moves here
 * (CLAUDE.md) — the two faces are stacked with `backfaceVisibility:
 * hidden` and the container turns, which is the one way to do this
 * without animating anything the browser has to lay out.
 */
function FlipFace({
  card,
  w,
  h,
  down,
}: {
  card: PieceId;
  w: number;
  h: number;
  down: boolean;
}) {
  return (
    // `block`, not `inline-block`. An inline-block sits on the text
    // baseline, so the line box reserves descender space UNDER it — which
    // made the row a few px taller than the cards and put visibly more
    // felt below the closing ring than above it.
    <span className="relative block" style={{ width: w, height: h, perspective: 520 }}>
      <motion.span
        className="absolute inset-0"
        style={{ transformStyle: "preserve-3d" }}
        initial={false}
        animate={{ rotateY: down ? 180 : 0 }}
        transition={{ duration: DEAD_MELD_FLIP_MS, ease: [0.34, 0.9, 0.3, 1] }}
      >
        <span className="absolute inset-0" style={{ backfaceVisibility: "hidden" }}>
          <CardFace card={card} w={w} h={h} detail="index" />
        </span>
        <span
          className="absolute inset-0"
          style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
        >
          <CardBack w={w} h={h} />
        </span>
      </motion.span>
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
  view,
  groups,
  collapsed,
  meldCount,
  availableW,
  onMeldTap,
  rejected,
}: {
  view: RummyView;
  groups: OwnerGroup[];
  collapsed: boolean;
  meldCount: number;
  /** Content width the panel currently offers, in px. */
  availableW: number;
  /** Present only while a lay-off is possible to ATTEMPT. */
  onMeldTap?: (meldId: number) => void;
  rejected: number | null;
}) {
  const { w, h, gap } = collapsed ? PEEK_CARD : expandedCardSize(meldCount, availableW);

  const melds = (group: OwnerGroup) =>
    group.melds.map((m) => (
      <MeldRow
        key={m.id}
        view={view}
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
        // The padding is not decoration: the owner chips sit slightly
        // proud of their cards and `ClosingRing` sits proud of all four,
        // and an `overflow-x` container clips the other axis too (per the
        // CSS Overflow spec, one axis set to a non-visible value promotes
        // the other) — without room to spare, both get sliced.
        className="flex items-start overflow-x-auto px-1.5 pt-2 pb-2"
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
              rather than floating in the middle of the tallest one, and
              `overflow-x-auto` because the card size above only
              guarantees the SHORTEST legal meld fits — a seven-card run
              in a side rail has to be reachable, not clipped. */}
          <div
            className="flex flex-wrap items-start overflow-x-auto p-1.5"
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
  view,
  meld,
  w,
  h,
  gap,
  onTap,
  rejected,
}: {
  view: RummyView;
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
      className={`relative flex shrink-0 flex-nowrap items-start rounded-md ${
        interactive ? "cursor-pointer" : ""
      } ${rejected ? "ring-1 ring-red-400/70" : ""}`}
      style={{ gap }}
    >
      <AnimatePresence>{meld.closing ? <ClosingRing /> : null}</AnimatePresence>
      {meld.cards.map((c) => (
        <SheetCardFace
          key={c.id}
          view={view}
          card={c}
          w={w}
          h={h}
          owner={meld.owner}
          dead={meld.dead}
        />
      ))}
    </motion.div>
  );
}

/* ============================================================
   Selection — the half of a turn that has not happened yet
   ============================================================ */

/**
 * The staged meld and the staged pickup, plus the tap handler that builds
 * them.
 *
 * Lifted out of the play page when Rummy went online, because all of it
 * is table behaviour rather than page behaviour and the online table
 * needs every bit of it. The one thing that changed on the way is the
 * seat: "my hand" was `HERO`, and is now whoever is looking.
 *
 * Both values live here rather than in engine state because neither has
 * happened yet, and "nothing has happened yet" is exactly what lets
 * Cancel genuinely mean it.
 */
export function useRummySelection(view: RummyView) {
  const seat = mySeat(view);
  const [picked, setPicked] = useState<PieceId[]>([]);
  const [pickupDepth, setPickupDepth] = useState<number | null>(null);

  const clearSelection = useCallback(() => {
    paintSelection([], []);
    setPicked([]);
    setPickupDepth(null);
  }, []);

  const onPieceTap = (id: PieceId, live: Live) => {
    const state = live.state;
    // A claim race is the one time this seat may act without being the
    // seat on turn, and no tap on the felt means anything during one.
    if (!live.isHeroTurn || inClaimRace(state, seat)) return;
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

    // ---- your own hand, wherever you are sitting
    if (placement.zone === "hand" && placement.seat === seat) {
      const next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
      setPicked(next);
      paintSelection(staged, next);
    }
  };

  return { picked, pickupDepth, clearSelection, onPieceTap };
}

/* ============================================================
   GameHost slots
   ============================================================ */

export function playerViews(view: RummyView, seats: number) {
  return (state: RummyState, live: Live): SeatView[] => {
    const views: SeatView[] = [];
    // Every seat but the viewer's own. A spectator has no seat, so
    // `mySeat` is -1 and every chair at the table gets a pod — which is
    // right: they are watching all of them.
    for (let s = 0; s < seats; s++) {
      if (s === view.viewerSeat) continue;
      const cue = seatCue(live, s);
      views.push({
        seat: s,
        name: view.nameFor(s),
        colour: view.colourFor(s),
        meta: `${(state.hands[s] ?? []).length} cards · ${state.scores[s] ?? 0}`,
        active: cue.active,
        thinking: cue.thinking,
        away: view.awayFor?.(s) ?? false,
      });
    }
    return views;
  };
}

export function standings(view: RummyView, seats: number) {
  return (state: RummyState) =>
    Array.from({ length: seats }, (_, s) => ({
      seat: s,
      name: view.nameFor(s),
      total: state.scores[s] ?? 0,
    })).sort((a, b) => b.total - a.total);
}

export function statsFor(state: RummyState) {
  return [
    { label: "Round", value: String(state.round) },
    { label: "Melds down", value: String(state.melds.length) },
    { label: "Dealt", value: `${state.dealSize} cards` },
  ];
}

export function roundSummary(view: RummyView, seats: number) {
  return (state: RummyState): { title: string; rows: ScoreRow[]; note?: RoundNote } | null => {
    const result = state.result;
    if (!result) return null;

    const rows: ScoreRow[] = Array.from({ length: seats }, (_, s) => ({
      seat: s,
      name: view.nameFor(s),
      colour: view.colourFor(s),
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
        result.wentOut === null
          ? "Round complete"
          : result.wentOut === view.viewerSeat
            ? "You went out"
            : `${view.nameFor(result.wentOut)} went out`,
      rows,
      note,
    };
  };
}

export function pendingLabel(view: RummyView) {
  return (state: RummyState, seat: SeatId): string => {
    const what =
      state.claimWindow !== null
        ? "racing for the discard"
        : state.dealSizePending !== null
          ? "dealing"
          : state.phase === "draw"
            ? "drawing"
            : "melding";
    return `${view.nameFor(seat)} pending — ${what}`;
  };
}

/* ============================================================
   Setup
   ============================================================ */

