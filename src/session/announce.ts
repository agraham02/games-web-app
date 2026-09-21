/**
 * Turning an engine announcement into a line of text for one viewer.
 *
 * Pure, and shared by both runtimes, because the two would otherwise
 * phrase the same event differently — the offline table saying "Mia
 * played the ace" while the online one says something else about the same
 * `GameEvent` is exactly the kind of drift that is invisible until
 * somebody plays both in one sitting.
 */

import type { GameEvent, SeatId, Tone } from "@/engine/types";

export type AnnounceEvent = Extract<GameEvent, { t: "announce" }>;

/**
 * Resolves a seat to a display name. Offline this is the bot-name table;
 * online it is the room's real roster.
 */
export type NameForSeat = (seat: SeatId) => string;

/**
 * Composes the toast — both the words and the colour.
 *
 * They resolve together because they are the same decision made twice.
 * A line reads differently depending on whether it is about you, and so
 * does its tone: "takes the trick" is good news to exactly one person at
 * the table. Offline that person is always seat 0 and both could be
 * decided in the engine; online neither can.
 *
 * An announcement with no `actor` belongs to the table rather than to a
 * person — "Nobody could play" — and is returned untouched, name and all.
 */
export function composeAnnounce(
  event: AnnounceEvent,
  viewerSeat: SeatId | null,
  nameFor: NameForSeat,
): { text: string; tone: Tone | undefined } {
  if (event.actor === undefined) return { text: event.text, tone: event.tone };

  const isViewer = viewerSeat !== null && event.actor === viewerSeat;
  const name = isViewer ? "You" : nameFor(event.actor);
  const body = isViewer && event.selfText !== undefined ? event.selfText : event.text;
  const tone = isViewer && event.selfTone !== undefined ? event.selfTone : event.tone;
  return { text: `${name} ${body}`, tone };
}
