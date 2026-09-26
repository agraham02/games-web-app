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
import { emitDice } from "@/table/fx";
import type { GameRuntime } from "@/table/useGameRuntime";
import type { LrcAction, LrcState } from "@/games/lrc/types";
import { LrcControls } from "./table";

const live = {
  isHeroTurn: false,
  busy: true,
  submitAction: () => {},
} as unknown as GameRuntime<LrcState, LrcAction>;

const shown = () => screen.queryAllByLabelText(/^die showing/).map((el) => el.getAttribute("aria-label"));

describe("the dice overlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
    render(<LrcControls live={live} />);
    expect(shown()).toEqual([]);
  });

  it("tumbles the moment the roll is played, and settles before any chip may move", () => {
    render(<LrcControls live={live} />);
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
    render(<LrcControls live={live} />);
    act(() => emitDice({ seat: 1, faces: ["dot", "L", "dot"] }));
    expect(shown()[1]).toBe("die showing L");
  });
});
