// @vitest-environment jsdom

/**
 * The dice overlay against the clock the chips wait on.
 *
 * Reported: the roll and the chips it decides looked simultaneous. The
 * dice used to be drawn on their own clock off `lastAction`, which lands
 * when a turn ARRIVES, while the chips waited on a separate `pause`; the
 * two drifted apart. The dice are now an event in the chips' own queue,
 * and this pins the other half: the overlay reacts to that event, and has
 * finished tumbling by the time the choreographer lets a chip move.
 */

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DURATION } from "@/motion/presets";
import { createRng } from "@/engine/rng";
import { createLrc } from "@/games/lrc/rules";
import { emitDice } from "@/table/fx";
import { resolveTable } from "@/table/geometry";
import { useTableStore } from "@/table/store";
import type { GameRuntime } from "@/table/useGameRuntime";
import type { LrcAction, LrcState } from "@/games/lrc/types";
import { LrcControls, OFFLINE_VIEW } from "./table";

// A real dealt state: the band counts the pot from it.
const lrc = createLrc();
const live = {
  state: lrc.setup({ seats: 3, rng: createRng(1) }),
  isHeroTurn: false,
  busy: true,
  submitAction: () => {},
} as unknown as GameRuntime<LrcState, LrcAction>;

// A spectator's view: the stub runtime has no state, and a spectator holds
// no chips for the band to count. The dice are the same for everybody.
const view = { ...OFFLINE_VIEW, viewerSeat: -1 };

const shown = () => screen.queryAllByLabelText(/^die showing/).map((el) => el.getAttribute("aria-label"));

describe("the dice overlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The dice sit on the table's centre, so there has to be a table.
    useTableStore.getState().setGeometry(resolveTable({ seats: 3, width: 390, height: 844 }));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
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
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows nothing until dice are thrown", () => {
    render(<LrcControls view={view} live={live} />);
    expect(shown()).toEqual([]);
  });

  it("tumbles the moment the roll is played, and settles before any chip may move", () => {
    render(<LrcControls view={view} live={live} />);
    act(() => emitDice({ seat: 1, faces: ["L", "C", "R"] }));
    // On screen at once — not waiting behind a previous roll's exit.
    expect(shown()).toHaveLength(3);

    const seen = new Set<string>();
    const tumbleMs = DURATION.diceTumble * 1000;
    for (let t = 0; t < tumbleMs; t += 50) {
      seen.add(shown().join("|"));
      act(() => {
        vi.advanceTimersByTime(50);
      });
    }
    // It actually tumbled...
    expect(seen.size).toBeGreaterThan(2);
    // ...and has landed on the real roll by the end of the tumble, which
    // is before the choreographer releases the first chip (tumble + read).
    const real = ["die showing L", "die showing C", "die showing R"];
    expect(shown()).toEqual(real);
    act(() => {
      vi.advanceTimersByTime(DURATION.diceRead * 1000);
    });
    expect(shown()).toEqual(real);
  });

  it("tumbles from the press, before the result is known, and lands on it when it comes", () => {
    // Online the roll is the server's: the dice must not sit still for the
    // round trip (the user, 2026-10-02).
    render(<LrcControls view={view} live={live} />);
    act(() => emitDice({ seat: 0, faces: null, count: 3 }));
    expect(shown()).toHaveLength(3);
    const seen = new Set<string>();
    for (let t = 0; t < 2_000; t += 50) {
      seen.add(shown().join("|"));
      act(() => {
        vi.advanceTimersByTime(50);
      });
    }
    // Still tumbling, well past an ordinary tumble: it is waiting.
    expect(seen.size).toBeGreaterThan(2);
    act(() => emitDice({ seat: 0, faces: ["L", "C", "R"] }));
    act(() => {
      vi.advanceTimersByTime(DURATION.diceTumble * 1000);
    });
    expect(shown()).toEqual(["die showing L", "die showing C", "die showing R"]);
  });

  it("stops tumbling a throw whose result never comes", () => {
    render(<LrcControls view={view} live={live} />);
    act(() => emitDice({ seat: 0, faces: null, count: 2 }));
    const after = (ms: number) => {
      for (let t = 0; t < ms; t += 100) {
        act(() => {
          vi.advanceTimersByTime(100);
        });
      }
      return shown().join("|");
    };
    // Given up (and fading out): nothing moves any more.
    const settled = after(10_000);
    expect(after(1_000)).toBe(settled);
  });

  it("shows the result without the tumble under reduced motion", () => {
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: media.includes("reduce"),
      media,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    render(<LrcControls view={view} live={live} />);
    act(() => emitDice({ seat: 1, faces: ["dot", "L", "dot"] }));
    expect(shown()[1]).toBe("die showing L");
  });
});
