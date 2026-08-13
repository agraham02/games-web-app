import { describe, expect, it } from "vitest";
import { applyEventToTable, reindex } from "./applyEvent";
import { useTableStore } from "./store";
import { STAGGER } from "@/motion/presets";
import type { PieceMeta, PlacementMap } from "@/engine/types";

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

  it("preserves motionDelayMs through its identity-preservation path", () => {
    // reindex only special-cases index/count and otherwise spreads or
    // reuses the whole object — worth pinning explicitly, since this is
    // exactly the kind of field reindex could silently drop.
    const map: PlacementMap = {
      SA: { ...hand(0, 2), motionDelayMs: 40 },
      SK: hand(1, 2),
    };
    const next = reindex(map);
    expect(next).toBe(map); // nothing about index/count changed -> identity preserved
    expect(next.SA!.motionDelayMs).toBe(40);
  });
});

/**
 * `applyEventToTable`'s collect/sweep stagger. `collect`/`sweep` are the
 * one pair of events whose whole batch lands in a single store write —
 * `motionDelayMs` is what lets PieceLayer still show them arriving one
 * after another instead of snapping to their new zone simultaneously.
 */
describe("applyEventToTable — collect/sweep stagger (motionDelayMs)", () => {
  function seed(map: PlacementMap): void {
    const meta: Record<string, PieceMeta> = {};
    for (const id of Object.keys(map)) meta[id] = { kind: "card", face: id };
    useTableStore.getState().reset(map, meta);
  }

  it("assigns an increasing per-piece delay on collect, capped at index 10", () => {
    const pieces = Array.from({ length: 12 }, (_, i) => `C${i}`);
    const map: PlacementMap = {};
    for (const id of pieces) map[id] = { zone: "trick", seat: 0, index: 0, count: 1, faceUp: true };
    seed(map);

    applyEventToTable({ t: "collect", pieces, to: 1 });
    const placements = useTableStore.getState().placements;
    pieces.forEach((id, i) => {
      expect(placements[id]!.motionDelayMs).toBeCloseTo(Math.min(i, 10) * STAGGER.collect * 1000);
    });
  });

  it("assigns an increasing per-piece delay on sweep, capped at index 10", () => {
    const pieces = Array.from({ length: 12 }, (_, i) => `T${i}`);
    const map: PlacementMap = {};
    for (const id of pieces) map[id] = { zone: "hand", seat: 0, index: 0, count: 1, faceUp: false };
    seed(map);

    applyEventToTable({ t: "sweep", pieces, to: "boneyard" });
    const placements = useTableStore.getState().placements;
    pieces.forEach((id, i) => {
      expect(placements[id]!.motionDelayMs).toBeCloseTo(Math.min(i, 10) * STAGGER.sweep * 1000);
    });
  });

  it("clears a nonzero motionDelayMs on a subsequent deal/play/flip/move of the same piece", () => {
    const map: PlacementMap = {
      A: { zone: "trick", seat: 0, index: 0, count: 2, faceUp: true },
      B: { zone: "trick", seat: 1, index: 1, count: 2, faceUp: true },
    };

    // deal clears it (goes through moveTo, same as draw/play).
    seed(map);
    applyEventToTable({ t: "collect", pieces: ["A", "B"], to: 2 });
    expect(useTableStore.getState().placements.B!.motionDelayMs).toBeGreaterThan(0);
    applyEventToTable({ t: "deal", piece: "B", to: 0, faceUp: true });
    expect(useTableStore.getState().placements.B!.motionDelayMs).toBeUndefined();

    // play clears it.
    seed(map);
    applyEventToTable({ t: "collect", pieces: ["A", "B"], to: 2 });
    applyEventToTable({ t: "play", piece: "B", from: 0, to: "trick" });
    expect(useTableStore.getState().placements.B!.motionDelayMs).toBeUndefined();

    // flip clears it.
    seed(map);
    applyEventToTable({ t: "collect", pieces: ["A", "B"], to: 2 });
    applyEventToTable({ t: "flip", piece: "B", faceUp: true });
    expect(useTableStore.getState().placements.B!.motionDelayMs).toBeUndefined();

    // move clears it too, even though the caller-built Placement rarely
    // mentions motionDelayMs at all.
    seed(map);
    applyEventToTable({ t: "collect", pieces: ["A", "B"], to: 2 });
    applyEventToTable({
      t: "move",
      piece: "B",
      to: { zone: "line", index: 0, count: 1, faceUp: true },
    });
    expect(useTableStore.getState().placements.B!.motionDelayMs).toBeUndefined();
  });
});
