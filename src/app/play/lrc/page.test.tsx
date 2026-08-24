// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LrcPlayPage from "./page";
import { useTableStore } from "@/table/store";

/**
 * A won MATCH fires `HeroWinFlourish`'s confetti. `react-confetti`
 * drives a real particle simulation onto a `<canvas>` via its own
 * internal animation-frame loop — jsdom has no canvas at all (stubbing
 * just `getContext` gets past the constructor, but its `update()` loop
 * then reaches for other browser-only machinery this test has no
 * reason to also fake). None of that is anything this test is actually
 * checking; the match ending is. A plain stub renders nothing, which is
 * exactly what a passed test needs from it.
 */
vi.mock("react-confetti", () => ({
  default: () => null,
}));

/**
 * An end-to-end smoke test for the actual reported bug — "I load in but
 * nothing happens" — which no other check in this repo could see.
 *
 * `tsc` proves the props typecheck. The production build prerenders the
 * page in its pre-game SETUP state, never past clicking "Deal in". And
 * every existing `setup.test.tsx`-style render test (Dominoes') stops at
 * the setup screen on purpose, because mounting the real table needs
 * things jsdom does not provide out of the box: `ResizeObserver`,
 * `matchMedia`, and real element measurements (`getBoundingClientRect`
 * always returns all-zero boxes in jsdom). None of those had ever been
 * stubbed in this repo, which means the mount path a real player hits
 * the instant they click "Deal in" had literally never been executed by
 * anything before this file.
 *
 * Fake timers vs. real timers, and why this file uses both:
 * `vi.advanceTimersByTime` reliably drives the opening deal (pure
 * `setTimeout`-based choreographer pacing, no user interaction), but a
 * click on a `motion.button` mid-animation, driven through fake timers,
 * was observed to silently not register — confirmed by direct
 * comparison: the identical click, under real timers with a wait long
 * enough to cross `HERO_REVEAL_MS` (~650ms), worked every time. That
 * gap is a jsdom / fake-timer / Motion interaction, not a bug in the
 * game — an isolated `motion.button` with no game code at all fails the
 * exact same way under fake timers. So: fake timers for the
 * non-interactive deal check, real timers (with adequately long waits)
 * for anything that clicks something.
 */

function stubResizeObserver() {
  class FakeResizeObserver {
    constructor(private cb: ResizeObserverCallback) {}
    observe() {
      // Fire once, synchronously enough for the effect that reads
      // `size` to see it — matches a real observer's initial callback.
      this.cb([], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
}

function stubMatchMedia() {
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
}

/** A plausible phone-sized box — jsdom's real `getBoundingClientRect`
 * always returns all zeros, which `TableSurface` explicitly treats as
 * "not yet measured" and never resolves geometry from. */
function stubMeasuredSize() {
  const rect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 390,
    bottom: 844,
    width: 390,
    height: 844,
    toJSON() {
      return this;
    },
  } as DOMRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("LRC play page — the game actually starts", () => {
  beforeEach(() => {
    stubResizeObserver();
    stubMatchMedia();
    stubMeasuredSize();
    // Deterministic across runs: randomSeed() (engine/rng.ts) is the
    // ONLY legitimate Math.random() call in this codebase (everything
    // else goes through a seeded Rng), so fixing it fixes the whole
    // match — which seat cuts first, every die roll, all of it.
    vi.spyOn(Math, "random").mockReturnValue(0.42);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the setup screen without crashing", () => {
    render(<LrcPlayPage />);
    expect(screen.getByText("Left Right Center")).toBeTruthy();
    expect(screen.getByText("Rounds to win")).toBeTruthy();
  });

  it("deals real chips onto the table the instant you click Deal in — the reported bug", () => {
    vi.useFakeTimers();
    render(<LrcPlayPage />);

    // Before the click: nothing has mounted the table yet.
    expect(Object.keys(useTableStore.getState().placements)).toHaveLength(0);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Deal in" }));
    });

    // useGameRuntime's mount effect runs synchronously inside the
    // click's own commit (no timer needed to reach this far) — this is
    // exactly the point a genuinely stuck mount would still be stuck at.
    const afterMount = useTableStore.getState().placements;
    expect(Object.keys(afterMount).length).toBeGreaterThan(0);

    // Advance well past the opening deal's whole animation AND the
    // first turn-hold — long enough that, win or lose the opening cut,
    // something has moved off the initial six-chips-in-the-bank state.
    act(() => {
      vi.advanceTimersByTime(15_000);
    });

    const settled = useTableStore.getState().placements;
    const stillAllBanked = Object.values(settled).every((p) => p.zone === "boneyard");
    expect(stillAllBanked).toBe(false);

    // Every chip is accounted for throughout — the deal must not have
    // dropped or duplicated one on the way out of the bank.
    expect(Object.keys(settled)).toHaveLength(18); // 6 seats * 3 chips
  });

  /**
   * A real interactive drive-through: click Roll whenever it is the
   * hero's turn, click "Next round" whenever a round has ended, and
   * nothing else — the same two buttons a real player has. This proves
   * the second half of the report: that a round win is retained toward
   * a match total rather than being thrown away the moment the next
   * round deals (the game used to have no round concept at all — every
   * "New Game" was a wholly independent pot).
   *
   * Target is dialled down to 2 via the setup screen's own stepper (the
   * same control a player has), and seats down to the minimum of 3 —
   * fewer players circulating chips means fewer rolls per round, which
   * is what keeps a REAL, wall-clock-timed match inside a reasonable
   * test budget without changing what the test actually proves.
   *
   * Real timers throughout — see the file doc for why. Each poll waits
   * long enough to cross HERO_REVEAL_MS (~650ms) before re-checking, so
   * a click's actual effect has had time to land before being judged.
   *
   * Deliberately does not special-case "the hero happened to open" vs.
   * "a bot opened" — a real session can land either way, and the drive
   * loop below handles both without knowing which happened.
   */
  it(
    "plays through multiple rounds and keeps the score, all the way to a real match winner",
    async () => {
      render(<LrcPlayPage />);

      fireEvent.change(screen.getByRole("slider"), { target: { value: "3" } });
      expect(screen.getByText("Players — 3")).toBeTruthy();

      const fewer = screen.getAllByRole("button", { name: /Fewer round/i })[0]!;
      fireEvent.click(fewer);
      fireEvent.click(fewer);
      fireEvent.click(fewer); // 5 -> 2, clamped at the stepper's own min
      expect(screen.getByText("2")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Deal in" }));

      let sawRoundTwo = false;
      let matchOver = false;

      for (let poll = 0; poll < 150 && !matchOver; poll++) {
        await act(async () => {
          await wait(800);
        });

        const rollBtn = screen.queryByRole("button", { name: "Roll" });
        if (rollBtn) fireEvent.click(rollBtn);

        const nextRoundBtn = screen.queryByRole("button", { name: "Next round" });
        if (nextRoundBtn) fireEvent.click(nextRoundBtn);

        // The literal bug report: confirm a second round is genuinely
        // reached at all — the old shape had no round concept, so
        // there was nothing to reach.
        if (screen.queryByText("Round 2")) sawRoundTwo = true;
        if (screen.queryByText(/Rematch/i)) matchOver = true;
      }

      expect(sawRoundTwo, "a second round was never reached").toBe(true);
      expect(matchOver, "the match never reached a game-end screen").toBe(true);
      expect(screen.getByText(/Rematch/i)).toBeTruthy();
    },
    120_000,
  );
});
