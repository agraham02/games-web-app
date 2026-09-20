import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import { createBs } from "./rules";
import {
  CHALLENGE_GRACE_MS,
  CHALLENGE_MS_ONLINE,
  CHALLENGE_MS_SOLO,
  MAX_PER_PLAY,
  REACTION_MAX,
  REACTION_MIN,
  challengeDeadlineMs,
  challengeReactions,
  entitledToCall,
  handTotalOf,
  nearestRivalCount,
  nextSeat,
  pileCardsOf,
  pileSize,
} from "./state";
import type { BsState } from "./types";

const def = createBs();

function fixture(overrides: Partial<BsState> = {}): BsState {
  return {
    ...def.setup({ seats: 4, rng: createRng(1) }),
    dealt: true,
    turn: 0,
    hands: { 0: [], 1: [], 2: [], 3: [] },
    ...overrides,
  };
}

describe("bs — seats", () => {
  it("passes the turn anticlockwise and wraps", () => {
    expect(nextSeat(4, 0)).toBe(1);
    expect(nextSeat(4, 3)).toBe(0);
    expect(nextSeat(2, 1)).toBe(0);
  });

  it("finds the shortest hand that is not this seat's", () => {
    const state = fixture({ hands: { 0: ["a"], 1: ["b", "c"], 2: ["d", "e", "f"], 3: ["g", "h"] } });
    expect(nearestRivalCount(state, 0)).toBe(2);
    expect(nearestRivalCount(state, 2)).toBe(1);
  });
});

describe("bs — the pile", () => {
  it("reads oldest first across every claim", () => {
    const state = fixture({
      plays: [
        { seat: 0, claimed: "A", cards: ["SA"] },
        { seat: 1, claimed: "2", cards: ["H2", "D9"] },
      ],
    });
    expect(pileCardsOf(state.plays)).toEqual(["SA", "H2", "D9"]);
    expect(pileSize(state)).toBe(3);
  });

  it("counts every card held at the table", () => {
    expect(handTotalOf({ 0: ["a"], 1: ["b", "c"], 2: [], 3: ["d"] }, 4)).toBe(4);
  });
});

describe("bs — the reaction race", () => {
  const state = fixture({ plays: [{ seat: 1, claimed: "A", cards: ["SA"] }] });

  it("draws every seat but the claimer, soonest first", () => {
    const race = challengeReactions(state, 1, state.plays[0]!, 0);
    expect(race.map((r) => r.seat).sort()).toEqual([0, 2, 3]);
    expect(race.map((r) => r.ms)).toEqual([...race.map((r) => r.ms)].sort((a, b) => a - b));
    for (const { ms } of race) {
      expect(ms).toBeGreaterThanOrEqual(REACTION_MIN);
      expect(ms).toBeLessThanOrEqual(REACTION_MAX);
    }
  });

  it("is a pure function of the position, so a seed replays the race", () => {
    // Hashed from the position rather than drawn from an rng, because
    // `reduce` receives none — and who wins a race has to replay exactly.
    expect(challengeReactions(state, 1, state.plays[0]!, 0))
      .toEqual(challengeReactions(state, 1, state.plays[0]!, 0));
  });

  it("gives a different order to a different play", () => {
    const other = fixture({ plays: [{ seat: 1, claimed: "A", cards: ["HA"] }] });
    const a = challengeReactions(state, 1, state.plays[0]!, 0).map((r) => r.ms);
    const b = challengeReactions(other, 1, other.plays[0]!, 0).map((r) => r.ms);
    expect(a).not.toEqual(b);
  });

  it("orders ties by seat, so an identical position can only resolve one way", () => {
    const race = challengeReactions(state, 1, state.plays[0]!, 0);
    const pairs = race.map((r) => [r.ms, r.seat] as const);
    for (let i = 1; i < pairs.length; i++) {
      const [pm, ps] = pairs[i - 1]!;
      const [cm, cs] = pairs[i]!;
      expect(pm < cm || (pm === cm && ps < cs), `${pm}/${ps} before ${cm}/${cs}`).toBe(true);
    }
  });
});

describe("bs — the window's clock", () => {
  it("shows a player the whole window, not a share of it shortened by rivals", () => {
    // Rummy's claim deadline caps a seat at the fastest rival's reaction. That
    // is right for a race that happens once every twelve rounds and wrong for
    // one after every play: it would hand a player 250ms to answer.
    const windowed = def.reduce(
      fixture({ hands: { 0: ["H2", "S9"], 1: ["D3"], 2: ["C4"], 3: ["C5"] } }),
      { t: "play", cards: ["H2"] },
    ).state;
    expect(challengeDeadlineMs(windowed)).toBe(CHALLENGE_MS_SOLO);
    for (const { seat } of windowed.window!.pending) {
      expect(entitledToCall(windowed, seat), `seat ${seat}`).toBe(true);
    }
    expect(entitledToCall(windowed, 0), "the claimer is never entitled").toBe(false);
  });

  it("gives a room a longer window than a solo table", () => {
    // Online the next player can cut a window short simply by playing, so a
    // generous one costs nobody but the person choosing to use all of it.
    expect(CHALLENGE_MS_ONLINE).toBeGreaterThan(CHALLENGE_MS_SOLO);
    expect(CHALLENGE_GRACE_MS).toBeGreaterThan(0);
  });

  it("caps a claim at what a rank can actually hold", () => {
    expect(MAX_PER_PLAY).toBe(4);
  });
});
