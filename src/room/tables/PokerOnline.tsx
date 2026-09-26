"use client";

/**
 * Poker, in a room.
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
import type { PokerAction, PokerState } from "@/games/poker/types";
import { botColour } from "@/games/_shared/botIdentity";
import { GameHostView } from "@/table/GameHost";
import { Button } from "@/ui/primitives/Button";
import {
  POKER_SETTINGS,
  PokerControls,
  pendingLabel,
  playerViews,
  roundSummary,
  standings,
  type PokerView,
} from "@/app/play/poker/table";
import { tintFor } from "../Roster";
import {
  awayFrom,
  continueWaitingFor,
  openingPosition,
  useOnlineRuntime,
} from "../useOnlineRuntime";
import type { OnlineTableProps } from "../tables";

export function PokerOnline({ api, room, frame }: OnlineTableProps) {
  const definition = useMemo(() => {
    const entry = GAMES[room.gameId ?? "poker"];
    return entry.create(room.settings);
  }, [room.gameId, room.settings]);

  const live = useOnlineRuntime<PokerState, PokerAction>({
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
  const view: PokerView = useMemo(
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

  // Only ever null for a moment before there is a frame at all: the table is
  // drawn from the first frame, and its deal plays once this player's own
  // table is up.
  if (!live) return <TableWaiting onLeave={api.exitGame} />;

  return (
    <div className="relative h-svh">
      <GameHostView<PokerState, PokerAction>
        definition={definition}
        runtime={{ seats: room.seats }}
        gameTitle={GAMES[room.gameId ?? "poker"].name}
        viewerSeat={frame.seat}
        serverDriven
        continueWaiting={continueWaitingFor(room)}
        live={live}
        players={(state, l) => playerViews(view, state, l)}
        standings={(state, l, seats) => standings(view, state, l, seats)}
        stats={(state) => [
          { label: "Hand", value: `${state.hand}` },
          { label: "Blinds", value: `${state.smallBlind}/${state.bigBlind}` },
        ]}
        roundSummary={(state) => roundSummary(view, state)}
        pendingLabel={(state, seat) => pendingLabel(view, state, seat)}
        onLobby={api.exitGame}
        settings={POKER_SETTINGS}
        // The only exit from a game is back to the lobby — leaving the room
        // outright is a lobby action, per the spec. Deliberately a small
        // corner control rather than anything in the hand band: that band
        // has one owner (`HandZone`). Handed to the host rather than
        // positioned here, so it shares one row with the Settings button.
        corner={
          <>
            {room.youAreLeader ? (
              <Button size="sm" tone="danger" onClick={api.endGame}>
                End game
              </Button>
            ) : null}
            <Button size="sm" onClick={api.exitGame}>
              {frame.seat === null ? "Stop watching" : "Step away"}
            </Button>
          </>
        }
      >
        {(l, prefs) => <PokerControls view={view} live={l} hints={prefs.hints ?? true} />}
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
