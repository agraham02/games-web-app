"use client";

/**
 * Rummy 500, in a room.
 *
 * The last of the five, and the only one that needed the RULES changed
 * rather than the wiring. Three things in this game answered "the human"
 * with `HERO`: the dealer's hand-size choice resolved inline for a bot
 * and parked only for seat 0, `currentSeat` handed the turn to seat 0
 * whenever a claim window opened, and the claim race itself was timed by
 * a `setTimeout` on the play page. A server can adjudicate none of that.
 *
 * All three are gone from the engine now, so this file is as thin as the
 * other four: a `View` saying who is looking, and a way back to the lobby.
 *
 * The one thing genuinely different here is the claim countdown. It still
 * runs on each player's own machine — see `useClaimCountdown` — and that
 * is safe precisely because it is not authoritative: the timer only ever
 * submits `passClaim` for the seat it belongs to, the server decides who
 * actually got the card, and the worst a lagged clock can do is cost its
 * own owner a card they were probably going to lose anyway.
 */

import { useMemo } from "react";
import type { SeatId } from "@/engine/types";
import { GAMES } from "@/session/registry";
import type { RummyAction, RummyState } from "@/games/rummy/types";
import { botColour } from "@/games/_shared/botIdentity";
import { GameHostView } from "@/table/GameHost";
import { Button } from "@/ui/primitives/Button";
import {
  RotateNotice,
  RummyTable,
  SHEET_PEEK_H,
  pendingLabel,
  playerViews,
  roundSummary,
  standings,
  statsFor,
  useRummySelection,
  useViewport,
  type RummyView,
} from "@/app/play/rummy/table";
import { tintFor } from "../Roster";
import { awayFrom, continueWaitingFor, openingPosition, useOnlineRuntime, nameForSeat } from "../useOnlineRuntime";
import type { OnlineTableProps } from "../tables";
import { TableMenu } from "./TableMenu";

export function RummyOnline({ api, room, frame }: OnlineTableProps) {
  const definition = useMemo(() => {
    const entry = GAMES[room.gameId ?? "rummy"];
    return entry.create(room.settings);
  }, [room.gameId, room.settings]);

  const { short, touch } = useViewport();

  const live = useOnlineRuntime<RummyState, RummyAction>({
    frame,
    submit: (action) => api.send({ t: "action", action }),
    nextRound: () => api.send({ t: "nextRound" }),
    // The undealt table, so the opening deal has a deck to fly from.
    initial: () => openingPosition(definition, room.seats, frame.seat),
  });

  /**
   * Who is who, from this viewer's chair.
   *
   * `viewerSeat` is the frame's real seat and may be `null` — Rummy's
   * table reads that as a spectator and gives them no hand, which is
   * right. The other four games coerce it to `-1` here; this one does not
   * need to, because `mySeat` in the table module does it at the point of
   * use and `RummyView.viewerSeat` is also what decides whose meld chip
   * reads "YOU".
   */
  const view: RummyView = useMemo(
    () => ({
      viewerSeat: frame.seat,
      nameFor: (seat: SeatId) =>
        seat === frame.seat ? "You" : nameForSeat(frame, seat),
      colourFor: (seat: SeatId) => {
        const owner = room.members.find((m) => m.seat === seat);
        return owner ? tintFor(owner.session) : botColour(seat);
      },
      // A seat somebody owns but is not currently in — see `awayFrom`.
      awayFor: awayFrom(frame),
      // Whoever is not live, owned or not: that is who the claim races.
      isBot: (seat: SeatId) => frame.botSeats.includes(seat),
    }),
    [frame, room.members],
  );

  const { picked, pickupDepth, clearSelection, onPieceTap } = useRummySelection(view);

  // Only ever null for a moment before there is a frame at all: the table is
  // drawn from the first frame, and its deal plays once this player's own
  // table is up.
  if (!live) return <TableWaiting onLeave={api.exitGame} />;

  return (
    <div className="relative h-svh">
      <GameHostView<RummyState, RummyAction>
        definition={definition}
        runtime={{ seats: room.seats }}
        gameTitle={GAMES[room.gameId ?? "rummy"].name}
        viewerSeat={frame.seat}
        serverDriven
        continueWaiting={continueWaitingFor(room)}
        menuActions={
          <TableMenu
            code={room.code}
            spectator={frame.seat === null}
            leader={room.youAreLeader}
            onStepAway={() => {
              // Not kept, unlike Spades' exchange: a bot plays this seat
              // meanwhile, so a staged pickup would be a depth into a pile
              // that is no longer the same pile.
              clearSelection();
              api.exitGame();
            }}
            onEndGame={api.endGame}
          />
        }
        live={live}
        // The resting sheet, above the band every table reserves.
        bottomZone={SHEET_PEEK_H}
        players={playerViews(view, room.seats)}
        standings={standings(view, room.seats)}
        stats={statsFor}
        roundSummary={roundSummary(view, room.seats)}
        pendingLabel={pendingLabel(view)}
        onPieceTap={onPieceTap}
        onLobby={() => {
          clearSelection();
          api.exitGame();
        }}
      >
        {(l) => (
          <RummyTable
            live={l}
            view={view}
            picked={picked}
            pickupDepth={pickupDepth}
            clearSelection={clearSelection}
          />
        )}
      </GameHostView>

      {/* Same overlay-not-a-branch reasoning as the offline page: taking
          the host down to show a notice would drop the player out of a
          running game, and here it would drop them out of everybody
          else's game too. */}
      {short ? <RotateNotice touch={touch} /> : null}

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
