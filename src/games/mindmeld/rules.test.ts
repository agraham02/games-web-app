import { createRng } from "@/engine/rng";
import type { GameEvent, SeatId } from "@/engine/types";
import { describe, expect, it } from "vitest";
import { fallbackBrain, type WordBrain } from "./brain";
import { HIDDEN_WORD, createMindMeld } from "./rules";
import { activePairs } from "./schedule";
import type { MindMeldAction, MindMeldRules, MindMeldState } from "./types";

/**
 * A fake brain, so a bot's word is exactly what a test says and nothing about
 * these rules depends on how good the real one is.
 */
const brain = (words: string[] = []): WordBrain => {
  let n = 0;
  return {
    bridge: () => words[n++ % Math.max(1, words.length)] ?? "thing",
    starter: () => words[n++ % Math.max(1, words.length)] ?? "thing",
  };
};

function game(rules: Partial<MindMeldRules> = {}, seats = 4, b?: WordBrain) {
  const def = createMindMeld(rules, { brain: () => b ?? brain(["apple"]) });
  const rng = createRng(5);
  const base = def.setup({ seats, rng });
  const { state } = def.startRound!(base, rng);
  return { def, rng, state };
}

function lock(
  def: ReturnType<typeof createMindMeld>,
  state: MindMeldState,
  seat: number,
  word: string,
): { state: MindMeldState; events: GameEvent[] } {
  const action: MindMeldAction = { t: "submit", seat: seat as SeatId, word };
  const problem = def.validate!(state, seat as SeatId, action);
  if (problem) throw new Error(`seat ${seat} "${word}": ${problem}`);
  return def.reduce(state, def.completeAction!(state, action, seat as SeatId, createRng(1)));
}

/** Every active seat locks one word, in seat order; returns the last result. */
function round(def: ReturnType<typeof createMindMeld>, state: MindMeldState, words: Record<number, string>) {
  let r = { state, events: [] as GameEvent[] };
  for (const seat of Object.keys(words).map(Number)) r = lock(def, r.state, seat, words[seat]!);
  return r;
}

describe("setting up", () => {
  it("makes pairs of adjacent seats, and rounds an odd count up to a bot's seat", () => {
    const { state } = game({}, 4);
    expect(state.pairs.map((p) => p.seats)).toEqual([[0, 1], [2, 3]]);
    expect(game({}, 5).state.seats).toBe(6);
    expect(game({}, 3).state.seats).toBe(4);
    expect(game({}, 1).state.seats).toBe(2);
    expect(game({}, 99).state.seats).toBe(10);
  });

  it("clamps hostile rules into their ranges", () => {
    const def = createMindMeld({ rounds: 99, tries: 3 as never, thinkSeconds: 7 as never, start: "x" as never });
    const s = def.setup({ seats: 4, rng: createRng(1) });
    expect(s.rules).toMatchObject({ rounds: 9, tries: 10, thinkSeconds: 0, start: "free", familySafe: true });
    expect(createMindMeld({ rounds: Number.NaN }).setup({ seats: 2, rng: createRng(1) }).rules.rounds).toBe(5);
  });

  it("places nothing on the table", () => {
    const { def, state } = game();
    expect(def.pieces(state)).toEqual({});
    expect(def.placements(state, 0)).toEqual({});
  });

  it("deals each pair two starting words that are not the same word, when asked", () => {
    const { state } = game({ start: "dealt" }, 4, brain(["beach", "sand", "sun", "sea"]));
    for (const pair of state.pairs) {
      expect(pair.chain).toHaveLength(2);
    }
    expect(game({ start: "free" }).state.pairs.every((p) => p.chain.length === 0)).toBe(true);
  });
});

describe("a try", () => {
  it("waits for everybody, then shows every word at once, after a countdown", () => {
    const { def, state } = game();
    const a = lock(def, state, 0, "dog");
    expect(a.state.pairs[0]!.chain).toEqual([]);
    const b = lock(def, a.state, 1, "cat");
    expect(b.state.pairs[0]!.chain).toEqual([]); // the other pair is not in yet
    const c = lock(def, b.state, 2, "sun");
    const d = lock(def, c.state, 3, "moon");
    expect(d.state.pairs[0]!.chain).toEqual(["dog", "cat"]);
    expect(d.state.pairs[1]!.chain).toEqual(["sun", "moon"]);
    expect(d.events[0]).toMatchObject({ t: "cue", kind: "countdown" });
    expect(d.state.reveal?.map((r) => r.outcome)).toEqual(["miss", "miss"]);
    expect(d.state.tryNo).toBe(1);
  });

  it("is the partners' words in order, a then b, try after try", () => {
    const { def, state } = game({}, 2);
    let s = round(def, state, { 0: "dog", 1: "cat" }).state;
    s = round(def, s, { 0: "pet", 1: "fur" }).state;
    expect(s.pairs[0]!.chain).toEqual(["dog", "cat", "pet", "fur"]);
    expect(s.pairs[0]!.tries).toBe(2);
  });

  it("is a meld when the two words are the same word, in any form a person would call it", () => {
    for (const [a, b] of [["dog", "Dogs"], ["ice-cream", "ice cream"], ["colour", "color"], ["2", "two"], ["café", "cafe"]]) {
      const { def, state } = game({}, 2);
      const r = round(def, state, { 0: a!, 1: b! });
      expect(r.state.pairs[0]!.meldedOn, `${a} / ${b}`).toBe(1);
    }
  });

  it("is a miss for a typo - and a so close, which is a flourish and never a meld", () => {
    const { def, state } = game({}, 2);
    const r = round(def, state, { 0: "recieve", 1: "receive" });
    expect(r.state.pairs[0]!.meldedOn).toBeNull();
    expect(r.state.reveal?.[0]!.outcome).toBe("close");
    expect(r.events.some((e) => e.t === "cue" && e.kind === "close")).toBe(true);
  });

  it("scores a meld by its try: ten on the first, one less each time, never under one", () => {
    const meldOn = (n: number) => {
      const { def, state } = game({ tries: 15 }, 2);
      let s = state;
      for (let t = 1; t < n; t++) s = round(def, s, { 0: `a${t}x`, 1: `b${t}y` }).state;
      s = round(def, s, { 0: "same", 1: "same" }).state;
      return s.pairs[0]!.points;
    };
    expect(meldOn(1)).toBe(10);
    expect(meldOn(2)).toBe(9);
    expect(meldOn(5)).toBe(6);
    expect(meldOn(10)).toBe(1);
    expect(meldOn(12)).toBe(1);
  });

  it("takes a melded pair out of the try: its seats are done, the rest go on", () => {
    const { def, state } = game();
    const r = round(def, state, { 0: "same", 1: "same", 2: "sun", 3: "moon" });
    expect(r.state.pairs[0]!.meldedOn).toBe(1);
    expect(def.legalActions(r.state, 0)).toEqual([]);
    expect(def.legalActions(r.state, 2)).toHaveLength(1);
    expect(r.state.window?.pending.map((p) => p.seat).sort()).toEqual([2, 3]);
  });
});

describe("what may be locked in", () => {
  it("refuses a word the pair has already said, in any form, and says only that", () => {
    const { def, state } = game({}, 2);
    const s = round(def, state, { 0: "dog", 1: "cat" }).state;
    expect(def.validate!(s, 0, { t: "submit", seat: 0, word: "Dogs" })).toMatch(/has been used/);
    expect(def.validate!(s, 1, { t: "submit", seat: 1, word: "the cat" })).toMatch(/has been used/);
    expect(def.validate!(s, 0, { t: "submit", seat: 0, word: "pet" })).toBeNull();
  });

  it("refuses nothing, too long, too many words, and what is not text", () => {
    const { def, state } = game({}, 2);
    expect(def.validate!(state, 0, { t: "submit", seat: 0, word: "  " })).toMatch(/type a word/i);
    expect(def.validate!(state, 0, { t: "submit", seat: 0, word: "x".repeat(40) })).toMatch(/too long/i);
    expect(def.validate!(state, 0, { t: "submit", seat: 0, word: "one two three four" })).toMatch(/3 words/i);
    expect(def.validate!(state, 0, { t: "submit", seat: 0, word: 5 as never })).toMatch(/text/);
    expect(def.validate!(state, 0, undefined as never)).toMatch(/not an action/);
    expect(def.validate!(state, 0, { t: "nope" } as never)).toMatch(/unknown/);
  });

  it("refuses a rude word with the filter on, and lets it through with it off", () => {
    const rude = "sh1t";
    const on = game({ familySafe: true }, 2);
    expect(on.def.validate!(on.state, 0, { t: "submit", seat: 0, word: rude })).toMatch(/another word/);
    const off = game({ familySafe: false }, 2);
    expect(off.def.validate!(off.state, 0, { t: "submit", seat: 0, word: rude })).toBeNull();
  });

  it("is not a second lock-in, and not for a seat whose pair is finished", () => {
    const { def, state } = game();
    const once = lock(def, state, 0, "dog").state;
    expect(def.validate!(once, 0, { t: "submit", seat: 0, word: "cat" })).toMatch(/nothing to lock in/);
    const melded = round(def, state, { 0: "same", 1: "same", 2: "a", 3: "b" }).state;
    expect(def.validate!(melded, 0, { t: "submit", seat: 0, word: "more" })).toMatch(/nothing to lock in/);
  });

  it("stamps the real seat, whatever a client sent", () => {
    const { def, state } = game();
    const stamped = def.completeAction!(state, { t: "submit", seat: 3, word: "dog" }, 1, createRng(1));
    expect(stamped).toEqual({ t: "submit", seat: 1, word: "dog" });
  });
});

describe("the round and the match", () => {
  it("ends when every pair has melded, and scores each pair's points to both partners", () => {
    const { def, state } = game({ rounds: 3 });
    let s = round(def, state, { 0: "same", 1: "same", 2: "x", 3: "y" }).state;
    s = round(def, s, { 2: "z", 3: "z" }).state;
    expect(def.isRoundOver!(s)).toBe(true);
    // Pair 0 melded on try 1 (10); pair 1 on try 2 (9).
    expect(s.scores).toEqual({ 0: 10, 1: 10, 2: 9, 3: 9 });
    expect(s.result?.winner).toBe(0);
    expect(s.result?.deltas).toEqual({ 0: 10, 1: 10, 2: 9, 3: 9 });
  });

  it("scores nothing for a pair that runs out of tries", () => {
    const { def, state } = game({ tries: 8 }, 2);
    let s = state;
    for (let t = 0; t < 8; t++) s = round(def, s, { 0: `p${t}a`, 1: `q${t}b` }).state;
    expect(def.isRoundOver!(s)).toBe(true);
    expect(s.pairs[0]!.points).toBe(0);
    expect(s.scores[0]).toBe(0);
  });

  it("plays the set number of rounds, and the most points wins", () => {
    const { def, rng, state } = game({ rounds: 2 });
    let s = state;
    for (let r = 0; r < 2; r++) {
      s = round(def, s, { 0: "same", 1: "same", 2: "x", 3: "y" }).state;
      s = round(def, s, { 2: "q", 3: "q" }).state;
      if (r === 0) {
        expect(def.isOver(s)).toBe(false);
        s = def.startRound!(s, rng).state;
      }
    }
    expect(def.isOver(s)).toBe(true);
    expect(s.winner).toBe(0);
  });

  it("plays on past the last round if the pairs are level", () => {
    const { def, rng, state } = game({ rounds: 1 });
    // Both pairs meld on the first try: 10 each, a tie.
    let s = round(def, state, { 0: "same", 1: "same", 2: "same", 3: "same" }).state;
    expect(def.isRoundOver!(s)).toBe(true);
    expect(def.isOver(s)).toBe(false);
    s = def.startRound!(s, rng).state;
    expect(s.round).toBe(2);
    s = round(def, s, { 0: "same", 1: "same", 2: "a", 3: "b" }).state;
    s = round(def, s, { 2: "c", 3: "c" }).state;
    expect(s.winner).toBe(0);
  });

  it("is a co-op game with one pair: they win together when the rounds are done", () => {
    const { def, state } = game({ rounds: 1 }, 2);
    const s = round(def, state, { 0: "same", 1: "same" }).state;
    expect(def.isOver(s)).toBe(true);
    expect(s.winner).toBe(0);
  });
});

describe("think time", () => {
  it("names no deadline of its own with no limit: the room's turn timer covers somebody away", () => {
    const { def, state } = game();
    expect(def.deadline!(state, 0)).toBeNull();
  });

  it("gives a person the think time plus the grace, one deadline for the whole try", () => {
    const { def, state } = game({ thinkSeconds: 30 });
    const d0 = def.deadline!(state, 0);
    const d2 = def.deadline!(state, 2);
    expect(d0?.ms).toBe(30_900);
    expect(d0?.key).toBe(d2?.key);
    // A new try is a new clock.
    const next = round(def, state, { 0: "a", 1: "b", 2: "c", 3: "d" }).state;
    expect(def.deadline!(next, 0)?.key).not.toBe(d0?.key);
  });

  it("gives a seat that has already locked no deadline", () => {
    const { def, state } = game({ thinkSeconds: 30 });
    const s = lock(def, state, 0, "dog").state;
    expect(def.deadline!(s, 0)).toBeNull();
    expect(def.deadline!(s, 1)).not.toBeNull();
  });

  it("forfeits the try for a pair still waiting, and reveals the others", () => {
    const { def, state } = game({ thinkSeconds: 30 });
    const s = round(def, state, { 0: "dog", 1: "cat", 2: "sun" }).state; // seat 3 never locks
    const r = def.reduce(s, { t: "timeout" });
    expect(r.state.pairs[1]!.tries).toBe(1);
    expect(r.state.pairs[1]!.chain).toEqual([]);
    expect(r.state.reveal?.find((x) => x.pair === 1)?.outcome).toBe("timeout");
    // The pair that was ready is shown as usual.
    expect(r.state.pairs[0]!.chain).toEqual(["dog", "cat"]);
    expect(r.events.some((e) => e.t === "announce" && e.text === "ran out of time")).toBe(true);
    // Everybody starts the next try with nothing locked.
    expect(Object.values(r.state.locks).every((l) => l === null)).toBe(true);
  });

  it("only lets a seat that is still waiting time out", () => {
    const { def, state } = game();
    const s = lock(def, state, 0, "dog").state;
    expect(def.validate!(s, 0, { t: "timeout" })).toMatch(/not waiting/);
    expect(def.validate!(s, 1, { t: "timeout" })).toBeNull();
  });
});

describe("what a viewer is told", () => {
  const SECRET = "zebracorn";

  it("shows only the viewer's own locked word, and that others have locked", () => {
    const { def, state } = game();
    const s = lock(def, lock(def, state, 0, SECRET).state, 2, "other").state;
    const view0 = def.playerView(s, 0);
    expect(view0.locks[0]).toBe(SECRET);
    expect(view0.locks[2]).toBe(HIDDEN_WORD);
    expect(view0.locks[1]).toBeNull(); // not locked: that is public
    const view1 = def.playerView(s, 1);
    expect(view1.locks[0]).toBe(HIDDEN_WORD);
    expect(JSON.stringify(view1)).not.toContain(SECRET);
    expect(JSON.stringify(def.playerView(s, 3))).not.toContain(SECRET);
  });

  it("shows a spectator no word at all", () => {
    const { def, state } = game();
    const s = lock(def, state, 0, SECRET).state;
    expect(JSON.stringify(def.playerView(s, -1 as SeatId))).not.toContain(SECRET);
  });

  it("makes a word public by revealing it, and not before", () => {
    const { def, state } = game({}, 2);
    const half = lock(def, state, 0, SECRET).state;
    expect(JSON.stringify(def.playerView(half, 1))).not.toContain(SECRET);
    const shown = lock(def, half, 1, "other").state;
    expect(JSON.stringify(def.playerView(shown, 1))).toContain(SECRET);
  });

  it("is always unpredictable: the reveal depends on words nobody can see", () => {
    const { def, state } = game();
    expect(def.unpredictable!(state, 0, { t: "submit", seat: 0, word: "x" })).toBe(true);
  });
});

describe("the clock a bot is paced by", () => {
  it("orders the seats by when a bot would have a word, soonest first, and names the soonest", () => {
    const { def, state } = game({}, 6);
    const order = state.window!.pending;
    expect(order).toHaveLength(6);
    for (let i = 1; i < order.length; i++) expect(order[i]!.ms).toBeGreaterThanOrEqual(order[i - 1]!.ms);
    expect(def.currentSeat(state)).toBe(order[0]!.seat);
  });

  it("is the same on every replay, so a seed replays a table's pace", () => {
    const a = game({}, 6).state.window;
    const b = game({}, 6).state.window;
    expect(a).toEqual(b);
  });

  it("has a bot wait out the rest of its time, never less than the beat", () => {
    const { def, state } = game({}, 4);
    const first = state.window!.pending[0]!;
    expect(def.turnHold!(state, first.seat)).toBe(first.ms);
    const after = lock(def, state, first.seat, "x").state;
    const second = after.window!.pending[0]!;
    expect(def.turnHold!(after, second.seat)).toBe(Math.max(150, second.ms - first.ms));
  });
});

describe("which pairs play a try is the schedule's answer", () => {
  /** A stand-in "take turns" schedule: the lowest-numbered pair that is still in. */
  const oneAtATime = (state: MindMeldState) => {
    const live = state.pairs.filter((p) => p.meldedOn === null && p.tries < state.rules.tries);
    return live.length > 0 ? [live[0]!.id] : [];
  };

  it("runs the whole round for one pair at a time without a change to the rules", () => {
    const def = createMindMeld({}, { schedule: oneAtATime, brain: () => brain(["x"]) });
    const rng = createRng(2);
    let s = def.startRound!(def.setup({ seats: 6, rng }), rng).state;
    expect(activePairs(s, oneAtATime)).toEqual([0]);
    // Only pair 0's seats may act.
    expect(def.legalActions(s, 0)).toHaveLength(1);
    expect(def.legalActions(s, 2)).toEqual([]);

    s = round(def, s, { 0: "same", 1: "same" }).state;
    expect(s.pairs[0]!.meldedOn).toBe(1);
    // Pair 1 is up next, and pair 2 still waits.
    expect(def.legalActions(s, 2)).toHaveLength(1);
    expect(def.legalActions(s, 4)).toEqual([]);

    s = round(def, s, { 2: "a", 3: "a" }).state;
    s = round(def, s, { 4: "b", 5: "b" }).state;
    expect(def.isRoundOver!(s)).toBe(true);
    expect(s.scores).toMatchObject({ 0: 10, 2: 10, 4: 10 });
  });
});

describe("a whole match, bots on every seat", () => {
  function play(seats: number, seed: number, rules: Partial<MindMeldRules>) {
    const def = createMindMeld({ rounds: 2, ...rules }, { brain: () => fallbackBrain });
    const rng = createRng(seed);
    let s = def.startRound!(def.setup({ seats, rng }), rng).state;
    let steps = 0;
    while (!def.isOver(s)) {
      if (def.isRoundOver!(s)) {
        s = def.startRound!(s, rng).state;
        continue;
      }
      if (++steps > 5000) throw new Error("never ended");
      const seat = def.currentSeat(s);
      if (seat === null) throw new Error("nobody to act in a live round");
      const view = def.playerView(s, seat);
      const action = def.bots.steady.choose(view, seat, rng);
      const problem = def.validate!(s, seat, action);
      if (problem) throw new Error(`bot chose an invalid word: ${problem} ${JSON.stringify(action)}`);
      s = def.reduce(s, action).state;
    }
    return s;
  }

  for (const seats of [2, 4, 6, 10]) {
    for (const start of ["free", "dealt"] as const) {
      it(`${seats} seats, ${start} start: ends, and every word a bot chooses is a valid one`, () => {
        for (let seed = 1; seed <= 4; seed++) {
          const s = play(seats, seed, { start, tries: 8 });
          expect(s.winner).not.toBeNull();
        }
      });
    }
  }
});
