// @vitest-environment jsdom

/**
 * With Hints on, every card that cannot be played ALONE is dimmed, and the
 * piece layer passes no tap to a dimmed card. A card that goes down WITH the
 * one just picked up is exactly such a card: so the second half of a pair
 * sat dead after the first was picked, although `onPieceTap` takes it
 * (reported 2026-11-01, Chromaly pairs, Hints on).
 *
 * `onPieceTap`'s own tests could not see it - they call the handler directly,
 * past the piece layer that refused the tap. The thing to pin is the mark the
 * piece layer reads.
 */

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { createChromaly, pieces, placements } from "@/games/chromaly/rules";
import { position, type Scenario } from "@/games/chromaly/testkit";
import type { ChromalyState } from "@/games/chromaly/types";
import { useTableStore } from "@/table/store";
import { joinsHeld, useUndimJoiners } from "./table";

// Crazy's rules: doubles, plain pairs and the 7/0 swap. A yellow 8 is the pile,
// so the yellow 7 goes on it, and the blue 7 only goes WITH it.
const CRAZY: Scenario = {
  hands: {
    0: ["RS.1", "Y6.1", "Y7.1", "B5.1", "B7.1", "F.1"],
    1: ["R4.1", "R6.1", "B2.1"],
    2: ["Y2.1", "Y3.1", "Y5.1"],
    3: ["G1.1", "G4.1", "B4.1"],
  },
  rules: { doubles: true, plainPairs: true, sevenZero: true },
  top: "Y8.1",
  color: "Y",
  turn: 0,
};

function seed(state: ChromalyState) {
  useTableStore.getState().reset(placements(state, 0), pieces(state));
}

const dimmed = (id: string) => Boolean(useTableStore.getState().placements[id]?.dimmed);

describe("a pair's second card, with Hints on", () => {
  const { state } = position(CRAZY);

  beforeEach(() => seed(state));

  it("starts dimmed, because it cannot go on the pile alone", () => {
    expect(dimmed("Y7.1")).toBe(false);
    expect(dimmed("B7.1")).toBe(true);
    expect(dimmed("B5.1")).toBe(true);
  });

  it("is undimmed once the first is picked up, and only what goes with it", () => {
    const { rerender } = renderHook(({ held }) => useUndimJoiners(state, 0, held), {
      initialProps: { held: [] as string[] },
    });
    expect(dimmed("B7.1")).toBe(true);

    rerender({ held: ["Y7.1"] });
    expect(dimmed("B7.1")).toBe(false);
    // Another number, another group: still not playable, still dimmed.
    expect(dimmed("B5.1")).toBe(true);
    expect(dimmed("RS.1")).toBe(true);
  });

  it("is dimmed again when the pick is put down", () => {
    const { rerender } = renderHook(({ held }) => useUndimJoiners(state, 0, held), {
      initialProps: { held: ["Y7.1"] },
    });
    expect(dimmed("B7.1")).toBe(false);

    rerender({ held: [] });
    expect(dimmed("B7.1")).toBe(true);
    expect(dimmed("Y7.1")).toBe(false);
  });

  it("is undimmed again after a batch resets the store under a pick", () => {
    const { rerender } = renderHook(({ s }) => useUndimJoiners(s, 0, ["Y7.1"]), {
      initialProps: { s: state },
    });
    expect(dimmed("B7.1")).toBe(false);

    // An opponent's move settles: the store is replaced wholesale.
    seed(state);
    expect(dimmed("B7.1")).toBe(true);
    rerender({ s: structuredClone(state) });
    expect(dimmed("B7.1")).toBe(false);
  });

  it("dims nothing that the game did not dim", () => {
    // Somebody else's turn: the game dims no card of this hand at all.
    const other = position({ ...CRAZY, turn: 1 }).state;
    seed(other);
    const { rerender } = renderHook(({ held }) => useUndimJoiners(other, 0, held), {
      initialProps: { held: [] as string[] },
    });
    rerender({ held: ["Y7.1"] });
    rerender({ held: [] });
    for (const id of other.hands[0]!) expect(dimmed(id), id).toBe(false);
  });
});

describe("what may join a pick", () => {
  const { state } = position(CRAZY);

  it("is the cards of the same group, and nothing else", () => {
    expect(joinsHeld(state, ["Y7.1"], "B7.1")).toBe(true);
    expect(joinsHeld(state, ["Y7.1"], "B5.1")).toBe(false);
    expect(joinsHeld(state, [], "B7.1")).toBe(false);
  });

  it("is nothing while a drawn card is being decided", () => {
    expect(joinsHeld({ ...state, drawn: "Y7.1" }, ["Y7.1"], "B7.1")).toBe(false);
  });
});

// The rules the table is built with, so a change to the engine's own dimming
// shows up here rather than as a silently different hand.
describe("the engine's own dimming", () => {
  it("is what the hook starts from", () => {
    const { state } = position(CRAZY);
    const def = createChromaly(state.rules);
    expect(def.placements(state, 0)["B7.1"]?.dimmed).toBe(true);
  });
});
