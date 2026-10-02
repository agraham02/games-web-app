// @vitest-environment jsdom

/** The action bar while a move is on its way. */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveTable } from "./geometry";
import { HandZone } from "./HandZone";
import { useTableStore } from "./store";

beforeEach(() => useTableStore.getState().setGeometry(resolveTable({ seats: 4, width: 390, height: 844 })));
afterEach(() => {
  cleanup();
  useTableStore.getState().setMoveInFlight(false);
});

describe("HandZone, with a move on its way", () => {
  it("turns the bar's buttons off until the move is answered, so nothing is sent twice", () => {
    render(<HandZone bar={<button type="button">BS!</button>} panel={<button type="button">Raise</button>} />);
    expect(screen.getByRole("button", { name: "BS!" })).toBeEnabled();
    act(() => useTableStore.getState().setMoveInFlight(true));
    expect(screen.getByRole("button", { name: "BS!" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Raise" })).toBeDisabled();
    act(() => useTableStore.getState().setMoveInFlight(false));
    expect(screen.getByRole("button", { name: "BS!" })).toBeEnabled();
  });
});
