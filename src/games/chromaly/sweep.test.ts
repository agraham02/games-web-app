import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import type { ChromalyAction, ChromalyRules } from "./types";
import { createChromaly } from "./rules";
import { everyCard, playMatch } from "./testkit";

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
  // The setup's Crazy preset, exactly: every house rule at its loudest.
  crazy: {
    drawToMatch: true,
    forcePlay: true,
    stacking: "upward",
    plusFour: "challenge",
    jumpIn: true,
    sevenZero: true,
    doubles: true,
    shuffleHands: true,
  },
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

describe("a person's moves", () => {
  // Bots only ever make the moves a bot would, so a sweep of bot matches
  // cannot see a path only a person takes. Seat 0 here plays like one: any
  // legal move at random, its own turn or a window it may answer. Written
  // while hunting "my drawn wild was played for me" (the user, 2026-10-31):
  // were the card just drawn ever left marked once its turn was over, the
  // next seat on turn would play it out of the wrong hand.
  it("never leave a drawn card marked past its turn, and keep the deck whole", () => {
    const def = createChromaly({ ...PRESETS.crazy, target: 100 });
    for (let seed = 0; seed < 60; seed++) {
      const rng = createRng(seed);
      let state = def.setup({ seats: 4, rng });
      state = def.startRound!(state, rng).state;
      const total = everyCard(state).length;
      for (let steps = 0; !def.isOver(state) && steps < 4000; steps++) {
        if (def.isRoundOver!(state)) {
          state = def.startRound!(state, rng).state;
          continue;
        }
        let seat = def.currentSeat(state)!;
        let action: ChromalyAction;
        const mine = def.legalActions(state, 0);
        if (mine.length > 0 && (seat === 0 || rng.next() < 0.5)) {
          seat = 0;
          action = mine[Math.floor(rng.next() * mine.length)]!;
        } else {
          action = def.bots.steady.choose(def.playerView(state, seat), seat, rng);
        }
        if (def.validate!(state, seat, action)) continue;
        state = def.reduce(state, action).state;
        if (state.drawn !== null) {
          expect(state.hands[state.turn], `seed ${seed}: ${state.drawn} marked drawn outside seat ${state.turn}'s hand`).toContain(state.drawn);
        }
        const all = everyCard(state);
        expect(new Set(all).size, `seed ${seed}: deck not whole after ${JSON.stringify(action)}`).toBe(total);
        expect(all).toHaveLength(total);
      }
    }
  });
});
