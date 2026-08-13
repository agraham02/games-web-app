import { describe, expect, it } from "vitest";
import type { SeatId } from "@/engine/types";
import { scoreRound, TARGET_SCORE, AUTO_LOSS_SCORE } from "./scoring";
import type { Bid } from "./types";

/**
 * Team A is seats 0 and 2; team B is seats 1 and 3 (see state.ts's
 * `teammates`). A team's contract target is the SUM of its two members'
 * individual bids, not either one alone — every fixture below picks two
 * DIFFERENT numbers for a team's pair so a copy-paste "both partners bid
 * the same number" mistake can't silently pass.
 */

function bid(tricks: number, opts: Partial<Bid> = {}): Bid {
  return { tricks, nil: false, blind: false, ...opts };
}
function nil(opts: Partial<Bid> = {}): Bid {
  return { tricks: 0, nil: true, blind: false, ...opts };
}

const NO_BAGS: Record<SeatId, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };

describe("scoreRound — the shared numeric contract", () => {
  it("pays 10/trick when the team makes its bid exactly", () => {
    // Team A: 2 + 2 = 4. Team B: 3 + 0 = 3.
    const bids = { 0: bid(2), 1: bid(3), 2: bid(2), 3: bid(0) };
    const tricksWon = { 0: 2, 1: 2, 2: 2, 3: 1 };
    const { deltas, bags } = scoreRound(bids, tricksWon, NO_BAGS);
    expect(deltas[0]).toBe(40);
    expect(deltas[2]).toBe(40);
    expect(deltas[1]).toBe(30);
    expect(deltas[3]).toBe(30);
    expect(bags[0]).toBe(0);
  });

  it("adds 1 point per overtrick as bags", () => {
    // Team A target: 3 + 2 = 5. Takes 4 + 3 = 7 -> 2 overtricks.
    const bids = { 0: bid(3), 1: bid(2), 2: bid(2), 3: bid(2) };
    const tricksWon = { 0: 4, 1: 2, 2: 3, 3: 2 };
    const { deltas, bags } = scoreRound(bids, tricksWon, NO_BAGS);
    expect(deltas[0]).toBe(52); // 5*10 + 2
    expect(bags[0]).toBe(2);
  });

  it("sets the team back 10/trick, never doubled, on a failed bid", () => {
    // Team A target: 5 + 2 = 7. Takes 3 + 2 = 5 -> short by 2.
    const bids = { 0: bid(5), 1: bid(2), 2: bid(2), 3: bid(2) };
    const tricksWon = { 0: 3, 1: 3, 2: 2, 3: 3 };
    const { deltas, bags } = scoreRound(bids, tricksWon, NO_BAGS);
    expect(deltas[0]).toBe(-70);
    expect(bags[0]).toBe(0);
  });

  it("never lets bags accrue on a failed bid even with tricks to spare", () => {
    // Team A target: 9 + 2 = 11. Takes 6 + 4 = 10 -> still short.
    const bids = { 0: bid(9), 1: bid(1), 2: bid(2), 3: bid(1) };
    const tricksWon = { 0: 6, 1: 1, 2: 4, 3: 1 };
    const { deltas, bags } = scoreRound(bids, tricksWon, NO_BAGS);
    expect(deltas[0]).toBe(-110);
    expect(bags[0]).toBe(0);
  });
});

describe("scoreRound — Nil and Blind Nil", () => {
  it("pays +100 for a successful Nil, on top of partner's own contract", () => {
    const bids = { 0: nil(), 1: bid(4), 2: bid(6), 3: bid(3) };
    const tricksWon = { 0: 0, 1: 4, 2: 6, 3: 3 };
    const { deltas } = scoreRound(bids, tricksWon, NO_BAGS);
    expect(deltas[0]).toBe(160); // 100 nil bonus + 6*10 partner contract
  });

  it("costs -100 for a failed Nil, and the stray tricks count as bags", () => {
    const bids = { 0: nil(), 1: bid(4), 2: bid(6), 3: bid(3) };
    const tricksWon = { 0: 2, 1: 4, 2: 6, 3: 1 }; // nil bidder took 2 unwanted tricks
    const { deltas, bags } = scoreRound(bids, tricksWon, NO_BAGS);
    // -100 nil penalty + 6*10 contract (team took 8 total, target 6 -> 2 bags)
    expect(deltas[0]).toBe(-100 + 60 + 2);
    expect(bags[0]).toBe(2);
  });

  it("pays +200 for a successful Blind Nil", () => {
    const bids = { 0: nil({ blind: true }), 1: bid(4), 2: bid(6), 3: bid(3) };
    const tricksWon = { 0: 0, 1: 4, 2: 6, 3: 3 };
    const { deltas } = scoreRound(bids, tricksWon, NO_BAGS);
    expect(deltas[0]).toBe(200 + 60);
  });

  it("costs -200 for a failed Blind Nil", () => {
    const bids = { 0: nil({ blind: true }), 1: bid(4), 2: bid(6), 3: bid(3) };
    const tricksWon = { 0: 1, 1: 4, 2: 6, 3: 2 };
    const { deltas } = scoreRound(bids, tricksWon, NO_BAGS);
    expect(deltas[0]).toBe(-200 + 60 + 1); // the 1 stray trick is a bag
  });
});

describe("scoreRound — blind numeric bids", () => {
  it("pays double (20/trick) on a successful blind numeric bid", () => {
    const bids = { 0: bid(6, { blind: true }), 1: bid(4), 2: nil(), 3: bid(3) };
    const tricksWon = { 0: 6, 1: 4, 2: 0, 3: 3 };
    const { deltas } = scoreRound(bids, tricksWon, NO_BAGS);
    expect(deltas[0]).toBe(120 + 100); // 6*20 + partner's nil-made bonus
  });

  it("pays a plain single penalty (not doubled) on a failed blind numeric bid", () => {
    const bids = { 0: bid(6, { blind: true }), 1: bid(4), 2: nil(), 3: bid(3) };
    const tricksWon = { 0: 5, 1: 4, 2: 0, 3: 4 }; // team fell short of 6
    const { deltas } = scoreRound(bids, tricksWon, NO_BAGS);
    expect(deltas[0]).toBe(-60 + 100);
  });

  it("doubles the WHOLE merged contract when only one of two numeric bids was blind", () => {
    // Team A target: 6 + 2 = 8, only seat0's half was bid blind.
    const bids = { 0: bid(6, { blind: true }), 1: bid(4), 2: bid(2), 3: bid(3) };
    const tricksWon = { 0: 6, 1: 4, 2: 2, 3: 3 }; // team makes exactly 8
    const { deltas } = scoreRound(bids, tricksWon, NO_BAGS);
    expect(deltas[0]).toBe(8 * 20); // documented judgment call: whole contract doubles
  });

  it("counts a TEAM blind bid (same Bid object mirrored on both seats) once, not twice", () => {
    // rules.ts's isTeamBlindBid mirrors the exact same object onto both
    // partners for a team-wide blind bid — the target here must be 6,
    // not 6+6=12, which is what treating it as two independent bids
    // (the ordinary case, covered above) would wrongly produce.
    const teamBid = bid(6, { blind: true });
    const bids = { 0: teamBid, 1: bid(4), 2: teamBid, 3: bid(3) };
    const tricksWon = { 0: 3, 1: 4, 2: 3, 3: 3 }; // team makes exactly 6
    const { deltas } = scoreRound(bids, tricksWon, NO_BAGS);
    expect(deltas[0]).toBe(6 * 20); // NOT 12 * 20
  });
});

describe("scoreRound — bag rollover", () => {
  it("charges -100 the instant cumulative bags reach 10, remainder carrying over", () => {
    const priorBags: Record<SeatId, number> = { 0: 8, 1: 0, 2: 8, 3: 0 };
    // Team A target: 3 + 2 = 5. Takes 4 + 3 = 7 -> 2 bags added -> 10 total.
    const bids = { 0: bid(3), 1: bid(4), 2: bid(2), 3: bid(3) };
    const tricksWon = { 0: 4, 1: 4, 2: 3, 3: 2 };
    const { deltas, bags, bagPenalty } = scoreRound(bids, tricksWon, priorBags);
    expect(bags[0]).toBe(10);
    expect(bagPenalty[0]).toBe(100);
    expect(deltas[0]).toBe(50 + 2 - 100);
  });

  it("matches the worked example: 337 pts, bid 5, win 8 (prior 7 bags) -> 290", () => {
    const priorScore = 337;
    const priorBags: Record<SeatId, number> = { 0: 7, 1: 0, 2: 7, 3: 0 };
    // Team A target: 3 + 2 = 5. Takes 5 + 3 = 8 -> 3 bags added.
    const bids = { 0: bid(3), 1: bid(4), 2: bid(2), 3: bid(3) };
    const tricksWon = { 0: 5, 1: 4, 2: 3, 3: 1 };
    const { deltas, bags, bagPenalty } = scoreRound(bids, tricksWon, priorBags);
    expect(bags[0]).toBe(10);
    expect(bagPenalty[0]).toBe(100);
    expect(deltas[0]).toBe(-47);
    expect(priorScore + deltas[0]!).toBe(290);
  });

  it("charges -200 when a single round's overtricks cross two 10-bag thresholds", () => {
    const priorBags: Record<SeatId, number> = { 0: 8, 1: 0, 2: 8, 3: 0 };
    // Team A target: just seat0's 1 (seat2 bid nil, contributing 0).
    const bids = { 0: bid(1), 1: bid(6), 2: nil(), 3: bid(6) };
    // Contrived: the team takes 15 of the round's 13 tricks is impossible
    // in a real deal, but this function only ever sees the aggregate
    // numbers a real reduce() would have produced, and exercising the
    // rollover math itself doesn't need a legal deal behind it.
    const tricksWon = { 0: 1, 1: 0, 2: 14, 3: -2 };
    const { bags, bagPenalty } = scoreRound(bids, tricksWon, priorBags);
    // target 1, team took 15 -> 14 bags added -> prior 8 + 14 = 22 -> crosses 10 and 20
    expect(bags[0]).toBe(22);
    expect(bagPenalty[0]).toBe(200);
  });

  it("keeps bag totals and penalties independent between the two teams", () => {
    const priorBags: Record<SeatId, number> = { 0: 9, 1: 0, 2: 9, 3: 0 };
    // Team A target: 3 + 2 = 5, takes 4 + 2 = 6 -> 1 bag added -> 10 total.
    // Team B target: 3 + 0 = 3, takes exactly 3 -> 0 bags.
    const bids = { 0: bid(3), 1: bid(3), 2: bid(2), 3: bid(0) };
    const tricksWon = { 0: 4, 1: 2, 2: 2, 3: 1 };
    const { bags, bagPenalty } = scoreRound(bids, tricksWon, priorBags);
    expect(bags[0]).toBe(10);
    expect(bagPenalty[0]).toBe(100);
    expect(bags[1]).toBe(0);
    expect(bagPenalty[1]).toBe(0);
  });
});

describe("match-level constants", () => {
  it("are sane, easy-to-retune numbers", () => {
    expect(TARGET_SCORE).toBeGreaterThan(0);
    expect(AUTO_LOSS_SCORE).toBeLessThan(0);
  });
});
