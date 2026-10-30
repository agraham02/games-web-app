import { describe, expect, it } from "vitest";
import type { ChromalyRules } from "./types";
import { playMatch } from "./testkit";

/** The house-rule bundles the setup offers, as plain rule sets. */
const PRESETS: Record<string, Partial<ChromalyRules>> = {
  classic: {},
  party: { drawToMatch: true, stacking: "upward", jumpIn: true, sevenZero: true },
  caribbean: { doubles: true },
  everything: {
    drawToMatch: true,
    forcePlay: true,
    stacking: "same",
    plusFour: "free",
    jumpIn: true,
    sevenZero: true,
    doubles: true,
    shuffleHands: true,
  },
  honest: { plusFour: "honest", stacking: "upward" },
};

describe("whole matches", () => {
  for (const [name, rules] of Object.entries(PRESETS)) {
    for (const seats of [2, 3, 4, 7, 10]) {
      it(`${name}, ${seats} seats: ends, keeps the deck whole, and only ever chooses legal actions`, () => {
        // Several seeds, because the bugs this finds are one position in
        // thousands: a window left open with nobody in it survived the single
        // seed this used to run and was found by a pooled bot match.
        for (let seed = 0; seed < 8; seed++) {
          // A low target keeps the sweep quick; the rules are what is under test.
          const played = playMatch({ rules: { ...rules, target: 100 }, seats, seed: seed * 101 + seats * 31 + name.length });
          expect(played.state.winner).not.toBeNull();
          expect(played.rounds).toBeGreaterThan(0);
        }
      });
    }
  }
});
