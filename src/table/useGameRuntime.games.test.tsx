// @vitest-environment jsdom
/**
 * Every game, driven through the real hook.
 *
 * This exists because of a specific refactor: the loop that used to live
 * inside `useGameRuntime` moved out to `GameSession`, and the claim that
 * mattered was "no game behaves differently". One end-to-end page test
 * (LRC's) covers one game through one code path; this covers all five
 * through the hook itself, which is where the seam actually moved.
 *
 * What it deliberately does NOT assert is any game's rules — those have
 * ~500 tests of their own. The claim here is narrower and is exactly the
 * one the extraction could break: that a definition handed to the hook
 * still deals, still reconciles the table, still paces bot turns off the
 * choreographer rather than racing them, and still stops on the hero.
 */

import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameDefinition } from "@/engine/types";
import { HERO } from "@/engine/types";
import { dominoes } from "@/games/dominoes/rules";
import { lrc } from "@/games/lrc/rules";
import { bs } from "@/games/bs/rules";
import { poker } from "@/games/poker/rules";
import { rummy } from "@/games/rummy/rules";
import { spades } from "@/games/spades/rules";
import { useTableStore } from "./store";
import { useGameRuntime } from "./useGameRuntime";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GAMES: ReadonlyArray<{ name: string; definition: GameDefinition<any, any> }> = [
  { name: "LRC", definition: lrc },
  { name: "Dominoes", definition: dominoes },
  { name: "Spades", definition: spades },
  { name: "Rummy 500", definition: rummy },
  { name: "Poker", definition: poker },
  { name: "BS", definition: bs },
];

/** Four seats is legal for all six games, so one number covers the table. */
const SEATS = 4;

describe("useGameRuntime — every game still runs through the extracted session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom implements no media queries and `prefersReducedMotion()` asks
    // for one on every drain. `matches: false` is the case worth
    // exercising — reduced motion collapses every wait to zero, which
    // would make the pacing assertions vacuous.
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
    // The placement store is a module-level singleton shared by every
    // table in the process, so one game's board would otherwise still be
    // sitting there when the next test mounts.
    useTableStore.getState().reset({}, {});
  });

  for (const { name, definition } of GAMES) {
    it(`${name}: deals onto the table and reconciles real placements`, () => {
      const { result } = renderHook(() =>
        useGameRuntime(definition, { seats: SEATS, seed: 4242 }),
      );

      // The opening deal is dispatched synchronously on mount, then
      // animates. Run it out.
      act(() => {
        vi.advanceTimersByTime(20_000);
      });

      const placements = useTableStore.getState().placements;
      expect(Object.keys(placements).length).toBeGreaterThan(0);

      // Whatever the board shows must be the game's own account of it —
      // this is the self-correcting reconcile, and it is the single thing
      // most likely to break if the settle path were rewired wrongly.
      const truth = definition.placements(result.current.rawState, HERO);
      expect(Object.keys(placements).sort()).toEqual(Object.keys(truth).sort());
    });

    it(`${name}: paces to a stopping point rather than racing to the end`, () => {
      const { result } = renderHook(() =>
        useGameRuntime(definition, { seats: SEATS, seed: 99 }),
      );

      act(() => {
        vi.advanceTimersByTime(60_000);
      });

      // A settled table is in exactly one of these states. The failure
      // this guards against is the loop stalling silently — sitting with
      // a bot on turn, nothing scheduled, and no way for a player to act.
      const seat = definition.currentSeat(result.current.rawState);
      const parked =
        result.current.isOver ||
        (definition.isRoundOver?.(result.current.rawState) ?? false) ||
        seat === null ||
        seat === HERO ||
        result.current.pendingReveal;

      expect(parked).toBe(true);
    });
  }

  it("refuses a hero action when it is not the hero's turn, leaving state untouched", () => {
    // The gate moved into `GameSession.submit` during the extraction, so
    // it is worth pinning that it still applies from the hook's side.
    //
    // Manual mode is what makes this deterministic: with auto-advance off
    // the loop parks with a bot's turn computed but unrevealed, so there
    // is a stable window where somebody other than the hero is on turn.
    // Under auto-advance the bots would play straight back round to the
    // hero and there would be nothing to test against.
    const { result } = renderHook(() =>
      useGameRuntime(spades, { seats: SEATS, seed: 17, autoAdvance: false }),
    );

    act(() => {
      vi.advanceTimersByTime(20_000);
    });

    // Asserted rather than branched on: a precondition inside an `if` is
    // how a test quietly stops testing anything the day the setup shifts.
    const before = result.current.rawState;
    expect(spades.currentSeat(before)).not.toBe(HERO);

    // Borrow the action the seat that IS on turn would legitimately make,
    // so the only thing wrong with the submission is who sent it. A
    // made-up card would prove nothing: Spades' own `reduce` discards an
    // illegal play regardless, so the test would pass with the gate gone.
    const theirMove = spades.legalActions(before, spades.currentSeat(before)!)[0]!;
    act(() => {
      result.current.submitAction(theirMove);
    });
    expect(result.current.rawState).toBe(before);
  });

  it("keeps a manual-mode bot turn pending until advance() is called", () => {
    // `autoAdvance` is live through DevPanel, and the extraction made it a
    // `configure()` call rather than a captured constructor value — so the
    // thing worth proving is that flipping it still actually holds a turn.
    const { result } = renderHook(() =>
      useGameRuntime(spades, { seats: SEATS, seed: 17, autoAdvance: false }),
    );

    act(() => {
      vi.advanceTimersByTime(20_000);
    });

    expect(result.current.pendingReveal).toBe(true);

    const before = result.current.rawState;
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.rawState).toBe(before); // Time alone must not move it.

    act(() => {
      result.current.advance();
    });
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(result.current.rawState).not.toBe(before);
  });

  describe("StrictMode's double mount", () => {
    /**
     * React runs mount -> cleanup -> mount in development, against the same
     * session object. That cleanup cancels whatever turn was scheduled, and
     * the `started` ref makes the second mount a no-op — so unless the
     * second mount RE-ARMS the loop, the game dies before its first bot
     * turn.
     *
     * It went unreachable for a long time by luck. The hazard needs the
     * opening batch to drain SYNCHRONOUSLY, so that `settled()` runs inside
     * the mount effect and schedules a turn the cleanup immediately kills.
     * Every game's opening deal was dozens of real animations, so the drain
     * was always async and the cleanup always ran first. Rummy's
     * `startRound` stopped dealing when the deal-size choice became a real
     * turn for any seat, and its opening batch became a single
     * zero-duration `phase` — at which point a bot dealer never dealt at
     * all, and the table sat at "stock empty" forever.
     *
     * Found by running the app, which is the only place StrictMode is on.
     */
    for (const { name, definition } of GAMES) {
      it(`${name}: still runs its first bot turn after a double mount`, () => {
        const { result, rerender } = renderHook(
          () => useGameRuntime(definition, { seats: SEATS, seed: 4242 }),
          { wrapper: StrictMode },
        );
        rerender();

        // Let every hold, think and animation resolve.
        act(() => {
          vi.advanceTimersByTime(30_000);
        });

        const state = result.current.rawState as Record<string, unknown>;
        const seat = definition.currentSeat(state);
        // Either a human is being waited on, or the game is over. What must
        // NOT happen is the loop parking on a seat no human occupies — that
        // is a turn nobody will ever take.
        const parkedOnABot = seat !== null && seat !== HERO;
        expect(
          parkedOnABot,
          `${name} parked on seat ${seat}, which no human is sitting in`,
        ).toBe(false);
      });
    }
  });
});
