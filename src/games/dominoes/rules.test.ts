import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import { doubleSixSet, isDouble, tilePips } from "@/games/_shared/tiles";
import { createDominoes, reduce, startRound } from "./rules";
import {
  BONEYARD_FLOOR,
  HIDDEN_TILE,
  canPlay,
  drawableTiles,
  handSize,
  openEnds,
  playableEnds,
  pipsInHand,
} from "./state";
import type { DomAction, DomState } from "./types";

/**
 * Rules checked against pagat.com's Draw and Block pages. The three most
 * commonly got wrong, and so the three most worth pinning: the 7/7/6
 * deal, the two tiles that are never drawn, and a score that subtracts
 * the winner's OWN pips rather than just summing everyone else's.
 */

function fresh(seats: number, seed = 7, target = 61) {
  const rng = createRng(seed);
  const def = createDominoes(target);
  const { state } = startRound(def.setup({ seats, rng }), rng);
  return { def, rng, state };
}

/** Runs a whole match with bots, returning the final state. */
function runMatch(seats: number, seed: number, target = 61): DomState {
  const rng = createRng(seed);
  const def = createDominoes(target);
  let state = def.setup({ seats, rng });
  ({ state } = startRound(state, rng));
  let guard = 0;
  while (!def.isOver(state) && guard++ < 4000) {
    if (def.isRoundOver!(state)) {
      ({ state } = startRound(state, rng));
      continue;
    }
    const seat = def.currentSeat(state)!;
    const action = def.bots.steady.choose(def.playerView(state, seat), seat, rng);
    ({ state } = def.reduce(state, action));
  }
  return state;
}

describe("dominoes — the deal", () => {
  it("deals 7/7/6 for 2/3/4 players and boneyards the rest", () => {
    for (const seats of [2, 3, 4]) {
      const { state } = fresh(seats);
      const per = handSize(seats);
      expect(per).toBe(seats >= 4 ? 6 : 7);
      for (let s = 0; s < seats; s++) expect(state.hands[s]).toHaveLength(per);
      expect(state.boneyard).toHaveLength(28 - per * seats);
    }
  });

  it("uses all 28 tiles exactly once", () => {
    const { state } = fresh(3);
    const seen = [...state.boneyard];
    for (let s = 0; s < state.seats; s++) seen.push(...state.hands[s]!);
    expect(seen.slice().sort()).toEqual(doubleSixSet().slice().sort());
  });

  it("gives the lead to the highest double in round one", () => {
    const { state } = fresh(4, 99);
    const doubles = [];
    for (let s = 0; s < state.seats; s++) {
      for (const id of state.hands[s]!) if (isDouble(id)) doubles.push({ s, id });
    }
    if (doubles.length === 0) return; // fallback path, covered by the type
    const best = doubles.reduce((a, b) => (tilePips(b.id) > tilePips(a.id) ? b : a));
    expect(state.turn).toBe(best.s);
  });

  it("starts undealt so the opening deal can animate", () => {
    const def = createDominoes();
    const state = def.setup({ seats: 3, rng: createRng(1) });
    expect(state.dealt).toBe(false);
    expect(state.boneyard).toHaveLength(28);
    expect(def.currentSeat(state)).toBeNull();
  });
});

describe("dominoes — playing", () => {
  it("only lets a tile join an end it actually matches", () => {
    const { def, state } = fresh(2, 21);
    const seat = def.currentSeat(state)!;
    const opening = def.legalActions(state, seat);
    // The opening tile has exactly one placement, not two.
    expect(opening.every((a) => a.t === "play")).toBe(true);
    const first = opening[0] as Extract<DomAction, { t: "play" }>;
    const { state: after } = reduce(state, first);

    const ends = openEnds(after);
    for (const id of doubleSixSet()) {
      const legal = playableEnds(after, id);
      for (const end of legal) {
        const pip = end === "left" ? ends.left : ends.right;
        expect(id.split("-").map(Number)).toContain(pip);
      }
    }
  });

  it("keeps the turn with a player who draws", () => {
    const { def, state } = fresh(2, 5);
    const seat = def.currentSeat(state)!;
    const { state: after } = reduce(state, { t: "draw" });
    expect(def.currentSeat(after)).toBe(seat);
    expect(after.hands[seat]).toHaveLength((state.hands[seat] ?? []).length + 1);
    expect(after.boneyard).toHaveLength(state.boneyard.length - 1);
  });

  it("never draws the last two tiles of the boneyard", () => {
    for (const seats of [2, 3, 4]) {
      for (const seed of [3, 17, 88, 404]) {
        const rng = createRng(seed);
        const def = createDominoes(61);
        let state = def.setup({ seats, rng });
        ({ state } = startRound(state, rng));
        let guard = 0;
        while (!def.isOver(state) && guard++ < 2000) {
          if (def.isRoundOver!(state)) {
            ({ state } = startRound(state, rng));
            continue;
          }
          const seat = def.currentSeat(state)!;
          const action = def.bots.casual.choose(def.playerView(state, seat), seat, rng);
          ({ state } = def.reduce(state, action));
          expect(state.boneyard.length).toBeGreaterThanOrEqual(BONEYARD_FLOOR);
        }
      }
    }
  });

  it("turns a draw at the floor into the pass the rules require", () => {
    const { state } = fresh(2, 11);
    // Strip the boneyard down to the two undrawable tiles.
    const stuck: DomState = { ...state, boneyard: state.boneyard.slice(0, 2) };
    expect(drawableTiles(stuck)).toBe(0);
    const { state: after } = reduce(stuck, { t: "draw" });
    expect(after.passes).toBe(1);
    expect(after.boneyard).toHaveLength(2);
  });

  it("offers draw or pass only when nothing can be played", () => {
    const { def, state } = fresh(3, 64);
    const seat = def.currentSeat(state)!;
    const actions = def.legalActions(state, seat);
    if (canPlay(state, seat)) {
      expect(actions.every((a) => a.t === "play")).toBe(true);
    } else {
      expect(actions).toHaveLength(1);
      expect(actions[0]!.t).toBe(drawableTiles(state) > 0 ? "draw" : "pass");
    }
  });
});

describe("dominoes — scoring", () => {
  it("scores a domino as the losers' pips less the winner's own", () => {
    for (const seats of [2, 3, 4]) {
      for (const seed of [1, 2, 3, 12, 33]) {
        const rng = createRng(seed);
        const def = createDominoes(10_000); // never reaches the target
        let state = def.setup({ seats, rng });
        ({ state } = startRound(state, rng));
        let guard = 0;
        while (!def.isRoundOver!(state) && guard++ < 2000) {
          const seat = def.currentSeat(state)!;
          const action = def.bots.sharp.choose(def.playerView(state, seat), seat, rng);
          ({ state } = def.reduce(state, action));
        }
        const result = state.result!;
        expect(result).not.toBeNull();

        if (result.winner === null) {
          expect(result.points).toBe(0);
          continue;
        }
        let expected = 0;
        for (let s = 0; s < seats; s++) {
          if (s !== result.winner) expected += result.pips[s] ?? 0;
        }
        expected -= result.pips[result.winner] ?? 0;
        expect(result.points).toBe(expected);
        expect(state.scores[result.winner]).toBe(expected);

        // Going out means holding nothing, which is what makes the same
        // formula cover both endings.
        if (result.kind === "domino") {
          expect(result.pips[result.winner]).toBe(0);
          expect(state.hands[result.winner]).toHaveLength(0);
        }
      }
    }
  });

  it("gives a blocked round to the lowest pip count", () => {
    // Hand-built rather than fished out of a seed: a blocked round is
    // rare enough that a fuzz run is a poor way to pin its tie-breaks.
    const rng = createRng(1);
    const def = createDominoes(61);
    const base = def.setup({ seats: 2, rng });
    const blocked: DomState = {
      ...base,
      dealt: true,
      round: 1,
      // Seat 0 holds 3 pips, seat 1 holds 9. Neither can play.
      hands: { 0: ["2-1"], 1: ["6-3"] },
      boneyard: ["5-5", "4-4"], // exactly the floor: nobody may draw
      chain: [{ id: "0-0", x: 0, y: 0, rot: 0, a: 0, b: 0 }],
      passes: 1,
      turn: 1,
    };
    const { state: after } = reduce(blocked, { t: "pass" });
    expect(after.result?.kind).toBe("blocked");
    expect(after.result?.winner).toBe(0);
    expect(after.result?.points).toBe(9 - 3);
  });

  it("scores nobody when a blocked round ties on pips and on lightest tile", () => {
    const rng = createRng(1);
    const def = createDominoes(61);
    const base = def.setup({ seats: 2, rng });
    const tied: DomState = {
      ...base,
      dealt: true,
      round: 1,
      hands: { 0: ["2-1"], 1: ["1-2"] }, // same pips, same lightest tile
      boneyard: ["5-5", "4-4"],
      chain: [{ id: "0-0", x: 0, y: 0, rot: 0, a: 0, b: 0 }],
      passes: 1,
      turn: 1,
    };
    const { state: after } = reduce(tied, { t: "pass" });
    expect(after.result?.winner).toBeNull();
    expect(after.result?.points).toBe(0);
    // The lead still has to move on, or the same seat opens forever.
    expect(after.opener).not.toBe(tied.opener === 0 ? 0 : after.opener);
  });

  it("ends the match when a score reaches the target", () => {
    for (const seats of [2, 3, 4]) {
      const state = runMatch(seats, 31, 40);
      expect(state.winner).not.toBeNull();
      expect(state.scores[state.winner!]).toBeGreaterThanOrEqual(40);
      expect(state.round).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("dominoes — round transition", () => {
  it("sweeps the previous round's WHOLE board back to the boneyard, not just the chain", () => {
    // Play round 1 out to a "domino" so at least one other seat is left
    // holding real tiles — the case a chain-only sweep silently missed:
    // those leftover HAND tiles had no event moving them at all.
    const rng = createRng(909);
    const def = createDominoes(10_000); // never reaches the target
    let state = def.setup({ seats: 3, rng });
    ({ state } = startRound(state, rng));
    let guard = 0;
    while (!def.isRoundOver!(state) && guard++ < 2000) {
      const seat = def.currentSeat(state)!;
      const action = def.bots.steady.choose(def.playerView(state, seat), seat, rng);
      ({ state } = def.reduce(state, action));
    }
    expect(state.result).not.toBeNull();

    const leftoverChain = state.chain.map((t) => t.id);
    const leftoverHands = Object.values(state.hands).flat();
    // A real regression case, not a vacuous one: something has to still
    // be on the table/in a hand for the bug to have been reachable.
    expect(leftoverChain.length + leftoverHands.length).toBeGreaterThan(0);

    const { events } = startRound(state, rng);
    const sweep = events.find((e) => e.t === "sweep");
    expect(sweep).toBeDefined();
    const swept = new Set((sweep as { pieces: string[] }).pieces);
    for (const id of [...leftoverChain, ...leftoverHands]) {
      expect(swept.has(id), `${id} left un-swept from the old round`).toBe(true);
    }
    // Boneyard tiles were already face down in the right zone — sweeping
    // them too would just be a piece popping in place, not a bug, but
    // it's not what a "gather what's on the table" event should claim.
    for (const id of state.boneyard) {
      expect(swept.has(id), `${id} (already in the boneyard) swept unnecessarily`).toBe(
        false,
      );
    }
  });

  it("emits no sweep on the very first deal", () => {
    const rng = createRng(3);
    const def = createDominoes();
    const { events } = startRound(def.setup({ seats: 2, rng }), rng);
    expect(events.some((e) => e.t === "sweep")).toBe(false);
  });
});

describe("dominoes — hidden information", () => {
  it("hides every other hand and the whole boneyard from a viewer", () => {
    const { def, state } = fresh(4, 77);
    const view = def.playerView(state, 2);
    expect(view.hands[2]).toEqual(state.hands[2]);
    for (const seat of [0, 1, 3]) {
      expect(view.hands[seat]).toHaveLength(state.hands[seat]!.length);
      expect(view.hands[seat]!.every((id) => id === HIDDEN_TILE)).toBe(true);
    }
    expect(view.boneyard).toHaveLength(state.boneyard.length);
    expect(view.boneyard.every((id) => id === HIDDEN_TILE)).toBe(true);
    // Counts stay honest — they are public facts at a real table.
    expect(pipsInHand(view, 0)).toBe(0);
    expect(pipsInHand(view, 2)).toBe(pipsInHand(state, 2));
  });

  it("leaves a bot able to play from nothing but its own view", () => {
    const { def, state } = fresh(3, 123);
    const seat = def.currentSeat(state)!;
    const action = def.bots.sharp.choose(def.playerView(state, seat), seat, rngOf(1));
    if (action.t === "play") {
      expect(state.hands[seat]).toContain(action.tile);
    }
  });
});

describe("dominoes — determinism", () => {
  it("replays a whole match identically from the same seed", () => {
    for (const seats of [2, 3, 4]) {
      const a = runMatch(seats, 5150, 40);
      const b = runMatch(seats, 5150, 40);
      expect(JSON.stringify(b)).toEqual(JSON.stringify(a));
    }
  });

  it("produces different matches from different seeds", () => {
    const a = runMatch(3, 1, 40);
    const b = runMatch(3, 2, 40);
    expect(JSON.stringify(b)).not.toEqual(JSON.stringify(a));
  });
});

function rngOf(seed: number) {
  return createRng(seed);
}
