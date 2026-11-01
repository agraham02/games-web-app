import { describe, expect, it } from "vitest";
import type { BotDifficulty } from "@/engine/types";
import { TIERS } from "./bots";
import { playMatch } from "./testkit";
import type { ChromalyRules } from "./types";

/**
 * Two things, and they are different claims.
 *
 * REACHABILITY: Chromaly has two races (catching a last card, jumping in) and
 * a bluff, and each exists only because a bot can fail to do the right thing.
 * A bot that always catches makes calling your last card a ritual, one that
 * never does makes it free, and a feature nobody can reach is invisible to a
 * suite that only asks whether every action was legal - Rummy's claim window
 * was dead for months that way. So the floors below count what actually
 * happens across whole matches.
 *
 * STRENGTH: proving the tiers BEHAVE differently proves nothing about which
 * one plays better. Measured the first time, `sharp` was level with `steady`
 * (its extra reading of the table was neutral), and the fix was found by
 * searching the card-choice weights, not by thinking. Matches are seeded, so
 * these counts are exact rather than statistical.
 */

const PARTY: Partial<ChromalyRules> = {
  drawToMatch: true,
  stacking: "upward",
  jumpIn: true,
  sevenZero: true,
  target: 200,
};

describe("what a table of bots gets to see", () => {
  const seen: Record<string, number> = {};
  const bump = (k: string) => (seen[k] = (seen[k] ?? 0) + 1);

  // One run, read by every assertion below.
  for (let seed = 1; seed <= 60; seed++) {
    const seats = [3, 4, 5][seed % 3]!;
    playMatch({
      rules: PARTY,
      seats,
      seed,
      onStep: (state, seat, action) => {
        const w = state.window;
        if (w && w.offenders.length > 0 && action.t === "callLast") {
          bump(w.offenders.includes(seat) ? "save" : "catch");
        }
        if (w && w.jumpers.length > 0 && action.t === "jumpIn") bump("jump");
        if (w && w.jumpers.length > 0) bump("jumpWindowStep");
        if (action.t === "challenge") bump(state.challenge?.guilty ? "bluffCaught" : "challengeWasted");
        if (action.t === "play" && action.cards[0]!.startsWith("F.") && state.window === null) {
          bump("plus4");
          const holdsColour = state.hands[seat]!.some((id) => id[0] === state.color && /^[RYGB]/.test(id));
          if (holdsColour) bump("bluff");
        }
        if (state.pendingDraw && state.pendingDraw.amount >= 6) bump("bigStack");
      },
    });
  }

  it("catches a seat that forgot to call, and seats get away with it too", () => {
    expect(seen.catch ?? 0, "nobody was ever caught").toBeGreaterThan(30);
    expect(seen.save ?? 0, "nobody ever saved themselves in the window").toBeGreaterThan(10);
  });

  it("jump-ins happen, and windows open that nobody takes", () => {
    expect(seen.jump ?? 0, "nobody ever jumped in").toBeGreaterThan(100);
    expect(seen.jumpWindowStep ?? 0).toBeGreaterThan(seen.jump ?? 0);
  });

  it("Wild +4 is bluffed, and a bluff is sometimes caught", () => {
    expect(seen.bluff ?? 0, "nobody ever bluffed").toBeGreaterThan(20);
    expect(seen.bluffCaught ?? 0, "no bluff was ever called").toBeGreaterThan(10);
  });

  it("stacks reach six or more under the Party rules", () => {
    expect(seen.bigStack ?? 0).toBeGreaterThan(20);
  });
});

describe("the tiers are different players", () => {
  it("fail at the races at different rates, in the order the copy says", () => {
    expect(TIERS.casual.catches).toBeLessThan(TIERS.steady.catches);
    expect(TIERS.steady.catches).toBeLessThan(TIERS.sharp.catches);
    expect(TIERS.casual.jumps).toBeLessThan(TIERS.steady.jumps);
    expect(TIERS.steady.jumps).toBeLessThan(TIERS.sharp.jumps);
    expect(TIERS.casual.forgets).toBeGreaterThan(TIERS.steady.forgets);
    expect(TIERS.steady.forgets).toBeGreaterThan(TIERS.sharp.forgets);
  });
});

/**
 * Seed families the tuning never saw. Pooled, because one family of a hundred
 * matches swings by several either way - sharp led steady 92-58 on the seeds
 * it was tuned on and 61-59 on the first fresh ones.
 */
const FAMILIES = [
  [13, 5],
  [29, 3],
  [41, 11],
] as const;
const PER_FAMILY = 200;

/** Matches won by `a` and by `b`, four seats alternating, so seat order cannot decide it. */
function duel(a: BotDifficulty, b: BotDifficulty, rules: Partial<ChromalyRules>): [number, number] {
  let wa = 0;
  let wb = 0;
  for (const [mul, add] of FAMILIES) {
    for (let n = 1; n <= PER_FAMILY; n++) {
      const flip = n % 2 === 0;
      const mix = [0, 1, 2, 3].map((i) => ((i % 2 === 0) !== flip ? a : b));
      const winner = playMatch({ rules, seats: 4, seed: n * mul + add, tiers: mix }).state.winner;
      if (winner === null) continue;
      if (mix[winner] === a) wa++;
      else wb++;
    }
  }
  return [wa, wb];
}

describe("a better tier wins more matches", () => {
  for (const [name, rules] of [
    ["classic", { target: 200 }],
    ["party", PARTY],
  ] as const) {
    it(`${name}: sharp beats steady, steady beats casual`, () => {
      const [sharp, steady] = duel("sharp", "steady", rules);
      expect(sharp, `sharp ${sharp} - steady ${steady}`).toBeGreaterThan(steady);
      const [steady2, casual] = duel("steady", "casual", rules);
      expect(steady2, `steady ${steady2} - casual ${casual}`).toBeGreaterThan(casual);
    });
  }

  it("sharp beats casual by a wide margin", () => {
    const [sharp, casual] = duel("sharp", "casual", { target: 200 });
    expect(sharp, `sharp ${sharp} - casual ${casual}`).toBeGreaterThan(casual * 1.5);
  });
});
