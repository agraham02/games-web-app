/**
 * Round scoring — isolated from `reduce` so it's testable as a pure
 * function over a finished round's bids and tricks, independent of how
 * play actually got there.
 *
 * One judgment call worth flagging: when a team's contract mixes an
 * ORDINARY numeric bid with a BLIND numeric bid (partner didn't bid
 * Nil), the double applies to the whole team's combined contract score,
 * not just "the blind bidder's share". Spades scoring has no concept of
 * a half-bid succeeding independently of its partner — a team's numeric
 * bids merge into one shared contract with one shared fate — so treating
 * the merged contract as doubled whenever ANY part of it was bid blind
 * is the only reading that stays consistent with the un-mixed case
 * (partner bid Nil, so the blind bidder's number already WAS the whole
 * target).
 */

import type { SeatId } from "@/engine/types";
import { teammates } from "./state";
import type { Bid } from "./types";

/** First team to reach this score wins the match. */
export const TARGET_SCORE = 500;
/** A team at or below this score has lost the match outright. */
export const AUTO_LOSS_SCORE = -200;

export interface RoundScore {
  /** This round's point swing, mirrored across each team's two seats. */
  deltas: Record<SeatId, number>;
  /** Cumulative bag count AFTER this round, mirrored per team. */
  bags: Record<SeatId, number>;
  /** -100 per bag-penalty threshold crossed this round (0 if none),
   * mirrored per team. */
  bagPenalty: Record<SeatId, number>;
  /**
   * THIS round's overtricks, mirrored per team — `bags[seat] -
   * (bags[seat] before this round)`, exposed directly rather than making
   * every caller re-derive it. It's the team's shared total (one player
   * under their own bid and the other over nets out at the TEAM level,
   * same as bags always have — see `bagsAdded`'s own doc below), not a
   * per-seat "this player personally overtricked" count. A UI showing
   * "N bags" on an individual player's row should read from here, not
   * recompute `tricksWon[seat] - bid[seat].tricks` itself — that naive
   * per-seat difference over/undercounts whenever the two partners'
   * individual bid/tricks don't happen to match their own share exactly
   * (see spades/page.tsx's `roundSummary`, which had exactly this bug).
   */
  bagsAdded: Record<SeatId, number>;
}

export function scoreRound(
  bids: Record<SeatId, Bid>,
  tricksWon: Record<SeatId, number>,
  priorBags: Record<SeatId, number>,
): RoundScore {
  const deltas: Record<SeatId, number> = {};
  const bags: Record<SeatId, number> = {};
  const bagPenalty: Record<SeatId, number> = {};
  const bagsAddedOut: Record<SeatId, number> = {};

  for (const team of [0, 1] as const) {
    const [a, b] = teammates(team);
    const teamTricks = (tricksWon[a] ?? 0) + (tricksWon[b] ?? 0);

    let delta = 0;
    let bagsAdded = 0;

    // The team's shared numeric contract — Nil bidders contribute
    // nothing to it, exactly like they contribute nothing toward "the
    // Board" during bidding. Double-Nil (both partners nil) leaves this
    // empty; that combination is unreachable through legalActions (see
    // state.ts's minLegalBid), so it deliberately scores as a no-op
    // contract rather than needing its own branch here.
    //
    // A team blind bid (rules.ts's `isTeamBlindBid`) mirrors the exact
    // SAME `Bid` object onto both seats — one shared team number, not
    // two independent ones that happen to match — so `bids[a] === bids[b]`
    // by reference in that case, and must count ONCE toward the target,
    // not twice (an earlier version of this summed it twice: bid 6
    // mirrored onto both seats was read as "6 + 6 = 12 tricks needed").
    const numericBidders =
      bids[a] === bids[b] ? [bids[a]!].filter((bid) => !bid.nil) : [bids[a]!, bids[b]!].filter((bid) => !bid.nil);
    if (numericBidders.length > 0) {
      const target = numericBidders.reduce((sum, bid) => sum + bid.tricks, 0);
      const doubled = numericBidders.some((bid) => bid.blind);
      if (teamTricks >= target) {
        bagsAdded = teamTricks - target;
        // Bags are never doubled, blind bid or not — only the contract
        // itself is.
        delta += target * (doubled ? 20 : 10) + bagsAdded;
      } else {
        // A failed bid is never doubled either way — "success pays
        // double, failure pays the normal single penalty" per the rule.
        delta -= target * 10;
      }
    }

    // Nil/Blind Nil score independently of the team's numeric contract,
    // per seat. A Nil bidder's own tricks (if the bid failed) already
    // flowed into `teamTricks` above, which is what makes them count
    // toward the partner's bid AND toward bags for free — no separate
    // bookkeeping needed here.
    for (const seat of [a, b]) {
      const bid = bids[seat]!;
      if (!bid.nil) continue;
      const made = (tricksWon[seat] ?? 0) === 0;
      const bonus = bid.blind ? 200 : 100;
      delta += made ? bonus : -bonus;
    }

    // Raw cumulative total, never reset — "remainder carries over" falls
    // out for free from comparing floor(total/10) to floor(prev/10),
    // including a round that crosses more than one threshold at once
    // (e.g. 8 bags -> +15 this round -> 23 total -> two crossings -> -200).
    const prevBags = priorBags[a] ?? 0; // mirrored: priorBags[a] === priorBags[b]
    const totalBags = prevBags + bagsAdded;
    const crossings = Math.floor(totalBags / 10) - Math.floor(prevBags / 10);
    delta -= crossings * 100;

    for (const seat of [a, b]) {
      deltas[seat] = delta;
      bags[seat] = totalBags;
      bagPenalty[seat] = crossings * 100;
      bagsAddedOut[seat] = bagsAdded;
    }
  }

  return { deltas, bags, bagPenalty, bagsAdded: bagsAddedOut };
}
