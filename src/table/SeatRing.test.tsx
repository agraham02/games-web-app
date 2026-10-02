// @vitest-environment jsdom

/** The turn timer's ring goes round the pod whose move it is, and only that one. */

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveTable } from "./geometry";
import { SeatRing, type SeatView } from "./SeatRing";
import { useTableStore } from "./store";

beforeEach(() => useTableStore.getState().setGeometry(resolveTable({ seats: 4, width: 390, height: 844 })));
afterEach(cleanup);

describe("SeatRing and the turn timer", () => {
  it("draws the ring round the pod on the clock", () => {
    const players: SeatView[] = [0, 1, 2, 3].map((seat) => ({
      seat,
      name: `P${seat}`,
      colour: "red",
      timer: seat === 2 ? { key: "turn:4:2", totalMs: 5_000, endsAt: Date.now() + 5_000 } : null,
    }));
    const { container } = render(<SeatRing players={players} />);
    expect(container.querySelectorAll('[data-testid="countdown-ring"]')).toHaveLength(1);
  });

  it("draws none when nobody's clock is running", () => {
    const players: SeatView[] = [0, 1, 2, 3].map((seat) => ({ seat, name: `P${seat}`, colour: "red" }));
    const { container } = render(<SeatRing players={players} />);
    expect(container.querySelectorAll('[data-testid="countdown-ring"]')).toHaveLength(0);
  });
});

describe("SeatRing and a slow link", () => {
  it("marks the pod of somebody whose connection is slow, and only theirs", () => {
    const players: SeatView[] = [0, 1, 2, 3].map((seat) => ({
      seat,
      name: `P${seat}`,
      colour: "red",
      weakLink: seat === 1,
    }));
    const { getAllByRole } = render(<SeatRing players={players} />);
    expect(getAllByRole("img", { name: /connection is slow/ }).map((e) => e.getAttribute("aria-label"))).toEqual([
      "P1's connection is slow",
    ]);
  });

  it("says nothing of the link once a bot is playing the seat", () => {
    const players: SeatView[] = [0, 1, 2, 3].map((seat) => ({
      seat,
      name: `P${seat}`,
      colour: "red",
      weakLink: seat === 1,
      away: seat === 1,
    }));
    const { queryAllByRole } = render(<SeatRing players={players} />);
    expect(queryAllByRole("img", { name: /connection is slow/ })).toHaveLength(0);
  });
});
