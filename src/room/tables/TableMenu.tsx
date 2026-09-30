"use client";

/**
 * The room's own buttons in an online table's Settings sheet: the invite
 * (so somebody can be asked in mid-game), back to the lobby for everyone,
 * and ending the game — or the whole room — for the leader.
 *
 * They used to be a row in the table's top-right corner. The user moved
 * them into the Settings sheet (2026-09-26): a table is for playing, and a
 * button that ends everybody's game does not belong a stray tap away from
 * the cards.
 */

import { EndGameAction } from "@/table/gameSettings";
import { Button } from "@/ui/primitives/Button";
import { InviteCard } from "../InviteCard";

export function TableMenu({
  code,
  spectator,
  leader,
  onStepAway,
  onEndGame,
  onCloseRoom,
}: {
  /** The room's code, for the invite. */
  code: string;
  /** Watching rather than seated. */
  spectator: boolean;
  /** The party leader, who alone may end the game. */
  leader: boolean;
  onStepAway: () => void;
  onEndGame: () => void;
  /** Leader only. A game played for money is settled first, as by End game. */
  onCloseRoom: () => void;
}) {
  return (
    <>
      <InviteCard code={code} compact />
      <Button onClick={onStepAway}>{spectator ? "Stop watching" : "Return to the lobby"}</Button>
      {spectator ? null : (
        <p className="text-center text-[11px] text-bone-500">
          Your seat is kept. A bot plays it until you come back.
        </p>
      )}
      {leader ? (
        <EndGameAction
          onEnd={onEndGame}
          tone="danger"
          label="End the game for everyone"
          question="End the game for everyone?"
          note="Everyone goes back to the lobby."
        />
      ) : null}
      {leader ? (
        <EndGameAction
          onEnd={onCloseRoom}
          tone="danger"
          label="Close the room"
          question="Close the room for everyone?"
          note="The game ends and everyone is sent home."
          confirmLabel="Close room"
          cancelLabel="Keep playing"
        />
      ) : null}
    </>
  );
}
