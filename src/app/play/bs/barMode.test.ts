import { describe, expect, it } from "vitest";

import { createRng } from "@/engine/rng";
import { createBs } from "@/games/bs/rules";
import type { BsAction, BsState, PilePlay } from "@/games/bs/types";
import type { GameRuntime } from "@/table/useGameRuntime";

import { barMode, OFFLINE_VIEW } from "./table";

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

/** `barMode` reads three fields; the rest of a runtime is irrelevant here. */
function live(s: BsState): GameRuntime<BsState, BsAction> {
  return { state: s, isOver: false, animating: false } as GameRuntime<BsState, BsAction>;
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

  it("still offers the play to the seat on turn, once cards are lifted", () => {
    // The bug this pins. A window enrols every seat but the claimer, so the
    // seat on turn is ALWAYS also entitled to call - and preferring the
    // challenge outright meant the player on turn was never shown a Play
    // button at all, while taps went on lifting cards out of their hand.
    // Playing over an open window is the interrupt the rules deliberately
    // grant, and the only defence a ten-second window has.
    expect(barMode(OFFLINE_VIEW, live(windowOnTurn()), 2)).toBe("claim");
  });

  it("offers the play on an ordinary turn with no window open", () => {
    expect(barMode(OFFLINE_VIEW, live(state()), 0)).toBe("claim");
    expect(barMode(OFFLINE_VIEW, live(state()), 1)).toBe("claim");
  });

  it("offers nothing to a seat with neither a turn nor a window", () => {
    expect(barMode(OFFLINE_VIEW, live(state({ turn: 2 })), 0)).toBeNull();
  });

  it("offers nothing once a pile is waiting to be swallowed", () => {
    // `pendingTake` ends both entitlements at once.
    const s = state({ turn: 0, plays: [PLAY], pendingTake: 1 });
    expect(barMode(OFFLINE_VIEW, live(s), 2)).toBeNull();
  });
});
