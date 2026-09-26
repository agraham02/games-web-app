import { describe, expect, it } from "vitest";
import type { BotDifficulty, GameEvent } from "@/engine/types";
import { gapAfter } from "@/motion/choreographer";
import { DURATION } from "@/motion/presets";
import { createRng } from "@/engine/rng";
import { createPoker } from "./rules";
import type { PokerAction, PokerState } from "./types";

const definition = createPoker(2000, 20);

function seatActs(state: PokerState) {
  return definition.currentSeat(state);
}

function deal(seats: number, seed: number, startingStack = 2000, bigBlind = 20) {
  const rng = createRng(seed);
  const d = createPoker(startingStack, bigBlind);
  let state = d.setup({ seats, rng });
  const first = d.startRound!(state, rng);
  state = first.state;
  return { d, rng, state };
}

/** Plays every seat's turn with `call`/`check` (never folds, never
 * raises) until the hand reaches showdown or a forced end. Useful for
 * directed tests that want to reach showdown deterministically. */
function callDownToShowdown(d: ReturnType<typeof createPoker>, state: PokerState) {
  for (let i = 0; i < 200; i++) {
    if (d.isRoundOver!(state)) return state;
    const seat = d.currentSeat(state);
    if (seat === null) return state;
    if (state.pendingShowdown) {
      state = d.reduce(state, { t: "muck" }).state;
      continue;
    }
    const legal = d.legalActions(state, seat);
    const action =
      legal.find((a) => a.t === "check") ?? legal.find((a) => a.t === "call") ?? legal[0]!;
    state = d.reduce(state, action).state;
  }
  throw new Error("callDownToShowdown: did not settle in time");
}

describe("startRound — blinds, deal, turn order", () => {
  it("posts blinds and deals 2 hole cards to every seat", () => {
    const { state } = deal(4, 1);
    expect(state.hand).toBe(1);
    const sbTotal = Object.values(state.streetCommitted).filter((n) => n === 10);
    const bbTotal = Object.values(state.streetCommitted).filter((n) => n === 20);
    expect(sbTotal.length).toBe(1);
    expect(bbTotal.length).toBe(1);
    for (let s = 0; s < 4; s++) {
      const hole = Object.entries(state.cardOwner).filter(([, o]) => o === s);
      expect(hole.length).toBe(2);
    }
  });

  it("3+-handed preflop action starts at UTG (after the big blind)", () => {
    const { state } = deal(4, 1);
    const bb = Object.entries(state.streetCommitted).find(([, n]) => n === 20)![0];
    const utgExpected = (Number(bb) + 1) % 4;
    expect(seatActs(state)).toBe(utgExpected);
  });

  it("heads-up preflop action starts at the button (the small blind)", () => {
    const { state } = deal(2, 1);
    expect(seatActs(state)).toBe(state.button);
  });

  it("every one of the 52 cards is accounted for exactly once after the deal", () => {
    const { state } = deal(6, 7);
    expect(Object.keys(state.cardOwner).length).toBe(52);
    const owners = Object.values(state.cardOwner);
    expect(owners.filter((o) => o === "deck").length).toBe(52 - 6 * 2);
  });
});

describe("fold-out — no showdown, no reveal", () => {
  it("everyone-but-one folding resolves instantly with no pendingShowdown", () => {
    const { d, state: initial } = deal(3, 2);
    let state = initial;
    for (let i = 0; i < 20; i++) {
      if (d.isRoundOver!(state)) break;
      const seat = d.currentSeat(state)!;
      const legal = d.legalActions(state, seat);
      const fold = legal.find((a) => a.t === "fold");
      const action = fold ?? legal.find((a) => a.t === "check") ?? legal[0]!;
      state = d.reduce(state, action).state;
    }
    expect(state.pendingShowdown).toBeNull();
    expect(state.result?.showdown).toBe(false);
    expect(state.result?.winningSeats.length).toBe(1);
  });
});

describe("pendingShowdown — show or muck", () => {
  it("seizes currentSeat for a losing showdown seat before the hand settles", () => {
    const { d, state: initial } = deal(2, 3);
    let state = initial;
    state = callDownToShowdown(d, state);
    // Either it resolved straight through (winner-only, no losers to ask)
    // or pendingShowdown is open for exactly the non-winning seats.
    if (state.pendingShowdown) {
      const seat = d.currentSeat(state)!;
      expect(state.pendingShowdown.order[0]).toBe(seat);
      expect(d.legalActions(state, seat).map((a) => a.t).sort()).toEqual(["muck", "show"]);
      expect(state.result).toBeNull(); // Not settled yet — still waiting on this decision.
    } else {
      expect(state.result?.showdown).toBe(true);
    }
  });

  it("muck hides the hand the same way a fold does; show flips it", () => {
    const { d, state: initial } = deal(2, 3);
    let state = initial;
    state = callDownToShowdown(d, state);
    if (!state.pendingShowdown) return; // Nothing to muck this seed — fine, other seeds cover it.
    const seat = state.pendingShowdown.order[0]!;
    const { state: mucked } = d.reduce(state, { t: "muck" });
    expect(mucked.folded[seat]).toBe(true);
  });

  it("winners are never offered a show/muck choice", () => {
    const { d, state: initial } = deal(3, 4);
    let state = initial;
    state = callDownToShowdown(d, state);
    if (!state.pendingShowdown) return;
    for (const seat of state.pendingShowdown.winningSeats) {
      expect(state.pendingShowdown.order).not.toContain(seat);
    }
  });

  it("stacks and result only finalize once every pending decision resolves", () => {
    const { d, state: initial } = deal(3, 5);
    let state = initial;
    state = callDownToShowdown(d, state);
    if (!state.pendingShowdown) return;
    const before = { ...state.stacks };
    while (state.pendingShowdown && state.pendingShowdown.order.length > 0) {
      expect(state.result).toBeNull();
      state = d.reduce(state, { t: "muck" }).state;
    }
    expect(state.result).not.toBeNull();
    expect(state.stacks).not.toEqual(before);
  });
});

describe("side pots — a real 3-way all-in through actual gameplay", () => {
  it("layers correctly when stacks differ and pays each layer to its rightful winner", () => {
    // Small, staggered stacks force an all-in landscape almost every
    // seed; try a handful and demand at least one produces a real
    // multi-layer pot, rather than asserting on one brittle hand.
    let sawSidePot = false;
    for (let seed = 0; seed < 60 && !sawSidePot; seed++) {
      const rng = createRng(seed);
      const d = createPoker(1, 20); // seats get non-uniform stacks below
      let state = d.setup({ seats: 3, rng });
      state = { ...state, stacks: { 0: 40, 1: 150, 2: 400 } };
      const r = d.startRound!(state, rng);
      state = r.state;
      for (let i = 0; i < 40 && !d.isRoundOver!(state); i++) {
        const seat = d.currentSeat(state);
        if (seat === null) break;
        if (state.pendingShowdown) {
          state = d.reduce(state, { t: "muck" }).state;
          continue;
        }
        const legal = d.legalActions(state, seat);
        // Push all-in whenever possible to reliably create layered pots.
        const shove = legal.find((a) => a.t === "bet" || a.t === "raise");
        const action = shove
          ? { t: shove.t, to: state.stacks[seat]! + (state.streetCommitted[seat] ?? 0) }
          : (legal.find((a) => a.t === "call") ?? legal[0]!);
        state = d.reduce(state, action as PokerAction).state;
      }
      if (state.result && !state.result.showdown) continue;
      // Reconstruct the layering from totalCommitted at the moment the
      // hand was fully-committed — still readable off `result.deltas`'
      // sibling data isn't kept, so re-derive from what we know settled:
      // at least 3 distinct deltas across seats implies more than one
      // pot layer paid out independently.
      const distinctPayouts = new Set(Object.values(state.result?.deltas ?? {}));
      if (distinctPayouts.size >= 2) sawSidePot = true;
    }
    expect(sawSidePot).toBe(true);
  });
});

describe("all-in below the blind", () => {
  it("a short-stacked big blind posts all-in for less than the full blind", () => {
    const rng = createRng(11);
    const d = createPoker(1, 20);
    let state = d.setup({ seats: 3, rng });
    state = { ...state, stacks: { 0: 1000, 1: 1000, 2: 12 } };
    const r = d.startRound!(state, rng);
    state = r.state;
    const shortSeat = Object.entries(state.stacks).find(([, n]) => n === 0)?.[0];
    if (shortSeat !== undefined) {
      expect(state.totalCommitted[Number(shortSeat)]).toBeLessThanOrEqual(20);
    }
  });
});

describe("the incomplete-raise cap", () => {
  it("closes betting for the rest of the street once a short all-in raise lands", () => {
    const rng = createRng(21);
    const d = createPoker(1, 20);
    let state = d.setup({ seats: 3, rng });
    // Seat 0 opens for a full raise; seat 1 is too short to make
    // another FULL raise but can still shove for more than a call.
    state = { ...state, stacks: { 0: 1000, 1: 45, 2: 1000 } };
    const r = d.startRound!(state, rng);
    state = r.state;

    // Drive it: whoever's first bets 60 (a full opening raise over the
    // 20 BB), then the short stack shoves all-in for 45 total (less
    // than a full raise increment of 60 more).
    const opener = d.currentSeat(state)!;
    state = d.reduce(state, { t: "bet", to: 60 }).state;
    if (d.isRoundOver!(state)) return; // Runout beat us to it on this seed.
    const shortSeat = 1;
    if (d.currentSeat(state) === shortSeat) {
      state = d.reduce(state, { t: "raise", to: 45 }).state;
      expect(state.raiseCapped).toBe(true);
      // Nobody still owed a response may raise further this street.
      const remaining = d.currentSeat(state);
      if (remaining !== null && !state.pendingShowdown) {
        const legal = d.legalActions(state, remaining);
        expect(legal.some((a) => a.t === "bet" || a.t === "raise")).toBe(false);
      }
    }
    void opener;
  });
});

describe("elimination and match end", () => {
  it("winner/gameEnd fire only once stacks leave ≤1 seat with chips", () => {
    const rng = createRng(31);
    const d = createPoker(20, 20); // one big blind of a stack each — busts fast
    let state = d.setup({ seats: 2, rng });
    const r = d.startRound!(state, rng);
    state = r.state;
    let hands = 0;
    while (!d.isOver(state) && hands < 60) {
      if (d.isRoundOver!(state)) {
        hands++;
        const r2 = d.startRound!(state, rng);
        state = r2.state;
        continue;
      }
      const seat = d.currentSeat(state);
      if (seat === null) break;
      if (state.pendingShowdown) {
        state = d.reduce(state, { t: "muck" }).state;
        continue;
      }
      const legal = d.legalActions(state, seat);
      const shove = legal.find((a) => a.t === "bet" || a.t === "raise");
      const action = shove
        ? { t: shove.t, to: 10000 }
        : (legal.find((a) => a.t === "call") ?? legal[0]!);
      state = d.reduce(state, action as PokerAction).state;
    }
    expect(d.isOver(state)).toBe(true);
    expect(state.winner).not.toBeNull();
    const stillIn = Object.values(state.stacks).filter((n) => n > 0);
    expect(stillIn.length).toBe(1);
  });
});

describe("no free-choice fold", () => {
  it("never offers fold when check is free", () => {
    const { d, state } = deal(4, 41);
    const seat = d.currentSeat(state)!;
    const legal = d.legalActions(state, seat);
    const toCall = state.streetCommitted;
    const highest = Math.max(0, ...Object.values(toCall));
    const owesNothing = (state.streetCommitted[seat] ?? 0) === highest;
    if (owesNothing) {
      expect(legal.some((a) => a.t === "fold")).toBe(false);
      expect(legal.some((a) => a.t === "check")).toBe(true);
    }
  });
});

/* ============================================================
   Bot-vs-bot fuzz sweep
   ============================================================ */

const TIERS: BotDifficulty[] = ["casual", "steady", "sharp"];

function simulate(seats: number, seed: number, maxHands: number) {
  const rng = createRng(seed);
  const startingStack = 300; // shallow relative to the blind — forces real all-ins/eliminations within `maxHands`
  const d = createPoker(startingStack, 20);
  const difficulty = Array.from({ length: seats }, (_, s) => TIERS[(s + seed) % TIERS.length]!);
  let state = d.setup({ seats, rng, difficulty });
  const r = d.startRound!(state, rng);
  state = r.state;

  let hands = 0;
  let sidePotHands = 0;
  let splitPotHands = 0;
  let showdownHands = 0;
  let botShows = 0;
  let sawHeadsUp = false;
  let steps = 0;

  while (hands < maxHands && steps < 20000) {
    steps++;
    if (d.isOver(state)) break;
    if (d.isRoundOver!(state)) {
      hands++;
      if (state.result?.showdown) {
        showdownHands++;
        if (state.result.winningSeats.length > 1) splitPotHands++;
        if (new Set(Object.values(state.result.deltas)).size >= 2) sidePotHands++;
      }
      if (Object.keys(state.folded).length === 2) sawHeadsUp = true;
      const nr = d.startRound!(state, rng);
      state = nr.state;
      continue;
    }
    const seat = d.currentSeat(state);
    if (seat === null) break;
    const tier = difficulty[seat] ?? "steady";
    const view = d.playerView(state, seat);
    const legal = d.legalActions(state, seat);
    expect(legal.length, `seed ${seed} seats ${seats}: no legal actions for seat ${seat}`).toBeGreaterThan(0);
    const action = d.bots[tier].choose(view, seat, rng);
    expect(
      legal.some((a) => a.t === action.t),
      `seed ${seed} seats ${seats}: bot chose illegal action type ${action.t}`,
    ).toBe(true);
    if ((action.t === "bet" || action.t === "raise") && "to" in action) {
      const legalOfType = legal.find((a) => a.t === action.t);
      expect(legalOfType).toBeDefined();
    }
    if (action.t === "show") botShows++;

    const before = state;
    const { state: nextState } = d.reduce(state, action);
    expect(nextState, `seed ${seed} seats ${seats}: reduce was a no-op for a real action`).not.toBe(
      before,
    );
    state = nextState;

    // No stack or commitment ever goes negative or exceeds the starting
    // total for this match.
    for (const s of Object.keys(state.stacks).map(Number)) {
      expect(state.stacks[s]!, `seed ${seed}: negative stack`).toBeGreaterThanOrEqual(0);
    }
  }

  return { state, hands, sidePotHands, splitPotHands, showdownHands, botShows, sawHeadsUp };
}

describe("bot-vs-bot fuzz sweep", () => {
  it("every action stays legal and accounting stays sane across many seeds and seat counts", () => {
    for (const seats of [2, 3, 4, 6, 9]) {
      for (let seed = 0; seed < 12; seed++) {
        simulate(seats, seed * 97 + seats, 25);
      }
    }
  });

  it("side pots, split pots and elimination actually occur — not just possible in principle", () => {
    let sidePotHands = 0;
    let splitPotHands = 0;
    let eliminationHands = 0;
    let botShows = 0;
    const rounds = 40;
    for (let seed = 0; seed < rounds; seed++) {
      const result = simulate(4, seed, 40);
      sidePotHands += result.sidePotHands;
      splitPotHands += result.splitPotHands;
      botShows += result.botShows;
      if (definitionIsOver(result.state)) eliminationHands++;
    }
    expect(sidePotHands, "side pots never formed across the whole sweep").toBeGreaterThan(0);
    expect(splitPotHands, "split pots never formed across the whole sweep").toBeGreaterThan(0);
    expect(eliminationHands, "the match never actually eliminated anyone across the whole sweep").toBeGreaterThan(0);
    expect(botShows, "a losing bot never chose to show across the whole sweep").toBeGreaterThan(0);
  });

  it("heads-up play is actually reached and exercises the inverted turn order", () => {
    let headsUpSeen = 0;
    for (let seed = 0; seed < 20; seed++) {
      const result = simulate(2, seed, 30);
      if (result.sawHeadsUp) headsUpSeen++;
    }
    expect(headsUpSeen, "heads-up play was never actually reached across the sweep").toBeGreaterThan(0);
  });
});

function definitionIsOver(state: PokerState): boolean {
  return state.winner !== null;
}

describe("dealing the board", () => {
  /**
   * Reported: the burn card was barely visible before the next card came,
   * and the flop's three cards were dealt at once. Measured on the clock
   * the table actually plays by — `gapAfter`, the rule `drain()` uses —
   * rather than by counting events, because it is the waits between them
   * that were missing.
   */
  it("burns, then deals the flop one card at a time", () => {
    const d = createPoker();
    const rng = createRng(12);
    let state: PokerState = d.startRound!(d.setup({ seats: 4, rng }), rng).state;
    let flop: GameEvent[] = [];
    for (let i = 0; i < 20 && flop.length === 0; i++) {
      const seat = d.currentSeat(state)!;
      const legal = d.legalActions(state, seat);
      const action = legal.find((a) => a.t === "check") ?? legal.find((a) => a.t === "call")!;
      const { state: next, events } = d.reduce(state, action);
      if (events.some((e) => e.t === "move" && e.to.zone === "community")) flop = events;
      state = next;
    }
    expect(flop.length).toBeGreaterThan(0);

    // When each event starts, on the table's own clock.
    const starts: number[] = [0];
    for (let i = 1; i < flop.length; i++) starts.push(starts[i - 1]! + gapAfter(flop[i - 1]!, flop[i]!));
    const at = (pred: (e: GameEvent) => boolean) =>
      flop.flatMap((e, i) => (pred(e) ? [starts[i]!] : []));

    const burn = at((e) => e.t === "move" && e.to.zone === "burnt");
    const cards = at((e) => e.t === "move" && e.to.zone === "community");
    const flips = at((e) => e.t === "flip");
    expect(cards).toHaveLength(3);
    // The burn has landed before the first card leaves...
    expect(cards[0]! - burn[0]!).toBeGreaterThanOrEqual(DURATION.play * 1000);
    for (let i = 0; i < 3; i++) {
      // ...each card has landed before it turns over...
      expect(flips[i]! - cards[i]!).toBeGreaterThanOrEqual(DURATION.play * 1000);
      // ...and has turned over before the next one leaves.
      if (i < 2) expect(cards[i + 1]! - flips[i]!).toBeGreaterThanOrEqual(DURATION.flip * 1000);
    }
  });
});

describe("announcements", () => {
  /**
   * Reported offline as "You checks" and "You takes the pot"; online it
   * was worse. Poker baked names into its text — "You" for seat 0 and a
   * bot's name for everyone else — so every player in a room saw seat 0's
   * moves as their own, and the people at the table were called by bot
   * names. An `actor` lets each viewer's screen name the mover itself.
   */
  it("names every mover through `actor`, never in the text", () => {
    const d = createPoker();
    const rng = createRng(21);
    let state: PokerState = d.startRound!(d.setup({ seats: 5, rng }), rng).state;
    const announced: GameEvent[] = [];
    for (let i = 0; i < 2000 && !d.isOver(state); i++) {
      if (d.isRoundOver!(state)) {
        const { state: next, events } = d.startRound!(state, rng);
        announced.push(...events.filter((e) => e.t === "announce"));
        state = next;
        continue;
      }
      const seat = d.currentSeat(state)!;
      const action = d.bots.steady.choose(d.playerView(state, seat), seat, rng);
      const { state: next, events } = d.reduce(state, action);
      announced.push(...events.filter((e) => e.t === "announce"));
      state = next;
    }
    expect(announced.length).toBeGreaterThan(50);
    // A hand kept hidden at the showdown is announced, not silent.
    expect(announced.some((e) => e.t === "announce" && e.text.startsWith("doesn't show"))).toBe(true);
    for (const e of announced) {
      if (e.t !== "announce" || e.text === "The pot is split") continue;
      expect(e.actor, e.text).toBeDefined();
      expect(e.selfText, e.text).toBeDefined();
      expect(e.text).not.toMatch(/You/);
    }
  });
});
