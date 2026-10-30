"use client";

/**
 * Mind Meld, in a room.
 *
 * The same shape as every other online table: `GameHostView` renders it,
 * `MindMeldTable` supplies the game's own content, `useOnlineRuntime` presents
 * the server's frames. The server holds the bot brain and the unrevealed words;
 * a client only ever receives "locked" until the reveal, so there is nothing
 * here to protect - which is also why this file is no bigger than it is.
 */

import { useMemo } from "react";
import type { SeatId } from "@/engine/types";
import { botColour } from "@/games/_shared/botIdentity";
import type { MindMeldAction, MindMeldState } from "@/games/mindmeld/types";
import { GAMES } from "@/session/registry";
import { GameHostView } from "@/table/GameHost";
import { Button } from "@/ui/primitives/Button";
import {
  MINDMELD_HAND_ZONE,
  MINDMELD_SETTINGS,
  MindMeldTable,
  pendingLabel,
  playerViews,
  roundSummary,
  standings,
  statsFor,
  type MindMeldView,
} from "@/app/play/mindmeld/table";
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

export function MindMeldOnline({ api, room, frame, corner }: OnlineTableProps) {
  const definition = useMemo(() => {
    const entry = GAMES[room.gameId ?? "mindmeld"];
    return entry.create(room.settings);
  }, [room.gameId, room.settings]);

  const live = useOnlineRuntime<MindMeldState, MindMeldAction>({
    frame,
    submit: (action, tag) => api.send({ t: "action", action, ...tag }),
    definition,
    refused: api.refusedMove,
    nextRound: () => api.send({ t: "nextRound" }),
    initial: () => openingPosition(definition, room.seats, frame.seat),
  });

  const view: MindMeldView = useMemo(
    () => ({
      // A spectator has no seat: `-1` is nobody's pair, so every pair is drawn
      // round the rim and no input appears.
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

  return (
    <div className="relative h-svh">
      <GameHostView<MindMeldState, MindMeldAction>
        definition={definition}
        settings={MINDMELD_SETTINGS}
        runtime={{ seats: room.seats }}
        gameTitle={GAMES[room.gameId ?? "mindmeld"].name}
        handZone={MINDMELD_HAND_ZONE}
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
        handActive={() => false}
        turnSeat={() => null}
        onLobby={() => api.exitGame()}
      >
        {(l, settings) => <MindMeldTable view={view} live={l} settings={settings} />}
      </GameHostView>
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
