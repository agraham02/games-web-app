import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import type { BotDifficulty, SeatId } from "@/engine/types";
import { rankOf } from "./cards";
import { createBs, startRound } from "./rules";
import type { BsAction, BsState } from "./types";

const TIERS: BotDifficulty[] = ["casual", "steady", "sharp"];

/**
 * A whole match, every seat botted, with a callback on each step.
 *
 * Everything in this file measures REACHABILITY rather than correctness, and
 * that is the point of it. Rummy's claim window shipped dead — zero windows
 * across 453 rounds — because every bot played the locally optimal move and
 * the feature became literally unreachable. Its correctness suite was green
 * throughout, because a test that asserts what happens when a thing happens
 * cannot tell you the thing never does.
 */
function sweep(
  tier: BotDifficulty,
  seeds: number,
  onStep: (before: BsState, action: BsAction, after: BsState, seat: SeatId) => void,
  seats = 4,
) {
  for (let seed = 1; seed <= seeds; seed++) {
    const game = createBs({ target: 2 });
    const rng = createRng(seed);
    let state = game.setup({ seats, rng });
    ({ state } = startRound(state, rng));
    let steps = 0;
    while (!game.isOver(state) && steps++ < 20_000) {
      if (game.isRoundOver!(state)) {
        ({ state } = startRound(state, rng));
        continue;
      }
      const seat = game.currentSeat(state)!;
      const action = game.bots[tier].choose(game.playerView(state, seat), seat, rng);
      const before = state;
      ({ state } = game.reduce(state, action));
      onStep(before, action, state, seat);
    }
  }
}

function isLie(cards: readonly string[], claimed: string): boolean {
  return cards.some((id) => rankOf(id) !== claimed);
}

describe("bs — the challenge window is reachable, and every outcome in it", () => {
  it("reaches all five outcomes a player has to be able to see", () => {
    let plays = 0;
    let calls = 0;
    let caught = 0;
    let survived = 0;
    let wrongly = 0;
    let onGoingOut = 0;

    sweep("steady", 25, (before, action, after, seat) => {
      if (action.t === "play") plays++;
      if (action.t === "callBs") {
        calls++;
        const live = before.plays[before.window!.play]!;
        if ((before.hands[live.seat] ?? []).length === 0) onGoingOut++;
        if (after.reveal!.truthful) wrongly++;
        else caught++;
      }
      // The last seat letting it go is the moment a lie becomes permanent.
      if (action.t === "declineBs" && after.window === null && before.window!.pending.length === 1) {
        const live = before.plays[before.window!.play]!;
        if (isLie(live.cards, live.claimed)) survived++;
      }
      expect(seat).toBeGreaterThanOrEqual(0);
    });

    // Floors, not targets. Measured at steady over 25 matches: ~5,000 plays,
    // a challenge on roughly one play in four, and every outcome in the
    // hundreds. What matters is that none of them is ZERO — a zero here is
    // a feature nobody will ever meet.
    expect(plays, "no plays at all").toBeGreaterThan(1000);
    expect(calls, "nobody ever doubted a claim").toBeGreaterThan(200);
    expect(caught, "no lie was ever caught").toBeGreaterThan(100);
    expect(survived, "no lie ever got away with it").toBeGreaterThan(100);
    expect(wrongly, "a truthful claim was never once doubted").toBeGreaterThan(50);
    expect(onGoingOut, "nobody ever contested a player going out").toBeGreaterThan(20);
    // And the other direction: a table that challenges everything is not
    // playing BS either, it is auditing.
    expect(calls / plays, "challenged far too often to be a bluffing game").toBeLessThan(0.45);
  });

  it("lies when it does not have to, or every claim would be trustworthy", () => {
    let lies = 0;
    let freeLies = 0;
    sweep("steady", 12, (before, action, after) => {
      if (action.t !== "play") return;
      const laid = after.plays[after.plays.length - 1]!;
      if (!isLie(laid.cards, laid.claimed)) return;
      lies++;
      // It held at least one real card of the rank and chose to pad anyway.
      const honest = (before.hands[laid.seat] ?? []).filter((id) => rankOf(id) === laid.claimed);
      if (honest.length > 0) freeLies++;
    });
    expect(lies).toBeGreaterThan(200);
    expect(freeLies, "a bot only ever lied when forced, so a fat claim is a tell")
      .toBeGreaterThan(20);
  });

  it("sometimes claims all four, so a big claim stays a question", () => {
    // With a hard cap on bluff size, three- and four-card claims are ALWAYS
    // honest, which is a rule a person can read off the table and play
    // against for free. See `Nerve.reckless`.
    let big = 0;
    let bigLies = 0;
    sweep("sharp", 12, (_before, action, after) => {
      if (action.t !== "play") return;
      const laid = after.plays[after.plays.length - 1]!;
      if (laid.cards.length < 3) return;
      big++;
      if (isLie(laid.cards, laid.claimed)) bigLies++;
    });
    expect(big).toBeGreaterThan(50);
    expect(bigLies, "every fat claim was honest — a free read for the player")
      .toBeGreaterThan(10);
  });
});

/**
 * Seat 0 bluffs on every single play and never calls. Holding the LIAR fixed
 * is the only way to read difficulty off a table of bots: measured across a
 * homogeneous table, "lies caught" conflates being good at catching with
 * being good at lying, and the two move in opposite directions.
 */
function bluffPast(tier: BotDifficulty, seeds: number, bluffSize: number) {
  let lies = 0;
  let caught = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const game = createBs({ target: 2 });
    const rng = createRng(seed);
    let state = game.setup({ seats: 4, rng });
    ({ state } = startRound(state, rng));
    let steps = 0;
    while (!game.isOver(state) && steps++ < 20_000) {
      if (game.isRoundOver!(state)) {
        ({ state } = startRound(state, rng));
        continue;
      }
      const seat = game.currentSeat(state)!;
      let action: BsAction;
      if (seat === 0) {
        if (state.pendingTake === 0) action = { t: "takePile", seat: 0 };
        else if (state.window !== null && state.turn !== 0) action = { t: "declineBs", seat: 0 };
        else {
          const junk = state.hands[0]!.filter((id) => rankOf(id) !== state.rank);
          action = { t: "play", cards: (junk.length > 0 ? junk : state.hands[0]!).slice(0, bluffSize) };
        }
      } else {
        action = game.bots[tier].choose(game.playerView(state, seat), seat, rng);
      }
      const before = state;
      ({ state } = game.reduce(state, action));

      if (action.t === "play" && seat === 0) {
        const laid = state.plays[state.plays.length - 1]!;
        if (isLie(laid.cards, laid.claimed)) lies++;
      }
      if (
        action.t === "callBs" &&
        before.plays[before.window!.play]!.seat === 0 &&
        !state.reveal!.truthful
      ) {
        caught++;
      }
    }
  }
  return { lies, caught, rate: caught / Math.max(1, lies) };
}

describe("bs — difficulty is a real difference", () => {
  it("catches a fat bluff more often the sharper the table", () => {
    const rates = TIERS.map((tier) => bluffPast(tier, 15, 3).rate);
    // Measured over 25 matches: 38% / 48% / 53%. Asserted as an ORDERING
    // rather than on the numbers, so tuning the nerve table does not have to
    // come back here — what must never invert is which tier is harder.
    expect(rates[0]).toBeLessThan(rates[1]!);
    expect(rates[1]).toBeLessThan(rates[2]!);
    expect(rates[2], "a sharp table should catch a three-card bluff about half the time")
      .toBeGreaterThan(0.35);
  });

  it("lets a single card past every tier, because a small lie is the point", () => {
    // If one-card bluffs were reliably caught there would be no game: a hand
    // with none of the rank could not be played at all without losing the
    // pile, and every turn would be forced.
    for (const tier of TIERS) {
      const { rate } = bluffPast(tier, 12, 1);
      expect(rate, `${tier} caught a single-card bluff far too often`).toBeLessThan(0.35);
      expect(rate, `${tier} never caught a single-card bluff at all`).toBeGreaterThan(0.02);
    }
  });

  it("misses a provable lie sometimes, even at sharp", () => {
    // Deliberate. A bot that never misses proof means a hand holding none of
    // the rank cannot bluff, and the game collapses to "play honestly or lose
    // the pile". See `Nerve.caught`.
    const game = createBs();
    const rng = createRng(3);
    const state: BsState = {
      ...game.setup({ seats: 4, rng }),
      dealt: true,
      turn: 0,
      rank: "7",
      hands: { 0: ["H2", "S9"], 1: ["H7", "D7", "C7", "S7"], 2: ["D3"], 3: ["C4"] },
      plays: [],
    };
    const { state: windowed } = game.reduce(state, { t: "play", cards: ["H2"] });
    // Seat 1 holds all four sevens: the claim is arithmetically impossible.
    let called = 0;
    const probe = createRng(11);
    for (let i = 0; i < 200; i++) {
      const action = game.bots.sharp.choose(game.playerView(windowed, 1), 1, probe);
      if (action.t === "callBs") called++;
    }
    expect(called, "sharp should almost always catch proof").toBeGreaterThan(160);
    expect(called, "but not literally always").toBeLessThan(200);
  });
});

describe("bs — bot mechanics", () => {
  const windowed = () => {
    const game = createBs();
    const base: BsState = {
      ...game.setup({ seats: 4, rng: createRng(2) }),
      dealt: true,
      turn: 0,
      rank: "A",
      hands: { 0: ["H2", "S9"], 1: ["D3", "D4"], 2: ["C5", "C6"], 3: ["S7", "S8"] },
      plays: [],
    };
    return { game, state: game.reduce(base, { t: "play", cards: ["H2"] }).state };
  };

  it("spends the reaction time the race drew, not a fresh one", () => {
    // The list decides who gets the first look; the pause a player watches is
    // what makes that legible. Two different numbers would mean a bot that
    // visibly hesitates and then somehow beats the one that answered first.
    const { game, state } = windowed();
    for (const entry of state.window!.pending) {
      const ms = game.bots.steady.thinkMs(state, entry.seat, createRng(5));
      expect(ms, `seat ${entry.seat}`).toBe(entry.ms);
    }
  });

  it("answers a window with a call or a pass, and nothing else", () => {
    const { game, state } = windowed();
    for (const tier of TIERS) {
      const rng = createRng(7);
      for (let i = 0; i < 60; i++) {
        const seat = state.window!.pending[i % 3]!.seat;
        const action = game.bots[tier].choose(game.playerView(state, seat), seat, rng);
        expect(["callBs", "declineBs"], `${tier}`).toContain(action.t);
        expect(game.validate!(state, seat, action), `${tier}`).toBeNull();
      }
    }
  });

  it("never uses the seat-on-turn interrupt", () => {
    // Seat 1 is both entitled to answer the window and next to play. Jumping
    // its own queue gains a bot nothing; the interrupt is there for people,
    // who are the only ones a generous window can hold up.
    const { game, state } = windowed();
    expect(state.turn).toBe(1);
    expect(game.legalActions(state, 1).some((a) => a.t === "play")).toBe(true);
    for (const tier of TIERS) {
      const rng = createRng(9);
      for (let i = 0; i < 40; i++) {
        expect(game.bots[tier].choose(game.playerView(state, 1), 1, rng).t, tier)
          .not.toBe("play");
      }
    }
  });

  it("picks up a pile it has lost without being asked twice", () => {
    const { game, state } = windowed();
    const { state: called } = game.reduce(state, { t: "callBs", seat: 2 });
    expect(called.pendingTake).toBe(0);
    for (const tier of TIERS) {
      expect(game.bots[tier].choose(game.playerView(called, 0), 0, createRng(1)))
        .toEqual({ t: "takePile", seat: 0 });
    }
  });

  it("only ever proposes something validate accepts, at every seat count", () => {
    for (const seats of [2, 3, 5, 6]) {
      for (const tier of TIERS) {
        sweep(
          tier,
          3,
          (before, action, _after, seat) => {
            expect(
              createBs({ target: 2 }).validate!(before, seat, action),
              `${tier}/${seats}: ${JSON.stringify(action)}`,
            ).toBeNull();
          },
          seats,
        );
      }
    }
  });
});
