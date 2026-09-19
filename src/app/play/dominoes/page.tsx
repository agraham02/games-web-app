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

import { useMemo, useState } from "react";
import Link from "next/link";
import { HERO, type BotDifficulty, type PieceId } from "@/engine/types";
import { DifficultyPicker, botTable } from "@/ui/primitives/DifficultyPicker";
import { NumberStepper } from "@/ui/primitives/NumberStepper";
import { SetupShell } from "@/ui/primitives/SetupShell";
import { Toggle } from "@/ui/primitives/Toggle";
import { GameHost } from "@/table/GameHost";
import {
  DominoTable,
  OFFLINE_VIEW,
  pendingLabel,
  playerViews,
  roundSummary,
  standings,
  tapTile,
} from "./table";
import type { GameRuntime } from "@/table/useGameRuntime";
import { useTableStore } from "@/table/store";
import { createDominoes, MAX_SEATS, MIN_SEATS } from "@/games/dominoes/rules";
import { CARIBBEAN_DEFAULT_TARGET, CARIBBEAN_SEATS, CARIBBEAN_TARGET_MAX, CARIBBEAN_TARGET_MIN, SIX_LOVE_DEFAULT_TARGET, pipsInHand, playableTiles, rollsSlam, sideOf } from "@/games/dominoes/state";
import type { ChainEnd, DomAction, DomMode, DomState } from "@/games/dominoes/types";

type Live = GameRuntime<DomState, DomAction>;

const TARGETS = [61, 100, 150];

export default function DominoesPlayPage() {
  const [mode, setMode] = useState<DomMode>("classic");
  const [seats, setSeats] = useState(3);
  /**
   * Two targets, not one, because they are not the same UNIT — classic
   * counts pips to 61/100/150, Caribbean counts games won to somewhere
   * between 1 and 20. Sharing one number meant flipping the mode and
   * back left a match playing to 10 points or to 100 games.
   */
  const [target, setTarget] = useState(100);
  const [games, setGames] = useState(CARIBBEAN_DEFAULT_TARGET);
  const [teams, setTeams] = useState(false);
  const [keyTileBonus, setKeyTileBonus] = useState(false);
  const [sixLove, setSixLove] = useState(false);
  const [difficulty, setDifficulty] = useState<BotDifficulty>("steady");
  const [started, setStarted] = useState(false);
  const [gameKey, setGameKey] = useState(0);
  /** The tile the hero has picked up, if any. Lives here rather than in
   * the controls because the piece-tap handler and the ghost layer are
   * on opposite sides of GameHost. */
  const [held, setHeld] = useState<PieceId | null>(null);

  const caribbean = mode === "caribbean";
  // Caribbean is a four-handed game — `makeSetup` forces this too, so
  // the engine cannot be handed a short deal, but the runtime needs the
  // same number or the seat ring lays out a different table.
  const tableSeats = caribbean ? CARIBBEAN_SEATS : seats;
  // Six love is meaningless without two sides to alternate between —
  // see `defaultTarget`. Held as its own flag so unticking Teams doesn't
  // silently forget the player had asked for it.
  const sixLoveActive = caribbean && teams && sixLove;

  const definition = useMemo(
    () =>
      createDominoes(
        caribbean
          ? { mode, teams, keyTileBonus, sixLove: sixLoveActive, target: games }
          : { mode, target },
      ),
    [caribbean, mode, teams, keyTileBonus, sixLoveActive, games, target],
  );

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

  /**
   * Only the hero's own hand tiles are ever tappable — see PieceLayer.
   * What a tap MEANS lives in `tapTile`, next to the online table, so the
   * two screens cannot answer it differently again.
   */
  const onPieceTap = (id: PieceId, live: Live) =>
    tapTile(id, live, held, {
      select: (tile) => {
        useTableStore.getState().patch(tile, { selected: true });
        setHeld(tile);
      },
      release,
      play: (tile, end) => play(live, tile, end),
    });

  if (!started) {
    return (
      <SetupScreen
        difficulty={difficulty}
        onDifficultyChange={setDifficulty}
        mode={mode}
        onModeChange={setMode}
        seats={seats}
        target={target}
        games={games}
        teams={teams}
        keyTileBonus={keyTileBonus}
        sixLove={sixLove}
        onSeatsChange={setSeats}
        onTargetChange={setTarget}
        onGamesChange={setGames}
        onTeamsChange={(on) => {
          setTeams(on);
          // Six love only terminates two-a-side, so it is offered with
          // Teams and its target default follows it — see `defaultTarget`.
          if (!on) setGames((g) => (g === SIX_LOVE_DEFAULT_TARGET ? CARIBBEAN_DEFAULT_TARGET : g));
        }}
        onKeyTileBonusChange={setKeyTileBonus}
        onSixLoveChange={(on) => {
          setSixLove(on);
          setGames(on ? SIX_LOVE_DEFAULT_TARGET : CARIBBEAN_DEFAULT_TARGET);
        }}
        onStart={() => setStarted(true)}
      />
    );
  }

  return (
    <GameHost<DomState, DomAction>
      key={gameKey}
      definition={definition}
      runtime={{ seats: tableSeats, difficulty: botTable(tableSeats, difficulty) }}
      gameTitle={caribbean ? "Caribbean Dominoes" : "Dominoes"}
      players={(state, live) => playerViews(OFFLINE_VIEW, state, live)}
      standings={(state, live, seats) => standings(OFFLINE_VIEW, state, live, seats)}
      stats={(state) => [
        { label: "Round", value: `${state.round}` },
        {
          label: state.rules.mode === "caribbean" ? "Games to win" : "Target",
          value: `${state.target}`,
        },
      ]}
      roundSummary={(state) => roundSummary(OFFLINE_VIEW, state)}
      pendingLabel={(state, seat) => pendingLabel(OFFLINE_VIEW, state, seat)}
      scenarios={dominoScenarios}
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
        <DominoTable view={OFFLINE_VIEW} live={live} held={held} onPlace={play} onRelease={release} />
      )}
    </GameHost>
  );
}

function dominoScenarios(live: Live) {
  const state = live.rawState;
  if (state.rules.mode !== "caribbean") return [];

  const playable = playableTiles(state, HERO).map((p) => p.tile);

  return [
    {
      label: "Slam my next play",
      // The roll is a pure hash of (seed, round, chain length, seat,
      // tile), so the honest way to guarantee one is to look for a seed
      // where every tile the hero could play rolls true — then whichever
      // they pick, it slams. Searching the seed is a dev action on the
      // same function real play uses, not a bypass of it.
      run: () => {
        if (playable.length === 0) return;
        let best = state.seed;
        let bestHits = -1;
        for (let i = 0; i < 20_000 && bestHits < playable.length; i++) {
          const seed = (state.seed + i) >>> 0;
          const probe = { ...state, seed };
          const hits = playable.filter((t) => rollsSlam(probe, HERO, t, false)).length;
          if (hits > bestHits) {
            bestHits = hits;
            best = seed;
          }
        }
        live.replaceState({ ...state, seed: best });
      },
    },
    {
      label: "One tile from out",
      // Trims the hero to a single playable tile, so the next play ends
      // the round — which is the 80% going-out roll, and the only way to
      // see the key-tile bonus without building a whole board by hand.
      run: () => {
        const keep = playable[0] ?? state.hands[HERO]?.[0];
        if (!keep) return;
        live.replaceState({
          ...state,
          turn: HERO,
          hands: { ...state.hands, [HERO]: [keep] },
        });
      },
    },
    {
      label: "Win the last round",
      // Puts the hero's side one game short, so the next round they take
      // ends the match — the crown, the confetti and (in team mode) both
      // partners being crowned.
      run: () => {
        const scores = { ...state.scores };
        for (const seat of sideOf(state, HERO)) scores[seat] = state.target - 1;
        live.replaceState({ ...state, scores });
      },
    },
  ];
}

/* ============================================================
   Setup
   ============================================================ */

/** What each tier actually does — see `judge()` in bots.ts. */
const DOMINO_BLURBS = {
  casual: "Plays whatever's in hand, no plan behind it.",
  steady: "Sheds its heaviest tiles first — enough to punish a careless hand.",
  sharp: "Keeps its own options open, and squeezes a block when one's going cheap.",
};

function SetupScreen({
  mode,
  onModeChange,
  seats,
  target,
  games,
  teams,
  keyTileBonus,
  sixLove,
  onSeatsChange,
  onTargetChange,
  onGamesChange,
  onTeamsChange,
  onKeyTileBonusChange,
  onSixLoveChange,
  difficulty,
  onDifficultyChange,
  onStart,
}: {
  mode: DomMode;
  onModeChange: (m: DomMode) => void;
  seats: number;
  target: number;
  games: number;
  teams: boolean;
  keyTileBonus: boolean;
  sixLove: boolean;
  onSeatsChange: (n: number) => void;
  onTargetChange: (n: number) => void;
  onGamesChange: (n: number) => void;
  onTeamsChange: (v: boolean) => void;
  onKeyTileBonusChange: (v: boolean) => void;
  onSixLoveChange: (v: boolean) => void;
  difficulty: BotDifficulty;
  onDifficultyChange: (d: BotDifficulty) => void;
  onStart: () => void;
}) {
  const caribbean = mode === "caribbean";
  return (
    <SetupShell maxWidth="max-w-xs">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="eyebrow">New match</span>
        <h1 className="font-display text-4xl tracking-wider text-brass-300">
          Dominoes
        </h1>
        <p className="max-w-xs text-sm text-bone-400">
          {caribbean
            ? "Four hands, the whole set dealt, and no boneyard — if you cannot go, you pass. Win the round, win a game."
            : "Block & Draw with a double-six set. Match an open end, draw when you are stuck, and go out first — the pips left in everyone else's hands are yours."}
        </p>
      </div>

      {/* Two named rulesets, so a segmented row rather than a switch —
          a toggle labelled "Caribbean" would leave the other option
          unnamed, and "off" is not what classic Block & Draw is. */}
      <div className="flex w-full max-w-xs flex-col gap-2">
        <span className="eyebrow text-center">Rules</span>
        <div className="flex gap-2">
          {(["classic", "caribbean"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onModeChange(m)}
              className={`flex-1 rounded-lg px-3 py-2.5 text-sm font-bold ring-1 ${
                m === mode
                  ? "bg-brass-400/18 text-brass-300 ring-brass-400/60"
                  : "bg-bone-50/5 text-bone-300 ring-bone-50/12"
              }`}
            >
              {m === "classic" ? "Block & Draw" : "Caribbean"}
            </button>
          ))}
        </div>
      </div>

      {caribbean ? (
        <div className="flex w-full max-w-xs flex-col items-center gap-1 rounded-lg bg-bone-50/4 px-3.5 py-2.5 ring-1 ring-bone-50/8">
          <span className="text-sm font-bold text-bone-200">Four players</span>
          <span className="text-center text-[11px] text-bone-500">
            No more, no less — seven tiles each is the whole set.
          </span>
        </div>
      ) : (
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
      )}

      {caribbean ? (
        <div className="flex w-full max-w-xs flex-col gap-2">
          <span className="eyebrow text-center">Games to win</span>
          <NumberStepper
            value={games}
            min={CARIBBEAN_TARGET_MIN}
            max={CARIBBEAN_TARGET_MAX}
            onChange={onGamesChange}
            label={games === 1 ? "game" : "games"}
          />
          <span className="text-center text-[11px] text-bone-500">
            {sixLove && teams
              ? "Six love resets you, so these have to be won in a row — six runs about an hour."
              : "One game per round won. Two if you finish on the key tile."}
          </span>
        </div>
      ) : (
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
      )}

      {caribbean ? (
        <div className="flex w-full max-w-xs flex-col gap-2">
          <span className="eyebrow text-center">Optional rules</span>
          <Toggle
            label="Partners"
            hint="Two against two, partners across the table. You play with the seat opposite you."
            checked={teams}
            onChange={onTeamsChange}
          />
          <Toggle
            label="Key tile"
            hint="Finish on the only tile left that could have been played and the round is worth two games. Never a double."
            checked={keyTileBonus}
            onChange={onKeyTileBonusChange}
          />
          <Toggle
            label="Six love"
            hint={
              teams
                ? "Your score goes back to nothing whenever the other side wins, so you have to take them in a row."
                : "Needs partners — winning in a row is not something four separate players can realistically do."
            }
            checked={sixLove}
            disabled={!teams}
            onChange={onSixLoveChange}
          />
        </div>
      ) : null}

      <div className="flex w-full max-w-xs">
        <DifficultyPicker value={difficulty} onChange={onDifficultyChange} blurbs={DOMINO_BLURBS} />
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
