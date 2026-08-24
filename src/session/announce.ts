/**
 * Turning an engine announcement into a line of text for one viewer.
 *
 * Pure, and shared by both runtimes, because the two would otherwise
 * phrase the same event differently — the offline table saying "Mia
 * played the ace" while the online one says something else about the same
 * `GameEvent` is exactly the kind of drift that is invisible until
 * somebody plays both in one sitting.
 */

import type { GameEvent, SeatId } from "@/engine/types";

export type AnnounceEvent = Extract<GameEvent, { t: "announce" }>;

/**
 * Resolves a seat to a display name. Offline this is the bot-name table;
 * online it is the room's real roster.
 */
export type NameForSeat = (seat: SeatId) => string;

/**
 * Composes the toast text.
 *
 * An announcement with no `actor` is already a whole sentence and is
 * returned untouched — "Nobody could play" belongs to the table, not to a
 * person, and prefixing it with a name would be wrong.
 */
export function composeAnnounce(
  event: AnnounceEvent,
  viewerSeat: SeatId | null,
  nameFor: NameForSeat,
): string {
  if (event.actor === undefined) return event.text;

  const isViewer = viewerSeat !== null && event.actor === viewerSeat;
  const name = isViewer ? "You" : nameFor(event.actor);
  const body = isViewer && event.selfText !== undefined ? event.selfText : event.text;
  return `${name} ${body}`;
}
