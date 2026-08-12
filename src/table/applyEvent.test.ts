import { describe, expect, it } from "vitest";
import { reindex } from "./applyEvent";
import type { PlacementMap } from "@/engine/types";

/**
 * `reindex` is the quiet load-bearing piece of the piece layer. It has
 * to renumber a bucket after a piece joins or leaves it, AND preserve
 * object identity for every piece whose numbers did not change —
 * otherwise the narrow per-piece store subscriptions stop working and
 * every card re-renders on every move.
 */

const hand = (index: number, count: number, seat = 0) => ({
  zone: "hand" as const,
  seat,
  index,
  count,
  faceUp: true,
});

describe("reindex", () => {
  it("renumbers a bucket contiguously from zero", () => {
    const map: PlacementMap = {
      SA: hand(5, 3),
      SK: hand(9, 3),
      SQ: hand(2, 3),
    };
    const next = reindex(map);
    // Order is preserved by the previous index, not by key.
    expect(next.SQ!.index).toBe(0);
    expect(next.SA!.index).toBe(1);
    expect(next.SK!.index).toBe(2);
  });

  it("corrects a stale count after a piece leaves the bucket", () => {
    const map: PlacementMap = {
      SA: hand(0, 3),
      SK: hand(1, 3),
      // SQ was played away; the remaining two still claim count 3.
    };
    const next = reindex(map);
    expect(next.SA!.count).toBe(2);
    expect(next.SK!.count).toBe(2);
  });

  it("keeps buckets separate by zone, seat and group", () => {
    const map: PlacementMap = {
      SA: hand(0, 1, 0),
      SK: hand(0, 1, 1),
      H2: { zone: "board", group: 0, index: 0, count: 1, faceUp: true },
      H3: { zone: "board", group: 1, index: 0, count: 1, faceUp: true },
    };
    const next = reindex(map);
    for (const id of ["SA", "SK", "H2", "H3"]) {
      expect(next[id]!.index, id).toBe(0);
      expect(next[id]!.count, id).toBe(1);
    }
  });

  it("preserves object identity when nothing changed", () => {
    const map: PlacementMap = { SA: hand(0, 2), SK: hand(1, 2) };
    const next = reindex(map);
    // Same map object back, so no subscriber re-renders at all.
    expect(next).toBe(map);
    expect(next.SA).toBe(map.SA);
  });

  it("only allocates new objects for pieces that actually moved", () => {
    const map: PlacementMap = {
      SA: hand(0, 3),
      SK: hand(1, 3),
      SQ: hand(2, 3),
    };
    // Drop the LAST card: SA and SK keep index 0 and 1, but every count
    // goes 3 -> 2, so all survivors legitimately change.
    const shrunk: PlacementMap = { SA: map.SA!, SK: map.SK! };
    const next = reindex(shrunk);
    expect(next.SA).not.toBe(map.SA);
    expect(next.SA!.index).toBe(0);

    // Now a change that touches only one bucket: a second seat's hand
    // must come back byte-identical.
    const twoSeats: PlacementMap = {
      SA: hand(0, 1, 0),
      SK: hand(0, 2, 1),
      SQ: hand(1, 2, 1),
    };
    const stable = reindex(twoSeats);
    expect(stable).toBe(twoSeats);
    expect(stable.SA).toBe(twoSeats.SA);
  });

  it("handles an empty board", () => {
    expect(reindex({})).toEqual({});
  });
});
