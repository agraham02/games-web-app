"use client";

/**
 * Dominoes, in a room.
 *
 * Almost nothing here is new, and that is the point of the four stages
 * that came before it: `GameHost` renders the table, `SpadesTable`
 * supplies the game-specific overlays, and `useOnlineRuntime` presents the
 * server's frames in the shape both of them already consume. What this
 * file adds is only the three things that genuinely differ online — who
 * you are, what the other people are called, and a way back to the lobby.
 *
 * `GameHost` is given a `definition` because it needs one for `pieces()`
 * and for the round/game predicates it reads off state. It never reduces
 * anything: `submitAction` goes to the wire, and every move that comes
 * back has already been decided by the server. Building the definition
 * from the room's own settings is what keeps the two in step.
 */

import { useMemo } from "react";
import type { SeatId } from "@/engine/types";
import { GAMES } from "@/session/registry";
import type { DomAction, DomState } from "@/games/dominoes/types";
import type { ChainEnd } from "@/games/dominoes/types";
import { botColour } from "@/games/_shared/botIdentity";
import { GameHostView } from "@/table/GameHost";
import { useTableStore } from "@/table/store";
import { Button } from "@/ui/primitives/Button";
import {
  DominoTable,
  pendingLabel,
  playerViews,
  roundSummary,
  standings,
  tapTile,
  type DomView,
} from "@/app/play/dominoes/table";
import { tintFor } from "../Roster";
import { awayFrom, openingPosition, useOnlineRuntime } from "../useOnlineRuntime";
import type { OnlineTableProps } from "../tables";

export function DominoesOnline({
  api,
  room,
  frame,
  held,
  onToggleHeld,
  onClearHeld,
}: OnlineTableProps) {
  const definition = useMemo(() => {
    const entry = GAMES[room.gameId ?? "dominoes"];
    return entry.create(room.settings);
  }, [room.gameId, room.settings]);

  const live = useOnlineRuntime<DomState, DomAction>({
    frame,
    submit: (action) => api.send({ t: "action", action }),
    nextRound: () => api.send({ t: "nextRound" }),
    // The undealt table, so the opening deal has a deck to fly from.
    initial: () => openingPosition(definition, room.seats, frame.seat),
  });

  /**
   * Who is who, from this viewer's chair.
   *
   * `seatNames` rides on the frame so a pod can be labelled without a
   * second lookup, and an empty seat falls back to a bot name — which is
   * honest, because an empty seat IS being played by a bot.
   */
  const view: DomView = useMemo(
    () => ({
      // A spectator has no seat. `-1` matches no seat anywhere, which is
      // exactly the effect wanted: nothing on the table is "yours".
      viewerSeat: frame.seat ?? -1,
      nameFor: (seat: SeatId) => frame.seatNames[seat] ?? `Bot ${seat + 1}`,
      colourFor: (seat: SeatId) => {
        const owner = room.members.find((m) => m.seat === seat);
        return owner ? tintFor(owner.session) : botColour(seat);
      },
      // A seat somebody owns but is not currently in — see `awayFrom`.
      awayFor: awayFrom(frame),
    }),
    [frame, room.members],
  );

  /**
   * Put down whatever is held.
   *
   * The store patch is the half that is easy to forget: `held` is what the
   * ghosts read, but `selected` is what LIFTS the tile out of the hand,
   * and clearing one without the other leaves a tile standing proud of a
   * fan it is no longer part of. The ghosts go too, since they are fed
   * into the camera's extent and would otherwise keep the board eased out
   * around a tile that has already been played.
   */
  const release = () => {
    const store = useTableStore.getState();
    for (const tile of held) store.patch(tile, { selected: false });
    store.setGhosts([]);
    onClearHeld();
  };

  // Only ever null for a moment before there is a frame at all: the table is
  // drawn from the first frame, and its deal plays once this player's own
  // table is up.
  if (!live) return <TableWaiting onLeave={api.exitGame} />;

  return (
    <div className="relative h-svh">
      <GameHostView<DomState, DomAction>
        definition={definition}
        runtime={{ seats: room.seats }}
        gameTitle={GAMES[room.gameId ?? "dominoes"].name}
        viewerSeat={frame.seat}
        serverDriven
        live={live}
        players={(state, l) => playerViews(view, state, l)}
        standings={(state, l, seats) => standings(view, state, l, seats)}
        stats={(state) => [
          { label: "Round", value: `${state.round}` },
          {
            label: state.rules.mode === "caribbean" ? "Games to win" : "Target",
            value: `${state.target}`,
          },
        ]}
        roundSummary={(state) => roundSummary(view, state)}
        pendingLabel={(state, seat) => pendingLabel(view, state, seat)}
        /*
          Not a bare toggle. Picking a tile up is only meaningful when
          there is an end to CHOOSE between — with one legal end this
          plays it, exactly as the offline screen has always done. See
          `tapTile`, which is where that rule now lives for both.
        */
        onPieceTap={(id, l) =>
          tapTile(id, l, held[0] ?? null, {
            select: (tile) => {
              useTableStore.getState().patch(tile, { selected: true });
              onToggleHeld(tile);
            },
            release,
            play: (tile, end) => {
              release();
              l.submitAction({ t: "play", tile, end });
            },
          })
        }
        onLobby={() => {
          release();
          api.exitGame();
        }}
      >
        {(l) => (
          <DominoTable
            view={view}
            live={l}
            held={held[0] ?? null}
            onPlace={(live, tile, end: ChainEnd) => {
              release();
              live.submitAction({ t: "play", tile, end });
            }}
            onRelease={release}
          />
        )}
      </GameHostView>

      {/*
        The only exit from a game is back to the lobby — leaving the room
        outright is a lobby action, per the spec. Deliberately a small
        corner control rather than anything in the hand band: that band has
        one owner (`HandZone`), and a second claimant on it is how the
        layout starts fighting itself.
      */}
      <div className="absolute top-2 right-2 z-1900 flex gap-2">
        {room.youAreLeader ? (
          <Button size="sm" tone="danger" onClick={api.endGame}>
            End game
          </Button>
        ) : null}
        <Button size="sm" onClick={api.exitGame}>
          {frame.seat === null ? "Stop watching" : "Step away"}
        </Button>
      </div>
    </div>
  );
}

function TableWaiting({ onLeave }: { onLeave: () => void }) {
  return (
    <main className="felt felt-weave flex h-svh flex-col items-center justify-center gap-4">
      <span className="eyebrow">Dealing you in</span>
      <Button size="sm" onClick={onLeave}>
        Back to the lobby
      </Button>
    </main>
  );
}
