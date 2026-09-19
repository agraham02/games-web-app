"use client";

/**
 * Dominoes' table content, shared by the offline page and by an online
 * room. Same split as Spades' and Poker's, for the same reason: none of it
 * is about being offline, and the only thing that differs is who is
 * looking.
 *
 * The dev scenario rig stays behind in the page. It reaches into state to
 * manufacture positions a real game would take minutes to reach, which is
 * a single-player debugging affordance and has no business in a room.
 */

import { useEffect, useMemo } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { PieceId, SeatId } from "@/engine/types";
import { botColour, botName } from "@/games/_shared/botIdentity";
import { partnerOf, teammates } from "@/games/_shared/partnership";
import { openEndAnchor, placeTile } from "@/games/dominoes/board";
import {
  canPlay,
  drawableTiles,
  openEnds,
  pipsInHand,
  playableEnds,
} from "@/games/dominoes/state";
import type { ChainEnd, DomAction, DomState } from "@/games/dominoes/types";
import { boardCamera, boardPieceSize, projectCell } from "@/table/layout";
import { TRANSITIONS } from "@/motion/presets";
import { TileFace } from "@/ui/primitives/TileFace";
import { HandZone } from "@/table/HandZone";
import type { RoundNote } from "@/table/GameHost";
import type { SeatView } from "@/table/SeatRing";
import { seatCue } from "@/table/turnCue";
import { useBoardView, useGeometry, useTableStore } from "@/table/store";
import { TurnIndicator, type ScoreRow } from "@/ui/phases/PhaseScreens";
import type { GameRuntime } from "@/table/useGameRuntime";

type Live = GameRuntime<DomState, DomAction>;

/** Who is looking at this table, and what everyone is called. */
export interface DomView {
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
export const OFFLINE_VIEW: DomView = {
  viewerSeat: 0,
  nameFor: botName,
  colourFor: botColour,
};


/**
 * What tapping one of your own tiles means.
 *
 * Shared by both screens, and it had to be: it is a RULES question — how
 * many ends will this tile legally go on — and the two screens answered it
 * differently. Offline, one legal end played immediately; online, every
 * tap put up ghosts and asked you to confirm a choice that did not exist.
 * A tile that can only go in one place is not a decision, and being asked
 * to make it is the game getting in the way.
 *
 * The three callbacks are all the two screens genuinely differ by: offline
 * holds the tile in the page's own state and lifts it in the piece store,
 * online holds it in `RoomScreen` so it survives a trip out to the lobby.
 * Neither difference is about the rule, which is why the rule is here.
 */
export function tapTile(
  id: PieceId,
  live: Live,
  held: PieceId | null,
  on: {
    /** Pick it up: two or more ends, so the player has to choose one. */
    select: (tile: PieceId) => void;
    /** Put down whatever is currently held. */
    release: () => void;
    play: (tile: PieceId, end: ChainEnd) => void;
  },
): void {
  if (!live.isHeroTurn) return;
  const ends = playableEnds(live.state, id);
  if (ends.length === 0) return;
  // Tapping the held tile again puts it back down.
  if (held === id) {
    on.release();
    return;
  }
  if (held) on.release();
  // One legal end is not a choice, so do not make the player confirm it.
  // Two ends is a real decision and gets two ghosts to pick between.
  if (ends.length === 1) {
    on.play(id, ends[0]!);
    return;
  }
  on.select(id);
}

/* ============================================================
   Table overlays
   ============================================================ */

export function DominoTable({
  view,
  live,
  held,
  onPlace,
  onRelease,
}: {
  view: DomView;
  live: Live;
  held: PieceId | null;
  onPlace: (live: Live, tile: PieceId, end: ChainEnd) => void;
  onRelease: () => void;
}) {
  const state = live.state;
  const playable = live.isHeroTurn && canPlay(state, view.viewerSeat);
  const canDraw = live.isHeroTurn && !playable && drawableTiles(state) > 0;
  const mustPass = live.isHeroTurn && !playable && drawableTiles(state) === 0;

  // A held tile that survives into someone else's turn would leave two
  // ghosts sitting on a board that is moving underneath them.
  useEffect(() => {
    if (!live.isHeroTurn && held) onRelease();
  }, [live.isHeroTurn, held, onRelease]);

  const label = held
    ? "Tap where it goes"
    : playable
      ? "Your turn — tap a tile"
      : canDraw
        ? "Nothing to play — draw"
        : mustPass
          ? "Nothing to play — pass"
          : "";

  return (
    <>
      <OpenEndBadges state={state} dimmed={held !== null} />
      <GhostTiles live={live} held={held} onPlace={onPlace} />
      <BoneyardCount view={view} state={state} />

      <HandZone
        center={<TurnIndicator inline label={label} show={live.isHeroTurn && label !== ""} />}
      />

      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 z-1800 flex items-end justify-center gap-2 pb-3"
        style={{ height: 56 }}
      >
        <AnimatePresence>
          {canDraw ? (
            <ActionButton key="draw" onClick={() => live.submitAction({ t: "draw" })}>
              Draw
            </ActionButton>
          ) : null}
          {mustPass ? (
            <ActionButton key="pass" onClick={() => live.submitAction({ t: "pass" })}>
              Pass
            </ActionButton>
          ) : null}
          {held ? (
            <ActionButton key="cancel" onClick={onRelease} tone="quiet">
              Cancel
            </ActionButton>
          ) : null}
        </AnimatePresence>
      </div>
    </>
  );
}

function ActionButton({
  onClick,
  tone = "primary",
  children,
}: {
  onClick: () => void;
  tone?: "primary" | "quiet";
  children: React.ReactNode;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      transition={TRANSITIONS.ui}
      className={
        tone === "primary"
          ? "pointer-events-auto rounded-full bg-linear-to-b from-brass-300 to-brass-500 px-7 py-2.5 text-sm font-extrabold text-felt-950 shadow-e2"
          : "pointer-events-auto rounded-full bg-bone-50/8 px-5 py-2.5 text-sm font-semibold text-bone-200 ring-1 ring-bone-50/18"
      }
    >
      {children}
    </motion.button>
  );
}

/**
 * The held tile, drawn at every end it can legally go, exactly where it
 * will land. Positioned through the same camera as the real pieces, so a
 * ghost and its tile occupy the same pixels.
 */
function GhostTiles({
  live,
  held,
  onPlace,
}: {
  live: Live;
  held: PieceId | null;
  onPlace: (live: Live, tile: PieceId, end: ChainEnd) => void;
}) {
  const geometry = useGeometry();
  const board = useBoardView(true);
  const setGhosts = useTableStore((s) => s.setGhosts);
  const state = live.state;

  const ghosts = useMemo(() => {
    if (!held) return [];
    return playableEnds(state, held).map((end) => ({
      end,
      tile: placeTile(state.chain, state.arms[end], end, held).tile,
    }));
    // `state` is republished only between turns, so this is stable for
    // the whole time a tile is held.
  }, [held, state]);

  // Feeding the ghosts to the store folds them into the camera's extent,
  // so picking a tile up eases the view out just far enough to show
  // where it would go — and the real tile then lands on its own ghost
  // instead of shunting the board a second time.
  useEffect(() => {
    setGhosts(ghosts.map((g) => ({ x: g.tile.x, y: g.tile.y, rot: g.tile.rot })));
    return () => setGhosts([]);
  }, [ghosts, setGhosts]);

  if (!geometry || !held) return null;
  const cam = boardCamera(geometry, board);
  const size = boardPieceSize(cam);

  return (
    <div className="pointer-events-none absolute inset-0 z-700">
      {ghosts.map(({ end, tile }) => {
        const { cx, cy, rotate } = projectCell(
          { x: tile.x, y: tile.y, rot: tile.rot },
          cam,
        );
        return (
          <motion.button
            key={end}
            type="button"
            onClick={() => onPlace(live, held, end)}
            aria-label={`Play ${held} on the ${end} end`}
            className="pointer-events-auto absolute"
            style={{
              left: cx,
              top: cy,
              width: size.short,
              height: size.long,
              marginLeft: -size.short / 2,
              marginTop: -size.long / 2,
            }}
            initial={{ opacity: 0, scale: 0.86 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.86 }}
            transition={TRANSITIONS.ui}
          >
            <motion.div
              style={{ rotate, transformOrigin: "center center" }}
              animate={{ opacity: [0.55, 0.9, 0.55] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
            >
              <div className="relative">
                <TileFace tile={held} w={size.short} h={size.long} ariaHidden />
                <span
                  aria-hidden
                  className="absolute inset-0 rounded-[12%] border-2 border-dashed border-brass-300"
                  style={{ boxShadow: "var(--shadow-glow)" }}
                />
              </div>
            </motion.div>
          </motion.button>
        );
      })}
    </div>
  );
}

/** "This end wants a 4." Hidden while ghosts are showing — by then the
 * question has already been answered more precisely. */
function OpenEndBadges({ state, dimmed }: { state: DomState; dimmed: boolean }) {
  const geometry = useGeometry();
  const board = useBoardView(true);
  if (!geometry || state.chain.length === 0) return null;

  const cam = boardCamera(geometry, board);
  const ends = openEnds(state);
  const size = Math.max(16, Math.min(26, cam.unit * 0.62));

  return (
    <div className="pointer-events-none absolute inset-0 z-700">
      <AnimatePresence>
        {dimmed
          ? null
          : (["left", "right"] as ChainEnd[]).map((end) => {
              const anchor = openEndAnchor(state.chain, state.arms[end], end);
              const pip = ends[end];
              if (!anchor || pip === null) return null;
              const { cx, cy } = projectCell({ ...anchor, rot: 0 }, cam);
              return (
                <motion.span
                  key={end}
                  className="absolute flex items-center justify-center rounded-full bg-felt-950/85 font-bold text-brass-300 ring-1 ring-brass-400/70 backdrop-blur-sm"
                  style={{
                    left: cx,
                    top: cy,
                    width: size,
                    height: size,
                    marginLeft: -size / 2,
                    marginTop: -size / 2,
                    fontSize: size * 0.52,
                  }}
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={TRANSITIONS.ui}
                >
                  {pip}
                </motion.span>
              );
            })}
      </AnimatePresence>
    </div>
  );
}

/**
 * How deep the boneyard still is, and how heavy your own hand is. A
 * stack of identical backs can say neither, and both are numbers a
 * domino player keeps in their head all game — how much is left to draw,
 * and how much a blocked round would cost them.
 */
function BoneyardCount({ view, state }: { view: DomView; state: DomState }) {
  const geometry = useGeometry();
  if (!geometry) return null;
  const zone = geometry.zones.boneyard;
  const left = drawableTiles(state);
  // Caribbean has no boneyard at all, so there is nothing to report on
  // it — "boneyard dry" would describe a pile that never existed. Own
  // pip weight still matters (it decides a blocked round), so that line
  // stays and simply moves up into the slot.
  const caribbean = state.rules.mode === "caribbean";

  return (
    <div
      className="pointer-events-none absolute z-1900 flex flex-col items-center gap-0.5 text-center text-[10px] leading-tight"
      style={{ left: zone.x - 8, top: zone.y + zone.h + 4, width: zone.w + 16 }}
    >
      {caribbean ? null : (
        <span className="font-semibold text-bone-400">
          {left > 0 ? `${left} to draw` : "boneyard dry"}
        </span>
      )}
      <span className="tnum font-bold text-brass-400">
        {pipsInHand(state, view.viewerSeat)} pips
      </span>
    </div>
  );
}

/* ============================================================
   GameHost slots
   ============================================================ */

export function playerViews(view: DomView, state: DomState, live: Live): SeatView[] {
  const out: SeatView[] = [];
  const hero = state.rules.teams ? partnerOf(view.viewerSeat) : null;
  // Every seat but the VIEWER's own. This counted from 1 for a long time,
  // which is the same thing exactly as long as the viewer is seat 0 —
  // and online they are not. A player at seat 1 got no pod for seat 0
  // (the party leader simply had no nameplate) and a redundant one for
  // themselves.
  for (let seat = 0; seat < state.seats; seat++) {
    if (seat === view.viewerSeat) continue;
    const tiles = state.hands[seat]?.length ?? 0;
    // "Who just moved" and "who are we waiting on" — see `seatCue`. The
    // second used to have no answer, so a human's pod only lit once they
    // acted, a whole turn late.
    const cue = seatCue(live, seat);
    const isPartner = seat === hero;
    out.push({
      seat,
      name: view.nameFor(seat),
      // Your partner takes your own accent, so which two pods are on
      // your side reads at a glance rather than from the score line.
      colour: isPartner ? "var(--color-brass-300)" : view.colourFor(seat),
      meta: `${tiles} tile${tiles === 1 ? "" : "s"} · ${state.scores[seat] ?? 0}`,
      // Renders a "Partner" line on the pod — already built for Spades,
      // and the hero's own pod is filtered out of the ring, so this only
      // ever answers "is THIS pod on my side".
      partner: isPartner || undefined,
      active: cue.active,
      thinking: cue.thinking,
      away: view.awayFor?.(seat) ?? false,
    });
  }
  return out;
}

export function standings(view: DomView, state: DomState, _live: Live, seats: SeatView[]) {
  const name = (seat: number) => (seat === view.viewerSeat ? "You" : view.nameFor(seat));
  // In team mode the four scores are two numbers written twice (they
  // mirror within a side), so listing four rows would show every total
  // duplicated. One row per side instead.
  if (state.rules.teams) {
    return ([0, 1] as const)
      .map((team) => {
        const [a, b] = teammates(team);
        return {
          seat: a,
          name: `${name(a)} & ${name(b)}`,
          total: state.scores[a] ?? 0,
        };
      })
      .sort((x, y) => y.total - x.total);
  }
  return [
    { seat: view.viewerSeat, name: "You", total: state.scores[view.viewerSeat] ?? 0 },
    ...seats.map((s) => ({
      seat: s.seat,
      name: s.name,
      total: state.scores[s.seat] ?? 0,
    })),
  ].sort((a, b) => b.total - a.total);
}

export function roundSummary(view: DomView, state: DomState) {
  const result = state.result;
  if (!result) return null;

  const name = (seat: number) => (seat === view.viewerSeat ? "You" : view.nameFor(seat));
  const won = new Set(result.winningSeats ?? []);
  const rows: ScoreRow[] = [];
  for (let seat = 0; seat < state.seats; seat++) {
    const pips = result.pips[seat] ?? 0;
    rows.push({
      seat,
      name: name(seat),
      colour: seat === view.viewerSeat ? "var(--color-brass-300)" : view.colourFor(seat),
      detail: pips === 0 ? "went out" : `${pips} pips left`,
      // Every seat on the winning SIDE shows the gain — in team mode the
      // partner who was still holding tiles scored just as much as the
      // one who laid the last.
      delta: won.has(seat) ? result.points : 0,
      total: state.scores[seat] ?? 0,
    });
  }
  rows.sort((a, b) => b.total - a.total);

  const note = roundNote(view, state, result, name);

  const title =
    result.winner === null
      ? "No score"
      : result.kind === "domino"
        ? result.bonus
          ? `${name(result.winner)} finish${result.winner === view.viewerSeat ? "" : "es"} on the key tile`
          : `${name(result.winner)} ${result.winner === view.viewerSeat ? "go" : "goes"} out`
        : `${name(result.winner)} ${result.winner === view.viewerSeat ? "win" : "wins"} it`;

  return { title, rows, note };
}

function roundNote(
  view: DomView,
  state: DomState,
  result: NonNullable<DomState["result"]>,
  name: (seat: number) => string,
): RoundNote | undefined {
  if (result.bonus) {
    return {
      tone: "info",
      title: "Key tile",
      body: "That was the only tile left that could legally have gone down, so the round is worth two games.",
    };
  }
  if (result.kind !== "blocked") return undefined;

  const caribbean = state.rules.mode === "caribbean";
  if (result.winner === null) {
    return {
      tone: "warn",
      title: "Blocked",
      body: caribbean
        ? "Nobody could play and the lowest count was tied, so nobody scores — the double six opens the redeal."
        : "Nobody could play and the lowest count was tied, so nobody scores.",
    };
  }
  return {
    tone: "warn",
    title: "Blocked",
    body: `Nobody could play. Lowest count takes the round: ${name(result.winner)} on ${result.pips[result.winner] ?? 0} pips.`,
  };
}

export function pendingLabel(view: DomView, state: DomState, seat: number): string {
  const tiles = state.hands[seat]?.length ?? 0;
  return `${view.nameFor(seat)} pending — ${tiles} tile${tiles === 1 ? "" : "s"}`;
}

/**
 * Dev-only one-shot rigs, for the states you would otherwise have to
 * wait for. A slam is a ~12% roll per play; the going-out slam needs a
 * hand down to its last tile. Neither is something to sit and hope for
 * while checking whether the animation reads right.
 *
 * Both work WITH the deterministic roll rather than around it — nothing
 * here sets a "force the next slam" flag, because a flag would be a
 * second code path that could drift from the real one. See
 * [[dev-tooling-thin-pacing-toggle]]'s rule: dev tooling gates timing,
 * never behaviour.
 */
