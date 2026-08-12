import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import { lrc } from "./rules";
import { isEliminated, passLeft, passRight } from "./state";
import type { LrcState } from "./types";

/** A 5-seat state with seat 2 forced to zero chips (eliminated) and
 * every other seat left at 3 — built directly rather than by playing
 * moves, so these tests aren't at the mercy of dice rolls. */
function stateWithSeat2Eliminated(): LrcState {
  const state = lrc.setup({ seats: 5, rng: createRng(1) });
  const chipOwner = { ...state.chipOwner };
  // Move every chip seat 2 owns to seat 3 instead — seat 2 is now at 0.
  for (const [id, owner] of Object.entries(chipOwner)) {
    if (owner === 2) chipOwner[id] = 3;
  }
  return { ...state, chipOwner };
}

describe("isEliminated", () => {
  it("is false for every seat at setup", () => {
    const state = lrc.setup({ seats: 5, rng: createRng(1) });
    for (let s = 0; s < 5; s++) expect(isEliminated(state, s)).toBe(false);
  });

  it("is true exactly for a seat holding zero chips", () => {
    const state = stateWithSeat2Eliminated();
    expect(isEliminated(state, 2)).toBe(true);
    for (const s of [0, 1, 3, 4]) expect(isEliminated(state, s)).toBe(false);
  });
});

describe("passLeft / passRight — the house-rule redirect", () => {
  it("with nobody eliminated, behaves like plain seat+1 / seat-1", () => {
    const state = lrc.setup({ seats: 5, rng: createRng(1) });
    expect(passLeft(state, 0)).toBe(1);
    expect(passRight(state, 0)).toBe(4);
  });

  it("skips a single eliminated seat to land on the next active one", () => {
    const state = stateWithSeat2Eliminated();
    // Seat 1's left is seat 2 — eliminated — so it should redirect to 3.
    expect(passLeft(state, 1)).toBe(3);
    // Seat 3's right is seat 2 — eliminated — redirect to 1.
    expect(passRight(state, 3)).toBe(1);
  });

  it("never lands ON the eliminated seat itself, from either side", () => {
    const state = stateWithSeat2Eliminated();
    for (let seat = 0; seat < 5; seat++) {
      if (seat === 2) continue;
      expect(passLeft(state, seat)).not.toBe(2);
      expect(passRight(state, seat)).not.toBe(2);
    }
  });

  it("skips MULTIPLE consecutive eliminated seats", () => {
    let state = stateWithSeat2Eliminated();
    // Also eliminate seat 3, leaving only 0, 1, 4 (and the roller) in.
    const chipOwner = { ...state.chipOwner };
    for (const [id, owner] of Object.entries(chipOwner)) {
      if (owner === 3) chipOwner[id] = 4;
    }
    state = { ...state, chipOwner };

    // Seat 1's left is 2 (out), then 3 (out), then 4 (in) — must land on 4.
    expect(passLeft(state, 1)).toBe(4);
  });

  it("falls back to the roller when every other seat is eliminated", () => {
    // Not reachable through real play (isOver would already be true),
    // but the primitive itself must degrade safely rather than loop or
    // throw if it's ever called in that shape.
    const state = lrc.setup({ seats: 3, rng: createRng(1) });
    const chipOwner = { ...state.chipOwner };
    for (const [id, owner] of Object.entries(chipOwner)) {
      if (owner === 1 || owner === 2) chipOwner[id] = 0;
    }
    const soleSurvivor: LrcState = { ...state, chipOwner };
    expect(passLeft(soleSurvivor, 0)).toBe(0);
    expect(passRight(soleSurvivor, 0)).toBe(0);
  });
});

describe("reduce — elimination is permanent", () => {
  it("a chip aimed at an eliminated seat's direction reaches the next active seat instead", () => {
    const state = stateWithSeat2Eliminated();
    // Seat 1 rolls L: would go to seat 2 (eliminated) under plain
    // arithmetic, must redirect to seat 3.
    const { state: next } = lrc.reduce({ ...state, turn: 1 }, {
      t: "roll",
      dice: ["L"],
    });
    const seat2Chips = Object.values(next.chipOwner).filter((o) => o === 2).length;
    const seat3Chips = Object.values(next.chipOwner).filter((o) => o === 3).length;
    expect(seat2Chips).toBe(0); // still and forever eliminated
    // stateWithSeat2Eliminated already moved seat 2's 3 chips onto seat
    // 3, so seat 3 starts this test at 6 — +1 more for the redirect.
    expect(seat3Chips).toBe(7);
  });

  it("an eliminated seat never becomes currentSeat again", () => {
    const state = stateWithSeat2Eliminated();
    // Drive several turns and confirm seat 2 is never selected.
    let s = { ...state, turn: 0 };
    for (let i = 0; i < 10 && !lrc.isOver(s); i++) {
      const seat = lrc.currentSeat(s)!;
      expect(seat).not.toBe(2);
      s = lrc.reduce(s, lrc.bots.steady.choose(s, seat, createRng(500 + i))).state;
    }
  });
});
