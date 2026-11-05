// @vitest-environment jsdom

/**
 * Large symbols: a player's parents could not read the rank and suit of a
 * Spades hand on a phone, so a setting makes them big — corner index and suit
 * on a card, bigger dots on a domino — for every game that draws either.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BS_SETTINGS } from "@/app/play/bs/table";
import { DOMINO_SETTINGS } from "@/app/play/dominoes/table";
import SpadesPlayPage from "@/app/play/spades/page";
import { SPADES_SETTINGS } from "@/app/play/spades/table";
import { POKER_SETTINGS } from "@/app/play/poker/table";
import { RUMMY_SETTINGS } from "@/app/play/rummy/table";
import { CardFace } from "@/ui/primitives/CardFace";
import { TileFace } from "@/ui/primitives/TileFace";
import { LARGE_SYMBOLS_SETTING } from "./gameSettings";
import { HAND_FLOORS, LARGE_HAND_FLOORS, LARGE_TILE_FLOORS, MIN_HAND_GAP_FRACTION, handFloorOf } from "./geometry";
import { useTableStore } from "./store";

vi.mock("react-confetti", () => ({ default: () => null }));

/** The size of the first text node's own span, in px. */
function rankSize(container: HTMLElement): number {
  const rank = [...container.querySelectorAll("span")].find((s) => s.textContent === "K");
  return parseFloat(rank!.style.fontSize);
}

describe("a card face", () => {
  it("draws its rank and suit bigger, and without pips, when large", () => {
    const small = render(<CardFace card="SK" w={100} h={140} />);
    const big = render(<CardFace card="SK" w={100} h={140} large />);

    expect(rankSize(big.container)).toBeGreaterThan(rankSize(small.container) * 1.5);
    // Still says what it is to a screen reader.
    expect(within(big.container).getByRole("img").getAttribute("aria-label")).toBe(
      within(small.container).getByRole("img").getAttribute("aria-label"),
    );
    // The court panel's own letter is gone: one K, not two.
    expect([...big.container.querySelectorAll("span")].filter((s) => s.textContent === "K")).toHaveLength(1);
  });

  it("enlarges a joker's corner label too", () => {
    const size = (large: boolean) => {
      const { container } = render(<CardFace card="XB" w={100} h={140} large={large} />);
      return parseFloat([...container.querySelectorAll("span")].find((s) => s.textContent === "BIG")!.style.fontSize);
    };
    expect(size(true)).toBeGreaterThan(size(false));
  });
});

describe("a domino face", () => {
  it("draws bigger dots when large", () => {
    const dot = (large: boolean) => {
      const { container } = render(<TileFace tile="6-3" w={50} h={100} large={large} />);
      // Every cell is a span; inked ones have a background colour.
      const inked = [...container.querySelectorAll("span")].find((s) => s.style.background.includes("suit-ink"));
      return parseFloat(inked!.style.width);
    };
    expect(dot(true)).toBeGreaterThan(dot(false) * 1.4);
  });
});

describe("the setting", () => {
  it("is offered by every game that draws cards or dominoes", () => {
    for (const list of [SPADES_SETTINGS, RUMMY_SETTINGS, BS_SETTINGS, DOMINO_SETTINGS, POKER_SETTINGS]) {
      expect(list).toContain(LARGE_SYMBOLS_SETTING);
    }
  });

  it("is off until asked for, and shared by every game", () => {
    expect(LARGE_SYMBOLS_SETTING.default).toBe(false);
    expect(LARGE_SYMBOLS_SETTING.shared).toBe(true);
  });
});

describe("on a real table", () => {
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

  it("switches from Settings, and spreads the hand out wider", async () => {
    render(<SpadesPlayPage />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /deal in/i }));
    });
    expect(useTableStore.getState().largeSymbols).toBe(false);
    expect(useTableStore.getState().handFloor).toBe(MIN_HAND_GAP_FRACTION);

    fireEvent.click(await screen.findByRole("button", { name: /settings/i }));
    fireEvent.click(await screen.findByRole("switch", { name: /large symbols/i }));
    expect(useTableStore.getState().largeSymbols).toBe(true);
    expect(useTableStore.getState().handFloor).toBe(LARGE_HAND_FLOORS.comfortable);

    // Each choice keeps its meaning, wider.
    fireEvent.click(screen.getByRole("button", { name: "Roomy" }));
    expect(useTableStore.getState().handFloor).toBe(LARGE_HAND_FLOORS.roomy);
    fireEvent.click(screen.getByRole("button", { name: "Fit all" }));
    expect(useTableStore.getState().handFloor).toBe(LARGE_HAND_FLOORS.fit);

    // Off again: the ordinary floor for the same choice comes back.
    fireEvent.click(screen.getByRole("switch", { name: /large symbols/i }));
    expect(useTableStore.getState().largeSymbols).toBe(false);
    expect(useTableStore.getState().handFloor).toBe(HAND_FLOORS.fit);

    fireEvent.click(screen.getByRole("button", { name: "Comfortable" }));
  });
});

describe("the hand floors", () => {
  it("are wider with large symbols on, for every choice, and keep their order", () => {
    for (const choice of ["fit", "comfortable", "roomy"] as const) {
      expect(handFloorOf(choice, true)).toBeGreaterThan(handFloorOf(choice));
    }
    expect(LARGE_HAND_FLOORS.fit).toBeLessThan(LARGE_HAND_FLOORS.comfortable);
    expect(LARGE_HAND_FLOORS.comfortable).toBeLessThan(LARGE_HAND_FLOORS.roomy);
  });

  it("fall back to Comfortable for a value nobody recognises", () => {
    expect(handFloorOf("nonsense")).toBe(MIN_HAND_GAP_FRACTION);
    expect(handFloorOf(undefined, true)).toBe(LARGE_HAND_FLOORS.comfortable);
  });

  it("gives a rack its own, wider floors: Comfortable and Roomy never overlap tiles", () => {
    for (const choice of ["fit", "comfortable", "roomy"] as const) {
      expect(handFloorOf(choice, true, true)).toBe(LARGE_TILE_FLOORS[choice]);
    }
    expect(handFloorOf("comfortable", true, true)).toBeGreaterThanOrEqual(1);
    // The ordinary rack is untouched.
    expect(handFloorOf("comfortable", false, true)).toBe(HAND_FLOORS.comfortable);
  });
});
