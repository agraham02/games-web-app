import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import { HERO } from "@/engine/types";
import { partnerOf, teammates } from "@/games/_shared/partnership";
import { doubleSixSet, isDouble, tilePips } from "@/games/_shared/tiles";
import { createDominoes, reduce, startRound, type DominoesOptions } from "./rules";
import {
  CARIBBEAN_SEATS,
  SLAM_CHANCE,
  drawableTiles,
  handSize,
  isKeyTile,
  openEnds,
  rollsSlam,
  slamChance,
} from "./state";
import type { DomAction, DomState } from "./types";

/**
 * Caribbean rules, checked against pagat.com's Caribbean Dominoes page
 * and gamerules.com's partner and cut-throat pages. The three most worth
 * pinning, because they are where this game differs from Block & Draw
 * and so where a shared code path can quietly do the classic thing: the
 * whole set dealt with no boneyard, a blocked round that stops at the
 * pip comparison instead of falling through to the lightest-tile
 * tiebreak, and a round being worth one GAME rather than a pile of pips.
 */

function caribbean(opts: Partial<DominoesOptions> = {}) {
  return createDominoes({ mode: "caribbean", target: 10, ...opts });
}

function dealt(seed: number, opts: Partial<DominoesOptions> = {}) {
  const rng = createRng(seed);
  const def = caribbean(opts);
  const { state } = startRound(def.setup({ seats: CARIBBEAN_SEATS, rng }), rng);
  return { def, rng, state };
}

/**
 * Plays a whole match out with bots. Returns every round result along
 * the way as well as the final state, so a test can assert about what
 * happened during the match rather than only how it ended.
 */
function runMatch(seed: number, opts: Partial<DominoesOptions> = {}) {
  const rng = createRng(seed);
  const def = caribbean(opts);
  let state = def.setup({ seats: CARIBBEAN_SEATS, rng });
  ({ state } = startRound(state, rng));
  const results: NonNullable<DomState["result"]>[] = [];
  const states: DomState[] = [];
  let guard = 0;
  while (!def.isOver(state) && guard++ < 20_000) {
    if (def.isRoundOver!(state)) {
      results.push(state.result!);
      states.push(state);
      ({ state } = startRound(state, rng));
      continue;
    }
    const seat = def.currentSeat(state)!;
    const action = def.bots.steady.choose(def.playerView(state, seat), seat, rng);
    ({ state } = def.reduce(state, action));
  }
  if (state.result) results.push(state.result);
  return { state, results, states, exhausted: guard >= 20_000 };
}

describe("caribbean — the deal", () => {
  it("deals the whole set, seven each, and leaves no boneyard", () => {
    for (const seed of [1, 9, 44, 512]) {
      const { state } = dealt(seed);
      expect(handSize(CARIBBEAN_SEATS, "caribbean")).toBe(7);
      expect(state.seats).toBe(4);
      for (let s = 0; s < 4; s++) expect(state.hands[s]).toHaveLength(7);
      expect(state.boneyard).toEqual([]);
      // The whole point: with nothing in the boneyard there is nothing
      // to draw, which is what turns "draw if you can, else pass" into
      // "pass" without any Caribbean-specific branch.
      expect(drawableTiles(state)).toBe(0);
    }
  });

  it("accounts for all 28 tiles exactly once", () => {
    const { state } = dealt(77);
    const seen = Object.values(state.hands).flat();
    expect(seen).toHaveLength(28);
    expect(new Set(seen).size).toBe(28);
    expect([...seen].sort()).toEqual([...doubleSixSet()].sort());
  });

  it("forces four seats even when asked for fewer", () => {
    const rng = createRng(4);
    // Not a hypothetical: the play page picks seats for classic and the
    // engine must not be handed a short deal that silently strands tiles.
    const state = caribbean().setup({ seats: 2, rng });
    expect(state.seats).toBe(CARIBBEAN_SEATS);
    expect(caribbean().minSeats).toBe(4);
    expect(caribbean().maxSeats).toBe(4);
  });

  it("opens round one on the double six", () => {
    for (const seed of [3, 21, 99, 1234]) {
      const { state } = dealt(seed);
      // Every tile is dealt, so somebody always holds it — this is the
      // printed rule rather than a stand-in for cutting for the lead.
      expect(state.hands[state.opener]).toContain("6-6");
      expect(state.turn).toBe(state.opener);
    }
  });
});

describe("caribbean — playing", () => {
  it("never offers a draw; a stuck seat can only pass", () => {
    for (const seed of [5, 61, 700]) {
      const { def, rng } = dealt(seed);
      let state = dealt(seed).state;
      let guard = 0;
      while (!def.isRoundOver!(state) && guard++ < 400) {
        const seat = def.currentSeat(state)!;
        const legal = def.legalActions(state, seat);
        expect(legal.some((a) => a.t === "draw")).toBe(false);
        if (legal.every((a) => a.t === "pass")) expect(legal).toEqual([{ t: "pass" }]);
        const action = def.bots.steady.choose(def.playerView(state, seat), seat, rng);
        expect(action.t).not.toBe("draw");
        ({ state } = def.reduce(state, action));
      }
      expect(state.boneyard).toEqual([]);
    }
  });

  it("never emits a slam in classic mode", () => {
    const rng = createRng(31);
    const def = createDominoes({ target: 10_000 });
    let state = def.setup({ seats: 4, rng });
    ({ state } = startRound(state, rng));
    let guard = 0;
    while (!def.isRoundOver!(state) && guard++ < 400) {
      const seat = def.currentSeat(state)!;
      const action = def.bots.steady.choose(def.playerView(state, seat), seat, rng);
      const { state: next, events } = def.reduce(state, action);
      expect(events.some((e) => e.t === "slam")).toBe(false);
      state = next;
    }
  });
});

describe("caribbean — scoring", () => {
  it("pays one game for going out, whoever else was holding what", () => {
    const { results } = runMatch(11);
    const outs = results.filter((r) => r.kind === "domino" && !r.bonus);
    expect(outs.length).toBeGreaterThan(0);
    for (const r of outs) expect(r.points).toBe(1);
  });

  it("ends the match at the target rather than on points", () => {
    for (const seed of [2, 19, 250]) {
      const { state, exhausted } = runMatch(seed, { target: 4 });
      expect(exhausted).toBe(false);
      expect(state.winner).not.toBeNull();
      expect(state.scores[state.winner!]).toBeGreaterThanOrEqual(4);
    }
  });

  it("gives a blocked round to the lowest count, with no lightest-tile tiebreak", () => {
    const base = caribbean().setup({ seats: 4, rng: createRng(1) });
    // Two seats level on count. Classic Block & Draw would break this on
    // the lightest single tile; Caribbean has no such rule, so it is a
    // tie and nobody scores.
    const tied: DomState = {
      ...base,
      dealt: true,
      round: 1,
      hands: { 0: ["6-1"], 1: ["5-2"], 2: ["6-5"], 3: ["6-4"] },
      chain: [{ id: "0-0", x: 0, y: 0, rot: 0, a: 0, b: 0 }],
      passes: 3,
      turn: 3,
    };
    const { state } = reduce(tied, { t: "pass" });
    expect(state.result?.kind).toBe("blocked");
    expect(state.result?.winner).toBeNull();
    expect(state.result?.points).toBe(0);
    for (let s = 0; s < 4; s++) expect(state.scores[s]).toBe(0);

    // One seat clearly lightest — that seat takes the round for a game.
    const clear: DomState = { ...tied, hands: { 0: ["1-0"], 1: ["5-2"], 2: ["6-5"], 3: ["6-4"] } };
    const won = reduce(clear, { t: "pass" }).state;
    expect(won.result?.winner).toBe(HERO);
    expect(won.result?.points).toBe(1);
    expect(won.scores[HERO]).toBe(1);
  });

  it("hands the lead back to the double six after a tied round", () => {
    const base = caribbean().setup({ seats: 4, rng: createRng(1) });
    const tied: DomState = {
      ...base,
      dealt: true,
      round: 1,
      opener: 2,
      hands: { 0: ["6-1"], 1: ["5-2"], 2: ["6-5"], 3: ["6-4"] },
      chain: [{ id: "0-0", x: 0, y: 0, rot: 0, a: 0, b: 0 }],
      passes: 3,
      turn: 3,
    };
    const blocked = reduce(tied, { t: "pass" }).state;
    expect(blocked.result?.winner).toBeNull();
    const { state: next } = startRound(blocked, createRng(88));
    expect(next.hands[next.opener]).toContain("6-6");
  });

  it("classic keeps the lightest-tile tiebreak that Caribbean drops", () => {
    // ONE shape, run through both rulesets, chosen so the two must
    // disagree: seats 0 and 1 are level on 7 pips, but seat 1's lightest
    // single tile is a 3 against seat 0's 7. Classic breaks the tie
    // there and pays seat 1; Caribbean has no such rule and calls it a
    // tie. Without the differing lightest tiles this test would pass
    // against an implementation that never consulted the tiebreak at all.
    const hands = { 0: ["6-1"], 1: ["4-0", "3-0"], 2: ["6-5"], 3: ["6-4"] };
    const shape = (def: ReturnType<typeof createDominoes>): DomState => ({
      ...def.setup({ seats: 4, rng: createRng(1) }),
      dealt: true,
      round: 1,
      hands,
      chain: [{ id: "0-0", x: 0, y: 0, rot: 0, a: 0, b: 0 }],
      passes: 3,
      turn: 3,
    });

    const classic = reduce(shape(createDominoes({ target: 61 })), { t: "pass" }).state;
    expect(classic.result?.winner).toBe(1);

    const carib = reduce(shape(caribbean()), { t: "pass" }).state;
    expect(carib.result?.winner).toBeNull();
  });
});

describe("caribbean — the key tile", () => {
  /** Chain showing `left` and `right`, with `absent` treated as played. */
  function board(left: number, right: number, played: string[]): DomState {
    const base = caribbean({ keyTileBonus: true }).setup({ seats: 4, rng: createRng(1) });
    return {
      ...base,
      dealt: true,
      round: 1,
      chain: played.map((id, i) => ({ id, x: i, y: 0, rot: 90, a: left, b: right })),
    };
  }

  it("is the only tile in the set that could still be played", () => {
    // Ends 6 and 5. Every tile holding a 6 or a 5 is already down except
    // one, so that one is the key tile.
    const everySixOrFive = doubleSixSet().filter((id) => id.includes("6") || id.includes("5"));
    const played = everySixOrFive.filter((id) => id !== "6-0");
    const state = board(6, 5, played);
    expect(openEnds(state)).toEqual({ left: 6, right: 5 });
    expect(isKeyTile(state, "6-0")).toBe(true);
  });

  it("is not a key tile when two tiles could still go down", () => {
    const everySixOrFive = doubleSixSet().filter((id) => id.includes("6") || id.includes("5"));
    const played = everySixOrFive.filter((id) => id !== "6-0" && id !== "5-0");
    const state = board(6, 5, played);
    expect(isKeyTile(state, "6-0")).toBe(false);
    expect(isKeyTile(state, "5-0")).toBe(false);
  });

  it("is never a double, even when it is the only tile left", () => {
    const everySixOrFive = doubleSixSet().filter((id) => id.includes("6") || id.includes("5"));
    const played = everySixOrFive.filter((id) => id !== "6-6");
    const state = board(6, 5, played);
    // 6-6 genuinely is the only playable tile here...
    expect(
      doubleSixSet().filter(
        (id) => !played.includes(id) && (id.includes("6") || id.includes("5")),
      ),
    ).toEqual(["6-6"]);
    // ...and the rule still excludes it.
    expect(isDouble("6-6")).toBe(true);
    expect(isKeyTile(state, "6-6")).toBe(false);
  });

  it("needs the two ends to differ", () => {
    const everySix = doubleSixSet().filter((id) => id.includes("6"));
    const played = everySix.filter((id) => id !== "6-0");
    const state = board(6, 6, played);
    expect(isKeyTile(state, "6-0")).toBe(false);
  });

  it("pays two games, and only with the toggle on", () => {
    const withBonus = caribbean({ keyTileBonus: true }).setup({ seats: 4, rng: createRng(1) });
    const everySixOrFive = doubleSixSet().filter((id) => id.includes("6") || id.includes("5"));
    const played = everySixOrFive.filter((id) => id !== "6-0");
    const chain = played.map((id, i) => ({ id, x: i, y: 0, rot: 90, a: 6, b: 5 }));
    const hands = { 0: ["6-0"], 1: ["4-3"], 2: ["4-2"], 3: ["3-2"] };
    const shape: DomState = { ...withBonus, dealt: true, round: 1, hands, chain, turn: HERO };

    const on = reduce(shape, { t: "play", tile: "6-0", end: "left" } as DomAction).state;
    expect(on.result?.bonus).toBe(true);
    expect(on.result?.points).toBe(2);

    const offRules = { ...shape.rules, keyTileBonus: false };
    const off = reduce({ ...shape, rules: offRules }, {
      t: "play",
      tile: "6-0",
      end: "left",
    } as DomAction).state;
    expect(off.result?.bonus).toBe(false);
    expect(off.result?.points).toBe(1);
  });
});

describe("caribbean — teams", () => {
  const teamOpts = { teams: true } as const;

  it("keeps scores mirrored within a side after every round", () => {
    for (const seed of [7, 88, 404]) {
      const { states, state } = runMatch(seed, { ...teamOpts, target: 4 });
      for (const s of [...states, state]) {
        expect(s.scores[0]).toBe(s.scores[2]);
        expect(s.scores[1]).toBe(s.scores[3]);
      }
    }
  });

  it("wins the round for both partners when one goes out", () => {
    const { results } = runMatch(7, { ...teamOpts, target: 4 });
    const scored = results.filter((r) => r.winner !== null);
    expect(scored.length).toBeGreaterThan(0);
    for (const r of scored) {
      expect(r.winningSeats).toHaveLength(2);
      expect(r.winningSeats).toEqual([...teammates(r.winner! % 2 === 0 ? 0 : 1)]);
      expect(r.winningSeats).toContain(r.winner);
      expect(r.winningSeats).toContain(partnerOf(r.winner!));
    }
  });

  it("names both partners on a match win", () => {
    const { state } = runMatch(7, { ...teamOpts, target: 3 });
    expect(state.winner).not.toBeNull();
    expect(state.winningSeats).toHaveLength(2);
    expect(state.winningSeats).toContain(state.winner);
    expect(state.winningSeats).toContain(partnerOf(state.winner!));
  });

  it("is not a tie when both lowest counts are on the same side", () => {
    const base = caribbean(teamOpts).setup({ seats: 4, rng: createRng(1) });
    const shape: DomState = {
      ...base,
      dealt: true,
      round: 1,
      // Seats 0 and 2 are partners and both hold 3 pips — their side
      // simply has the lowest count twice, which is a win, not a tie.
      hands: { 0: ["2-1"], 1: ["6-5"], 2: ["3-0"], 3: ["6-4"] },
      chain: [{ id: "0-0", x: 0, y: 0, rot: 0, a: 0, b: 0 }],
      passes: 3,
      turn: 3,
    };
    const { state } = reduce(shape, { t: "pass" });
    expect(state.result?.winner).not.toBeNull();
    expect(state.result?.winningSeats).toEqual([0, 2]);
    expect(state.scores[0]).toBe(1);
    expect(state.scores[2]).toBe(1);
    expect(state.scores[1]).toBe(0);
  });

  it("is a tie when the lowest counts are on opposite sides", () => {
    const base = caribbean(teamOpts).setup({ seats: 4, rng: createRng(1) });
    const shape: DomState = {
      ...base,
      dealt: true,
      round: 1,
      hands: { 0: ["2-1"], 1: ["3-0"], 2: ["6-5"], 3: ["6-4"] },
      chain: [{ id: "0-0", x: 0, y: 0, rot: 0, a: 0, b: 0 }],
      passes: 3,
      turn: 3,
    };
    const { state } = reduce(shape, { t: "pass" });
    expect(state.result?.winner).toBeNull();
    expect(state.result?.winningSeats).toBeNull();
  });

  it("six love sends the other side back to nothing", () => {
    const base = caribbean({ ...teamOpts, sixLove: true, target: 6 }).setup({
      seats: 4,
      rng: createRng(1),
    });
    const shape: DomState = {
      ...base,
      dealt: true,
      round: 1,
      scores: { 0: 0, 1: 3, 2: 0, 3: 3 },
      hands: { 0: ["2-1"], 1: ["6-5"], 2: ["6-3"], 3: ["6-4"] },
      chain: [{ id: "0-0", x: 0, y: 0, rot: 0, a: 0, b: 0 }],
      passes: 3,
      turn: 3,
    };
    const { state } = reduce(shape, { t: "pass" });
    // Seat 0's side takes it, so 1/3's three games evaporate.
    expect(state.scores[0]).toBe(1);
    expect(state.scores[2]).toBe(1);
    expect(state.scores[1]).toBe(0);
    expect(state.scores[3]).toBe(0);
  });

  it("without six love, scores accumulate normally", () => {
    const base = caribbean(teamOpts).setup({ seats: 4, rng: createRng(1) });
    const shape: DomState = {
      ...base,
      dealt: true,
      round: 1,
      scores: { 0: 0, 1: 3, 2: 0, 3: 3 },
      hands: { 0: ["2-1"], 1: ["6-5"], 2: ["6-3"], 3: ["6-4"] },
      chain: [{ id: "0-0", x: 0, y: 0, rot: 0, a: 0, b: 0 }],
      passes: 3,
      turn: 3,
    };
    const { state } = reduce(shape, { t: "pass" });
    expect(state.scores[1]).toBe(3);
    expect(state.scores[3]).toBe(3);
  });

  it("plays a whole six-love match out without stalling", () => {
    // The reason six love is team-only: it needs to actually terminate.
    // At two sides a 3-streak lands often enough to prove the loop.
    const { state, exhausted } = runMatch(5, { ...teamOpts, sixLove: true, target: 3 });
    expect(exhausted).toBe(false);
    expect(state.winner).not.toBeNull();
    expect(state.scores[state.winner!]).toBe(3);
  });
});

describe("caribbean — the slam", () => {
  it("is a pure function of the position", () => {
    const { state } = dealt(42);
    for (const tile of state.hands[HERO] ?? []) {
      const a = rollsSlam(state, HERO, tile, false);
      const b = rollsSlam(state, HERO, tile, false);
      expect(a).toBe(b);
    }
  });

  it("raises the odds for the last round's winner, and for their partner", () => {
    const solo = caribbean().setup({ seats: 4, rng: createRng(1) });
    const withWin: DomState = { ...solo, lastRoundWinner: 2 };
    expect(slamChance(withWin, 2, false)).toBe(SLAM_CHANCE.lastWinner);
    expect(slamChance(withWin, 0, false)).toBe(SLAM_CHANCE.base);

    const team = caribbean({ teams: true }).setup({ seats: 4, rng: createRng(1) });
    const teamWin: DomState = { ...team, lastRoundWinner: 2 };
    // Seat 0 partners seat 2, so the swagger is shared.
    expect(slamChance(teamWin, 0, false)).toBe(SLAM_CHANCE.lastWinner);
    expect(slamChance(teamWin, 1, false)).toBe(SLAM_CHANCE.base);
  });

  it("is near-certain on the tile that goes out", () => {
    const { state } = dealt(3);
    expect(slamChance(state, HERO, true)).toBe(SLAM_CHANCE.goingOut);
  });

  it("fires at roughly the designed rate across a sweep", () => {
    let plays = 0;
    let slams = 0;
    let goingOutPlays = 0;
    let goingOutSlams = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const rng = createRng(seed);
      const def = caribbean({ target: 3 });
      let state = def.setup({ seats: 4, rng });
      ({ state } = startRound(state, rng));
      let guard = 0;
      while (!def.isOver(state) && guard++ < 4000) {
        if (def.isRoundOver!(state)) {
          ({ state } = startRound(state, rng));
          continue;
        }
        const seat = def.currentSeat(state)!;
        const action = def.bots.steady.choose(def.playerView(state, seat), seat, rng);
        const { state: next, events } = def.reduce(state, action);
        if (action.t === "play") {
          const out = (next.hands[seat] ?? []).length === 0;
          const slammed = events.some((e) => e.t === "slam");
          if (out) {
            goingOutPlays++;
            if (slammed) goingOutSlams++;
          } else {
            plays++;
            if (slammed) slams++;
          }
        }
        state = next;
      }
    }
    expect(plays).toBeGreaterThan(500);
    // A correctness suite cannot otherwise see whether a probabilistic
    // feature fires at all, let alone at the intended rate — the same
    // reason Rummy counts its claim windows. Generous bands: this is
    // pinning "roughly as designed", not the hash's exact output.
    const rate = slams / plays;
    expect(rate).toBeGreaterThan(0.06);
    expect(rate).toBeLessThan(0.2);
    const outRate = goingOutSlams / goingOutPlays;
    expect(goingOutPlays).toBeGreaterThan(20);
    expect(outRate).toBeGreaterThan(0.65);
  });

  it("rides immediately before the move, and shakes only what is on the table", () => {
    let checked = 0;
    for (let seed = 1; seed <= 40 && checked < 25; seed++) {
      const rng = createRng(seed);
      const def = caribbean({ target: 3 });
      let state = def.setup({ seats: 4, rng });
      ({ state } = startRound(state, rng));
      let guard = 0;
      while (!def.isOver(state) && guard++ < 4000) {
        if (def.isRoundOver!(state)) {
          ({ state } = startRound(state, rng));
          continue;
        }
        const seat = def.currentSeat(state)!;
        const action = def.bots.steady.choose(def.playerView(state, seat), seat, rng);
        const before = state;
        const { state: next, events } = def.reduce(state, action);
        const at = events.findIndex((e) => e.t === "slam");
        if (at >= 0) {
          checked++;
          const slam = events[at]!;
          if (slam.t !== "slam") throw new Error("unreachable");
          // The move for the same piece must be the very next event, or
          // the flourish and the flight are two gestures rather than one.
          const next1 = events[at + 1];
          expect(next1?.t).toBe("move");
          expect(next1 && next1.t === "move" ? next1.piece : null).toBe(slam.piece);

          const onBoard = new Set(before.chain.map((t) => t.id));
          expect(slam.shake.every((id) => onBoard.has(id))).toBe(true);
          // The decisive property: a shake can never reach into a hand.
          const inHands = new Set(Object.values(before.hands).flat());
          expect(slam.shake.some((id) => inHands.has(id))).toBe(false);
          expect(slam.shake).not.toContain(slam.piece);

          // `final` has to agree with whether THIS play actually emptied
          // the hand — never guessed from the odds (going out is ~80%,
          // not 100%), and never left to default to `false`.
          const goesOut = (next.hands[seat] ?? []).length === 0;
          expect(slam.final).toBe(goesOut);
        }
        state = next;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("marks the round-ending slam final, and never an ordinary one", () => {
    let regular = 0;
    let final = 0;
    for (let seed = 1; seed <= 60 && (regular === 0 || final === 0); seed++) {
      const rng = createRng(seed);
      const def = caribbean({ target: 3 });
      let state = def.setup({ seats: 4, rng });
      ({ state } = startRound(state, rng));
      let guard = 0;
      while (!def.isOver(state) && guard++ < 4000) {
        if (def.isRoundOver!(state)) {
          ({ state } = startRound(state, rng));
          continue;
        }
        const seat = def.currentSeat(state)!;
        const action = def.bots.steady.choose(def.playerView(state, seat), seat, rng);
        const { state: next, events } = def.reduce(state, action);
        for (const e of events) {
          if (e.t !== "slam") continue;
          if (e.final) final++;
          else regular++;
        }
        state = next;
      }
    }
    expect(regular).toBeGreaterThan(0);
    expect(final).toBeGreaterThan(0);
  });

  it("is off entirely in classic, even on the going-out tile", () => {
    // Gated on the mode inside `rollsSlam` itself rather than at the
    // call site, so a future caller cannot reintroduce it by accident.
    // The going-out roll is the one at 80%, so if any case leaks through
    // in classic it is this one.
    const { state } = dealt(15);
    const asClassic: DomState = { ...state, rules: { ...state.rules, mode: "classic" } };
    for (const tile of doubleSixSet()) {
      expect(rollsSlam(asClassic, HERO, tile, true)).toBe(false);
    }
    // ...and the identical position in Caribbean does slam.
    expect(doubleSixSet().some((tile) => rollsSlam(state, HERO, tile, true))).toBe(true);
  });
});

describe("caribbean — full match sweep", () => {
  it("terminates under every toggle combination", () => {
    const combos: Array<Partial<DominoesOptions>> = [
      { target: 3 },
      { target: 3, keyTileBonus: true },
      { target: 3, teams: true },
      { target: 3, teams: true, keyTileBonus: true },
      { target: 3, teams: true, sixLove: true },
    ];
    for (const opts of combos) {
      for (const seed of [1, 40, 909]) {
        const { state, exhausted } = runMatch(seed, opts);
        expect(exhausted).toBe(false);
        expect(state.winner).not.toBeNull();
      }
    }
  });

  it("keeps every tile accounted for across round transitions", () => {
    const { states } = runMatch(23, { target: 4 });
    for (const s of states) {
      const seen = [...s.chain.map((t) => t.id), ...Object.values(s.hands).flat()];
      expect(seen).toHaveLength(28);
      expect(new Set(seen).size).toBe(28);
    }
  });

  it("never lets a chain outgrow what the board is sized for", () => {
    // Classic's cap is 26 (two tiles never leave the boneyard). Caribbean
    // deals all 28 but the round ends the instant one seat empties, so
    // the other three still hold at least one each — 25 is the true
    // ceiling and the board has room for it.
    const { states } = runMatch(23, { target: 6 });
    for (const s of states) expect(s.chain.length).toBeLessThanOrEqual(25);
  });

  it("scores a blocked round to somebody far more often than not", () => {
    // Sanity on the documented rule replacing the earlier "always
    // redeal" reading: most blocks have a clear lowest count.
    const { results } = runMatch(101, { target: 8 });
    const blocked = results.filter((r) => r.kind === "blocked");
    if (blocked.length > 0) {
      const scored = blocked.filter((r) => r.winner !== null);
      expect(scored.length).toBeGreaterThanOrEqual(blocked.length / 2);
    }
  });
});

describe("caribbean — tile weights are unchanged", () => {
  it("still counts pips the ordinary way", () => {
    expect(tilePips("6-6")).toBe(12);
    expect(tilePips("0-0")).toBe(0);
  });
});
