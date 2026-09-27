"use client";

/**
 * The room's own buttons in an online table's Settings sheet: the invite
 * (so somebody can be asked in mid-game), back to the lobby for everyone,
 * and ending the game for the leader.
 *
 * They used to be a row in the table's top-right corner. The user moved
 * them into the Settings sheet (2026-09-26): a table is for playing, and a
 * button that ends everybody's game does not belong a stray tap away from
 * the cards.
 */

import { Button } from "@/ui/primitives/Button";
import { InviteCard } from "../InviteCard";

export function TableMenu({
  code,
  spectator,
  leader,
  onStepAway,
  onEndGame,
}: {
  /** The room's code, for the invite. */
  code: string;
  /** Watching rather than seated. */
  spectator: boolean;
  /** The party leader, who alone may end the game. */
  leader: boolean;
  onStepAway: () => void;
  onEndGame: () => void;
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
        <Button tone="danger" onClick={onEndGame}>
          End the game for everyone
        </Button>
      ) : null}
    </>
  );
}
