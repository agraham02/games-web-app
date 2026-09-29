// @vitest-environment jsdom

/**
 * Card spacing, end to end on a real table: the player picks how condensed
 * their hand is in Settings (the user, 2026-09-29), and the hand's floor —
 * what the fan is drawn with and what it pans by — follows.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BS_SETTINGS } from "@/app/play/bs/table";
import { DOMINO_SETTINGS } from "@/app/play/dominoes/table";
import { POKER_SETTINGS } from "@/app/play/poker/table";
import { RUMMY_SETTINGS } from "@/app/play/rummy/table";
import { HAND_SPACING_SETTING } from "@/table/gameSettings";
import { HAND_FLOORS, MIN_HAND_GAP_FRACTION } from "@/table/geometry";
import { useTableStore } from "@/table/store";
import SpadesPlayPage from "./page";
import { SPADES_SETTINGS } from "./table";

vi.mock("react-confetti", () => ({ default: () => null }));

// A phone-sized, measured table: jsdom measures everything as 0x0, which
// `TableSurface` treats as not laid out yet (see the LRC page test).
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: ResizeObserverCallback) {}
      observe() {
        this.cb([], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 390, bottom: 844, width: 390, height: 844, toJSON() { return this; } };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect as DOMRect);
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Card spacing", () => {
  it("is offered by the games whose hand can outgrow a phone, and only those", () => {
    for (const list of [SPADES_SETTINGS, RUMMY_SETTINGS, BS_SETTINGS]) {
      expect(list).toContain(HAND_SPACING_SETTING);
    }
    // Two cards, and tiles that do not pan: the setting would do nothing.
    for (const list of [POKER_SETTINGS, DOMINO_SETTINGS]) {
      expect(list).not.toContain(HAND_SPACING_SETTING);
    }
  });

  it("changes how the hand is spaced from the Settings sheet", async () => {
    render(<SpadesPlayPage />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /deal in/i }));
    });
    expect(useTableStore.getState().handFloor).toBe(MIN_HAND_GAP_FRACTION);

    fireEvent.click(await screen.findByRole("button", { name: /settings/i }));
    const spacing = await screen.findByRole("group", { name: "Card spacing" });
    expect(within(spacing).getByRole("button", { name: "Comfortable" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(within(spacing).getByRole("button", { name: "Roomy" }));
    expect(useTableStore.getState().handFloor).toBeCloseTo(HAND_FLOORS.roomy, 6);

    fireEvent.click(within(spacing).getByRole("button", { name: "Fit all" }));
    expect(useTableStore.getState().handFloor).toBe(HAND_FLOORS.fit);

    // Put it back for anything else on the page's cache.
    fireEvent.click(within(spacing).getByRole("button", { name: "Comfortable" }));
  });
});
