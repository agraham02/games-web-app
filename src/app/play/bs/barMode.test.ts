import { describe, expect, it } from "vitest";

import { createRng } from "@/engine/rng";
import { createBs } from "@/games/bs/rules";
import type { BsAction, BsState, PilePlay } from "@/games/bs/types";
import type { GameRuntime } from "@/table/useGameRuntime";

import { barMode, canPlay, OFFLINE_VIEW } from "./table";

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
