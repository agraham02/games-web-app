import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import type { BotDifficulty } from "@/engine/types";
import { createRummy } from "./rules";
import { rummyBots } from "./bots";
import type { Meld, RummyState } from "./types";

const def = createRummy();
const TIERS: BotDifficulty[] = ["casual", "steady", "sharp"];

function fixture(overrides: Partial<RummyState> = {}): RummyState {
  const base = def.setup({ seats: 4, rng: createRng(7) });
  return {
    ...base,
    round: 1,
    dealt: true,
    turn: 1,
    phase: "draw",
    hands: { 0: [], 1: [], 2: [], 3: [] },
    stock: ["D2", "D3", "D4"],
    discard: [],
    melds: [],
    nextMeldId: 1,
    ...overrides,
  };
}

function meld(id: number, owner: number, cards: string[]): Meld {
  return { id, owner, cards, hitBy: {} };
}

describe("rummy bots — legality", () => {
  it("only ever chooses an action legalActions agrees with", () => {
    for (const tier of TIERS) {
      for (let seed = 1; seed <= 40; seed++) {
        const game = createRummy({ target: 150 });
        const rng = createRng(seed);
        let state = game.setup({ seats: 4, rng });
        ({ state } = game.startRound!(state, rng));

        let n = 0;
        while (!game.isOver(state) && n++ < 3000) {
          if (game.isRoundOver!(state)) {
            ({ state } = game.startRound!(state, rng));
            continue;
          }
          const seat = game.currentSeat(state)!;
          const legal = game.legalActions(state, seat);
          if (state.claimWindow) {
            // Bots never face one — drive it and move on.
            ({ state } = game.reduce(state, { t: "passClaim" }));
            continue;
          }
          const action = game.bots[tier].choose(game.playerView(state, seat), seat, rng);
          expect(legal, `${tier} seed ${seed}: illegal ${JSON.stringify(action)}`)
            .toContainEqual(action);
          ({ state } = game.reduce(state, action));
        }
      }
    }
  });
});

describe("rummy bots — decisions", () => {
  it("discharges a pickup obligation rather than anything else", () => {
    const state = fixture({
      phase: "meld",
      hands: { 0: [], 1: ["S7", "H7", "D7", "CK"], 2: [], 3: [] },
      mandatory: { card: "S7", pool: [] },
    });
    for (const tier of TIERS) {
      const action = rummyBots[tier].choose(state, 1, createRng(3));
      expect(action.t, tier).toBe("layNewMeld");
      if (action.t === "layNewMeld") expect(action.cards, tier).toContain("S7");
    }
  });

  it("lays off onto the board before parting with a card — but not infallibly", () => {
    // Load-bearing imperfection, not flavour. Every tier used to lay off
    // EVERY available card before discarding, which meant a bot's discard
    // could never extend a live meld — so `claimableMeld` was always null
    // on it and **the hero's claim window could never open at all.** The
    // whole "Rummy!" interaction was unreachable, and was reported twice
    // as a missing button. Missing a lay-off is also just what players
    // do; `sharp` is the tier that never does.
    const state = fixture({
      phase: "meld",
      hands: { 0: [], 1: ["S8", "CK"], 2: [], 3: [] },
      melds: [meld(1, 2, ["S5", "S6", "S7"])],
      nextMeldId: 2,
    });
    const laysOff = (tier: BotDifficulty) => {
      let n = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const action = rummyBots[tier].choose(state, 1, createRng(seed));
        if (action.t === "extendMeld") {
          expect(action, tier).toEqual({ t: "extendMeld", meldId: 1, card: "S8" });
          n++;
        } else {
          // The only other reasonable move: it kept S8 and pitched the
          // king. Never something illegal or self-defeating.
          expect(action, tier).toEqual({ t: "discard", card: "CK" });
        }
      }
      return n / 200;
    };

    expect(laysOff("sharp"), "sharp never misses a lay-off").toBe(1);
    // Small oversight rates, on purpose: ~5% for steady and ~15% for
    // casual. The first pass ran 20%/55%, which made the claim window
    // common — the wrong correction for a bug that was "it can never
    // happen", not "it is rare".
    expect(laysOff("steady")).toBeGreaterThan(0.88);
    expect(laysOff("steady")).toBeLessThan(1);
    expect(laysOff("casual")).toBeGreaterThan(0.75);
    expect(laysOff("casual")).toBeLessThan(0.94);
  });

  it("takes a pile dig that hands it a whole meld", () => {
    const state = fixture({
      hands: { 0: [], 1: ["CA", "D9", "H4"], 2: [], 3: [] },
      discard: ["SA", "HA", "DA"],
    });
    // Steady and sharp weigh the pile; casual mostly stays out of it,
    // which is the whole point of the tier.
    for (const tier of ["steady", "sharp"] as BotDifficulty[]) {
      const action = rummyBots[tier].choose(state, 1, createRng(5));
      expect(action.t, tier).toBe("drawDiscard");
    }
  });

  it("never digs when there is nothing legal to dig for", () => {
    const state = fixture({
      hands: { 0: [], 1: ["C2", "D9", "H4"], 2: [], 3: [] },
      discard: ["SK"],
    });
    for (const tier of TIERS) {
      expect(rummyBots[tier].choose(state, 1, createRng(5)), tier)
        .toEqual({ t: "drawStock" });
    }
  });

  it("keeps a sharp bot from feeding a live meld when it has a safer card", () => {
    const state = fixture({
      phase: "meld",
      hands: { 0: [], 1: ["S8", "CK"], 2: [], 3: [] },
      // A meld owned by someone else that S8 extends — but the bot has
      // already laid off, so this state hands it only the discard.
      melds: [meld(1, 2, ["S5", "S6", "S7"])],
      nextMeldId: 2,
    });
    // With the layoff available it takes that instead, which is itself
    // the strongest form of "don't feed it".
    expect(rummyBots.sharp.choose(state, 1, createRng(9)).t).toBe("extendMeld");
  });
});

describe("rummy bots — pacing", () => {
  it("hurries a decision that isn't one", () => {
    const forced = fixture({ discard: [], hands: { 0: [], 1: ["CK"], 2: [], 3: [] } });
    const real = fixture({
      hands: { 0: [], 1: ["CA", "D9"], 2: [], 3: [] },
      discard: ["SA", "HA", "DA"],
    });
    for (const tier of TIERS) {
      const quick = rummyBots[tier].thinkMs(forced, 1, createRng(2));
      const considered = rummyBots[tier].thinkMs(real, 1, createRng(2));
      expect(quick, tier).toBeLessThan(considered);
    }
  });

  it("never resolves instantly — an opponent has to feel like a person", () => {
    for (const tier of TIERS) {
      const ms = rummyBots[tier].thinkMs(fixture(), 1, createRng(4));
      expect(ms, tier).toBeGreaterThan(100);
    }
  });
});

describe("rummy bots — honesty", () => {
  it("cannot see another hand, because playerView already redacted it", () => {
    const state = fixture({
      hands: { 0: ["SA", "SK", "SQ"], 1: ["C2", "D9"], 2: [], 3: [] },
      discard: ["SJ"],
    });
    const view = def.playerView(state, 1);
    expect(view.hands[0]).toEqual(["??", "??", "??"]);
    // And the decision it makes from that view is a legal one regardless.
    const action = rummyBots.sharp.choose(view, 1, createRng(1));
    expect(def.legalActions(state, 1)).toContainEqual(action);
  });

  it("is deterministic for the same state and rng seed", () => {
    const state = fixture({
      phase: "meld",
      hands: { 0: [], 1: ["S7", "H7", "D7", "CK", "C2"], 2: [], 3: [] },
    });
    for (const tier of TIERS) {
      const a = rummyBots[tier].choose(state, 1, createRng(11));
      const b = rummyBots[tier].choose(state, 1, createRng(11));
      expect(a, tier).toEqual(b);
    }
  });
});
