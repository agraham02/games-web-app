/**
 * Which pairs are playing the try that is open.
 *
 * Two answers, chosen by the `pace` rule: every pair still in the round at
 * once (the user's first call, 2026-10-24), or one pair at a time with the
 * others watching (asked for 2026-10-30). It is a function rather than a loop
 * in the rules so the choice lives here and nothing else changes: `rules.ts`
 * never walks the pairs any other way, so the lock, the reveal and the scoring
 * are the same code either way.
 */

import { isActive } from "./state";
import type { MindMeldRules, MindMeldState } from "./types";

export type Schedule = (state: MindMeldState) => number[];

/** Every pair that has not melded and has tries left, all together. */
export const allAtOnce: Schedule = (state) =>
  state.pairs.filter((p) => isActive(p, state.rules)).map((p) => p.id);

/**
 * One pair per try, round the table. Each try moves to the next pair, and
 * each round starts one pair further on, so nobody always goes first - which
 * matters, because the first meld ends the round.
 */
export const takingTurns: Schedule = (state) => {
  const n = state.pairs.length;
  if (n === 0) return [];
  const start = (Math.max(0, state.round - 1) + state.tryNo) % n;
  for (let k = 0; k < n; k++) {
    const pair = state.pairs[(start + k) % n]!;
    if (isActive(pair, state.rules)) return [pair.id];
  }
  return [];
};

/** The schedule a set of rules plays to. */
export function scheduleFor(rules: Pick<MindMeldRules, "pace">): Schedule {
  return rules.pace === "turns" ? takingTurns : allAtOnce;
}

/** The pairs playing now. Defaults to the schedule the state's own rules name. */
export function activePairs(state: MindMeldState, schedule: Schedule = scheduleFor(state.rules)): number[] {
  return schedule(state);
}

/** The seats of the pairs playing now, in seat order. */
export function activeSeats(state: MindMeldState, schedule: Schedule = scheduleFor(state.rules)) {
  return activePairs(state, schedule).flatMap((id) => state.pairs[id]!.seats);
}
