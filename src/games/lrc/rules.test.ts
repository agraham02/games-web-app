import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import { HERO } from "@/engine/types";
import { lrc, CHIPS_PER_PLAYER } from "./rules";
import { chipsHeld, diceCountFor, passLeft, passRight, potSize } from "./state";
import type { LrcState } from "./types";

/** Plays a full game from a seed, bots for every seat including the
 * hero (rolling is the only action, so the hero's own "bot" is fine for
 * a rules test — no UI involved). Returns the final state and the
 * number of turns taken, as a safety net against infinite loops. */
function playFullGame(seed: number, seats: number) {
  const rng = createRng(seed);
  let state = lrc.setup({ seats, rng });
  let turns = 0;
  const maxTurns = 100_000; // generous; a real game ends in dozens

  while (!lrc.isOver(state) && turns < maxTurns) {
    const seat = lrc.currentSeat(state)!;
    const action = lrc.bots.steady.choose(state, seat, rng);
    state = lrc.reduce(state, action).state;
    turns++;
  }

  return { state, turns };
}

describe("setup", () => {
  it("gives every seat exactly CHIPS_PER_PLAYER chips", () => {
    const state = lrc.setup({ seats: 6, rng: createRng(1) });
    for (let s = 0; s < 6; s++) {
      expect(chipsHeld(state, s)).toBe(CHIPS_PER_PLAYER);
    }
  });

  it("cuts for who rolls first rather than always the hero", () => {
    // It used to be a hardcoded HERO, so the player opened every single
    // game. LRC is pure luck and going first is a real edge, so that is
    // both unfair and immediately noticeable across a few games.
    const seen = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) {
      const state = lrc.setup({ seats: 4, rng: createRng(seed) });
      expect(state.turn, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      expect(state.turn, `seed ${seed}`).toBeLessThan(4);
      expect(state.winner).toBeNull();
      expect(lrc.isOver(state)).toBe(false);
      seen.add(state.turn);
    }
    expect(seen.size, "the first roller must not be fixed").toBeGreaterThan(1);
    expect(seen.has(HERO), "the hero must still get their share of first rolls").toBe(true);
  });

  it("rejects seat counts outside 3-10 at the definition level", () => {
    expect(lrc.minSeats).toBe(3);
    expect(lrc.maxSeats).toBe(10);
  });
});

describe("reduce", () => {
  it("moves a chip left, right, or to the pot per die face — never invents or drops one", () => {
    const rng = createRng(2);
    const state = lrc.setup({ seats: 4, rng });
    const before = Object.keys(state.chipOwner).length;
    // Whoever the cut gave the first roll to — no longer always the hero.
    const roller = state.turn;

    const { state: next } = lrc.reduce(state, {
      t: "roll",
      dice: ["L", "R", "C"],
    });

    expect(Object.keys(next.chipOwner).length).toBe(before);
    expect(potSize(next)).toBe(1);
    // The roller started with 3 and gave one to each of L/R/pot.
    expect(chipsHeld(next, roller)).toBe(0);
    expect(chipsHeld(next, passLeft(state, roller))).toBe(CHIPS_PER_PLAYER + 1);
    expect(chipsHeld(next, passRight(state, roller))).toBe(CHIPS_PER_PLAYER + 1);
  });

  it("dots move nothing", () => {
    const state = lrc.setup({ seats: 4, rng: createRng(3) });
    const { state: next } = lrc.reduce(state, { t: "roll", dice: ["dot", "dot", "dot"] });
    expect(next.chipOwner).toEqual(state.chipOwner);
  });

  it("advances turn anticlockwise, skipping seats with zero chips", () => {
    // Empty the first roller into the seat on their left.
    let state = lrc.setup({ seats: 4, rng: createRng(4) });
    const roller = state.turn;
    const left = passLeft(state, roller);
    state = lrc.reduce(state, { t: "roll", dice: ["L", "L", "L"] }).state;
    // The roller gave all 3 chips left, so they are now at zero and the
    // turn must never come back around to them: their neighbour holds 6,
    // they hold 0, and advancing must always skip a zero-chip seat.
    expect(chipsHeld(state, roller)).toBe(0);
    expect(chipsHeld(state, left)).toBe(6);

    // Drain seat 1 back to zero too and confirm turn-passing never
    // selects a zero-chip seat as `currentSeat`.
    for (let i = 0; i < 20 && !lrc.isOver(state); i++) {
      const seat = lrc.currentSeat(state)!;
      expect(chipsHeld(state, seat)).toBeGreaterThan(0);
      state = lrc.reduce(state, lrc.bots.steady.choose(state, seat, createRng(100 + i))).state;
    }
  });

  it("only ever grows the pot, never shrinks it", () => {
    let state = lrc.setup({ seats: 5, rng: createRng(5) });
    let lastPot = potSize(state);
    for (let i = 0; i < 200 && !lrc.isOver(state); i++) {
      const seat = lrc.currentSeat(state)!;
      state = lrc.reduce(state, lrc.bots.steady.choose(state, seat, createRng(200 + i))).state;
      const pot = potSize(state);
      expect(pot).toBeGreaterThanOrEqual(lastPot);
      lastPot = pot;
    }
  });

  it("declares the sole remaining chip-holder the winner, and fires gameEnd", () => {
    let state = lrc.setup({ seats: 3, rng: createRng(6) });
    // Force it: the first roller gives everything away.
    const roller = state.turn;
    const r1 = lrc.reduce(state, { t: "roll", dice: ["L", "R", "C"] });
    state = r1.state;
    expect(chipsHeld(state, roller)).toBe(0);
    expect(lrc.isOver(state)).toBe(false); // two seats still hold chips

    // Drain the other two seats' chips into the pot until one remains.
    for (let i = 0; i < 50 && !lrc.isOver(state); i++) {
      const seat = lrc.currentSeat(state)!;
      const count = diceCountFor(state, seat);
      const dice = Array.from({ length: count }, () => "C" as const);
      const result = lrc.reduce(state, { t: "roll", dice });
      state = result.state;
      if (lrc.isOver(state)) {
        expect(result.events.some((e) => e.t === "gameEnd")).toBe(true);
      }
    }

    expect(lrc.isOver(state)).toBe(true);
    expect(state.winner).not.toBeNull();
    expect(chipsHeld(state, state.winner!)).toBeGreaterThan(0);
  });
});

describe("full game", () => {
  it("always terminates with exactly one seat holding chips", () => {
    for (const seed of [10, 11, 12, 13]) {
      for (const seats of [3, 6, 10]) {
        const { state, turns } = playFullGame(seed, seats);
        expect(lrc.isOver(state), `seed ${seed}, ${seats} seats`).toBe(true);
        expect(turns).toBeLessThan(100_000);

        const winners = Array.from({ length: seats }, (_, s) => s).filter(
          (s) => chipsHeld(state, s) > 0,
        );
        expect(winners, `seed ${seed}, ${seats} seats`).toHaveLength(1);
        expect(winners[0]).toBe(state.winner);
      }
    }
  });

  it("conserves chips: held + pot always equals the starting total", () => {
    const seats = 7;
    const total = seats * CHIPS_PER_PLAYER;
    const { state } = playFullGame(20, seats);

    let held = 0;
    for (let s = 0; s < seats; s++) held += chipsHeld(state, s);
    expect(held + potSize(state)).toBe(total);
  });

  it("is deterministic: the same seed replays to the same outcome", () => {
    const a = playFullGame(42, 6);
    const b = playFullGame(42, 6);
    expect(a.state).toEqual(b.state);
    expect(a.turns).toBe(b.turns);
  });

  it("produces different outcomes for different seeds (sanity — not stuck on one path)", () => {
    const outcomes = new Set<number>();
    for (let seed = 1; seed <= 8; seed++) {
      outcomes.add(playFullGame(seed, 5).state.winner!);
    }
    expect(outcomes.size).toBeGreaterThan(1);
  });
});

describe("legalActions", () => {
  it("only the current seat has a legal action", () => {
    const state = lrc.setup({ seats: 4, rng: createRng(7) });
    expect(lrc.legalActions(state, state.turn)).toHaveLength(1);
    expect(lrc.legalActions(state, (state.turn + 1) % 4)).toHaveLength(0);
  });

  it("nobody has a legal action once the game is over", () => {
    // One persistent rng across the whole game, not re-seeded per turn:
    // a fresh createRng(sameSeed) every iteration replays the identical
    // roll whenever a seat repeats the same dice count, which can cycle
    // chips forever without ever landing "C" — a real bug this test
    // caught once already. The turn cap is a second, independent
    // safety net in case a future change reintroduces a cycle.
    const rng = createRng(8);
    let state: LrcState = lrc.setup({ seats: 3, rng });
    let turns = 0;
    while (!lrc.isOver(state) && turns++ < 10_000) {
      const seat = lrc.currentSeat(state)!;
      state = lrc.reduce(state, lrc.bots.steady.choose(state, seat, rng)).state;
    }
    expect(lrc.isOver(state)).toBe(true);
    for (let s = 0; s < 3; s++) {
      expect(lrc.legalActions(state, s)).toHaveLength(0);
    }
  });
});

describe("pieces", () => {
  it("names exactly seats * CHIPS_PER_PLAYER pieces, every one a chip", () => {
    const state = lrc.setup({ seats: 8, rng: createRng(9) });
    const meta = lrc.pieces(state);
    expect(Object.keys(meta)).toHaveLength(8 * CHIPS_PER_PLAYER);
    expect(Object.values(meta).every((m) => m.kind === "chip")).toBe(true);
  });
});

describe("placements", () => {
  it("accounts for every piece exactly once, matching pieces()", () => {
    let state = lrc.setup({ seats: 5, rng: createRng(10) });
    state = lrc.reduce(state, { t: "roll", dice: ["L", "R", "C"] }).state;

    const ids = Object.keys(lrc.pieces(state));
    const placementIds = Object.keys(lrc.placements(state, HERO));
    expect(placementIds.sort()).toEqual(ids.sort());
  });
});
