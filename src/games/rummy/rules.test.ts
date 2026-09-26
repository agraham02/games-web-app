import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import { HERO, type SeatId } from "@/engine/types";
import { contributorOf, findCompletion, rummyDeck } from "./cards";
import { rummyBots } from "./bots";
import { createRummy, reduce, startRound, turnHold } from "./rules";
import {
  CLAIM_MS,
  CLAIM_REACTION_MAX,
  CLAIM_REACTION_MIN,
  claimDeadlineMs,
  claimReactions,
  mandatoryMelds,
  maxDealSize,
  validDealSizes,
} from "./state";
import type { Meld, RummyState } from "./types";

const def = createRummy({ target: 250 });

/**
 * A dealt, mid-round state with a known shape. `setup` picks a random
 * dealer, so every fixture pins the fields a test actually reasons
 * about rather than depending on a seed staying put.
 */
function fixture(overrides: Partial<RummyState> = {}): RummyState {
  const base = def.setup({ seats: 4, rng: createRng(7) });
  return {
    ...base,
    round: 1,
    dealer: 3,
    turn: 0,
    phase: "draw",
    dealt: true,
    dealSize: 7,
    dealSizePending: null,
    hands: { 0: [], 1: [], 2: [], 3: [] },
    stock: [],
    discard: [],
    melds: [],
    nextMeldId: 1,
    ...overrides,
  };
}

function meld(id: number, owner: SeatId, cards: string[]): Meld {
  return { id, owner, cards, hitBy: {} };
}

/** Every card the state accounts for, sorted — the accounting invariant. */
function allCards(state: RummyState): string[] {
  return [
    ...Object.values(state.hands).flat(),
    ...state.stock,
    ...state.discard,
    ...state.melds.flatMap((m) => m.cards),
  ].sort();
}

/* ============================================================
   Deal size
   ============================================================ */

describe("rummy — deal size is the dealer's own choice, every round", () => {
  it("offers only odd sizes the deck can serve", () => {
    // 3 and 4 used to be 17 and 13 — deals that consume 51 and all 52
    // cards, leaving a round with no stock and, at four seats, a
    // `discard: [null]` that crashed the next `legalDrawDepths`. The
    // deal now reserves a card to flip and a card to draw.
    expect(maxDealSize(2)).toBe(25);
    expect(maxDealSize(3)).toBe(15);
    expect(maxDealSize(4)).toBe(11);
    expect(maxDealSize(5)).toBe(9);
    expect(maxDealSize(6)).toBe(7);
    for (const seats of [2, 3, 4, 5, 6]) {
      for (const size of validDealSizes(seats)) {
        expect(size % 2, `${seats} seats / ${size}`).toBe(1);
        expect(seats * size).toBeLessThanOrEqual(50);
      }
    }
  });

  it("asks whoever is dealing before dealing — every seat, including in round 1", () => {
    // This used to assert that a HUMAN dealer was asked and a bot dealer
    // resolved inline, which was a fair description of a one-human game
    // and is wrong the moment a second person sits down: online, seat 3
    // may be the dealer and is as entitled to choose as seat 0.
    //
    // Nothing decides who is human here any more. The seat parks, and
    // whether a person or a bot answers is the session's business —
    // exactly as it is for every other turn in every other game.
    const base = def.setup({ seats: 4, rng: createRng(1) });
    for (const dealer of [0, 1, 2, 3]) {
      // Round 1's dealer is `state.dealer` unrotated.
      const opened = startRound({ ...base, dealer, round: 0 }, createRng(1));
      expect(opened.state.dealSizePending).toBe(dealer);
      expect(opened.state.dealt).toBe(false);
      expect(def.currentSeat(opened.state)).toBe(dealer);
      // Nothing has been dealt yet: no card has left the deck.
      expect(opened.events.some((e) => e.t === "deal")).toBe(false);
      // And the seat that was asked is the only one that may answer.
      for (const other of [0, 1, 2, 3]) {
        expect(def.legalActions(opened.state, other).length > 0).toBe(other === dealer);
      }
    }
  });

  it("deals on chooseDealSize, and only for a size that is actually offered", () => {
    const base = def.setup({ seats: 4, rng: createRng(1) });
    const { state: pending } = startRound({ ...base, dealer: HERO, round: 0 }, createRng(1));

    const bogus = reduce(pending, { t: "chooseDealSize", size: 8 });
    expect(bogus.state).toBe(pending);

    const { state, events } = reduce(pending, { t: "chooseDealSize", size: 7 });
    expect(state.dealt).toBe(true);
    expect(state.dealSize).toBe(7);
    expect(state.dealSizePending).toBeNull();
    for (const seat of [0, 1, 2, 3]) expect(state.hands[seat]).toHaveLength(7);
    expect(state.discard).toHaveLength(1);
    expect(events.filter((e) => e.t === "deal")).toHaveLength(28);
    expect(allCards(state)).toEqual([...rummyDeck()].sort());
  });

  it("deals the same cards for the same (round, dealer, size) — replayable", () => {
    const base = def.setup({ seats: 4, rng: createRng(1) });
    const { state: pending } = startRound({ ...base, dealer: HERO, round: 0 }, createRng(1));
    const a = reduce(pending, { t: "chooseDealSize", size: 7 }).state;
    const b = reduce(pending, { t: "chooseDealSize", size: 7 }).state;
    expect(a.hands).toEqual(b.hands);
    expect(a.discard).toEqual(b.discard);
  });

  it("rotates the dealer plainly, round over round", () => {
    let state = def.setup({ seats: 4, rng: createRng(3) });
    state = { ...state, dealer: 1, round: 0 };
    const seen: SeatId[] = [];
    for (let i = 0; i < 5; i++) {
      const next = startRound(state, createRng(3));
      seen.push(next.state.dealer);
      state = { ...next.state, round: next.state.round };
    }
    // Round 1 keeps the cut; every round after is +1.
    expect(seen).toEqual([1, 2, 3, 0, 1]);
  });
});

/* ============================================================
   Drawing
   ============================================================ */

describe("rummy — the draw is where the game lives", () => {
  it("takes stock freely, with no obligation", () => {
    const state = fixture({ stock: ["S2", "H9"], hands: { 0: ["D4"], 1: [], 2: [], 3: [] } });
    const { state: next } = reduce(state, { t: "drawStock" });
    expect(next.hands[0]).toContain("H9");
    expect(next.phase).toBe("meld");
    expect(next.mandatory).toBeNull();
  });

  it("skips the draw when the stock is dry — it never reshuffles", () => {
    const state = fixture({ stock: [], hands: { 0: ["D4"], 1: [], 2: [], 3: [] } });
    const { state: next } = reduce(state, { t: "drawStock" });
    expect(next.phase).toBe("meld");
    expect(next.discard).toEqual(state.discard);
  });

  it("refuses a bare top card that completes nothing — there is no free grab", () => {
    const state = fixture({
      hands: { 0: ["D4", "C9"], 1: [], 2: [], 3: [] },
      discard: ["SK"],
    });
    expect(def.legalActions(state, 0)).not.toContainEqual({ t: "drawDiscard", depth: 1 });
    expect(reduce(state, { t: "drawDiscard", depth: 1 }).state).toBe(state);
  });

  it("forces a brand-new meld for EVERY depth, including a single top card", () => {
    const state = fixture({
      hands: { 0: ["H7", "D7"], 1: [], 2: [], 3: [] },
      discard: ["S7"],
    });
    expect(def.legalActions(state, 0)).toContainEqual({ t: "drawDiscard", depth: 1 });
    const { state: next } = reduce(state, { t: "drawDiscard", depth: 1 });
    expect(next.mandatory?.card).toBe("S7");
    expect(next.hands[0]).toContain("S7");
  });

  it("will not let the pile complete a meld out of its own cards", () => {
    // Three aces sitting together: digging to the deepest and melding it
    // with the other two — still in the pile — uses no hand card at all.
    const state = fixture({
      hands: { 0: ["C2", "D9"], 1: [], 2: [], 3: [] },
      discard: ["SA", "HA", "DA"],
    });
    expect(def.legalActions(state, 0).filter((a) => a.t === "drawDiscard")).toEqual([]);
  });

  it("allows the same dig once one real hand card joins in", () => {
    const state = fixture({
      hands: { 0: ["CA", "D9"], 1: [], 2: [], 3: [] },
      discard: ["SA", "HA", "DA"],
    });
    expect(def.legalActions(state, 0)).toContainEqual({ t: "drawDiscard", depth: 3 });
  });

  it("plays a multi-card pickup as one concurrent batch", () => {
    const state = fixture({
      hands: { 0: ["CA"], 1: [], 2: [], 3: [] },
      discard: ["SA", "HA", "DA"],
    });
    const { events } = reduce(state, { t: "drawDiscard", depth: 3 });
    expect(events.filter((e) => e.t === "draw")).toHaveLength(3);
  });
});

/* ============================================================
   Melding
   ============================================================ */

describe("rummy — melding", () => {
  it("blocks everything but the obligation while a pickup is outstanding", () => {
    const state = fixture({
      phase: "meld",
      hands: { 0: ["S7", "H7", "D7", "CK"], 1: [], 2: [], 3: [] },
      melds: [meld(1, 1, ["S4", "S5", "S6"])],
      nextMeldId: 2,
      mandatory: { card: "S7", pool: [] },
    });
    const legal = def.legalActions(state, 0);
    expect(legal.every((a) => a.t === "layNewMeld")).toBe(true);
    expect(reduce(state, { t: "discard", card: "CK" }).state).toBe(state);
    expect(reduce(state, { t: "extendMeld", meldId: 1, card: "CK" }).state).toBe(state);
  });

  it("rejects a meld that does not discharge the obligation", () => {
    const state = fixture({
      phase: "meld",
      hands: { 0: ["S7", "H7", "D7", "SJ", "SQ", "SK"], 1: [], 2: [], 3: [] },
      mandatory: { card: "S7", pool: [] },
    });
    expect(reduce(state, { t: "layNewMeld", cards: ["SJ", "SQ", "SK"] }).state).toBe(state);
    const ok = reduce(state, { t: "layNewMeld", cards: ["S7", "H7", "D7"] });
    expect(ok.state.mandatory).toBeNull();
    expect(ok.state.melds).toHaveLength(1);
  });

  it("melds only the DEEPEST card, letting the rest of a pickup just join the hand", () => {
    // Reported from play: pile 6♥ A♦ K♠ Q♦ Q♥ 2♦, hand holds K♦. Digging
    // to the A♦ takes five cards, and the mandatory meld is Q♦-K♦-A♦ —
    // the K♠, Q♥ and 2♦ ride along into the hand and are not part of it.
    // Requiring the WHOLE pickup to form one valid meld (which the UI
    // briefly did) makes this legal dig impossible: no arrangement of
    // all five cards is a meld.
    const state = fixture({
      hands: { 0: ["DK", "C3"], 1: [], 2: [], 3: [] },
      discard: ["H6", "DA", "SK", "DQ", "HQ", "D2"],
    });

    expect(def.legalActions(state, 0)).toContainEqual({ t: "drawDiscard", depth: 5 });

    const { state: drawn } = reduce(state, { t: "drawDiscard", depth: 5 });
    expect(drawn.mandatory?.card).toBe("DA");
    expect(drawn.hands[0]).toEqual(expect.arrayContaining(["DA", "SK", "DQ", "HQ", "D2", "DK"]));

    const { state: melded } = reduce(drawn, { t: "layNewMeld", cards: ["DQ", "DK", "DA"] });
    expect(melded.mandatory, "the obligation is discharged").toBeNull();
    expect(melded.melds).toHaveLength(1);
    expect(melded.melds[0]!.cards).toEqual(["DQ", "DK", "DA"]);
    // The cards that merely rode along stay in hand, exactly as taken.
    expect(melded.hands[0]).toEqual(expect.arrayContaining(["SK", "HQ", "D2", "C3"]));
  });

  it("finds that meld through the ace-high reading, which is what makes the dig legal", () => {
    // `legalDrawDepths` offers the depth only because this search gets
    // past the ace-low reading. (The UI deliberately does NOT pre-fill
    // the meld from it — finding the meld is the player's job.)
    const meld = findCompletion("DA", ["DK", "C3"], ["SK", "DQ", "HQ", "D2"]);
    expect(meld).not.toBeNull();
    expect([...meld!].sort()).toEqual(["DA", "DK", "DQ"]);
  });

  it("self-validates rather than trusting the caller matched legalActions", () => {
    const state = fixture({ phase: "meld", hands: { 0: ["S7", "H7", "D8"], 1: [], 2: [], 3: [] } });
    expect(reduce(state, { t: "layNewMeld", cards: ["S7", "H7", "D8"] }).state).toBe(state);
    expect(reduce(state, { t: "layNewMeld", cards: ["S7", "H7"] }).state).toBe(state);
    // A card not actually held.
    expect(reduce(state, { t: "layNewMeld", cards: ["S7", "H7", "C7"] }).state).toBe(state);
    // The same card twice.
    expect(reduce(state, { t: "layNewMeld", cards: ["S7", "S7", "H7"] }).state).toBe(state);
  });

  it("lets any seat extend any meld, and attributes the hit to the hitter", () => {
    const state = fixture({
      phase: "meld",
      turn: 2,
      hands: { 0: [], 1: [], 2: ["S8", "DK"], 3: [] },
      melds: [meld(1, 1, ["S5", "S6", "S7"])],
      nextMeldId: 2,
    });
    const { state: next } = reduce(state, { t: "extendMeld", meldId: 1, card: "S8" });
    const updated = next.melds[0]!;
    expect(updated.cards).toEqual(["S5", "S6", "S7", "S8"]);
    // The meld's owner never changes; only the card carries a contributor.
    expect(updated.owner).toBe(1);
    expect(updated.hitBy).toEqual({ S8: 2 });
  });

  it("keeps `cards` as an append-only log, unsorted", () => {
    const state = fixture({
      phase: "meld",
      hands: { 0: ["S4", "DK"], 1: [], 2: [], 3: [] },
      melds: [meld(1, 1, ["S5", "S6", "S7"])],
      nextMeldId: 2,
    });
    const { state: next } = reduce(state, { t: "extendMeld", meldId: 1, card: "S4" });
    // Extending the LOW end appends, it does not insert — display order
    // is a separate concern (see cards.test.ts).
    expect(next.melds[0]!.cards).toEqual(["S5", "S6", "S7", "S4"]);
  });
});

/* ============================================================
   The claim window
   ============================================================ */

describe("rummy — the claim window", () => {
  const claimable = () =>
    fixture({
      phase: "meld",
      melds: [meld(1, 2, ["S5", "S6", "S7"])],
      nextMeldId: 2,
      stock: ["D2", "D3"],
      hands: { 0: ["S8", "CK"], 1: ["S8", "CK"], 2: ["H2"], 3: ["H3"] },
    });

  it("opens a window to every eligible seat, each with its own clock", () => {
    const state = { ...claimable(), turn: 1 as SeatId };
    const { state: next } = reduce(state, { t: "discard", card: "S8" });
    expect(next.claimWindow?.discard).toBe("S8");
    expect(next.claimWindow?.discarder).toBe(1);
    expect(next.claimWindow?.meldId).toBe(1);

    // The clocks are the race, and every eligible seat has one — no seat
    // is left out for being the hero's. That exclusion WAS the seat-0
    // assumption: the page ran the hero's clock and the state carried
    // only the bots', which works exactly as long as there is one human
    // and they sit at seat 0.
    const pending = next.claimWindow!.pending;
    expect(pending.map((p) => p.seat).sort()).toEqual([0, 2, 3]); // 1 discarded it
    expect(pending.map((p) => p.ms)).toEqual(
      [...pending].sort((a, b) => a.ms - b.ms).map((p) => p.ms),
    );
    for (const p of pending) {
      expect(p.ms).toBeGreaterThanOrEqual(CLAIM_REACTION_MIN);
      expect(p.ms).toBeLessThanOrEqual(CLAIM_REACTION_MAX);
    }

    // `currentSeat` names whoever the PACING waits on — the soonest — and
    // that is deliberately not the only seat allowed to act.
    expect(def.currentSeat(next)).toBe(pending[0]!.seat);
    // Every pending seat is entitled, which is what makes it a race: a
    // human three deep in the list can still beat the bot at the front by
    // being quick. `GameSession.submit` asks `legalActions` rather than
    // `currentSeat` for exactly this case.
    for (const seat of [0, 2, 3] as SeatId[]) {
      expect(def.legalActions(next, seat)).toEqual([
        { t: "claim", seat },
        { t: "passClaim", seat },
      ]);
    }
    // The discarder is not in the race and may do nothing at all.
    expect(def.legalActions(next, 1)).toEqual([]);
    // And nothing has been grabbed while the window is open.
    expect(next.melds[0]!.cards).toEqual(["S5", "S6", "S7"]);
  });

  it("lets a seat that is not first in the queue win the race", () => {
    // The property the old model could not express at all. Whoever
    // submits first takes the card, whatever the clocks said — the clocks
    // only decide when an UNATTENDED seat gets there.
    const state = { ...claimable(), turn: 1 as SeatId };
    const opened = reduce(state, { t: "discard", card: "S8" }).state;
    const pending = opened.claimWindow!.pending;
    const slowest = pending[pending.length - 1]!.seat;
    expect(slowest).not.toBe(def.currentSeat(opened));

    const { state: next } = reduce(opened, { t: "claim", seat: slowest });
    expect(next.claimWindow).toBeNull();
    expect(contributorOf(next.melds[0]!, "S8")).toBe(slowest);
  });

  it("refuses a claim from a seat that is not in the race", () => {
    const state = { ...claimable(), turn: 1 as SeatId };
    const opened = reduce(state, { t: "discard", card: "S8" }).state;
    // Seat 1 discarded it and is not eligible. The reducer is not the
    // only thing between a spoofed seat and somebody else's card, but it
    // must still stand there.
    const { state: next } = reduce(opened, { t: "claim", seat: 1 });
    expect(next).toBe(opened);
    expect(next.claimWindow).not.toBeNull();
  });

  it("stamps the submitting seat over whatever the client sent", () => {
    // `completeAction` is what makes the `seat` field on a claim
    // trustworthy. Without it, "pass for seat 2" would knock a rival out
    // of a race they never conceded.
    const state = { ...claimable(), turn: 1 as SeatId };
    const opened = reduce(state, { t: "discard", card: "S8" }).state;
    const forged = { t: "passClaim", seat: 2 } as const;
    expect(def.completeAction!(opened, forged, 3, createRng(1))).toEqual({
      t: "passClaim",
      seat: 3,
    });
  });

  it("keeps the window open while anyone is still in the race", () => {
    const state = { ...claimable(), turn: 1 as SeatId };
    const opened = reduce(state, { t: "discard", card: "S8" }).state;
    const order = opened.claimWindow!.pending.map((p) => p.seat);

    // One seat declining does not hand the card to the next in line — it
    // just stops being a contender. That is the difference between a race
    // and a queue, and the old code was the queue.
    const afterOne = reduce(opened, { t: "passClaim", seat: order[0]! }).state;
    expect(afterOne.claimWindow).not.toBeNull();
    expect(afterOne.claimWindow!.pending.map((p) => p.seat)).toEqual(order.slice(1));
    expect(afterOne.melds[0]!.cards).toEqual(["S5", "S6", "S7"]);

    const afterTwo = reduce(afterOne, { t: "passClaim", seat: order[1]! }).state;
    expect(afterTwo.claimWindow!.pending.map((p) => p.seat)).toEqual(order.slice(2));

    // The last one to pass closes it and play moves on.
    const afterAll = reduce(afterTwo, { t: "passClaim", seat: order[2]! }).state;
    expect(afterAll.claimWindow).toBeNull();
    expect(afterAll.melds[0]!.cards).toEqual(["S5", "S6", "S7"]);
    expect(afterAll.turn).toBe(2);
  });

  it("resolves a claim to the seat that made it, attributed to them", () => {
    const state = { ...claimable(), turn: 1 as SeatId };
    const opened = reduce(state, { t: "discard", card: "S8" }).state;
    const { state: next } = reduce(opened, { t: "claim", seat: HERO });
    expect(next.claimWindow).toBeNull();
    expect(next.melds[0]!.cards).toContain("S8");
    expect(next.melds[0]!.hitBy).toEqual({ S8: HERO });
    expect(next.discard).not.toContain("S8");
    // Play resumes after the discarder, not after the claimer.
    expect(next.turn).toBe(2);
  });

  it("paces a claim with a real think beat before the card moves", () => {
    const state = { ...claimable(), turn: 1 as SeatId };
    const opened = reduce(state, { t: "discard", card: "S8" }).state;
    const claimer = def.currentSeat(opened)!;
    const { state: next, events } = reduce(opened, { t: "claim", seat: claimer });
    expect(next.melds[0]!.cards).toContain("S8");

    // The regression this exists for: a claim landing in the same instant
    // as the discard that caused it, with no readable beat between, reads
    // as "it already knew". The transition is synchronous, so the pacing
    // has to be a real event in the batch.
    const think = events.findIndex((e) => e.t === "think");
    const grab = events.findIndex((e) => e.t === "draw");
    expect(think, "a claim must carry a think beat").toBeGreaterThanOrEqual(0);
    expect(think).toBeLessThan(grab);
  });

  it("opens a window on the hero's own discard too, for everybody else", () => {
    // This used to resolve straight to the fastest bot with no window at
    // all, reasoning that the only human had just discarded it. In a room
    // the other three seats may be people, and they are as entitled to
    // the card as any bot was.
    const state = claimable();
    const { state: next } = reduce(state, { t: "discard", card: "S8" });
    expect(next.claimWindow).not.toBeNull();
    expect(next.claimWindow!.pending.map((p) => p.seat).sort()).toEqual([1, 2, 3]);
    // And the discarder cannot claim their own discard back.
    expect(def.legalActions(next, HERO)).toEqual([]);
  });

  it("just advances when the discard extends nothing", () => {
    const state = claimable();
    const { state: next } = reduce(state, { t: "discard", card: "CK" });
    expect(next.claimWindow).toBeNull();
    expect(next.turn).toBe(1);
    expect(next.phase).toBe("draw");
  });

  it("spreads contested claims across the table, not to whoever is next", () => {
    // The correction this encodes: extension has no owner restriction, so
    // every non-discarder is equally capable. Awarding it to the
    // discarder's next seat every time is an arbitrary, silently biased
    // tiebreak that reads as "whoever's turn is coming up always wins".
    const state = fixture();
    const winners = new Set<SeatId>();
    for (const card of rummyDeck()) {
      const fastest = claimReactions(state, card, 0)[0];
      if (fastest) winners.add(fastest.seat);
    }
    expect(winners.size).toBeGreaterThan(1);
  });

  it("awards a passed claim to the FASTEST bot, not to a re-derived pick", () => {
    // The window's clocks are fixed when it opens, so the winner is
    // already decided by the time the hero passes. Re-deriving it on the
    // pass would make the countdown a lie: the ring could run down against
    // one bot and the card go to another.
    const state = { ...claimable(), turn: 1 as SeatId };
    const opened = reduce(state, { t: "discard", card: "S8" }).state;
    // The hero stands aside; the soonest remaining seat is the winner.
    const passed = reduce(opened, { t: "passClaim", seat: HERO }).state;
    const fastest = passed.claimWindow!.pending[0]!.seat;
    const { state: next } = reduce(passed, { t: "claim", seat: fastest });
    expect(next.melds[0]!.cards).toContain("S8");
    // `contributorOf`, not `hitBy` — `hitBy` records only the cards whose
    // player differs from the meld's owner, so asserting on it directly
    // would pass for the wrong reason whenever the winner happens to own
    // the meld already.
    expect(contributorOf(next.melds[0]!, "S8")).toBe(fastest);
  });

  it("spends the winning bot's own reaction time BEFORE it claims", () => {
    // A claim that resolves instantly reads as "it already knew", which was
    // reported exactly that way — so the bot waits its reaction time. It
    // used to wait it as a `think` inside the claim's own frame, which
    // plays AFTER the claim is made: online the card was gone while a
    // person's ring still ran, and a press inside the ring lost. The wait
    // is the session's hold now (`turnHold`), and the think is nothing.
    const state = { ...claimable(), turn: HERO, phase: "meld" as const };
    // Two cards, so discarding one does not empty the hand and end the
    // round before the claim ever resolves.
    const withCard = { ...state, hands: { ...state.hands, [HERO]: ["S8", "CK"] } };
    const opened = reduce(withCard, { t: "discard", card: "S8" }).state;

    const soonest = opened.claimWindow!.pending[0]!;
    expect(soonest.ms).toBeGreaterThanOrEqual(CLAIM_REACTION_MIN);
    expect(soonest.ms).toBeLessThanOrEqual(CLAIM_REACTION_MAX);
    expect(turnHold(opened, soonest.seat)).toBe(soonest.ms);
    expect(rummyBots.steady.thinkMs(opened, soonest.seat, createRng(1))).toBe(0);
    // Every other turn keeps the driver's ordinary beat.
    expect(turnHold(withCard, HERO)).toBeUndefined();
  });

  it("counts a pass as time gone, so the next bot does not start again", () => {
    // A person passes when their ring runs out, at the soonest rival's
    // time. The bot after them has already waited that long.
    const state = claimable();
    const pending = [
      { seat: 0, ms: 1200 },
      { seat: 2, ms: 2000 },
      { seat: 3, ms: 4000 },
    ];
    const open = { ...state, claimWindow: { discard: "S8", discarder: 1, meldId: 1, pending } };
    const passed = reduce(open, { t: "passClaim", seat: 0 }).state;
    expect(passed.claimWindow!.elapsed).toBe(2000);
    expect(turnHold(passed, 2)).toBe(0);
    expect(turnHold(passed, 3)).toBe(2000);
  });

  it("times a person's ring by the bots alone, never by another person", () => {
    const state = claimable();
    const pending = [
      { seat: 0, ms: 1200 },
      { seat: 2, ms: 1500 },
      { seat: 3, ms: 3000 },
    ];
    const open = { ...state, claimWindow: { discard: "S8", discarder: 1, meldId: 1, pending } };
    // Offline everybody else is a bot, which is the default.
    expect(claimDeadlineMs(open, 2)).toBe(1200);
    // Seats 0 and 2 are both people: each races seat 3, the only bot.
    const isBot = (s: number) => s === 3;
    expect(claimDeadlineMs(open, 0, isBot)).toBe(3000);
    expect(claimDeadlineMs(open, 2, isBot)).toBe(3000);
    // With no bot in the race, the longest wait.
    expect(claimDeadlineMs(open, 2, () => false)).toBe(CLAIM_MS);
  });

  it("can give a bot a shorter clock than the hero's whole window", () => {
    // Otherwise it is not a race. The hero used to get a guaranteed five
    // seconds before any bot got a look, which meant a contested claim
    // could never actually be contested.
    const state = fixture();
    let sawFast = false;
    for (const card of rummyDeck()) {
      const soonest = claimReactions(state, card, 1)[0];
      if (soonest && soonest.ms < 2500) sawFast = true;
    }
    expect(sawFast, "no bot ever arrives before a slow human would").toBe(true);
  });

  it("draws reaction times deterministically — reduce stays replayable", () => {
    const state = fixture();
    expect(claimReactions(state, "S8", 0)).toEqual(claimReactions(state, "S8", 0));
    // ...and never gives two bots the same instant, or "who was first"
    // would come down to array order rather than to the race.
    const times = claimReactions(state, "S8", 0).map((b) => b.ms);
    expect(new Set(times).size).toBe(times.length);
  });
});

/* ============================================================
   Round end and scoring
   ============================================================ */

describe("rummy — round end and scoring", () => {
  it("ends the round when a seat discards its last card", () => {
    const state = fixture({
      phase: "meld",
      hands: { 0: ["CK"], 1: ["H2"], 2: ["H3"], 3: ["H4"] },
    });
    const { state: next } = reduce(state, { t: "discard", card: "CK" });
    expect(def.isRoundOver!(next)).toBe(true);
    expect(next.result?.wentOut).toBe(HERO);
  });

  it("does NOT end the round when a meld empties a hand — that is not going out", () => {
    // Going out means DISCARDING your last card. Laying it just ends
    // your turn; you stay in the round and play carries on round the
    // table. (rummy.md originally specified the opposite; corrected
    // against how the game is actually played.)
    const state = fixture({
      stock: ["D9", "D8"],
      phase: "meld",
      hands: { 0: ["S7", "H7", "D7"], 1: ["H2"], 2: ["H3"], 3: ["H4"] },
    });
    const { state: next } = reduce(state, { t: "layNewMeld", cards: ["S7", "H7", "D7"] });
    expect(def.isRoundOver!(next)).toBe(false);
    expect(next.hands[0]).toEqual([]);
    // The turn simply moves on — there is nothing to discard with.
    expect(next.turn).toBe(1);
    expect(next.phase).toBe("draw");
  });

  it("deals an out player back in each lap while the stock lasts", () => {
    let state = fixture({
      stock: ["D9", "D8"],
      phase: "meld",
      hands: { 0: [], 1: ["H2", "H5"], 2: ["H3", "H6"], 3: ["H4", "H8"] },
      turn: 3,
    });
    // Seat 3 discards, play comes back round to the empty-handed hero.
    ({ state } = reduce(state, { t: "discard", card: "H8" }));
    expect(def.isRoundOver!(state)).toBe(false);
    expect(def.currentSeat(state)).toBe(HERO);
    expect(def.legalActions(state, HERO)).toContainEqual({ t: "drawStock" });

    // They draw one and get the same choice again: lay it, or discard
    // it and finish.
    ({ state } = reduce(state, { t: "drawStock" }));
    expect(state.hands[0]).toHaveLength(1);
    expect(def.legalActions(state, HERO).some((a) => a.t === "discard")).toBe(true);
  });

  it("ends the round when play returns to an out player and the stock is dry", () => {
    const state = fixture({
      stock: [],
      phase: "meld",
      // Seat 3 keeps a card back, so THEY are not the one going out —
      // the round ends because play reaches the empty-handed hero with
      // no stock left to deal them back in.
      hands: { 0: [], 1: ["H2", "H5"], 2: ["H3"], 3: ["H4", "H9"] },
      turn: 3,
    });
    const { state: next } = reduce(state, { t: "discard", card: "H4" });
    expect(def.isRoundOver!(next)).toBe(true);
    expect(next.result?.wentOut).toBe(HERO);
    expect(next.result?.blocked).toBe(false);
  });

  it("scores board contributions minus what is still held", () => {
    const board = meld(1, 1, ["S5", "S6", "S7"]);
    board.hitBy = { S7: 2 };
    const state = fixture({
      phase: "meld",
      hands: { 0: ["CK"], 1: ["HA"], 2: [], 3: ["D2", "D3"] },
      melds: [board],
      nextMeldId: 2,
    });
    const { state: next } = reduce(state, { t: "discard", card: "CK" });
    const r = next.result!;
    // Seat 1 laid S5+S6 (5+5) and kept an ace (15).
    expect(r.contributed[1]).toBe(10);
    expect(r.handPenalty[1]).toBe(15);
    expect(r.deltas[1]).toBe(-5);
    // Seat 2 only hit S7, and holds nothing.
    expect(r.contributed[2]).toBe(5);
    expect(r.deltas[2]).toBe(5);
    // The hero went out with an empty hand and nothing on the board.
    expect(r.deltas[0]).toBe(0);
    expect(r.deltas[3]).toBe(-10);
    expect(r.winner).toBe(2);
  });

  it("counts cards you laid into SOMEONE ELSE'S meld as yours", () => {
    // Melds are owned for scoring attribution only — anyone may hit any
    // meld, and the hit card scores for the hitter, not the owner.
    const board = meld(1, 2, ["S5", "S6", "S7", "S8"]);
    board.hitBy = { S8: HERO };
    const state = fixture({
      phase: "meld",
      hands: { 0: ["CK"], 1: [], 2: [], 3: [] },
      melds: [board],
      nextMeldId: 2,
    });
    const { state: next } = reduce(state, { t: "discard", card: "CK" });
    const r = next.result!;
    expect(r.contributed[HERO], "the S8 the hero hit on is theirs").toBe(5);
    expect(r.contributed[2], "seat 2 keeps only the three it laid").toBe(15);
  });

  it("scores tens as ten, everywhere they appear", () => {
    // The ten reads like a number card but scores with the pictures.
    // Getting it wrong under-counted both hands and boards — a lone
    // 10♣ in hand showed as −5 instead of −10.
    // Seat 1 goes out, so the round ends while everyone else is still
    // holding — which is what puts a real hand penalty on the board.
    const board = meld(1, HERO, ["S10", "H10", "D10"]);
    const state = fixture({
      phase: "meld",
      turn: 1,
      hands: { 0: ["C10"], 1: ["S2"], 2: ["DA"], 3: [] },
      melds: [board],
      nextMeldId: 2,
    });
    const { state: next } = reduce(state, { t: "discard", card: "S2" });
    const r = next.result!;
    expect(r.contributed[HERO], "three tens on the board").toBe(30);
    expect(r.handPenalty[HERO], "one ten still held").toBe(10);
    expect(r.deltas[HERO]).toBe(20);
    expect(r.handPenalty[2], "an ace held").toBe(15);
  });

  it("crowns the hero as round winner when they actually scored most", () => {
    // What `HeroWinFlourish` reads, via GameRuntime.roundWinner ->
    // state.result.winner. If this is not the hero, no confetti fires.
    const state = fixture({
      phase: "meld",
      hands: { 0: ["C2"], 1: ["HA", "SK"], 2: [], 3: [] },
      melds: [meld(1, HERO, ["S10", "H10", "D10"])],
      nextMeldId: 2,
    });
    const { state: next } = reduce(state, { t: "discard", card: "C2" });
    expect(next.result?.wentOut).toBe(HERO);
    expect(next.result?.winner).toBe(HERO);
  });

  it("declares a match winner once someone crosses the target", () => {
    const state = fixture({
      target: 20,
      phase: "meld",
      scores: { 0: 0, 1: 30, 2: 0, 3: 0 },
      hands: { 0: ["CK"], 1: [], 2: [], 3: [] },
    });
    const { state: next, events } = reduce(state, { t: "discard", card: "CK" });
    expect(next.winner).toBe(1);
    expect(def.isOver(next)).toBe(true);
    expect(events.some((e) => e.t === "gameEnd")).toBe(true);
  });

  it("ends a round as blocked once nothing has happened for several laps", () => {
    // The backstop exists because a round genuinely CAN cycle forever
    // once every pickup carries a mandatory-meld obligation — confirmed
    // in a 300,000-turn simulation that never budged. This is why the
    // stock never needs to reshuffle.
    let state = fixture({
      phase: "meld",
      stock: [],
      hands: { 0: ["CK"], 1: ["DK"], 2: ["HK"], 3: ["SK"] },
      noProgressStreak: 4 * 20 - 1,
      handTotalCheckpoint: 4,
    });
    ({ state } = reduce(state, { t: "discard", card: "CK" }));
    // Discarding the last card would go out, so use a state that cannot.
    state = fixture({
      phase: "meld",
      stock: [],
      hands: { 0: ["CK", "C2"], 1: ["DK"], 2: ["HK"], 3: ["SK"] },
      noProgressStreak: 4 * 20 - 1,
      handTotalCheckpoint: 5,
    });
    const { state: next } = reduce(state, { t: "discard", card: "CK" });
    expect(def.isRoundOver!(next)).toBe(true);
    expect(next.result?.blocked).toBe(true);
    expect(next.result?.wentOut).toBeNull();
  });
});

/* ============================================================
   placements
   ============================================================ */

describe("rummy — placements", () => {
  it("seeds every unaccounted card into the deck so the deal can animate", () => {
    const state = fixture({
      hands: { 0: ["S7"], 1: ["H7"], 2: [], 3: [] },
      discard: ["D9"],
    });
    const p = def.placements(state, HERO);
    expect(Object.keys(p)).toHaveLength(52);
    expect(p["S2"]!.zone).toBe("deck");
  });

  it("never leaks another seat's cards, even for one reconcile", () => {
    const state = fixture({ hands: { 0: ["S7"], 1: ["H7"], 2: [], 3: [] } });
    const p = def.placements(state, HERO);
    expect(p["S7"]!.faceUp).toBe(true);
    expect(p["H7"]!.faceUp).toBe(false);
    // ...and from seat 1's own point of view, the reverse.
    const p1 = def.placements(state, 1);
    expect(p1["H7"]!.faceUp).toBe(true);
    expect(p1["S7"]!.faceUp).toBe(false);
  });

  it("marks board cards hidden, grouped by meld, attributed per card", () => {
    const board = meld(4, 1, ["S5", "S6", "S7"]);
    board.hitBy = { S7: 2 };
    const state = fixture({ melds: [board], nextMeldId: 5 });
    const p = def.placements(state, HERO);
    expect(p["S5"]).toMatchObject({ zone: "board", group: 4, seat: 1, hidden: true });
    // Grouping and attribution are free to disagree — that is the point.
    expect(p["S7"]).toMatchObject({ zone: "board", group: 4, seat: 2, hidden: true });
  });

  it("tags only the cards a meld's owner did NOT play", () => {
    const board = meld(4, 1, ["S5", "S6", "S7"]);
    board.hitBy = { S7: 2 };
    const state = fixture({ melds: [board], nextMeldId: 5 });
    const p = def.placements(state, HERO);
    // Seat 1 laid S5 and S6 — the group heading already says so, and
    // repeating it on every card says nothing.
    expect(p["S5"]!.ownerTag).toBeUndefined();
    expect(p["S6"]!.ownerTag).toBeUndefined();
    // Seat 2 hit S7 onto it, which is the one thing the heading cannot
    // tell you — so that card, and only that card, carries a chip.
    expect(p["S7"]!.ownerTag).toBeDefined();
    expect(p["S7"]!.accentColour).toBeDefined();
  });

  it("makes every discard card tappable while drawing, and lights NONE of them", () => {
    const state = fixture({
      hands: { 0: ["H7", "D7"], 1: [], 2: [], 3: [] },
      discard: ["SK", "S7"],
    });
    const p = def.placements(state, HERO);
    // Exploration is free — tapping stages a cancelable preview.
    expect(p["SK"]!.tappable).toBe(true);
    expect(p["S7"]!.tappable).toBe(true);
    // But nothing is lit, even though depth 1 (the S7) genuinely
    // completes a set of sevens. Marking the workable depths would
    // answer, before the player has looked, the question the game is
    // asking them — working it out IS the play. The commit validates.
    expect(p["S7"]!.highlighted, "a legal depth must not be pre-lit").toBeUndefined();
    expect(p["SK"]!.highlighted).toBeUndefined();
  });

  it("leaves NO deck piece once the stock is dry, which is why the UI needs its own way out", () => {
    // Reported from play: stock empty, player did not want the discard
    // pile, and could not act at all. `drawStock` is still legal (a seat
    // facing an empty stock simply skips drawing) — but `placements`
    // correctly produces no deck piece to tap, so there was nothing on
    // the felt to submit it with. The play screen carries an explicit
    // "play on" control for exactly this state.
    const hands = { 0: ["CK", "C2"], 1: ["H2"], 2: ["H3"], 3: ["H4"] };
    const board = ["S5", "S6", "S7"];
    // Every card has to be SOMEWHERE, or `placements`' deck-fallback
    // (which is what makes an opening deal animate) puts the remainder
    // back in the deck and the test proves nothing about a real table.
    const placed = new Set([...Object.values(hands).flat(), ...board]);
    const state = fixture({
      stock: [],
      hands,
      discard: rummyDeck().filter((id) => !placed.has(id)),
      melds: [meld(1, 1, board)],
      nextMeldId: 2,
    });
    const p = def.placements(state, HERO);
    expect(Object.values(p).some((x) => x.zone === "deck")).toBe(false);
    expect(def.legalActions(state, 0)).toContainEqual({ t: "drawStock" });

    const { state: next } = reduce(state, { t: "drawStock" });
    expect(next.phase, "the draw must still resolve").toBe("meld");
    // ...and now melding and discarding are genuinely available.
    const legal = def.legalActions(next, 0);
    expect(legal.some((a) => a.t === "discard")).toBe(true);
  });

  it("does not offer the pile at all when it is not the viewer's draw", () => {
    const state = fixture({ turn: 1, discard: ["SK"] });
    const p = def.placements(state, HERO);
    expect(p["SK"]!.tappable).toBeUndefined();
  });

  it("gives the hero's own hand instantAct, so a tap toggles immediately", () => {
    const state = fixture({ hands: { 0: ["S7"], 1: ["H7"], 2: [], 3: [] } });
    const p = def.placements(state, HERO);
    expect(p["S7"]!.instantAct).toBe(true);
    expect(p["H7"]!.instantAct).toBeUndefined();
  });
});

describe("rummy — playerView", () => {
  it("redacts every hand but the viewer's", () => {
    const state = fixture({ hands: { 0: ["S7", "S8"], 1: ["H7"], 2: [], 3: ["D2"] } });
    const view = def.playerView(state, 1);
    expect(view.hands[1]).toEqual(["H7"]);
    expect(view.hands[0]).toEqual(["??", "??"]);
    expect(view.hands[3]).toEqual(["??"]);
  });
});

/* ============================================================
   Full-match simulation
   ============================================================ */

/**
 * How many claim windows the last `runMatch` opened.
 *
 * Instrumentation, kept because the number 0 was a real bug and nothing
 * else in the suite could see it: bots used to lay off every extendable
 * card before discarding, so a bot's discard never left anything
 * claimable, so the hero's "Rummy!" window was unreachable in play. It
 * measured 0 across 453 rounds and was reported twice as a missing
 * button. See `LAYOFF_ATTENTION` in bots.ts.
 */
let claimWindowsOpened = 0;

function runMatch(seed: number, seats: number, deep = true, guard = 8000) {
  const game = createRummy({ target: 200 });
  const rng = createRng(seed);
  let state = game.setup({ seats, rng });
  ({ state } = startRound(state, rng));

  let steps = 0;
  while (!game.isOver(state) && steps++ < guard) {
    if (game.isRoundOver!(state)) {
      ({ state } = startRound(state, rng));
      continue;
    }
    const seat = game.currentSeat(state);
    expect(seat, `seed ${seed}/${seats}: nobody to act at step ${steps}`).not.toBeNull();

    const legal = game.legalActions(state, seat!);
    expect(legal.length, `seed ${seed}/${seats}: no legal action for seat ${seat}`)
      .toBeGreaterThan(0);

    // A claim window only ever faces a human, so drive it from the legal
    // list — a bot never sees one in the real runtime.
    const action = state.claimWindow
      ? legal[steps % legal.length]!
      : game.bots.steady.choose(game.playerView(state, seat!), seat!, rng);

    expect(legal, `seed ${seed}/${seats}: illegal ${JSON.stringify(action)}`)
      .toContainEqual(action);

    const before = state;
    ({ state } = game.reduce(state, action));
    if (state.claimWindow && !before.claimWindow) claimWindowsOpened++;
    expect(state, `seed ${seed}/${seats}: ${JSON.stringify(action)} was a no-op`)
      .not.toBe(before);

    if (state.dealt) {
      // 52 ids, all distinct, all drawn from the deck to begin with, is
      // exactly "the deck is intact" — and unlike sorting and deep-
      // comparing on every step it is cheap enough to run 200 matches
      // through. `deep` adds the literal comparison for the handful of
      // targeted matches where the extra certainty is worth the time.
      const cards = allCards(state);
      expect(cards.length, `seed ${seed}/${seats}: a card went missing`).toBe(52);
      expect(new Set(cards).size, `seed ${seed}/${seats}: a card was duplicated`).toBe(52);
      if (deep) {
        expect(cards, `seed ${seed}/${seats}: the deck changed identity`)
          .toEqual([...rummyDeck()].sort());
      }
    }
    for (const hand of Object.values(state.hands)) {
      expect(hand, `seed ${seed}/${seats}: HIDDEN_CARD leaked into real state`)
        .not.toContain("??");
    }
  }
  expect(game.isOver(state), `seed ${seed}/${seats}: never finished in ${guard} steps`)
    .toBe(true);
  return state;
}

describe("rummy — full-match simulation invariants", () => {
  it("plays out at every seat count", () => {
    for (const seats of [2, 3, 4, 5, 6]) runMatch(11, seats);
  });

  it("replays identically from the same seed", () => {
    const a = runMatch(42, 4);
    const b = runMatch(42, 4);
    expect(a.scores).toEqual(b.scores);
    expect(a.winner).toBe(b.winner);
    expect(a.round).toBe(b.round);
  });

  // The sweep that earns its keep: a couple of hundred whole matches
  // asserting every chosen action is legal and no engine sentinel ever
  // reaches real state. Cheap, and it catches exactly the class of
  // low-probability interaction bug a handful of fixed seeds does not.
  it("sweeps 200 seeds end to end", { timeout: 90_000 }, () => {
    for (let seed = 1; seed <= 200; seed++) runMatch(seed, 2 + (seed % 5), false);
  });

  it("opens claim windows often enough for a player to ever see one", () => {
    // The regression guard for a bug the rest of this suite structurally
    // could not see. Every bot tier used to lay off every extendable card
    // before discarding, which made a bot's discard never claimable —
    // and so made the hero's "Rummy!" window unreachable in real play.
    // A window opening is not proof the feature is good, but zero of them
    // is proof it is dead, which is what it measured before.
    // Measured with `steady` (what `runMatch` plays): 19 windows across
    // 60 matches, roughly one every twelve rounds. Casual is ~5x that,
    // sharp is genuinely zero — it never misses a lay-off AND avoids
    // discarding into a live meld, which is what "rarely hands you a
    // gift" has to mean. The floor here only has to be above zero;
    // zero was the bug.
    claimWindowsOpened = 0;
    for (let seed = 1; seed <= 60; seed++) runMatch(seed, 2 + (seed % 5), false);
    expect(claimWindowsOpened, "no discard was ever claimable across 60 matches").toBeGreaterThan(
      5,
    );
  });
});

describe("the move check accepts every valid meld", () => {
  /**
   * Reported: taking two aces off the discard pile with two more in hand,
   * "Create meld" put all four in the hand instead of melding them — and
   * melding them from the hand was then "not allowed".
   *
   * Both halves were one bug. The table sends the pickup and the meld as
   * two moves, and the session checks each against `legalActions` — which
   * lists ONE meld per starting card, not every valid one. Four aces was
   * not on the list, so the pickup went through and the meld did not.
   */
  const state = fixture({
    phase: "draw",
    discard: ["D9", "CA", "DA"],
    hands: { 0: ["HA", "SA", "D6", "C2", "C4", "HJ", "S3", "S7", "S9"], 1: [], 2: [], 3: [] },
    stock: ["H2", "H3"],
  });

  it("takes the pickup and lays the four aces, as the table sends them", () => {
    const afterDraw = reduce(state, { t: "drawDiscard", depth: 2 }).state;
    const meld = { t: "layNewMeld" as const, cards: ["CA", "DA", "HA", "SA"] };
    expect(def.validate!(afterDraw, 0, meld)).toBeNull();
    const done = reduce(afterDraw, meld).state;
    expect(done.melds.at(-1)?.cards).toEqual(["CA", "DA", "HA", "SA"]);
    expect(done.mandatory).toBeNull();
  });

  it("still refuses a meld that is not one, or skips the card the pickup owes", () => {
    const afterDraw = reduce(state, { t: "drawDiscard", depth: 2 }).state;
    // Not a meld.
    expect(def.validate!(afterDraw, 0, { t: "layNewMeld", cards: ["CA", "D6", "S9"] })).not.toBeNull();
    // A meld, but without the ace the pickup obliges (CA, the deepest).
    expect(def.validate!(afterDraw, 0, { t: "layNewMeld", cards: ["DA", "HA", "SA"] })).not.toBeNull();
    // Cards not in the hand.
    expect(def.validate!(afterDraw, 0, { t: "layNewMeld", cards: ["CA", "DA", "HK"] })).not.toBeNull();
    // Somebody else's turn.
    expect(def.validate!(afterDraw, 1, { t: "layNewMeld", cards: ["CA", "DA", "HA"] })).not.toBeNull();
    // Not even the right shape.
    expect(def.validate!(afterDraw, 0, { t: "layNewMeld", cards: "CA" } as never)).not.toBeNull();
  });
});

describe("a pickup's meld needs a card from the hand", () => {
  /**
   * Reported: with three kings sitting in the discard pile, "Create meld"
   * offered to lay them as a set with no card from the hand. The rule is
   * that a meld made from a pickup uses at least one card you already
   * held; the pickup refused it, but the button did not know.
   */
  const state = fixture({
    phase: "draw",
    discard: ["D9", "SK", "HK", "H9", "CK"],
    hands: { 0: ["DK", "C2", "C4", "HJ", "S3"], 1: [], 2: [], 3: [] },
    stock: ["H2", "H3"],
  });

  it("refuses the pile's own kings, and takes them with the one in hand", () => {
    const afterDraw = reduce(state, { t: "drawDiscard", depth: 4 }).state;
    expect(afterDraw.mandatory?.card).toBe("SK");

    const pileOnly = { t: "layNewMeld" as const, cards: ["SK", "HK", "CK"] };
    expect(def.validate!(afterDraw, 0, pileOnly)).not.toBeNull();
    expect(reduce(afterDraw, pileOnly).state).toBe(afterDraw);

    const withHand = { t: "layNewMeld" as const, cards: ["SK", "HK", "DK"] };
    expect(def.validate!(afterDraw, 0, withHand)).toBeNull();
    expect(reduce(afterDraw, withHand).state.mandatory).toBeNull();
  });

  it("never lists a pile-only meld for the obligation, so a bot cannot lay one", () => {
    const afterDraw = reduce(state, { t: "drawDiscard", depth: 4 }).state;
    const hand = afterDraw.hands[0]!;
    const melds = mandatoryMelds(hand, "SK", afterDraw.mandatory!.pool);
    expect(melds.length).toBeGreaterThan(0);
    for (const m of melds) expect(m).toContain("DK");
  });
});
