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
import { HERO, type PieceId } from "@/engine/types";
import { botTable } from "@/ui/primitives/DifficultyPicker";
import { GameSetup, useGameSetup } from "@/ui/setup/GameSetup";
import { GameHost } from "@/table/GameHost";
import {
  DominoTable,
  OFFLINE_VIEW,
  pendingLabel,
  playerViews,
  roundSummary,
  standings,
  tapTile,
  DOMINO_SETTINGS,
} from "./table";
import type { GameRuntime } from "@/table/useGameRuntime";
import { useTableStore } from "@/table/store";
import { playableTiles, rollsSlam, sideOf } from "@/games/dominoes/state";
import type { ChainEnd, DomAction, DomState } from "@/games/dominoes/types";
import { GAMES, clampSeats } from "@/session/registry";

type Live = GameRuntime<DomState, DomAction>;

export default function DominoesPlayPage() {
  // Rules, target, optional rules, players and bots — all of it one value,
  // drawn and clamped by the game's spec (`session/gameSetup.ts`), which
  // the lobby shares. Caribbean first: the user's choice of default.
  const [setup, setSetup] = useGameSetup("dominoes");
  const [started, setStarted] = useState(false);
  const [gameKey, setGameKey] = useState(0);
  /** The tile the hero has picked up, if any. Lives here rather than in
   * the controls because the piece-tap handler and the ghost layer are
   * on opposite sides of GameHost. */
  const [held, setHeld] = useState<PieceId | null>(null);

  const settings = useMemo(() => GAMES.dominoes.parse(setup.settings), [setup.settings]);
  const caribbean = settings.mode === "caribbean";
  // Caribbean is a four-handed game; `seatBounds` reads that from the
  // definition itself, so the runtime and the engine cannot disagree.
  const tableSeats = clampSeats("dominoes", setup.settings, setup.seats);
  const definition = useMemo(() => GAMES.dominoes.create(settings), [settings]);

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
      <GameSetup game="dominoes" value={setup} onChange={setSetup} onStart={() => setStarted(true)} />
    );
  }

  return (
    <GameHost<DomState, DomAction>
      key={gameKey}
      definition={definition}
      runtime={{ seats: tableSeats, difficulty: botTable(tableSeats, setup.difficulty) }}
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
      settings={DOMINO_SETTINGS}
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
