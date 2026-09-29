import { describe, expect, it } from "vitest";

import { createRng } from "@/engine/rng";
import { createBs } from "@/games/bs/rules";
import type { BsAction, BsState, PilePlay } from "@/games/bs/types";
import type { GameRuntime } from "@/table/useGameRuntime";

import { barMode, canPlay, OFFLINE_VIEW, playerViews, turnSeat } from "./table";

const def = createBs({ target: 2 });

function state(overrides: Partial<BsState> = {}): BsState {
  const base = def.setup({ seats: 4, rng: createRng(7) });
  return {
    ...base,
    round: 1,
    dealer: 3,
    turn: 0,
    dealt: true,
    rank: "A",
    hands: { 0: ["SA", "H2"], 1: ["HK"], 2: ["DQ"], 3: ["CJ"] },
    plays: [],
    window: null,
    reveal: null,
    pendingTake: null,
    ...overrides,
  };
}

/**
 * `barMode` reads a few fields; the rest of a runtime is irrelevant here.
 * `latest` is where the game has got to, which a move still animating
 * puts ahead of `state`.
 */
function live(s: BsState, latest: BsState = s): GameRuntime<BsState, BsAction> {
  return { state: s, latest, isOver: false, animating: false } as GameRuntime<BsState, BsAction>;
}

const PLAY: PilePlay = { seat: 3, claimed: "A", cards: ["CJ"] };

/** A window open on the seat that has just been handed the turn. */
function windowOnTurn(): BsState {
  return state({
    turn: 0,
    plays: [PLAY],
    window: { play: 0, pending: [{ seat: 0, ms: 200 }, { seat: 1, ms: 400 }] },
  });
}

describe("bs — which control the action band offers", () => {
  it("offers the challenge while a window is open and nothing is picked up", () => {
    expect(barMode(OFFLINE_VIEW, live(windowOnTurn()), 0)).toBe("challenge");
  });

  it("keeps the challenge for the seat on turn until the window closes", () => {
    // Nobody plays into an open window (the user's rule), so the seat on
    // turn gets BS / Let it go like everyone else, never the Play button.
    expect(barMode(OFFLINE_VIEW, live(windowOnTurn()), 0)).toBe("challenge");
    expect(barMode(OFFLINE_VIEW, live(windowOnTurn()), 2)).toBe("challenge");
  });

  it("offers the play on an ordinary turn with no window open", () => {
    expect(barMode(OFFLINE_VIEW, live(state()), 0)).toBe("claim");
    expect(barMode(OFFLINE_VIEW, live(state()), 1)).toBe("claim");
  });

  it("offers nothing to a seat with neither a turn nor a window", () => {
    expect(barMode(OFFLINE_VIEW, live(state({ turn: 2 })), 0)).toBeNull();
  });

  it("takes the challenge down the moment somebody else has called", () => {
    // Reported: the BS and Let it go buttons stayed up after a bot called.
    // Its call was already made; the table was still animating it.
    const open = state({
      turn: 2,
      plays: [PLAY],
      window: { play: 0, pending: [{ seat: 1, ms: 300 }, { seat: 0, ms: 900 }] },
    });
    const called = { ...open, window: null, pendingTake: 3 };
    expect(barMode(OFFLINE_VIEW, live(open), 0)).toBe("challenge");
    expect(barMode(OFFLINE_VIEW, live(open, called), 0)).toBeNull();
  });

  it("offers nothing once a pile is waiting to be swallowed", () => {
    // `pendingTake` ends both entitlements at once.
    const s = state({ turn: 0, plays: [PLAY], pendingTake: 1 });
    expect(barMode(OFFLINE_VIEW, live(s), 2)).toBeNull();
  });
});

describe("bs — when your hand is live", () => {
  it("stays asleep while the table waits on your answer to a window", () => {
    // Reported: cards became tappable when it was not your turn. First in a
    // window's queue, the viewer is the seat the table waits on, but all
    // they may do is call or let it go. `handActive` reads this, not
    // `isHeroTurn`.
    const s = state({
      turn: 2,
      plays: [PLAY],
      window: { play: 0, pending: [{ seat: 0, ms: 1200 }, { seat: 1, ms: 2000 }] },
    });
    expect(canPlay(OFFLINE_VIEW, live(s))).toBe(false);
    // Not even when it is your turn next: nobody plays into an open window.
    expect(canPlay(OFFLINE_VIEW, live({ ...s, turn: 0 }))).toBe(false);
    // Once it is closed, your turn is your turn.
    expect(canPlay(OFFLINE_VIEW, live({ ...s, turn: 0, window: null }))).toBe(true);
  });
});

describe("bs — who the turn line names", () => {
  it("stays on the player whose play is under challenge while bots decide", () => {
    // Reported 2026-09-28: the "…is thinking" line walked the answer queue,
    // naming each bot as it decided whether to call. The pacing still waits
    // on the queue (`currentSeat`); the line names the play's owner, as the
    // pods do.
    const s = state({
      turn: 0,
      plays: [PLAY],
      window: { play: 0, pending: [{ seat: 1, ms: 400 }, { seat: 2, ms: 900 }] },
    });
    const queue = (seat: number) => ({ ...live(s), currentSeat: seat }) as GameRuntime<BsState, BsAction>;
    expect(turnSeat(s, queue(1))).toBe(3);
    expect(turnSeat({ ...s, window: { play: 0, pending: [{ seat: 2, ms: 900 }] } }, queue(2))).toBe(3);
  });

  it("follows the table again once the window closes", () => {
    const s = state({ turn: 0, plays: [PLAY], window: null });
    const onTurn = { ...live(s), currentSeat: 0 } as GameRuntime<BsState, BsAction>;
    expect(turnSeat(s, onTurn)).toBe(0);
  });
});

describe("bs — whose pod is lit", () => {
  const lit = (s: BsState, l: GameRuntime<BsState, BsAction>) =>
    playerViews(OFFLINE_VIEW, s, l)
      .filter((v) => v.active)
      .map((v) => v.seat);

  it("stays on the play under challenge while the window is open", () => {
    const s = state({
      turn: 0,
      plays: [PLAY],
      window: { play: 0, pending: [{ seat: 1, ms: 400 }, { seat: 2, ms: 900 }] },
    });
    const deciding = { ...live(s), currentSeat: 1, pendingReveal: true, lastAction: { seat: 1, action: { t: "declineBs", seat: 1 } } };
    expect(lit(s, deciding as GameRuntime<BsState, BsAction>)).toEqual([3]);
  });

  it("goes to the next player, not the seat whose Let it go closed the window", () => {
    // Reported 2026-09-28: the last bot to let a play go lit up for a beat
    // between the window and the next turn. Letting a play go shows nothing.
    const s = state({ turn: 1, plays: [PLAY], window: null });
    const closing = {
      ...live(s),
      currentSeat: 1,
      pendingReveal: true,
      lastAction: { seat: 2, action: { t: "declineBs", seat: 2 } },
    };
    expect(lit(s, closing as GameRuntime<BsState, BsAction>)).toEqual([1]);
  });
});
