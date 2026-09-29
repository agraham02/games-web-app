// @vitest-environment jsdom

/**
 * Where an overflowing hand starts. A pan of 0 centres the fan, which hid a
 * card off each end of a 13-card hand on a phone before the player had
 * touched anything; it starts flush at the near edge instead, and stays
 * there as the deal adds cards, until the player drags it.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handFanMaxScroll, resolveTable } from "./geometry";
import { HandPan } from "./HandPan";
import { useTableStore } from "./store";

// An iPhone in portrait: ten cards fit at half a card each, thirteen do not.
const g = resolveTable({ seats: 4, width: 390, height: 844 });
const nearEdge = (count: number) => handFanMaxScroll(g, count) / 2;
const pan = () => useTableStore.getState().handScroll;

beforeEach(() => useTableStore.getState().setGeometry(g));
afterEach(cleanup);

describe("an overflowing hand", () => {
  it("fits ten cards on a phone, and pans thirteen", () => {
    expect(handFanMaxScroll(g, 10)).toBe(0);
    expect(handFanMaxScroll(g, 13)).toBeGreaterThan(0);
  });

  it("starts flush at its near edge, not centred", () => {
    render(<HandPan count={13} />);
    expect(pan()).toBeCloseTo(nearEdge(13), 6);
  });

  it("stays at the near edge while the deal adds cards", () => {
    const { rerender } = render(<HandPan count={0} />);
    expect(pan()).toBe(0);
    for (const count of [10, 11, 12, 13]) {
      rerender(<HandPan count={count} />);
      expect(pan(), `${count} cards`).toBeCloseTo(nearEdge(count), 6);
    }
  });

  it("leaves a pan the player moved alone, until the next deal", () => {
    const { rerender } = render(<HandPan count={13} />);
    act(() => useTableStore.getState().setHandScroll(-20));
    rerender(<HandPan count={12} />);
    expect(pan(), "a card played does not yank the hand back").toBe(-20);

    // The round ends with an empty hand; the next deal starts at the edge.
    rerender(<HandPan count={0} />);
    rerender(<HandPan count={13} />);
    expect(pan()).toBeCloseTo(nearEdge(13), 6);
  });

  it("hands the next game its plain fan back when it goes", () => {
    const { unmount } = render(<HandPan count={13} />);
    unmount();
    expect(pan()).toBeNull();
  });
});
