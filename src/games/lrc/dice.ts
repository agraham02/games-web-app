/**
 * Left Right Center's dice.
 *
 * A real LCR die is NOT an even split: 3 of its 6 faces are a dot (keep),
 * and L, C, R each get exactly one face. Getting this ratio right matters
 * — it's the entire game balance. Verified against gamerules.com,
 * ultraboardgames.com and officialgamerules.org before writing this.
 *
 * Dice values are resolved HERE, before `reduce` ever sees them — see
 * types.ts for why. Both the human path (the play screen's "Roll" button)
 * and every bot call `rollAction`, so there is exactly one place the
 * face distribution is encoded.
 */

import type { Rng } from "@/engine/rng";
import type { DieFace, LrcAction } from "./types";

const FACE_ORDER: readonly DieFace[] = ["L", "R", "C", "dot", "dot", "dot"];

export function rollDie(rng: Rng): DieFace {
  return FACE_ORDER[rng.int(6)]!;
}

export function rollDice(rng: Rng, count: number): DieFace[] {
  return Array.from({ length: count }, () => rollDie(rng));
}

/**
 * Builds a fully-resolved "roll" action. `count` is the number of dice
 * this seat is entitled to (min(chips held, 3)) — the caller supplies it
 * rather than this function re-deriving it from state, so this stays a
 * pure dice-only concern.
 */
export function rollAction(rng: Rng, count: number): LrcAction {
  return { t: "roll", dice: rollDice(rng, count) };
}
