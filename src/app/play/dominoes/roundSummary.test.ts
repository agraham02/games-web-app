/**
 * The scorecard between rounds says who went out. It used to decide that
 * from a zero pip count, and a hand holding just the double blank counts
 * zero too: Kofi went out, and the card said the viewer — still holding
 * the 0-0 — had gone out as well (reported 2026-09-28).
 */

import { describe, expect, it } from "vitest";
import type { DomState } from "@/games/dominoes/types";
import { OFFLINE_VIEW, roundSummary } from "./table";

function ended(result: Partial<NonNullable<DomState["result"]>>): DomState {
  return {
    seats: 3,
    rules: { mode: "classic", teams: false, keyTileBonus: false, sixLove: false },
    scores: { 0: 0, 1: 1, 2: 0 },
    target: 10,
    result: {
      kind: "domino",
      winner: 1,
      winningSeats: [1],
      pips: { 0: 0, 1: 0, 2: 6 },
      points: 1,
      bonus: false,
      ...result,
    },
  } as unknown as DomState;
}

const detailOf = (state: DomState, seat: number) =>
  roundSummary(OFFLINE_VIEW, state)!.rows.find((r) => r.seat === seat)!.detail;

describe("dominoes — who the scorecard says went out", () => {
  it("names only the seat that laid its last tile", () => {
    const state = ended({});
    expect(detailOf(state, 1)).toBe("went out");
    // Holding the double blank: zero pips, and still holding a tile.
    expect(detailOf(state, 0)).toBe("0 pips left");
    expect(detailOf(state, 2)).toBe("6 pips left");
  });

  it("names nobody when the round blocked", () => {
    const state = ended({ kind: "blocked" });
    expect(detailOf(state, 1)).toBe("0 pips left");
  });

  it("says one pip in the singular", () => {
    expect(detailOf(ended({ pips: { 0: 1, 1: 0, 2: 6 } }), 0)).toBe("1 pip left");
  });
});
