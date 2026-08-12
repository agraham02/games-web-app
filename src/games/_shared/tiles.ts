/**
 * Double-six domino set.
 *
 * Mirrors `cards.ts`: the pure model lives here, and `TileFace.tsx` only
 * draws it. Tile ids are "hi-lo" ("6-3", "4-4") and double as piece ids,
 * so they are stable for a whole game — a changing id reads as "old
 * piece destroyed, new piece created" and throws away the animation.
 */

import type { PieceId } from "@/engine/types";

export const MAX_PIPS = 6;

/** Canonical id: the higher half always leads. */
export function tileId(a: number, b: number): PieceId {
  return `${Math.max(a, b)}-${Math.min(a, b)}`;
}

/** `[hi, lo]` — the order `TileFace` draws them, top half first. */
export function parseTile(id: PieceId): [number, number] {
  const [a, b] = id.split("-").map(Number);
  return [a ?? 0, b ?? 0];
}

export function isDouble(id: PieceId): boolean {
  const [a, b] = parseTile(id);
  return a === b;
}

/** Total pips — the unit every domino game scores in. */
export function tilePips(id: PieceId): number {
  const [a, b] = parseTile(id);
  return a + b;
}

/** True if the tile can be joined to an open end showing `pip`. */
export function tileHas(id: PieceId, pip: number): boolean {
  const [a, b] = parseTile(id);
  return a === pip || b === pip;
}

/** The other half of `id`, given one of its halves. */
export function otherHalf(id: PieceId, pip: number): number {
  const [a, b] = parseTile(id);
  return a === pip ? b : a;
}

/** The 28 tiles of a double-six set, heaviest first. */
export function doubleSixSet(): PieceId[] {
  const tiles: PieceId[] = [];
  for (let a = MAX_PIPS; a >= 0; a--) {
    for (let b = a; b >= 0; b--) tiles.push(`${a}-${b}`);
  }
  return tiles;
}
