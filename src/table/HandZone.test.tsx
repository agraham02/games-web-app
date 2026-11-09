// @vitest-environment jsdom

/** The action bar while a move is on its way. */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveTable } from "./geometry";
import { HandZone } from "./HandZone";
import { useTableStore } from "./store";

beforeEach(() => useTableStore.getState().setGeometry(resolveTable({ seats: 4, width: 390, height: 844 })));
afterEach(() => {
  cleanup();
  useTableStore.getState().setMoveInFlight(false);
  useTableStore.getState().setHeroTurn(false);
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

describe("HandZone, on your turn", () => {
  // The user, 2026-11-02: a bigger sign of the viewer's own turn. The strip
  // over the hand lights up for it, and only for it.
  const glow = (container: HTMLElement) => container.querySelector<HTMLElement>('[aria-hidden="true"]')!;
  const opacity = (el: HTMLElement) => Number(el.style.opacity || 0);

  it("is dark until the turn is yours, lit while it is, and dark again after", async () => {
    const { container } = render(<HandZone />);
    expect(opacity(glow(container))).toBe(0);

    act(() => useTableStore.getState().setHeroTurn(true));
    await waitFor(() => expect(opacity(glow(container))).toBeGreaterThan(0.3));

    act(() => useTableStore.getState().setHeroTurn(false));
    await waitFor(() => expect(opacity(glow(container))).toBe(0));
  });

  it("never lights a table that has no host to say whose turn it is", () => {
    // `heroTurnActive` defaults true so nothing dims by omission; this one
    // must default the other way, or every lab page would glow for ever.
    expect(useTableStore.getState().heroTurn).toBe(false);
  });

  it("does not catch a tap meant for the cards underneath", () => {
    const { container } = render(<HandZone />);
    expect(glow(container).className).toContain("pointer-events-none");
  });
});
