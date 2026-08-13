import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import type { GameEvent, PieceId, SeatId } from "@/engine/types";
import { BIG_JOKER_ID, LITTLE_JOKER_ID, sortHandForDisplay } from "@/games/_shared/cards";
import { cardStrength, effectiveSuit, spadesDeck, type SpadesRules } from "./cards";
import { createSpades, legalPlays, minLegalBid, mustBidBlind, reduce, startRound } from "./rules";
import { HIDDEN_CARD } from "./state";
import type { SpadesState } from "./types";

const STANDARD: SpadesRules = { jokers: false, twoOfSpadesHigh: false };

/**
 * `dealer: 3` (-> leader/first-bidder seat 0) is forced on every fixture
 * below that needs one, rather than left to `makeSetup`'s own real
 * random cut (see that function's doc) — most of this file is written
 * around "seat 0 bids first" for readability, which is still a
 * perfectly valid scenario to exercise, just no longer the only one a
 * fresh setup produces in real play. The random cut itself, and its
 * rotation round to round, are covered directly in "spades — the deal"
 * below.
 */
function fresh(seed = 7, rules: SpadesRules = STANDARD) {
  const rng = createRng(seed);
  const def = createSpades(rules);
  const { state } = startRound({ ...def.setup({ seats: 4, rng }), dealer: 3 as SeatId }, rng);
  return { def, rng, state };
}

/** Every card in the deck is in exactly one of: a hand, a won pile, or
 * the current trick. */
function allCardsAccountedFor(state: SpadesState): PieceId[] {
  return [
    ...Object.values(state.hands).flat(),
    ...Object.values(state.won).flat(),
    ...state.trick.map((p) => p.card),
  ].sort();
}

describe("spades — the deal", () => {
  it("deals 13 cards to each of 4 seats and uses every card exactly once (standard deck)", () => {
    const { state } = fresh();
    for (let seat = 0; seat < 4; seat++) expect(state.hands[seat]).toHaveLength(13);
    expect(allCardsAccountedFor(state)).toEqual([...spadesDeck(STANDARD)].sort());
  });

  it("deals 13 cards to each of 4 seats with jokers enabled, still 52 cards total", () => {
    const rules: SpadesRules = { jokers: true, twoOfSpadesHigh: false };
    const { state } = fresh(3, rules);
    for (let seat = 0; seat < 4; seat++) expect(state.hands[seat]).toHaveLength(13);
    const all = allCardsAccountedFor(state);
    expect(all).toHaveLength(52);
    expect(all).toContain(BIG_JOKER_ID);
    expect(all).toContain(LITTLE_JOKER_ID);
  });

  it("starts undealt so the opening deal can animate", () => {
    const def = createSpades();
    const state = def.setup({ seats: 4, rng: createRng(1) });
    expect(state.dealt).toBe(false);
    expect(def.currentSeat(state)).toBeNull();
  });

  it("gives the first bid (and the first lead) to the seat left of the dealer", () => {
    // Round one's dealer is now a genuine random cut (rng.pick in
    // makeSetup — see its own doc), not a fixed sentinel, so this
    // checks the RELATIONSHIP (leader sits left of whoever the cut
    // landed on) rather than a hardcoded seat.
    const { state } = fresh();
    expect([0, 1, 2, 3]).toContain(state.dealer);
    expect(state.leader).toBe(((state.dealer + 1) % 4) as SeatId);
    expect(state.turn).toBe(state.leader);
  });

  it("rotates the dealer each round", () => {
    const rng = createRng(5);
    const def = createSpades();
    let state = def.setup({ seats: 4, rng });
    ({ state } = startRound(state, rng));
    const firstDealer = state.dealer;
    expect([0, 1, 2, 3]).toContain(firstDealer);
    // Force the round to look finished so startRound can be called again.
    state = {
      ...state,
      result: {
        bids: state.bids as never,
        tricksWon: state.tricksWon,
        deltas: {},
        bags: {},
        bagPenalty: {},
        bagsAdded: {},
      },
    };
    ({ state } = startRound(state, rng));
    expect(state.dealer).toBe(((firstDealer + 1) % 4) as SeatId);
  });
});

describe("spades — bidding order and the Board (team minimum-4) rule", () => {
  it("proceeds seat 0, 1, 2, 3 in order, alternating teams each turn", () => {
    const { def, state } = fresh();
    let s = state;
    expect(def.currentSeat(s)).toBe(0);
    ({ state: s } = reduce(s, { t: "bid", tricks: 3, nil: false }));
    expect(def.currentSeat(s)).toBe(1);
    ({ state: s } = reduce(s, { t: "bid", tricks: 3, nil: false }));
    expect(def.currentSeat(s)).toBe(2);
    ({ state: s } = reduce(s, { t: "bid", tricks: 4, nil: false }));
    expect(def.currentSeat(s)).toBe(3);
  });

  it("requires the second bidder to cover a Nil partner with at least 4", () => {
    const { def, state } = fresh();
    let s = state;
    ({ state: s } = reduce(s, { t: "bid", tricks: 0, nil: true })); // seat 0: Nil
    ({ state: s } = reduce(s, { t: "bid", tricks: 2, nil: false })); // seat 1
    expect(def.currentSeat(s)).toBe(2);
    expect(minLegalBid(s, 2)).toBe(4);
    const legal = def.legalActions(s, 2);
    // 3 is not enough...
    expect(legal.some((a) => a.t === "bid" && a.tricks === 3)).toBe(false);
    // ...4 is.
    expect(legal.some((a) => a.t === "bid" && a.tricks === 4)).toBe(true);
  });

  it("never offers double-Nil on one team as a legal option", () => {
    const { def, state } = fresh();
    const { state: afterNil } = reduce(state, { t: "bid", tricks: 0, nil: true });
    const legalForPartner = def.legalActions(afterNil, 2);
    expect(legalForPartner.some((a) => a.t === "bid" && a.nil)).toBe(false);
  });

  it("lets a first bidder bid Nil freely (no Board restriction yet)", () => {
    const { def, state } = fresh();
    const legal = def.legalActions(state, 0);
    expect(legal.some((a) => a.t === "bid" && a.nil)).toBe(true);
  });
});

describe("spades — blind eligibility and the hidden hand", () => {
  it("deals a blind-eligible hero's own hand face down; a non-eligible hero's face up", () => {
    const rng = createRng(9);
    const def = createSpades();
    const eligible = {
      ...def.setup({ seats: 4, rng }),
      dealer: 3 as SeatId,
      scores: { 0: 0, 1: 100, 2: 0, 3: 100 },
    };
    const { state: eligibleState, events: eligibleEvents } = startRound(eligible, rng);
    expect(eligibleState.blindEligible[0]).toBe(true);
    expect(eligibleState.handRevealed[0]).toBe(false);
    const heroDeals = eligibleEvents.filter((e) => e.t === "deal" && e.to === 0);
    expect(heroDeals.every((e) => e.t === "deal" && e.faceUp === false)).toBe(true);

    const rng2 = createRng(9);
    const notEligible = {
      ...def.setup({ seats: 4, rng: rng2 }),
      dealer: 3 as SeatId,
      scores: { 0: 0, 1: 50, 2: 0, 3: 50 },
    };
    const { state: normalState, events: normalEvents } = startRound(notEligible, rng2);
    expect(normalState.blindEligible[0]).toBe(false);
    expect(normalState.handRevealed[0]).toBe(true);
    const heroDeals2 = normalEvents.filter((e) => e.t === "deal" && e.to === 0);
    expect(heroDeals2.every((e) => e.t === "deal" && e.faceUp === true)).toBe(true);
  });

  it("reveals a blind NUMERIC bid's hand immediately on locking in", () => {
    const rng = createRng(9);
    const def = createSpades();
    const eligible = { ...def.setup({ seats: 4, rng }), dealer: 3 as SeatId, scores: { 0: 0, 1: 100, 2: 0, 3: 100 } };
    let { state } = startRound(eligible, rng);
    expect(state.handRevealed[0]).toBe(false);
    ({ state } = reduce(state, { t: "blindBid", tricks: 6 }));
    expect(state.bids[0]).toEqual({ tricks: 6, nil: false, blind: true });
    expect(state.handRevealed[0]).toBe(true);
  });

  it("keeps a Blind Nil bidder's hand hidden through bidding, until the exchange resolves", () => {
    const rng = createRng(9);
    const def = createSpades();
    const eligible = { ...def.setup({ seats: 4, rng }), dealer: 3 as SeatId, scores: { 0: 0, 1: 100, 2: 0, 3: 100 } };
    let { state } = startRound(eligible, rng);
    ({ state } = reduce(state, { t: "blindNil" }));
    expect(state.handRevealed[0]).toBe(false);
    ({ state } = reduce(state, { t: "bid", tricks: 3, nil: false })); // seat 1
    expect(state.handRevealed[0]).toBe(false);
    ({ state } = reduce(state, { t: "bid", tricks: 4, nil: false })); // seat 2, covers the Board
    expect(state.handRevealed[0]).toBe(false);
    ({ state } = reduce(state, { t: "bid", tricks: 2, nil: false })); // seat 3 — all 4 bids in now
    expect(state.handRevealed[0]).toBe(false); // exchange now pending, still hidden
    expect(state.exchange).not.toBeNull();
    ({ state } = reduce(state, { t: "skipExchange" }));
    expect(state.handRevealed[0]).toBe(true);
    expect(state.phase).toBe("play");
  });
});

describe("spades — synchronized team blind decision", () => {
  function eligible(seed: number) {
    const rng = createRng(seed);
    const def = createSpades();
    const state = { ...def.setup({ seats: 4, rng }), dealer: 3 as SeatId, scores: { 0: 0, 1: 100, 2: 0, 3: 100 } };
    return { def, rng, ...startRound(state, rng) };
  }

  it("locks the partner into blind once the first bidder bids Blind Nil — no 'look' option", () => {
    // Blind Nil stays an individual bid (its own exchange mechanic —
    // see the file-top doc), so the partner still gets a real turn
    // here, just restricted to blind choices. A blind NUMERIC first
    // bid is different — see the team-blind-bid tests below, where the
    // partner gets no turn at all.
    const { def, state } = eligible(9);
    let s = state;
    ({ state: s } = reduce(s, { t: "blindNil" })); // seat 0 goes blind
    ({ state: s } = reduce(s, { t: "bid", tricks: 3, nil: false })); // seat 1
    expect(def.currentSeat(s)).toBe(2);
    expect(mustBidBlind(s, 2)).toBe(true);
    const legal = def.legalActions(s, 2);
    expect(legal.some((a) => a.t === "look")).toBe(false);
    expect(legal.some((a) => a.t === "blindBid" || a.t === "blindNil")).toBe(true);
  });

  it("auto-reveals the partner's hand the instant the first bidder chooses to look", () => {
    const { def, state } = eligible(9);
    let s = state;
    expect(s.handRevealed[2]).toBe(false);
    ({ state: s } = reduce(s, { t: "look" })); // seat 0 looks
    ({ state: s } = reduce(s, { t: "bid", tricks: 4, nil: false })); // seat 0's actual bid, non-blind
    // Partner (seat 2) hasn't even had a turn yet, but the team already
    // committed to looking, so their hand is revealed pre-emptively.
    expect(s.handRevealed[2]).toBe(true);
    ({ state: s } = reduce(s, { t: "bid", tricks: 2, nil: false })); // seat 1
    expect(def.currentSeat(s)).toBe(2);
    // Ordinary bid pad, never the blind-choice screen — the team decision
    // already resolved.
    const legal = def.legalActions(s, 2);
    expect(legal.every((a) => a.t === "bid")).toBe(true);
  });

  it("bot bidders honour the lock — never returns 'look' once the partner went blind", () => {
    const { def, state } = eligible(21);
    let s = state;
    ({ state: s } = reduce(s, { t: "blindNil" })); // seat 0 goes blind
    ({ state: s } = reduce(s, { t: "bid", tricks: 3, nil: false })); // seat 1
    expect(def.currentSeat(s)).toBe(2);
    const view = def.playerView(s, 2);
    for (const seed of [1, 2, 3, 4, 5]) {
      const action = def.bots.steady.choose(view, 2, createRng(seed));
      expect(action.t).not.toBe("look");
    }
  });

  describe("a blind NUMERIC bid from the first bidder is the whole team's bid", () => {
    it("mirrors the exact bid onto the partner, reveals their hand, and skips their turn", () => {
      const { def, state } = eligible(9);
      let s = state;
      ({ state: s } = reduce(s, { t: "blindBid", tricks: 6 })); // seat 0, first bidder
      expect(s.bids[0]).toEqual({ tricks: 6, nil: false, blind: true });
      expect(s.bids[2]).toBe(s.bids[0]); // literally the same object — see scoring.ts's doc
      expect(s.handRevealed[2]).toBe(true); // partner's cards turn over immediately
      // Turn order skips straight past the partner to the next opponent.
      expect(def.currentSeat(s)).toBe(1);
      ({ state: s } = reduce(s, { t: "bid", tricks: 3, nil: false })); // seat 1
      // Not seat 2 — they already have a bid and never get a turn.
      expect(def.currentSeat(s)).toBe(3);
      ({ state: s } = reduce(s, { t: "bid", tricks: 2, nil: false })); // seat 3
      expect(s.phase).toBe("play");
      expect([0, 1, 2, 3].every((seat) => s.bids[seat as SeatId] != null)).toBe(true);
    });

    it("does not double-count the mirrored bid when scoring the round", () => {
      // A full engine-level check that the reference-equal mirrored bid
      // (see scoring.test.ts's unit test for the isolated case) actually
      // flows through endRound correctly — target is 6, not 12.
      const { def, state } = eligible(9);
      let s = state;
      ({ state: s } = reduce(s, { t: "blindBid", tricks: 6 })); // seat 0 + mirrored seat 2
      ({ state: s } = reduce(s, { t: "bid", tricks: 3, nil: false })); // seat 1
      ({ state: s } = reduce(s, { t: "bid", tricks: 2, nil: false })); // seat 3
      expect(s.phase).toBe("play");
      // Play the round out with steady bots so it actually reaches
      // endRound — the specific trick outcomes don't matter here, only
      // that the resulting score reflects a target of 6, never 12.
      const rng = createRng(9);
      let guard = 0;
      while (s.result === null && guard++ < 200) {
        const seat = def.currentSeat(s)!;
        const action = def.bots.steady.choose(def.playerView(s, seat), seat, rng);
        ({ state: s } = def.reduce(s, action));
      }
      expect(s.result).not.toBeNull();
      const teamTricks = (s.result!.tricksWon[0] ?? 0) + (s.result!.tricksWon[2] ?? 0);
      const madeTarget = teamTricks >= 6;
      // If the bug were still there (target read as 12), a team that
      // won, say, 7 tricks would score as a FAILED bid instead of a
      // successful one with bags — this is the behavioral difference
      // that actually matters, not just the raw delta number.
      if (madeTarget) {
        expect(s.result!.deltas[0]).toBeGreaterThan(0);
      } else {
        expect(s.result!.deltas[0]).toBeLessThan(0);
      }
    });

    it("a SECOND bidder's own blind numeric bid stays individual (no mirroring)", () => {
      const { def, state } = eligible(9);
      let s = state;
      ({ state: s } = reduce(s, { t: "blindNil" })); // seat 0 — individual, exchange-based
      ({ state: s } = reduce(s, { t: "bid", tricks: 3, nil: false })); // seat 1
      expect(def.currentSeat(s)).toBe(2);
      ({ state: s } = reduce(s, { t: "blindBid", tricks: 6 })); // seat 2, SECOND bidder
      expect(s.bids[2]).toEqual({ tricks: 6, nil: false, blind: true });
      expect(s.bids[0]).not.toBe(s.bids[2]); // NOT mirrored — seat 0 already had its own bid
      expect(def.currentSeat(s)).toBe(3); // ordinary turn order, nobody skipped
    });
  });
});

describe("spades — hand-reveal flips are ordered for display, not deal order", () => {
  it("orders the hero's own reveal by on-screen (suit-sorted) position when their partner's team blind bid flips it", () => {
    // The real reported scenario: HERO's own hand flips because their
    // PARTNER made a team blind bid, not because HERO acted. `dealer: 1`
    // makes the leader seat 2 (HERO's partner) — team 0 (seats 0 & 2)
    // trails by 100+, so it's blind-eligible, and seat 2 bids first.
    const rng = createRng(9);
    const def = createSpades();
    let state: SpadesState = {
      ...def.setup({ seats: 4, rng }),
      dealer: 1 as SeatId,
      scores: { 0: 0, 1: 100, 2: 0, 3: 100 },
    };
    ({ state } = startRound(state, rng));
    expect(state.leader).toBe(2);
    expect(def.currentSeat(state)).toBe(2);

    const heroHandBefore = state.hands[0] ?? [];
    const { state: next, events } = reduce(state, { t: "blindBid", tricks: 6 }); // seat 2
    expect(next.handRevealed[0]).toBe(true); // hero's hand really did reveal

    const heroFlipOrder = events
      .filter((e): e is GameEvent & { t: "flip" } => e.t === "flip")
      .map((e) => e.piece)
      .filter((id) => heroHandBefore.includes(id));

    const expectedOrder = sortHandForDisplay(
      heroHandBefore,
      effectiveSuit,
      (id) => cardStrength(id, STANDARD),
    );

    expect(heroFlipOrder).toEqual(expectedOrder);
  });
});

describe("spades — the blind-nil card exchange", () => {
  it("runs give -> take: exactly the right 4 cards swap, both hands land back at 13", () => {
    const rng = createRng(11);
    const def = createSpades();
    let state: SpadesState = { ...def.setup({ seats: 4, rng }), dealer: 3 as SeatId, scores: { 0: 0, 1: 100, 2: 0, 3: 100 } };
    ({ state } = startRound(state, rng));

    ({ state } = reduce(state, { t: "blindNil" })); // seat 0
    ({ state } = reduce(state, { t: "bid", tricks: 3, nil: false })); // seat 1
    expect(minLegalBid(state, 2)).toBe(4);
    ({ state } = reduce(state, { t: "bid", tricks: 4, nil: false })); // seat 2
    ({ state } = reduce(state, { t: "bid", tricks: 2, nil: false })); // seat 3

    expect(state.phase).toBe("bid");
    expect(state.exchange).toEqual({ giver: 0, taker: 2, stage: "give" });
    expect(def.currentSeat(state)).toBe(0);

    const giverBefore = state.hands[0]!;
    const takerBefore = state.hands[2]!;
    expect(giverBefore).toHaveLength(13);
    expect(takerBefore).toHaveLength(13);

    const given: [PieceId, PieceId] = [giverBefore[0]!, giverBefore[1]!];
    ({ state } = reduce(state, { t: "exchangeGive", cards: given }));
    expect(state.exchange).toEqual({ giver: 0, taker: 2, stage: "take", given });
    expect(state.hands[0]).toHaveLength(11);
    expect(state.hands[2]).toHaveLength(13); // untouched until the take resolves
    expect(def.currentSeat(state)).toBe(2);

    const takeBack: [PieceId, PieceId] = [takerBefore[0]!, takerBefore[1]!];
    ({ state } = reduce(state, { t: "exchangeTake", cards: takeBack }));

    expect(state.exchange).toBeNull();
    expect(state.phase).toBe("play");
    expect(state.hands[0]).toHaveLength(13);
    expect(state.hands[2]).toHaveLength(13);
    for (const id of given) expect(state.hands[2]).toContain(id);
    for (const id of takeBack) expect(state.hands[0]).toContain(id);
    expect(state.handRevealed[0]).toBe(true);
    expect(def.currentSeat(state)).toBe(state.leader);
  });

  it("skips cleanly straight to play when the giver declines", () => {
    const rng = createRng(11);
    const def = createSpades();
    let state: SpadesState = { ...def.setup({ seats: 4, rng }), dealer: 3 as SeatId, scores: { 0: 0, 1: 100, 2: 0, 3: 100 } };
    ({ state } = startRound(state, rng));
    ({ state } = reduce(state, { t: "blindNil" }));
    ({ state } = reduce(state, { t: "bid", tricks: 3, nil: false }));
    ({ state } = reduce(state, { t: "bid", tricks: 4, nil: false }));
    ({ state } = reduce(state, { t: "bid", tricks: 2, nil: false }));
    const before = state.hands[0]!;
    ({ state } = reduce(state, { t: "skipExchange" }));
    expect(state.exchange).toBeNull();
    expect(state.phase).toBe("play");
    expect(state.hands[0]).toEqual(before);
    expect(state.handRevealed[0]).toBe(true);
  });

  it("resolves a bot giver's blind (HIDDEN_CARD) pick into 2 real cards, never corrupting state", () => {
    // A bot giver's own hand is redacted to itself (playerView), so
    // `chooseExchange` can only ever hand back HIDDEN_CARD placeholders
    // — this is exactly what it returns; reduceExchangeGive has to
    // resolve that into 2 real cards rather than passing it straight
    // through (which used to leave the giver's hand untouched at 13 and
    // splice two literal "??" strings into the taker's real hand).
    const rng = createRng(11);
    const def = createSpades();
    let state: SpadesState = { ...def.setup({ seats: 4, rng }), dealer: 3 as SeatId, scores: { 0: 0, 1: 100, 2: 0, 3: 100 } };
    ({ state } = startRound(state, rng));
    ({ state } = reduce(state, { t: "blindNil" })); // seat 0
    ({ state } = reduce(state, { t: "bid", tricks: 3, nil: false }));
    ({ state } = reduce(state, { t: "bid", tricks: 4, nil: false }));
    ({ state } = reduce(state, { t: "bid", tricks: 2, nil: false }));

    const realHandBefore = state.hands[0]!;
    expect(realHandBefore).toHaveLength(13);

    ({ state } = reduce(state, { t: "exchangeGive", cards: [HIDDEN_CARD, HIDDEN_CARD] }));

    expect(state.hands[0]).toHaveLength(11);
    expect(state.hands[0]).not.toContain(HIDDEN_CARD);
    expect(state.exchange?.given).toBeDefined();
    for (const id of state.exchange!.given!) {
      expect(id).not.toBe(HIDDEN_CARD);
      expect(realHandBefore).toContain(id);
    }

    ({ state } = reduce(state, { t: "exchangeTake", cards: [state.hands[2]![0]!, state.hands[2]![1]!] }));
    // Every seat's hand is real cards only, still 13 each, no leaked
    // sentinel and no duplicate/missing card anywhere in the deck.
    expect(state.hands[0]).toHaveLength(13);
    expect(state.hands[2]).toHaveLength(13);
    const all = allCardsAccountedFor(state);
    expect(all).not.toContain(HIDDEN_CARD);
    expect(all).toEqual([...spadesDeck(STANDARD)].sort());
  });

  it("never creates an exchange when nobody bid Blind Nil", () => {
    const { state } = fresh();
    let s = state;
    ({ state: s } = reduce(s, { t: "bid", tricks: 3, nil: false }));
    ({ state: s } = reduce(s, { t: "bid", tricks: 3, nil: false }));
    ({ state: s } = reduce(s, { t: "bid", tricks: 4, nil: false }));
    ({ state: s } = reduce(s, { t: "bid", tricks: 2, nil: false }));
    expect(s.exchange).toBeNull();
    expect(s.phase).toBe("play");
  });
});

describe("spades — trick resolution", () => {
  it("highlights the winning card before collecting it to the winner", () => {
    const { def, state } = fresh(13);
    let s = state;
    ({ state: s } = reduce(s, { t: "bid", tricks: 3, nil: false }));
    ({ state: s } = reduce(s, { t: "bid", tricks: 3, nil: false }));
    ({ state: s } = reduce(s, { t: "bid", tricks: 4, nil: false }));
    ({ state: s } = reduce(s, { t: "bid", tricks: 2, nil: false }));
    expect(s.phase).toBe("play");

    let lastEvents: GameEvent[] = [];
    for (let i = 0; i < 4; i++) {
      const seat = def.currentSeat(s)!;
      const card = legalPlays(s, seat)[0]!;
      ({ state: s, events: lastEvents } = reduce(s, { t: "play", card }));
    }

    const highlightIdx = lastEvents.findIndex((e) => e.t === "highlight");
    const collectIdx = lastEvents.findIndex((e) => e.t === "collect");
    expect(highlightIdx).toBeGreaterThanOrEqual(0);
    // Fired before collect, in the same batch — the whole point is that
    // it's visible for collect's own HOLD.trick pause, not just the
    // instant the sweep starts.
    expect(collectIdx).toBeGreaterThan(highlightIdx);

    const highlightEvent = lastEvents[highlightIdx];
    if (highlightEvent?.t !== "highlight") throw new Error("expected a highlight event");
    expect(highlightEvent.on).toBe(true);
    // The highlighted card is genuinely the one the winner just took.
    expect(s.won[s.leader]).toContain(highlightEvent.piece);
  });
});

describe("spades — full-match simulation invariants", () => {
  function runMatch(seed: number, rules: SpadesRules, target: number, guard = 20000): SpadesState {
    const rng = createRng(seed);
    const def = createSpades(rules);
    let state: SpadesState = { ...def.setup({ seats: 4, rng }), target };
    ({ state } = startRound(state, rng));
    let n = 0;
    let lastRound = state.round;
    let sawTrumpBrokenThisRound = state.trumpBroken;

    while (!def.isOver(state) && n++ < guard) {
      if (def.isRoundOver!(state)) {
        ({ state } = startRound(state, rng));
        lastRound = state.round;
        sawTrumpBrokenThisRound = state.trumpBroken;
        continue;
      }

      // Invariants checked on every single step, not just at the end.
      expect(state.scores[0]).toBe(state.scores[2]);
      expect(state.scores[1]).toBe(state.scores[3]);
      expect(state.bags[0]).toBe(state.bags[2]);
      expect(state.bags[1]).toBe(state.bags[3]);
      const cards = allCardsAccountedFor(state);
      expect(cards).toHaveLength(spadesDeck(rules).length);
      expect(new Set(cards).size).toBe(cards.length);
      if (state.round === lastRound) {
        // trumpBroken must never flip back off within the same round.
        if (sawTrumpBrokenThisRound) expect(state.trumpBroken).toBe(true);
        sawTrumpBrokenThisRound = state.trumpBroken;
      }

      const seat = def.currentSeat(state)!;
      const view = def.playerView(state, seat);
      const action = def.bots.steady.choose(view, seat, rng);
      const legal = def.legalActions(state, seat);
      expect(legal).toContainEqual(action);

      ({ state } = def.reduce(state, action));
    }
    return state;
  }

  it("holds every invariant across a full standard match", () => {
    const final = runMatch(101, STANDARD, 100);
    expect(final.winner).not.toBeNull();
    expect(final.winningSeats).not.toBeNull();
  });

  it("holds every invariant across full matches with jokers and 2-of-spades-high, several seeds", () => {
    const rules: SpadesRules = { jokers: true, twoOfSpadesHigh: true };
    for (const seed of [3, 17, 88]) {
      const final = runMatch(seed, rules, 60);
      expect(final.winner).not.toBeNull();
      expect(final.winningSeats).toHaveLength(2);
      expect(final.winningSeats).toContain(final.winner);
    }
  });

  it("ends the match once a team's score reaches the target", () => {
    const final = runMatch(42, STANDARD, 1);
    expect(final.winner).not.toBeNull();
    const [a, b] = final.winningSeats!;
    expect(final.scores[a!]).toBeGreaterThanOrEqual(1);
    expect(final.scores[a!]).toBe(final.scores[b!]);
  });

  it("sweeps 300 seeds end to end: every bot action is legal, no HIDDEN_CARD ever leaks into real state", () => {
    // Broader and cheaper than the seed-by-seed tests above — this is
    // what actually caught two real bugs while adding the synchronized
    // team blind-bid rule: a bot as the Blind Nil exchange GIVER can
    // only ever choose blind (its own hand is genuinely hidden from
    // itself), and neither `reduceExchangeGive` nor `legalActions` used
    // to account for that — the former silently corrupted real hand
    // state, the latter never even recognised the bot's own only
    // possible action as legal. Both fixed; this sweep is what would
    // have caught it immediately instead of on one specific seed deep
    // into an unrelated test.
    const rules: SpadesRules = { jokers: false, twoOfSpadesHigh: false };
    for (let seed = 1; seed <= 300; seed++) {
      const def = createSpades(rules);
      const rng = createRng(seed);
      let state: SpadesState = { ...def.setup({ seats: 4, rng }), target: 80, autoLoss: -100 };
      ({ state } = startRound(state, rng));
      let n = 0;
      while (!def.isOver(state) && n++ < 5000) {
        if (def.isRoundOver!(state)) {
          ({ state } = startRound(state, rng));
          continue;
        }
        const seat = def.currentSeat(state)!;
        const action = def.bots.steady.choose(def.playerView(state, seat), seat, rng);
        expect(def.legalActions(state, seat), `seed ${seed}: illegal action`).toContainEqual(action);
        ({ state } = def.reduce(state, action));
        for (const hand of Object.values(state.hands)) {
          expect(hand, `seed ${seed}: HIDDEN_CARD leaked into real state`).not.toContain(HIDDEN_CARD);
        }
      }
      expect(def.isOver(state), `seed ${seed}: never finished within the guard`).toBe(true);
    }
  });

  it("ends the match once a team falls to or below the auto-loss threshold", () => {
    const rng = createRng(55);
    const def = createSpades(STANDARD);
    // Target effectively unreachable; a tight auto-loss makes THAT the
    // only possible way this match ends — disambiguates the path taken.
    let state: SpadesState = { ...def.setup({ seats: 4, rng }), target: 1_000_000, autoLoss: -1 };
    ({ state } = startRound(state, rng));
    let n = 0;
    while (!def.isOver(state) && n++ < 20000) {
      if (def.isRoundOver!(state)) {
        ({ state } = startRound(state, rng));
        continue;
      }
      const seat = def.currentSeat(state)!;
      const action = def.bots.steady.choose(def.playerView(state, seat), seat, rng);
      ({ state } = def.reduce(state, action));
    }
    expect(def.isOver(state)).toBe(true);
    expect(state.winningSeats).toHaveLength(2);
    // The LOSING team's score is the one at/under the threshold.
    const losingTeamSeats: [SeatId, SeatId] = state.winningSeats!.includes(0) ? [1, 3] : [0, 2];
    expect(state.scores[losingTeamSeats[0]]).toBeLessThanOrEqual(-1);
  });
});
