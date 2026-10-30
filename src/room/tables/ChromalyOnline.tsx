"use client";

/**
 * Chromaly, in a room.
 *
 * Almost nothing here is new, which is the whole return on building the
 * engine for two drivers from the start: `GameHostView` renders the table,
 * `ChromalyTable` supplies the game-specific band, and `useOnlineRuntime`
 * presents the server's frames in the shape both already consume. What this
 * file adds is only what genuinely differs online - who you are, what the
 * other people are called, and a way back to the lobby.
 *
 * Both of the game's races run over the wire: several people are entitled at
 * once, every client draws its own ring, and the server decides who actually
 * got there first. That works because nothing here is authoritative - a client
 * ring only ever removes its own owner from the race, and
 * `GameDefinition.deadline` on the server is what really closes a window.
 */

import { useMemo } from "react";
import type { PieceId, SeatId } from "@/engine/types";
import { botColour } from "@/games/_shared/botIdentity";
import type { ChromalyAction, ChromalyState } from "@/games/chromaly/types";
import { GAMES } from "@/session/registry";
import { GameHostView } from "@/table/GameHost";
import { Button } from "@/ui/primitives/Button";
import {
  CHROMALY_SETTINGS,
  ChromalyTable,
  canAct,
  canJump,
  clearPlayCards,
  onPieceTap as tapCard,
  pendingLabel,
  playerViews,
  roundSummary,
  standings,
  statsFor,
  togglePlayCard,
  turnSeat,
  type ChromalyView,
} from "@/app/play/chromaly/table";
import { tintFor } from "../Roster";
import {
  awayFrom,
  botFrom,
  autoContinueFor,
  continueWaitingFor,
  openingPosition,
  useOnlineRuntime,
  nameForSeat,
} from "../useOnlineRuntime";
import type { OnlineTableProps } from "../tables";
import { TableMenu } from "./TableMenu";
import { useSeatExtras } from "./seatExtras";

export function ChromalyOnline({ api, room, frame, held, onClearHeld, setHeld, corner }: OnlineTableProps) {
  const definition = useMemo(() => {
    const entry = GAMES[room.gameId ?? "chromaly"];
    return entry.create(room.settings);
  }, [room.gameId, room.settings]);

  const live = useOnlineRuntime<ChromalyState, ChromalyAction>({
    frame,
    submit: (action, tag) => api.send({ t: "action", action, ...tag }),
    // Your own moves, shown before the server answers (`predict.ts`).
    definition,
    refused: api.refusedMove,
    nextRound: () => api.send({ t: "nextRound" }),
    // The undealt table, so the opening deal has a pile to fly from.
    initial: () => openingPosition(definition, room.seats, frame.seat),
  });

  const view: ChromalyView = useMemo(
    () => ({
      // A spectator has no seat. `-1` matches no seat anywhere, which is
      // exactly the effect wanted: nothing on the table is "yours", and every
      // hand at it stays face down.
      viewerSeat: frame.seat ?? -1,
      nameFor: (seat: SeatId) => nameForSeat(frame, seat),
      colourFor: (seat: SeatId) => {
        const owner = room.members.find((m) => m.seat === seat);
        return owner ? tintFor(owner.session) : botColour(seat);
      },
      awayFor: awayFrom(frame),
      botFor: botFrom(frame),
    }),
    [frame, room.members],
  );

  const seatExtras = useSeatExtras(room, api.chat);
  if (!live) return <TableWaiting onLeave={api.exitGame} />;

  // Through the shared rule, not a bare toggle: a wild or a 7 is always
  // picked alone. `RoomScreen` owns WHERE the selection lives, so it survives
  // a trip to the lobby; what a tap means lives next to `onPieceTap`.
  const pickUp = (id: PieceId) =>
    setHeld((prev) => togglePlayCard(prev, id, live.state, view.viewerSeat));
  const putDown = () => {
    clearPlayCards(held);
    onClearHeld();
  };

  return (
    <div className="relative h-svh">
      <GameHostView<ChromalyState, ChromalyAction>
        definition={definition}
        settings={CHROMALY_SETTINGS}
        runtime={{ seats: room.seats }}
        gameTitle={GAMES[room.gameId ?? "chromaly"].name}
        viewerSeat={frame.seat}
        serverDriven
        autoContinueMs={autoContinueFor(room)}
        continueWaiting={continueWaitingFor(room)}
        seatExtras={seatExtras}
        corner={corner}
        turnClock={api.turnClock}
        menuActions={
          <TableMenu
            code={room.code}
            spectator={frame.seat === null}
            leader={room.youAreLeader}
            onStepAway={api.exitGame}
            onEndGame={api.endGame}
            onCloseRoom={api.closeRoom}
          />
        }
        live={live}
        players={(state, l) => playerViews(view, state, l)}
        standings={(state, l, seats) => standings(view, state, l, seats)}
        stats={(state) => statsFor(view, state)}
        roundSummary={(state) => roundSummary(view, state)}
        pendingLabel={(state, seat) => pendingLabel(view, state, seat)}
        onPieceTap={(id, l) => tapCard(view, id, l, pickUp)}
        // Your hand is live when you may PLAY or JUMP IN - not merely when the
        // table is waiting on your answer to a window.
        handActive={(l) => canAct(view, l) || canJump(view, l)}
        turnSeat={turnSeat}
        onLobby={() => {
          putDown();
          api.exitGame();
        }}
      >
        {(l, settings) => (
          <ChromalyTable view={view} live={l} held={held} onPick={pickUp} onClearHeld={putDown} settings={settings} />
        )}
      </GameHostView>
    </div>
  );
}

function TableWaiting({ onLeave }: { onLeave: () => void }) {
  return (
    <main data-game="chromaly" className="felt felt-weave flex h-svh flex-col items-center justify-center gap-4">
      <span className="eyebrow">Dealing you in</span>
      <Button size="sm" onClick={onLeave}>
        Back to the lobby
      </Button>
    </main>
  );
}
