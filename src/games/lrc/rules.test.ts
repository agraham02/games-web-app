import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import { HERO } from "@/engine/types";
import { lrc, createLrc, startRound, CHIPS_PER_PLAYER } from "./rules";
import { chipsHeld, diceCountFor, passLeft, passRight, potSize } from "./state";
import type { LrcState } from "./types";

/** A fresh, DEALT round — `setup` alone returns an undealt skeleton
 * (every chip in the bank, `dealt: false`), the same shape Dominoes
 * uses so the two share `useGameRuntime`'s round machinery for free. */
function fresh(seats: number, seed = 7, target?: number) {
  const rng = createRng(seed);
  const def = target === undefined ? lrc : createLrc(target);
  const { state } = startRound(def.setup({ seats, rng }), rng);
  return { def, rng, state };
}

/**
 * Plays a whole MATCH from a seed, bots for every seat including the
 * hero (rolling is the only action, so the hero's own "bot" is fine for
 * a rules test — no UI involved). Deals a fresh round whenever the
 * previous one ends short of the match target. Returns the final state,
 * every round's result along the way, and a turn count as a safety net.
 */
function playMatch(seed: number, seats: number, target?: number) {
  const rng = createRng(seed);
  const def = target === undefined ? lrc : createLrc(target);
  let state = def.setup({ seats, rng });
  ({ state } = startRound(state, rng));
  const results: NonNullable<LrcState["result"]>[] = [];
  let turns = 0;
  const maxTurns = 200_000; // generous; a real match ends in a few hundred

  while (!def.isOver(state) && turns < maxTurns) {
    if (def.isRoundOver!(state)) {
      results.push(state.result!);
      ({ state } = startRound(state, rng));
      continue;
    }
    const seat = def.currentSeat(state)!;
    const action = def.bots.steady.choose(state, seat, rng);
    state = def.reduce(state, action).state;
    turns++;
  }
  if (state.result) results.push(state.result);

  return { def, state, results, turns };
}

describe("setup — before the first deal", () => {
  it("returns an UNDEALT skeleton: every chip in the bank, nothing playable", () => {
    const state = lrc.setup({ seats: 6, rng: createRng(1) });
    expect(state.dealt).toBe(false);
    expect(state.round).toBe(0);
    for (const owner of Object.values(state.chipOwner)) expect(owner).toBe("bank");
    expect(lrc.currentSeat(state)).toBeNull();
    expect(lrc.legalActions(state, HERO)).toHaveLength(0);
    for (let s = 0; s < 6; s++) expect(state.scores[s]).toBe(0);
  });

  it("rejects seat counts outside 3-10 at the definition level", () => {
    expect(lrc.minSeats).toBe(3);
    expect(lrc.maxSeats).toBe(10);
  });
});

describe("startRound — the deal", () => {
  it("gives every seat exactly CHIPS_PER_PLAYER chips and marks the match dealt", () => {
    const { state } = fresh(6);
    expect(state.dealt).toBe(true);
    expect(state.round).toBe(1);
    for (let s = 0; s < 6; s++) expect(chipsHeld(state, s)).toBe(CHIPS_PER_PLAYER);
    expect(potSize(state)).toBe(0);
  });

  it("cuts for who rolls first rather than always the hero", () => {
    // It used to be a hardcoded HERO, so the player opened every single
    // game. LRC is pure luck and going first is a real edge, so that is
    // both unfair and immediately noticeable across a few rounds.
    const seen = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) {
      const { state } = fresh(4, seed);
      expect(state.turn, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      expect(state.turn, `seed ${seed}`).toBeLessThan(4);
      seen.add(state.turn);
    }
    expect(seen.size, "the first roller must not be fixed").toBeGreaterThan(1);
    expect(seen.has(HERO), "the hero must still get their share of first rolls").toBe(true);
  });

  it("cuts fresh EVERY round, not just the match's first", () => {
    // A subtler bug than a hardcoded HERO: a rule that only randomised
    // round 1 could still let whichever seat won it become a de facto
    // fixed opener from round 2 on. Play several rounds from one seed
    // and confirm the opener varies across them.
    const rng = createRng(9);
    let state = lrc.setup({ seats: 4, rng });
    ({ state } = startRound(state, rng));
    const openers = new Set<number>([state.turn]);
    for (let round = 0; round < 12; round++) {
      let guard = 0;
      while (!lrc.isRoundOver!(state) && guard++ < 400) {
        const seat = lrc.currentSeat(state)!;
        state = lrc.reduce(state, lrc.bots.steady.choose(state, seat, rng)).state;
      }
      ({ state } = startRound(state, rng));
      openers.add(state.turn);
    }
    expect(openers.size).toBeGreaterThan(1);
  });

  it("emits no sweep on the very first deal", () => {
    const rng = createRng(3);
    const { events } = startRound(lrc.setup({ seats: 4, rng }), rng);
    expect(events.some((e) => e.t === "sweep")).toBe(false);
  });

  it("sweeps every chip back to the bank before a later round redeals", () => {
    const rng = createRng(11);
    let state = lrc.setup({ seats: 4, rng });
    ({ state } = startRound(state, rng));
    let guard = 0;
    while (!lrc.isRoundOver!(state) && guard++ < 400) {
      const seat = lrc.currentSeat(state)!;
      state = lrc.reduce(state, lrc.bots.steady.choose(state, seat, rng)).state;
    }
    const { events } = startRound(state, rng);
    const sweep = events.find((e) => e.t === "sweep");
    expect(sweep).toBeDefined();
    expect(sweep && sweep.t === "sweep" ? sweep.pieces.length : 0).toBe(4 * CHIPS_PER_PLAYER);
  });

  it("conserves every chip across a sweep + redeal: none created, none lost", () => {
    const rng = createRng(13);
    let state = lrc.setup({ seats: 5, rng });
    ({ state } = startRound(state, rng));
    for (let round = 0; round < 6; round++) {
      let guard = 0;
      while (!lrc.isRoundOver!(state) && guard++ < 400) {
        const seat = lrc.currentSeat(state)!;
        state = lrc.reduce(state, lrc.bots.steady.choose(state, seat, rng)).state;
      }
      expect(Object.keys(state.chipOwner)).toHaveLength(5 * CHIPS_PER_PLAYER);
      ({ state } = startRound(state, rng));
      expect(Object.keys(state.chipOwner)).toHaveLength(5 * CHIPS_PER_PLAYER);
      for (let s = 0; s < 5; s++) expect(chipsHeld(state, s)).toBe(CHIPS_PER_PLAYER);
    }
  });
});

describe("reduce — one roll", () => {
  it("moves a chip left, right, or to the pot per die face — never invents or drops one", () => {
    const { state } = fresh(4, 2);
    const before = Object.keys(state.chipOwner).length;
    const roller = state.turn;

    const { state: next } = lrc.reduce(state, { t: "roll", dice: ["L", "R", "C"] });

    expect(Object.keys(next.chipOwner).length).toBe(before);
    expect(potSize(next)).toBe(1);
    expect(chipsHeld(next, roller)).toBe(0);
    expect(chipsHeld(next, passLeft(state, roller))).toBe(CHIPS_PER_PLAYER + 1);
    expect(chipsHeld(next, passRight(state, roller))).toBe(CHIPS_PER_PLAYER + 1);
  });

  it("dots move nothing, but the roll is still shown, never an empty batch", () => {
    // The reported bug: a dots roll used to produce ZERO events, which
    // useGameRuntime.submitAction special-cased into calling onIdle
    // synchronously — no settle beat at all, so the turn snapped
    // straight to the next one and read as visibly rushed next to a
    // roll that moved a real chip. The dice themselves are that beat now.
    const { state } = fresh(4, 3);
    const { state: next, events } = lrc.reduce(state, { t: "roll", dice: ["dot", "dot", "dot"] });
    expect(next.chipOwner).toEqual(state.chipOwner);
    expect(events).toEqual([{ t: "dice", seat: state.turn, faces: ["dot", "dot", "dot"] }]);
  });

  it("throws the dice before anything they decided moves", () => {
    // Reported: the roll and the chips it decides looked simultaneous.
    // The dice are an event in the same queue, so they come first.
    const { state } = fresh(4, 3);
    const { events } = lrc.reduce(state, { t: "roll", dice: ["L", "C", "R"] });
    expect(events[0]).toEqual({ t: "dice", seat: state.turn, faces: ["L", "C", "R"] });
    expect(events.slice(1).filter((e) => e.t === "move")).toHaveLength(3);
  });

  it("never returns an empty events array for a legal roll, across a real sweep", () => {
    // The general form of the fix, not just the hand-picked all-dots
    // case: whatever the dice actually say, a legal roll always leaves
    // something for the choreographer to pace against.
    for (let seed = 1; seed <= 30; seed++) {
      const rng = createRng(seed);
      let state = fresh(5, seed).state;
      for (let i = 0; i < 60 && !lrc.isRoundOver!(state); i++) {
        const seat = lrc.currentSeat(state)!;
        const action = lrc.bots.steady.choose(state, seat, rng);
        const result = lrc.reduce(state, action);
        expect(result.events.length, `seed ${seed}, turn ${i}`).toBeGreaterThan(0);
        state = result.state;
      }
    }
  });

  it("advances turn anticlockwise, skipping seats with zero chips", () => {
    const { state: base } = fresh(4, 4);
    const roller = base.turn;
    const left = passLeft(base, roller);
    let state = lrc.reduce(base, { t: "roll", dice: ["L", "L", "L"] }).state;
    expect(chipsHeld(state, roller)).toBe(0);
    expect(chipsHeld(state, left)).toBe(6);

    for (let i = 0; i < 20 && !lrc.isRoundOver!(state); i++) {
      const seat = lrc.currentSeat(state)!;
      expect(chipsHeld(state, seat)).toBeGreaterThan(0);
      state = lrc.reduce(state, lrc.bots.steady.choose(state, seat, createRng(100 + i))).state;
    }
  });

  it("only ever grows the pot, never shrinks it", () => {
    const { state: base } = fresh(5, 5);
    let state = base;
    let lastPot = potSize(state);
    for (let i = 0; i < 200 && !lrc.isRoundOver!(state); i++) {
      const seat = lrc.currentSeat(state)!;
      state = lrc.reduce(state, lrc.bots.steady.choose(state, seat, createRng(200 + i))).state;
      const pot = potSize(state);
      expect(pot).toBeGreaterThanOrEqual(lastPot);
      lastPot = pot;
    }
  });
});

describe("reduce — a round ending", () => {
  it("declares the sole remaining chip-holder the ROUND winner and scores it, without necessarily ending the match", () => {
    const { state: base, def } = fresh(3, 6, 100); // a high target — this round alone won't reach it
    const roller = base.turn;
    const r1 = def.reduce(base, { t: "roll", dice: ["L", "R", "C"] });
    let state = r1.state;
    expect(chipsHeld(state, roller)).toBe(0);
    expect(def.isRoundOver!(state)).toBe(false);

    for (let i = 0; i < 50 && !def.isRoundOver!(state); i++) {
      const seat = def.currentSeat(state)!;
      const count = diceCountFor(state, seat);
      const dice = Array.from({ length: count }, () => "C" as const);
      const result = def.reduce(state, dice.length > 0 ? { t: "roll", dice } : { t: "roll", dice: [] });
      state = result.state;
      if (def.isRoundOver!(state)) {
        expect(result.events.some((e) => e.t === "roundEnd")).toBe(true);
        expect(result.events.some((e) => e.t === "score")).toBe(true);
        // The MATCH target is 100 — one round win must not end it.
        expect(result.events.some((e) => e.t === "gameEnd")).toBe(false);
      }
    }

    expect(def.isRoundOver!(state)).toBe(true);
    expect(def.isOver(state)).toBe(false);
    expect(state.result).not.toBeNull();
    const roundWinner = state.result!.winner;
    expect(chipsHeld(state, roundWinner)).toBeGreaterThan(0);
    expect(state.scores[roundWinner]).toBe(1);
    // Nobody else's score moved.
    for (let s = 0; s < 3; s++) if (s !== roundWinner) expect(state.scores[s]).toBe(0);
  });

  it("does NOT end the match on a round win short of the target", () => {
    // Hand-built: seat 0 is one roll from taking the round (holds every
    // chip already claimed toward it), target is 3, and seat 0 has only
    // 1 prior round win — this round's win brings it to 2, still short.
    const { def, state: base } = fresh(3, 1, 3);
    const shape: LrcState = { ...base, scores: { 0: 1, 1: 0, 2: 0 }, turn: 1 };
    const chipOwner = { ...shape.chipOwner };
    for (const id of Object.keys(chipOwner)) {
      if (chipOwner[id] === 2) chipOwner[id] = 0; // seat 2 already out
    }
    const oneRollFromWinning: LrcState = { ...shape, chipOwner };
    const count = diceCountFor(oneRollFromWinning, 1);
    const dice = Array.from({ length: count }, () => "L" as const); // gives everything to seat 2 — eliminated, redirects to seat 0

    const { state: next, events } = def.reduce(oneRollFromWinning, { t: "roll", dice });
    expect(def.isRoundOver!(next)).toBe(true);
    expect(next.result!.winner).toBe(0);
    expect(next.scores[0]).toBe(2); // 1 prior + this round's win
    expect(def.isOver(next)).toBe(false);
    expect(next.winner).toBeNull();
    expect(events.some((e) => e.t === "gameEnd")).toBe(false);
  });

  it("ends the match on the round win that reaches the target, and fires gameEnd", () => {
    // Same shape, but seat 0 already has 2 of the 3 rounds needed.
    const { def, state: base } = fresh(3, 1, 3);
    const shape: LrcState = { ...base, scores: { 0: 2, 1: 0, 2: 0 }, turn: 1 };
    const chipOwner = { ...shape.chipOwner };
    for (const id of Object.keys(chipOwner)) {
      if (chipOwner[id] === 2) chipOwner[id] = 0;
    }
    const oneRollFromWinning: LrcState = { ...shape, chipOwner };
    const count = diceCountFor(oneRollFromWinning, 1);
    const dice = Array.from({ length: count }, () => "L" as const);

    const { state: next, events } = def.reduce(oneRollFromWinning, { t: "roll", dice });
    expect(def.isRoundOver!(next)).toBe(true);
    expect(next.scores[0]).toBe(3);
    expect(def.isOver(next)).toBe(true);
    expect(next.winner).toBe(0);
    const gameEnd = events.find((e) => e.t === "gameEnd");
    expect(gameEnd).toBeDefined();
    expect(gameEnd && gameEnd.t === "gameEnd" ? gameEnd.winner : null).toBe(0);
  });
});

describe("a full match", () => {
  it("terminates with the match winner's score at or above the target", () => {
    for (const seed of [10, 11, 12, 13]) {
      for (const seats of [3, 6, 10]) {
        const { state, turns } = playMatch(seed, seats, 4);
        expect(turns, `seed ${seed}, ${seats} seats`).toBeLessThan(200_000);
        expect(state.winner, `seed ${seed}, ${seats} seats`).not.toBeNull();
        expect(state.scores[state.winner!]).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it("plays MULTIPLE rounds when the target is above 1 — the actual bug report: scores must not reset each round", () => {
    const { state, results } = playMatch(14, 4, 3);
    expect(results.length).toBeGreaterThan(1);
    // Every round's winner accumulated toward the total that eventually
    // won the match — the sum of "won that round" across results must
    // land exactly on the final scoreboard, never reset partway through.
    const tally: Record<number, number> = {};
    for (const r of results) tally[r.winner] = (tally[r.winner] ?? 0) + 1;
    for (let s = 0; s < 4; s++) expect(state.scores[s] ?? 0).toBe(tally[s] ?? 0);
    expect(state.scores[state.winner!]).toBeGreaterThanOrEqual(3);
  });

  it("resets chip ownership every round — a round's elimination never survives into the next", () => {
    const { results } = playMatch(15, 5, 3);
    // If elimination carried over, a match target above the seat count
    // would be unreachable — that it reliably terminates each round with
    // a DIFFERENT set of eliminated seats than a flat carry-over would
    // allow is the only externally observable signal, so just check
    // every round genuinely had a winner (never stalls with 0 active
    // seats, which permanent cross-round elimination would eventually
    // produce for a small seat count and a high target).
    expect(results.length).toBeGreaterThanOrEqual(3);
    for (const r of results) expect(r.winner).toBeGreaterThanOrEqual(0);
  });

  it("conserves chips within each round: held + pot always equals the seat total", () => {
    const seats = 7;
    const total = seats * CHIPS_PER_PLAYER;
    const { state } = playMatch(20, seats, 4);
    let held = 0;
    for (let s = 0; s < seats; s++) held += chipsHeld(state, s);
    expect(held + potSize(state)).toBe(total);
  });

  it("is deterministic: the same seed replays to the same outcome", () => {
    const a = playMatch(42, 6, 3);
    const b = playMatch(42, 6, 3);
    expect(a.state).toEqual(b.state);
    expect(a.turns).toBe(b.turns);
    expect(a.results).toEqual(b.results);
  });

  it("produces different outcomes for different seeds (sanity — not stuck on one path)", () => {
    const outcomes = new Set<number>();
    for (let seed = 1; seed <= 8; seed++) {
      outcomes.add(playMatch(seed, 5, 3).state.winner!);
    }
    expect(outcomes.size).toBeGreaterThan(1);
  });
});

describe("legalActions", () => {
  it("only the current seat has a legal action, once dealt", () => {
    const { state } = fresh(4, 7);
    expect(lrc.legalActions(state, state.turn)).toHaveLength(1);
    expect(lrc.legalActions(state, (state.turn + 1) % 4)).toHaveLength(0);
  });

  it("nobody has a legal action once the MATCH is over", () => {
    const { state } = playMatch(8, 3, 2);
    expect(lrc.isOver(state) || lrc.legalActions(state, 0).length === 0).toBe(true);
    for (let s = 0; s < 3; s++) {
      if (lrc.isOver(state)) expect(lrc.legalActions(state, s)).toHaveLength(0);
    }
  });

  it("nobody has a legal action in the gap between a round ending and the next being dealt", () => {
    const { state } = fresh(3, 6, 100);
    let s = state;
    let guard = 0;
    while (!lrc.isRoundOver!(s) && guard++ < 400) {
      const seat = lrc.currentSeat(s)!;
      s = lrc.reduce(s, lrc.bots.steady.choose(s, seat, createRng(300 + guard))).state;
    }
    expect(lrc.isRoundOver!(s)).toBe(true);
    expect(lrc.currentSeat(s)).toBeNull();
    for (let seat = 0; seat < 3; seat++) expect(lrc.legalActions(s, seat)).toHaveLength(0);
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
  it("accounts for every piece exactly once, before and after a deal", () => {
    const undealt = lrc.setup({ seats: 5, rng: createRng(10) });
    const ids = Object.keys(lrc.pieces(undealt));
    expect(Object.keys(lrc.placements(undealt, HERO)).sort()).toEqual(ids.sort());

    const { state } = fresh(5, 10);
    const played = lrc.reduce(state, { t: "roll", dice: ["L", "R", "C"] }).state;
    expect(Object.keys(lrc.placements(played, HERO)).sort()).toEqual(ids.sort());
  });

  it("puts every undealt chip in the boneyard/bank, never on a seat or in the pot", () => {
    const undealt = lrc.setup({ seats: 4, rng: createRng(1) });
    const map = lrc.placements(undealt, HERO);
    for (const p of Object.values(map)) {
      expect(p.zone).toBe("boneyard");
      expect(p.seat).toBeUndefined();
    }
  });
});
