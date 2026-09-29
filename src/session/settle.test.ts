import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import type { SeatId } from "@/engine/types";
import type { LrcState } from "@/games/lrc/types";
import type { PokerState } from "@/games/poker/types";
import { amongPeople, fewestPayments, formatMoney, lrcNets, pokerNets, settleUp, type Payment, type Stint } from "./settle";

/** What the payments leave each seat with: must be exactly zero for all. */
function after(nets: Record<SeatId, number>, payments: Payment[]): Record<SeatId, number> {
  const left = { ...nets };
  for (const p of payments) {
    left[p.from] = (left[p.from] ?? 0) + p.cents;
    left[p.to] = (left[p.to] ?? 0) - p.cents;
  }
  return left;
}

/**
 * The fewest payments, found the slow way: try settling the first unsettled
 * person against every one of opposite sign, and keep the best. Slow, and
 * obviously right, which is what a check on the fast one needs.
 */
function fewestByBruteForce(values: number[]): number {
  const debts = values.filter((v) => v !== 0);
  const go = (start: number): number => {
    while (start < debts.length && debts[start] === 0) start++;
    if (start === debts.length) return 0;
    let best = Infinity;
    for (let i = start + 1; i < debts.length; i++) {
      if (debts[i]! * debts[start]! < 0) {
        debts[i]! += debts[start]!;
        best = Math.min(best, 1 + go(start + 1));
        debts[i]! -= debts[start]!;
      }
    }
    return best;
  };
  return go(0);
}

describe("the fewest payments", () => {
  it("pays two pairs off in two payments, not three", () => {
    // Greedy largest-to-largest can chain these into three.
    const nets = { 0: 500, 1: 500, 2: -500, 3: -500 };
    const payments = fewestPayments(nets);
    expect(payments).toHaveLength(2);
    expect(Object.values(after(nets, payments)).every((v) => v === 0)).toBe(true);
  });

  it("finds the groups that square up among themselves", () => {
    // {0, 2} and {1, 3, 4} each sum to zero: 1 + 2 payments. Taken as one
    // group of five it would be four.
    const nets = { 0: 700, 1: 300, 2: -700, 3: -100, 4: -200 };
    const payments = fewestPayments(nets);
    expect(payments).toHaveLength(3);
    expect(Object.values(after(nets, payments)).every((v) => v === 0)).toBe(true);
  });

  it("is never beaten, over thousands of random tables", () => {
    const rng = createRng(11);
    for (let trial = 0; trial < 2000; trial++) {
      const n = 2 + rng.int(6);
      const values = Array.from({ length: n - 1 }, () => (rng.int(9) - 4) * 25);
      values.push(-values.reduce((a, b) => a + b, 0));
      const nets = Object.fromEntries(values.map((v, i) => [i, v]));

      const payments = fewestPayments(nets);
      expect(Object.values(after(nets, payments)).every((v) => v === 0), `trial ${trial}`).toBe(true);
      expect(payments.every((p) => p.cents > 0), `trial ${trial}`).toBe(true);
      expect(payments.length, `trial ${trial}: ${values.join(",")}`).toBe(fewestByBruteForce(values));
    }
  });

  it("asks nothing of a table where everyone is even", () => {
    expect(fewestPayments({ 0: 0, 1: 0, 2: 0 })).toEqual([]);
  });
});

describe("leaving the bots out", () => {
  it("changes nothing when people won and lost only to each other", () => {
    expect(amongPeople({ 0: 300, 1: -300, 2: 0 }, [0, 1])).toEqual({ nets: { 0: 300, 1: -300 }, scaled: false });
  });

  it("scales the winners down to what the people who lost owe", () => {
    // Ada won $10: $4 of it from Bo, the rest from a bot. Bo pays her $4.
    const { nets, scaled } = amongPeople({ 0: 1000, 1: -400, 2: -600 }, [0, 1]);
    expect(nets).toEqual({ 0: 400, 1: -400 });
    expect(scaled).toBe(true);
  });

  it("scales the losers down to what the people who won are owed", () => {
    // Ada lost $10, $4 of it to Bo. The rest went to a bot, and stays there.
    expect(amongPeople({ 0: -1000, 1: 400, 2: 600 }, [0, 1]).nets).toEqual({ 0: -400, 1: 400 });
  });

  it("shares a shortfall in proportion, to the cent", () => {
    // $10 won between two people, $5 lost by one: each winner gets half.
    const { nets } = amongPeople({ 0: 600, 1: 400, 2: -500, 3: -500 }, [0, 1, 2]);
    expect(nets).toEqual({ 0: 300, 1: 200, 2: -500 });
    // And an odd cent goes somewhere, never nowhere.
    const odd = amongPeople({ 0: 100, 1: 100, 2: 100, 3: -101, 4: -199 }, [0, 1, 2, 3]).nets;
    expect(Object.values(odd).reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe("what each seat is up or down", () => {
  it("LRC: a round won is everyone else's three chips, a round lost your own three", () => {
    const state = { seats: 3, scores: { 0: 2, 1: 1, 2: 0 } } as unknown as LrcState;
    // Three rounds at 25¢ a chip: seat 0 won 2 × 6 chips and lost 3.
    expect(lrcNets(state, 25)).toEqual({ 0: 225, 1: 0, 2: -225 });
  });

  it("Poker: chips against the buy-in, at what a chip is worth", () => {
    const state = {
      seats: 3,
      stacks: { 0: 3000, 1: 1500, 2: 1500 },
      totalCommitted: { 0: 20, 1: 20, 2: 20 },
      pendingShowdown: null,
      result: { showdown: false },
    } as unknown as PokerState;
    // $20 for 2000 chips: one chip is a cent.
    expect(pokerNets(state, 2000, 2000)).toEqual({ 0: 1000, 1: -500, 2: -500 });
  });

  it("Poker: calls off a hand still being played", () => {
    // Everyone has 100 in the pot and nobody has won it yet.
    const state = {
      seats: 2,
      stacks: { 0: 1900, 1: 1900 },
      totalCommitted: { 0: 100, 1: 100 },
      pendingShowdown: null,
      result: null,
    } as unknown as PokerState;
    expect(pokerNets(state, 2000, 2000)).toEqual({ 0: 0, 1: 0 });
  });

  it("Poker: pays a hand already decided at its showdown", () => {
    const state = {
      seats: 2,
      stacks: { 0: 1900, 1: 1900 },
      totalCommitted: { 0: 100, 1: 100 },
      pendingShowdown: { pendingDeltas: { 0: 200 } },
      result: null,
    } as unknown as PokerState;
    expect(pokerNets(state, 2000, 2000)).toEqual({ 0: 100, 1: -100 });
  });

  it("Poker: rounds to whole cents without losing one", () => {
    // $10 for 3000 chips is a third of a cent a chip.
    const state = {
      seats: 3,
      stacks: { 0: 3001, 1: 2999, 2: 3000 },
      totalCommitted: {},
      pendingShowdown: null,
      result: { showdown: false },
    } as unknown as PokerState;
    const nets = pokerNets(state, 1000, 3000);
    expect(Object.values(nets).reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe("settling a game", () => {
  /** Sat down at the deal and still there. */
  const whole = (who: string, seat: SeatId): Stint<string> => ({ who, seat, from: 0, to: null });
  /** Two seats, one LRC round won by seat 0: at 150¢ a chip, seat 0 is up 450¢ and seat 1 down 450¢. */
  const headsUp = { seats: 2, scores: { 0: 1, 1: 0 } } as unknown as LrcState;

  it("is nothing at all without a stake", () => {
    const state = { seats: 3, scores: { 0: 1, 1: 0, 2: 0 } } as unknown as LrcState;
    expect(settleUp("lrc", state, { chipValue: 0 }, [whole("a", 0)])).toBeNull();
    expect(settleUp("spades", {}, {}, [whole("a", 0), whole("b", 1)])).toBeNull();
  });

  it("names the stake, and pays only between people", () => {
    const state = { seats: 3, scores: { 0: 1, 1: 0, 2: 0 } } as unknown as LrcState;
    // Seat 2 is a bot: its 3 chips are left out, and seat 1 pays seat 0 its 3.
    const s = settleUp("lrc", state, { chipValue: 50 }, [whole("ada", 0), whole("bo", 1)])!;
    expect(s.stake).toBe("50¢ a chip");
    expect(s.payments).toEqual([{ from: "bo", to: "ada", cents: 150 }]);
    expect(s.botsLeftOut).toBe(true);
  });

  it("does not charge a newcomer for what the bot lost before they sat down", () => {
    // Bo took seat 1 over from a bot that had already lost 450¢ to Ada, and
    // nothing has happened since. By seat, Bo owed Ada the bot's 450¢.
    const s = settleUp("lrc", headsUp, { chipValue: 150 }, [
      whole("ada", 0),
      { who: "bo", seat: 1, from: -450, to: null },
    ])!;
    expect(s.results).toContainEqual({ who: "bo", cents: 0 });
    expect(s.payments).toEqual([]);
    expect(s.botsLeftOut).toBe(true);
  });

  it("keeps somebody who walked out on what they had lost by then", () => {
    // Bo lost 450¢ to Ada, then left the room; a bot played the seat on. By
    // seat, Bo counted as a bot and owed nothing.
    const s = settleUp("lrc", headsUp, { chipValue: 150 }, [
      whole("ada", 0),
      { who: "bo", seat: 1, from: 0, to: -450 },
    ])!;
    expect(s.payments).toEqual([{ from: "bo", to: "ada", cents: 450 }]);
    expect(s.botsLeftOut).toBe(false);
  });

  it("adds up everything a person did, in every seat they sat in", () => {
    // Ada held seat 0 while it won 450¢, walked out, and came back to seat 1
    // after it had lost those 450¢ — and it has not moved since.
    const s = settleUp("lrc", headsUp, { chipValue: 150 }, [
      { who: "ada", seat: 0, from: 0, to: 450 },
      { who: "bo", seat: 1, from: 0, to: -450 },
      { who: "ada", seat: 1, from: -450, to: null },
    ])!;
    expect(s.results).toHaveLength(2);
    expect(s.payments).toEqual([{ from: "bo", to: "ada", cents: 450 }]);
  });

  it("writes money the way people say it", () => {
    expect(formatMoney(25)).toBe("25¢");
    expect(formatMoney(100)).toBe("$1");
    expect(formatMoney(2000)).toBe("$20");
    expect(formatMoney(1250)).toBe("$12.50");
  });
});
