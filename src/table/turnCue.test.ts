// @vitest-environment node

/**
 * Which pod is lit, and when.
 *
 * The reported bug: online, a player's turn indicator lagged. It moved to
 * them only once they drew or passed — but the turn was theirs the moment
 * the player before them finished.
 *
 * The cause was that "who just moved" was the only question anybody
 * asked. That is the right question while a move is being SHOWN, and it
 * is a complete answer offline, where every seat with a pod is a bot and
 * a bot's turn opens with a `think` — so `lastAction` lands on it as the
 * turn begins. A human emits nothing until they act, so the glow stayed
 * on the previous player for as long as they took to decide.
 *
 * These are on the rule rather than on any screen, because the rule is
 * what was missing and what five games had each written out by hand.
 */

import { describe, expect, it } from "vitest";
import { seatCue, type TurnCueSource } from "./turnCue";

/** A table parked on `currentSeat` with nothing playing. */
function idle(partial: Partial<TurnCueSource> = {}): TurnCueSource {
  return {
    animating: false,
    pendingReveal: false,
    currentSeat: 2,
    lastAction: { seat: 1 },
    ...partial,
  };
}

describe("seatCue", () => {
  it("lights the seat the table is waiting on, before they have done anything", () => {
    // The bug, stated. Seat 1 moved; seat 2 is up and has not acted.
    expect(seatCue(idle(), 2).active).toBe(true);
  });

  it("lets go of the seat that just moved once the move has been shown", () => {
    expect(seatCue(idle(), 1).active).toBe(false);
  });

  it("keeps the glow on the mover while their move is still playing", () => {
    // The behaviour four of the five games carry a comment defending, and
    // it has to survive: `currentSeat` already names the NEXT actor, so
    // without the `animating` gate the glow would jump forward before
    // anything of theirs had been drawn.
    const playing = idle({ animating: true });
    expect(seatCue(playing, 1).active).toBe(true);
    expect(seatCue(playing, 2).active).toBe(false);
  });

  it("waits out a turn that is computed but not yet revealed", () => {
    // LRC's reveal hold, and the dev panel's turn-by-turn stepping. The
    // dice of the seat that just rolled are still on screen; naming the
    // next seat over the top of them is what `pendingReveal` prevents.
    const held = idle({ pendingReveal: true });
    expect(seatCue(held, 2).active).toBe(false);
    expect(seatCue(held, 1).active).toBe(true);
  });

  it("lights nobody when the table is waiting on nobody", () => {
    // Between rounds, and after the last hand. A pod left glowing through
    // a scorecard reads as a turn nobody can take.
    const over = idle({ currentSeat: null, lastAction: null });
    expect(seatCue(over, 0).active).toBe(false);
    expect(seatCue(over, 2).active).toBe(false);
  });

  it("pulses only for a turn actually being played, not for one being awaited", () => {
    // A human who has walked away would otherwise pulse forever, with the
    // table insisting something is happening. `SeatView.away` speaks for
    // that seat instead.
    expect(seatCue(idle(), 2).thinking).toBe(false);
    expect(seatCue(idle({ animating: true }), 1).thinking).toBe(true);
  });

  it("never lights two pods at once", () => {
    // The two terms are joined by OR, so the case worth pinning is that
    // they cannot both be true of different seats in the same instant —
    // one glow means one seat in play, which is the whole point of it.
    for (const source of [
      idle(),
      idle({ animating: true }),
      idle({ pendingReveal: true }),
      idle({ currentSeat: 1 }),
      idle({ lastAction: null }),
      idle({ currentSeat: null }),
    ]) {
      const lit = [0, 1, 2, 3].filter((seat) => seatCue(source, seat).active);
      expect(lit.length, JSON.stringify(source)).toBeLessThanOrEqual(1);
    }
  });

  it("lights the mover's own seat when the table hands the turn straight back", () => {
    // Rummy draws then discards on one turn, and poker can put the same
    // seat back on the clock after a raise behind. `acting` and `waiting`
    // then name the SAME seat, and OR-ing them must not flicker it off.
    const same = idle({ currentSeat: 1, animating: false });
    expect(seatCue(same, 1).active).toBe(true);
  });
});
