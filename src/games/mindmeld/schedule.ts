/**
 * Which pairs are playing the try that is open.
 *
 * Today that is every pair still in the round, all at once (the user's call,
 * 2026-10-24). It is a function rather than a loop in the rules so that a
 * "pairs take turns" mode is a different answer here and nothing else: `rules.ts`
 * never walks the pairs any other way, and `schedule.test.ts` runs a stand-in
 * turn-taking schedule through the reducer to prove the lock, the reveal and the
 * scoring already work for one pair at a time.
 */

import { isActive } from "./state";
import type { MindMeldState } from "./types";

export type Schedule = (state: MindMeldState) => number[];

/** Every pair that has not melded and has tries left, all together. */
export const allAtOnce: Schedule = (state) =>
  state.pairs.filter((p) => isActive(p, state.rules)).map((p) => p.id);

/** The schedule in force. The one place a second mode would be chosen. */
export function activePairs(state: MindMeldState, schedule: Schedule = allAtOnce): number[] {
  return schedule(state);
}

/** The seats of the pairs playing now, in seat order. */
export function activeSeats(state: MindMeldState, schedule: Schedule = allAtOnce) {
  return activePairs(state, schedule).flatMap((id) => state.pairs[id]!.seats);
}
