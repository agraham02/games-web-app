/**
 * Cosmetic bot identity — a name and an avatar tint per seat.
 *
 * Purely flavour: nothing here affects rules or bot behaviour, and there
 * is no real player-profile system yet (single-player vs bots only). One
 * shared table so the lab's fixtures and every real game's play screen
 * assign the same bot the same name/colour, rather than each inventing
 * its own list that drifts from the others.
 */

import type { SeatId } from "@/engine/types";

const BOT_NAMES = [
  "Mia", "Sam", "Kofi", "Jo", "Ada", "Rui", "Nia", "Tomas", "Elle",
] as const;

const BOT_COLOURS = [
  "#c9a0a0", "#a0a8c9", "#c9bfa0", "#8fb8a0", "#b9a0c9",
  "#a0c9c4", "#c9b0a0", "#aab8a0", "#c0a8b8",
] as const;

/** `seat` is the real SeatId (1..seats-1) — HERO (0) has no bot identity. */
export function botName(seat: SeatId): string {
  return BOT_NAMES[(seat - 1) % BOT_NAMES.length]!;
}

export function botColour(seat: SeatId): string {
  return BOT_COLOURS[(seat - 1) % BOT_COLOURS.length]!;
}
