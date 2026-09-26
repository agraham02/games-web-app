// @vitest-environment jsdom

/**
 * Held cards are React state and their marks are store state. The marks
 * used to be written from inside React's state updater, which React may run
 * while rendering — reported online in BS as "Cannot update a component
 * (`Piece`) while rendering a different component (`RoomScreen`)".
 */

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { Placement } from "@/engine/types";
import { togglePlayCard } from "@/app/play/bs/table";
import { useTableStore } from "./store";
import { useHeldMarks } from "./useHeldMarks";

const card = (index: number): Placement => ({ zone: "hand", seat: 0, index, count: 3, faceUp: true });
const MARKS = { selected: true, highlighted: true } as const;
const marks = (id: string) => {
  const p = useTableStore.getState().placements[id];
  return { selected: Boolean(p?.selected), highlighted: Boolean(p?.highlighted) };
};

describe("useHeldMarks", () => {
  beforeEach(() => {
    useTableStore.getState().reset({ SA: card(0), H2: card(1), D3: card(2) }, {});
  });

  it("marks what is held and unmarks what is put back", () => {
    const { rerender } = renderHook(({ held }) => useHeldMarks(held, MARKS, 0), {
      initialProps: { held: ["SA", "H2"] },
    });
    expect(marks("SA")).toEqual({ selected: true, highlighted: true });
    expect(marks("H2")).toEqual({ selected: true, highlighted: true });

    rerender({ held: ["H2"] });
    expect(marks("SA")).toEqual({ selected: false, highlighted: false });
    expect(marks("H2")).toEqual({ selected: true, highlighted: true });
  });

  it("puts the marks back when a batch resets the store", () => {
    const { rerender } = renderHook(({ tick }) => useHeldMarks(["D3"], MARKS, tick), {
      initialProps: { tick: 0 },
    });
    useTableStore.getState().reset({ SA: card(0), H2: card(1), D3: card(2) }, {});
    expect(marks("D3").selected).toBe(false);
    rerender({ tick: 1 });
    expect(marks("D3")).toEqual({ selected: true, highlighted: true });
  });

  it("leaves the store alone when a card is picked up — the toggle is pure", () => {
    const before = useTableStore.getState().placements;
    expect(togglePlayCard([], "SA")).toEqual(["SA"]);
    expect(togglePlayCard(["SA"], "SA")).toEqual([]);
    expect(useTableStore.getState().placements).toBe(before);
  });
});
