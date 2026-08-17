"use client";

/**
 * Dominoes (Block & Draw) — the play screen.
 *
 * The genuinely game-specific parts are the three affordances that make
 * a domino line playable rather than merely visible:
 *
 *  - **ghost tiles.** Picking a tile up shows it, at real size and real
 *    orientation, at every end it could legally go — positioned by the
 *    same `placeTile` the engine will use, so the ghost is exactly, not
 *    approximately, where the tile lands. They are also the tap target,
 *    so choosing an end is choosing the thing you can already see.
 *  - **open-end badges.** A small brass marker past each live end
 *    showing the pip it wants. Once the chain has snaked into two or
 *    three rows, "which ends are open" stops being obvious, and that is
 *    the one question you need answered on every turn.
 *  - **Draw / Pass**, shown only when they are legal, so the buttons
 *    themselves tell you that you are stuck.
 *
 * Everything else — seat ring, toasts, scorecard, match summary, dev
 * panel — comes from GameHost unchanged.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { HERO, type BotDifficulty, type PieceId } from "@/engine/types";
import { DifficultyPicker, botTable } from "@/ui/primitives/DifficultyPicker";
import { SetupShell } from "@/ui/primitives/SetupShell";
import { GameHost, type RoundNote } from "@/table/GameHost";
import type { GameRuntime } from "@/table/useGameRuntime";
import type { SeatView } from "@/table/SeatRing";
import {
  boardCamera,
  boardPieceSize,
  projectCell,
} from "@/table/layout";
import { useBoardView, useGeometry, useTableStore } from "@/table/store";
import { TurnIndicator } from "@/ui/phases/PhaseScreens";
import { HandZone } from "@/table/HandZone";
import type { ScoreRow } from "@/ui/phases/PhaseScreens";
import { TileFace } from "@/ui/primitives/TileFace";
import { botColour, botName } from "@/games/_shared/botIdentity";
import { openEndAnchor, placeTile } from "@/games/dominoes/board";
import { createDominoes, MAX_SEATS, MIN_SEATS } from "@/games/dominoes/rules";
import {
  canPlay,
  drawableTiles,
  openEnds,
  pipsInHand,
  playableEnds,
} from "@/games/dominoes/state";
import type { ChainEnd, DomAction, DomState } from "@/games/dominoes/types";
import { TRANSITIONS } from "@/motion/presets";

type Live = GameRuntime<DomState, DomAction>;

const TARGETS = [61, 100, 150];

export default function DominoesPlayPage() {
  const [seats, setSeats] = useState(3);
  const [target, setTarget] = useState(100);
  const [difficulty, setDifficulty] = useState<BotDifficulty>("steady");
  const [started, setStarted] = useState(false);
  const [gameKey, setGameKey] = useState(0);
  /** The tile the hero has picked up, if any. Lives here rather than in
   * the controls because the piece-tap handler and the ghost layer are
   * on opposite sides of GameHost. */
  const [held, setHeld] = useState<PieceId | null>(null);

  const definition = useMemo(() => createDominoes(target), [target]);

  const release = () => {
    const store = useTableStore.getState();
    if (held) store.patch(held, { selected: false });
    store.setGhosts([]);
    setHeld(null);
  };

  const play = (live: Live, tile: PieceId, end: ChainEnd) => {
    release();
    live.submitAction({ t: "play", tile, end });
  };

  /** Only the hero's own hand tiles are ever tappable — see PieceLayer. */
  const onPieceTap = (id: PieceId, live: Live) => {
    if (!live.isHeroTurn) return;
    const ends = playableEnds(live.state, id);
    if (ends.length === 0) return;
    if (held === id) {
      release();
      return;
    }
    if (held) release();
    // One legal end is not a choice, so do not make the player confirm
    // it. Two ends is a real decision and gets two ghosts.
    if (ends.length === 1) {
      play(live, id, ends[0]!);
      return;
    }
    useTableStore.getState().patch(id, { selected: true });
    setHeld(id);
  };

  if (!started) {
    return (
      <SetupScreen
        difficulty={difficulty}
        onDifficultyChange={setDifficulty}
        seats={seats}
        target={target}
        onSeatsChange={setSeats}
        onTargetChange={setTarget}
        onStart={() => setStarted(true)}
      />
    );
  }

  return (
    <GameHost<DomState, DomAction>
      key={gameKey}
      definition={definition}
      runtime={{ seats, difficulty: botTable(seats, difficulty) }}
      gameTitle="Dominoes"
      players={playerViews}
      standings={standings}
      stats={(state) => [
        { label: "Round", value: `${state.round}` },
        { label: "Target", value: `${state.target}` },
      ]}
      roundSummary={roundSummary}
      pendingLabel={pendingLabel}
      onPieceTap={onPieceTap}
      onRematch={() => {
        release();
        setGameKey((k) => k + 1);
      }}
      onLobby={() => {
        release();
        setStarted(false);
      }}
    >
      {(live) => (
        <DominoTable live={live} held={held} onPlace={play} onRelease={release} />
      )}
    </GameHost>
  );
}

/* ============================================================
   Table overlays
   ============================================================ */

function DominoTable({
  live,
  held,
  onPlace,
  onRelease,
}: {
  live: Live;
  held: PieceId | null;
  onPlace: (live: Live, tile: PieceId, end: ChainEnd) => void;
  onRelease: () => void;
}) {
  const state = live.state;
  const playable = live.isHeroTurn && canPlay(state, HERO);
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
      <BoneyardCount state={state} />

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
function BoneyardCount({ state }: { state: DomState }) {
  const geometry = useGeometry();
  if (!geometry) return null;
  const zone = geometry.zones.boneyard;
  const left = drawableTiles(state);

  return (
    <div
      className="pointer-events-none absolute z-1900 flex flex-col items-center gap-0.5 text-center text-[10px] leading-tight"
      style={{ left: zone.x - 8, top: zone.y + zone.h + 4, width: zone.w + 16 }}
    >
      <span className="font-semibold text-bone-400">
        {left > 0 ? `${left} to draw` : "boneyard dry"}
      </span>
      <span className="tnum font-bold text-brass-400">
        {pipsInHand(state, HERO)} pips
      </span>
    </div>
  );
}

/* ============================================================
   GameHost slots
   ============================================================ */

function playerViews(state: DomState, live: Live): SeatView[] {
  const out: SeatView[] = [];
  for (let seat = 1; seat < state.seats; seat++) {
    const tiles = state.hands[seat]?.length ?? 0;
    // Keyed off `lastAction`, not `state.turn`: `turn` already names the
    // NEXT actor the instant reduce runs, so highlighting from it makes
    // the glow jump to a pod before anything of theirs has been shown.
    const acting = live.busy && live.lastAction?.seat === seat;
    out.push({
      seat,
      name: botName(seat),
      colour: botColour(seat),
      meta: `${tiles} tile${tiles === 1 ? "" : "s"} · ${state.scores[seat] ?? 0}`,
      active: acting,
      thinking: acting,
    });
  }
  return out;
}

function standings(state: DomState, _live: Live, seats: SeatView[]) {
  return [
    { seat: HERO, name: "You", total: state.scores[HERO] ?? 0 },
    ...seats.map((s) => ({
      seat: s.seat,
      name: s.name,
      total: state.scores[s.seat] ?? 0,
    })),
  ].sort((a, b) => b.total - a.total);
}

function roundSummary(state: DomState) {
  const result = state.result;
  if (!result) return null;

  const name = (seat: number) => (seat === HERO ? "You" : botName(seat));
  const rows: ScoreRow[] = [];
  for (let seat = 0; seat < state.seats; seat++) {
    const pips = result.pips[seat] ?? 0;
    rows.push({
      seat,
      name: name(seat),
      colour: seat === HERO ? "var(--color-brass-300)" : botColour(seat),
      detail: pips === 0 ? "went out" : `${pips} pips left`,
      delta: seat === result.winner ? result.points : 0,
      total: state.scores[seat] ?? 0,
    });
  }
  rows.sort((a, b) => b.total - a.total);

  const note: RoundNote | undefined =
    result.kind === "blocked"
      ? {
          tone: "warn",
          title: "Blocked",
          body:
            result.winner === null
              ? "Nobody could play and the lowest count was tied, so nobody scores."
              : `Nobody could play. Lowest count takes the round: ${name(result.winner)} on ${result.pips[result.winner] ?? 0} pips.`,
        }
      : undefined;

  const title =
    result.winner === null
      ? "No score"
      : result.kind === "domino"
        ? `${name(result.winner)} ${result.winner === HERO ? "go" : "goes"} out`
        : `${name(result.winner)} ${result.winner === HERO ? "win" : "wins"} it`;

  return { title, rows, note };
}

function pendingLabel(state: DomState, seat: number): string {
  const tiles = state.hands[seat]?.length ?? 0;
  return `${botName(seat)} pending — ${tiles} tile${tiles === 1 ? "" : "s"}`;
}

/* ============================================================
   Setup
   ============================================================ */

function SetupScreen({
  seats,
  target,
  onSeatsChange,
  onTargetChange,
  difficulty,
  onDifficultyChange,
  onStart,
}: {
  seats: number;
  target: number;
  onSeatsChange: (n: number) => void;
  onTargetChange: (n: number) => void;
  difficulty: BotDifficulty;
  onDifficultyChange: (d: BotDifficulty) => void;
  onStart: () => void;
}) {
  return (
    <SetupShell maxWidth="max-w-xs">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="eyebrow">New match</span>
        <h1 className="font-display text-4xl tracking-wider text-brass-300">
          Dominoes
        </h1>
        <p className="max-w-xs text-sm text-bone-400">
          Block &amp; Draw with a double-six set. Match an open end, draw
          when you are stuck, and go out first — the pips left in
          everyone else&apos;s hands are yours.
        </p>
      </div>

      <div className="flex w-full max-w-xs flex-col gap-2">
        <span className="eyebrow text-center">Players — {seats}</span>
        <input
          type="range"
          min={MIN_SEATS}
          max={MAX_SEATS}
          value={seats}
          onChange={(e) => onSeatsChange(Number(e.target.value))}
          className="w-full accent-brass-400"
        />
      </div>

      <div className="flex w-full max-w-xs flex-col gap-2">
        <span className="eyebrow text-center">Play to</span>
        <div className="flex gap-2">
          {TARGETS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onTargetChange(t)}
              className={`flex-1 rounded-lg px-3 py-2.5 text-sm font-bold ring-1 ${
                t === target
                  ? "bg-brass-400/18 text-brass-300 ring-brass-400/60"
                  : "bg-bone-50/5 text-bone-300 ring-bone-50/12"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <span className="text-center text-[11px] text-bone-500">
          61 is the usual target at three or four players, 100 heads-up.
        </span>
      </div>

      <div className="flex w-full max-w-xs">
        <DifficultyPicker value={difficulty} onChange={onDifficultyChange} />
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

// Referenced by the scorecard's per-seat detail line.
void pipsInHand;
