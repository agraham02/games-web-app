/**
 * Four-seat partnership arithmetic — partners across, teams alternating.
 *
 * Pure seat maths with no game in it, which is why it lives here rather
 * than in the game that happened to need it first (Spades). Caribbean
 * dominoes seats its partners exactly the same way, and any future 2v2
 * game will too.
 *
 * Seats 0/2 and 1/3 are partners, which is also where the existing table
 * geometry already seats a lone third opponent (see CLAUDE.md: seat
 * numbering runs the same direction turn order passes) — so a
 * partnership game needs no layout change to be geometrically true. On a
 * four-seat table seat 2 is the pod directly opposite the hero, which is
 * where a partner belongs.
 *
 * Turn order therefore alternates opponent / partner / opponent, which
 * is the fact any bot reasoning about "who plays next" has to respect.
 */

import type { SeatId } from "@/engine/types";

export function partnerOf(seat: SeatId): SeatId {
  return (seat + 2) % 4;
}

export function teamOf(seat: SeatId): 0 | 1 {
  return (seat % 2) as 0 | 1;
}

export function teammates(team: 0 | 1): [SeatId, SeatId] {
  return team === 0 ? [0, 2] : [1, 3];
}
