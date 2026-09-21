/**
 * What a seat pod says about a seat, in one place.
 *
 * Every game built this inline and every game built it the same way:
 *
 *   const acting = live.busy && live.lastAction?.seat === seat;
 *
 * That is "this seat just moved and the move is still on screen", and it
 * is deliberately not `state.turn` — `turn` names the NEXT actor the
 * instant `reduce` runs, so lighting a pod from it jumps the glow forward
 * before anything of theirs has been shown. Four of the five games carry
 * a comment saying so.
 *
 * What none of them had was the other half. "Who just moved" and "who are
 * we waiting on" are different questions, and the second one had no
 * answer at all. Offline that is invisible, because every seat that owns
 * a pod is a bot and a bot's turn OPENS with a `think` event — so
 * `lastAction` lands on it the moment its turn starts and the two
 * questions collapse into one.
 *
 * A second human does not do that. Their turn produces no frame until
 * they act, so `lastAction` still named the PREVIOUS player and the glow
 * sat on them until the current one moved. Reported exactly that way: the
 * indicator updated when somebody drew or passed, when it should have
 * moved the moment the turn before it ended.
 *
 * So the rule is the union of two terms, each gated so that exactly one
 * of them can be true at a time:
 *
 *   - `acting`  — their turn is on screen right now: a move animating, or
 *                 a computed turn waiting out its reveal hold.
 *   - `waiting` — the table is parked on them and there is nothing left to
 *                 watch.
 *
 * `busy` is deliberately NOT an input, though it is what every game used.
 * It answers "can the HERO act", which folds three unrelated things
 * together and is simply always true for a spectator, who is never on
 * turn — so a spectator's table kept the glow on whoever moved first, for
 * the rest of the game. `animating` and `pendingReveal` are the two facts
 * actually being asked about, and they are now asked for directly.
 *
 * Offline this is the same truth table it always was. `pendingReveal` is
 * set only for a seat NO human is in, so waiting on a person never trips
 * it; and offline the only person is the hero, whose pod is not drawn.
 * The behaviour that changes is the one that could not arise until there
 * was a second human at the table.
 */

import type { SeatId } from "@/engine/types";

/**
 * Structural on purpose: every `GameRuntime<S, A>` satisfies it whatever
 * its state type is, so this needs no generics and no cast at the five
 * call sites.
 */
export interface TurnCueSource {
  animating: boolean;
  pendingReveal: boolean;
  currentSeat: SeatId | null;
  lastAction: { seat: SeatId } | null;
}

export interface SeatCue {
  /** Highlight the pod: this seat is the one in play. */
  active: boolean;
  /**
   * Run the deliberation pulse.
   *
   * Deliberately NOT `active`. The pulse means "a turn is being played
   * out right now"; a table parked on somebody who has not moved yet is
   * a different thing, and an infinite pulse on a seat whose owner has
   * walked away would be the table insisting something is happening when
   * nothing is. The `Away` marker is what speaks for that seat instead.
   */
  thinking: boolean;
}

export function seatCue(live: TurnCueSource, seat: SeatId): SeatCue {
  const showing = live.animating || live.pendingReveal;
  const acting = showing && live.lastAction?.seat === seat;
  // The complement of `showing`, so the two terms can never name
  // different seats in the same instant. One glow, one seat in play.
  const waiting = !showing && live.currentSeat === seat;
  return { active: acting || waiting, thinking: acting };
}
