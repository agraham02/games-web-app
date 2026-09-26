import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import type { SeatId } from "@/engine/types";
import { standardDeck } from "@/games/_shared/cards";
import { HIDDEN_CARD, createBs, placements, playerView, reduce, startRound } from "./rules";
import { MAX_PER_PLAY, NO_PROGRESS_LIMIT, pileCardsOf } from "./state";
import type { BsState, PilePlay } from "./types";

const def = createBs();

/** A dealt, mid-round position with every field a test reasons about pinned. */
function fixture(overrides: Partial<BsState> = {}): BsState {
  const base = def.setup({ seats: 4, rng: createRng(7) });
  return {
    ...base,
    round: 1,
    dealer: 3,
    turn: 0,
    dealt: true,
    rank: "A",
    hands: { 0: [], 1: [], 2: [], 3: [] },
    plays: [],
    window: null,
    reveal: null,
    pendingTake: null,
    ...overrides,
  };
}

function play(seat: SeatId, claimed: PilePlay["claimed"], cards: string[]): PilePlay {
  return { seat, claimed, cards };
}

/** Every card the state accounts for — the accounting invariant. */
function allCards(state: BsState): string[] {
  return [...Object.values(state.hands).flat(), ...pileCardsOf(state.plays)].sort();
}

/* ============================================================
   The deal
   ============================================================ */

describe("bs — the deal", () => {
  it("deals the whole deck, unevenly when it has to", () => {
    for (const seats of [2, 3, 4, 5, 6]) {
      const rng = createRng(4);
      let state = def.setup({ seats, rng });
      ({ state } = startRound(state, rng));
      const sizes = Object.values(state.hands).map((h) => h.length);
      expect(sizes.reduce((a, b) => a + b, 0), `${seats} seats`).toBe(52);
      // At most one card between the biggest and smallest hand.
      expect(Math.max(...sizes) - Math.min(...sizes), `${seats} seats`).toBeLessThanOrEqual(1);
      expect(allCards(state)).toEqual([...standardDeck().map((c) => c.id)].sort());
    }
  });

  it("opens on aces, to the dealer's left", () => {
    const rng = createRng(9);
    let state = def.setup({ seats: 4, rng });
    ({ state } = startRound(state, rng));
    expect(state.rank).toBe("A");
    expect(state.turn).toBe((state.dealer + 1) % 4);
    expect(state.round).toBe(1);
  });

  it("parks the undealt deck on the pile, so the deal has somewhere to fly from", () => {
    // The gap poker has and this deliberately does not: `applyEvent`'s
    // `moveTo` is a no-op for a piece the store is not tracking, so a deal
    // whose cards have no prior placement simply appears instead of moving.
    const state = def.setup({ seats: 4, rng: createRng(1) });
    const map = placements(state, 0);
    expect(Object.keys(map)).toHaveLength(52);
    expect(Object.values(map).every((p) => p.zone === "pile")).toBe(true);
  });
});

/* ============================================================
   Playing, and the rank cycle
   ============================================================ */

describe("bs — a play", () => {
  it("puts the cards on the pile and opens a window on every other seat", () => {
    const state = fixture({ hands: { 0: ["SA", "H2", "D3"], 1: ["C4"], 2: ["C5"], 3: ["C6"] } });
    const { state: next } = reduce(state, { t: "play", cards: ["SA"] });

    expect(next.hands[0]).toEqual(["H2", "D3"]);
    expect(next.plays).toHaveLength(1);
    expect(next.plays[0]).toMatchObject({ seat: 0, claimed: "A", cards: ["SA"] });
    expect(next.window?.pending.map((p) => p.seat).sort()).toEqual([1, 2, 3]);
    // The claimer is never entitled to doubt their own claim.
    expect(next.window?.pending.some((p) => p.seat === 0)).toBe(false);
  });

  it("advances the rank and the turn together, and wraps K back to A", () => {
    let state = fixture({
      rank: "K",
      hands: { 0: ["SA"], 1: ["H2"], 2: ["D3"], 3: ["C4"] },
    });
    ({ state } = reduce(state, { t: "play", cards: ["SA"] }));
    expect(state.plays[0]!.claimed).toBe("K");
    expect(state.rank).toBe("A");
    expect(state.turn).toBe(1);
  });

  it("advances the rank even when the play is caught, because the rank was spent", () => {
    let state = fixture({
      rank: "7",
      hands: { 0: ["SA"], 1: ["H2"], 2: ["D3"], 3: ["C4"] },
    });
    ({ state } = reduce(state, { t: "play", cards: ["SA"] }));
    ({ state } = reduce(state, { t: "callBs", seat: 1 }));
    ({ state } = reduce(state, { t: "takePile", seat: 0 }));
    expect(state.rank).toBe("8");
    // Play continues in order: seat 1 was next before the call and still is.
    expect(state.turn).toBe(1);
  });

  it("is challengeable even when it empties the hand", () => {
    let state = fixture({ hands: { 0: ["SA"], 1: ["H2"], 2: ["D3"], 3: ["C4"] } });
    ({ state } = reduce(state, { t: "play", cards: ["SA"] }));
    expect(state.hands[0]).toEqual([]);
    // Not out yet — going out is only confirmed once the window closes.
    expect(state.result).toBeNull();
    expect(state.window).not.toBeNull();
  });
});

/* ============================================================
   The challenge window — a race, not a queue
   ============================================================ */

describe("bs — the challenge window", () => {
  const raced = () => {
    const state = fixture({
      hands: { 0: ["SA", "H2"], 1: ["D3"], 2: ["C4"], 3: ["C5"] },
    });
    return reduce(state, { t: "play", cards: ["H2"] }).state; // a lie: H2 claimed as an ace
  };

  it("entitles every pending seat, not just the one currentSeat names", () => {
    const state = raced();
    const pacing = def.currentSeat(state)!;
    for (const seat of [1, 2, 3] as SeatId[]) {
      expect(def.legalActions(state, seat).length, `seat ${seat}`).toBeGreaterThan(0);
      expect(def.validate!(state, seat, { t: "callBs", seat }), `seat ${seat}`).toBeNull();
    }
    // The point of the whole arrangement: a seat further down the list is
    // just as entitled as the one the pacing happens to be waiting on.
    const slowest = state.window!.pending[state.window!.pending.length - 1]!.seat;
    expect(slowest).not.toBe(pacing);
    expect(def.validate!(state, slowest, { t: "callBs", seat: slowest })).toBeNull();
  });

  it("lets a seat go and moves on to the next, closing when the list empties", () => {
    let state = raced();
    const order = state.window!.pending.map((p) => p.seat);
    ({ state } = reduce(state, { t: "declineBs", seat: order[0]! }));
    expect(state.window!.pending.map((p) => p.seat)).toEqual(order.slice(1));
    expect(def.currentSeat(state)).toBe(order[1]);
    ({ state } = reduce(state, { t: "declineBs", seat: order[1]! }));
    ({ state } = reduce(state, { t: "declineBs", seat: order[2]! }));
    expect(state.window).toBeNull();
    // The play stood. The lie is on the pile and nobody will ever know.
    expect(pileCardsOf(state.plays)).toEqual(["H2"]);
  });

  it("refuses a seat that has already let it go", () => {
    let state = raced();
    const seat = state.window!.pending[1]!.seat;
    ({ state } = reduce(state, { t: "declineBs", seat }));
    expect(def.validate!(state, seat, { t: "callBs", seat })).not.toBeNull();
    expect(def.legalActions(state, seat)).toEqual([]);
  });

  it("orders the race by a seeded reaction time, so a seed replays it", () => {
    const state = raced();
    const again = raced();
    expect(state.window!.pending).toEqual(again.window!.pending);
    const times = state.window!.pending.map((p) => p.ms);
    expect([...times]).toEqual([...times].sort((a, b) => a - b));
  });

  it("lets nobody play while a window is open, the seat on turn included", () => {
    // The user's rule: only BS or Let it go while a play can be challenged.
    // The seat on turn used to be able to play over the top of the window.
    const state = raced();
    expect(state.turn).toBe(1);
    expect(def.legalActions(state, 1).map((a) => a.t).sort()).toEqual(["callBs", "declineBs"]);
    expect(def.validate!(state, 1, { t: "play", cards: ["D3"] })).not.toBeNull();
    expect(reduce(state, { t: "play", cards: ["D3"] }).state.plays).toHaveLength(1);
  });
});

/* ============================================================
   Calling it
   ============================================================ */

describe("bs — calling BS", () => {
  it("sends the pile to a caught liar", () => {
    let state = fixture({
      hands: { 0: ["H2"], 1: ["D3"], 2: ["C4"], 3: ["C5"] },
      plays: [play(3, "K", ["SK", "H7"])],
    });
    ({ state } = reduce(state, { t: "play", cards: ["H2"] })); // H2 as an ace
    ({ state } = reduce(state, { t: "callBs", seat: 2 }));

    expect(state.reveal).toMatchObject({
      truthful: false,
      claimer: 0,
      caller: 2,
      loser: 0,
      cards: ["H2"],
      pile: 3,
    });
    expect(state.pendingTake).toBe(0);
    // Nothing has moved yet: the cards are face up for everyone to read.
    expect(pileCardsOf(state.plays)).toHaveLength(3);

    ({ state } = reduce(state, { t: "takePile", seat: 0 }));
    expect(state.hands[0]!.sort()).toEqual(["H2", "H7", "SK"]);
    expect(state.plays).toEqual([]);
    expect(state.pendingTake).toBeNull();
  });

  it("sends the pile to whoever called a true claim wrong", () => {
    let state = fixture({
      hands: { 0: ["SA", "H2"], 1: ["D3"], 2: ["C4"], 3: ["C5"] },
      plays: [play(3, "K", ["SK"])],
    });
    ({ state } = reduce(state, { t: "play", cards: ["SA"] })); // honest
    ({ state } = reduce(state, { t: "callBs", seat: 1 }));
    expect(state.reveal).toMatchObject({ truthful: true, loser: 1 });

    ({ state } = reduce(state, { t: "takePile", seat: 1 }));
    expect(state.hands[1]!.sort()).toEqual(["D3", "SA", "SK"]);
  });

  it("counts a claim padded with junk as a lie", () => {
    let state = fixture({
      rank: "7",
      hands: { 0: ["H7", "D7", "C2"], 1: ["D3"], 2: ["C4"], 3: ["C5"] },
    });
    ({ state } = reduce(state, { t: "play", cards: ["H7", "D7", "C2"] }));
    ({ state } = reduce(state, { t: "callBs", seat: 1 }));
    expect(state.reveal!.truthful).toBe(false);
    expect(state.reveal!.loser).toBe(0);
  });

  it("turns the revealed cards face up for everyone, spectator included", () => {
    // The half that is easy to get wrong: `placements` is the authority for
    // facing, so if the settled position said these were face down the
    // redaction layer would send them out as anonymous backs and the reveal
    // would be blank cards. See `redact.ts`.
    let state = fixture({ hands: { 0: ["H2"], 1: ["D3"], 2: ["C4"], 3: ["C5"] } });
    ({ state } = reduce(state, { t: "play", cards: ["H2"] }));
    ({ state } = reduce(state, { t: "callBs", seat: 2 }));

    for (const viewer of [0, 1, 2, 3, -1] as SeatId[]) {
      const map = placements(state, viewer);
      expect(map["H2"], `viewer ${viewer}`).toMatchObject({ zone: "reveal", faceUp: true });
    }
  });

  it("gives a going-out player the round when the call against them fails", () => {
    let state = fixture({
      hands: { 0: ["SA"], 1: ["D3"], 2: ["C4"], 3: ["C5"] },
      plays: [play(3, "K", ["SK"])],
    });
    ({ state } = reduce(state, { t: "play", cards: ["SA"] })); // last card, honest
    ({ state } = reduce(state, { t: "callBs", seat: 1 }));
    expect(state.result).toBeNull(); // the pile has to move first
    ({ state } = reduce(state, { t: "takePile", seat: 1 }));
    expect(state.result).toMatchObject({ wentOut: 0, winner: 0, blocked: false });
    expect(state.scores[0]).toBe(1);
  });

  it("puts a going-out player back in the game when the call lands", () => {
    let state = fixture({
      hands: { 0: ["H2"], 1: ["D3"], 2: ["C4"], 3: ["C5"] },
      plays: [play(3, "K", ["SK"])],
    });
    ({ state } = reduce(state, { t: "play", cards: ["H2"] })); // last card, a lie
    ({ state } = reduce(state, { t: "callBs", seat: 1 }));
    ({ state } = reduce(state, { t: "takePile", seat: 0 }));
    expect(state.result).toBeNull();
    expect(state.hands[0]).toHaveLength(2);
  });
});

/* ============================================================
   What a seat is allowed to know
   ============================================================ */

describe("bs — playerView", () => {
  const dealt = () => {
    const rng = createRng(3);
    let state = def.setup({ seats: 4, rng });
    ({ state } = startRound(state, rng));
    ({ state } = reduce(state, { t: "play", cards: [state.hands[state.turn]![0]!] }));
    return state;
  };

  it("hides every hand but the viewer's", () => {
    const state = dealt();
    const view = playerView(state, 2);
    expect(view.hands[2]).toEqual(state.hands[2]);
    for (const seat of [0, 1, 3] as SeatId[]) {
      expect(view.hands[seat], `seat ${seat}`).toEqual(state.hands[seat]!.map(() => HIDDEN_CARD));
    }
  });

  it("hides the pile from everyone, its own contributor included", () => {
    // Poker shipped `deck` and Rummy shipped `stock` intact for the same
    // reason: single-player never sends a view anywhere, so nothing noticed.
    // Here the pile is a list of every card played so far, in order.
    //
    // No exception for the player who put them there, even though they
    // obviously know. The rule is blunt on purpose — face down means the
    // identity does not travel — and `redact.test.ts` enforces it across
    // every game, which is how the exception this used to make was caught.
    const state = dealt();
    for (const viewer of [0, 1, 2, 3, -1] as SeatId[]) {
      const view = playerView(state, viewer);
      expect(view.plays[0]!.cards, `viewer ${viewer}`)
        .toEqual(state.plays[0]!.cards.map(() => HIDDEN_CARD));
    }
  });

  it("keeps what a person at a table would have heard", () => {
    const state = dealt();
    const view = playerView(state, (state.plays[0]!.seat + 1) % 4 as SeatId);
    expect(view.plays[0]!.claimed).toBe(state.plays[0]!.claimed);
    expect(view.plays[0]!.cards).toHaveLength(state.plays[0]!.cards.length);
    expect(view.window!.pending).toEqual(state.window!.pending);
    expect(view.rank).toBe(state.rank);
  });

  it("keeps revealed cards identified for everyone, because everyone saw them", () => {
    let state = fixture({ hands: { 0: ["H2"], 1: ["D3"], 2: ["C4"], 3: ["C5"] } });
    ({ state } = reduce(state, { t: "play", cards: ["H2"] }));
    ({ state } = reduce(state, { t: "callBs", seat: 3 }));
    for (const viewer of [0, 1, 2, 3, -1] as SeatId[]) {
      expect(playerView(state, viewer).plays[0]!.cards, `viewer ${viewer}`).toEqual(["H2"]);
    }
  });
});

/* ============================================================
   The action gate
   ============================================================ */

describe("bs — validate", () => {
  const mid = () => {
    const state = fixture({
      hands: { 0: ["SA", "H2", "D3", "C4", "S5"], 1: ["HK"], 2: ["DQ"], 3: ["CJ"] },
    });
    return state;
  };

  it("refuses more cards than a rank can hold", () => {
    const state = mid();
    expect(def.validate!(state, 0, { t: "play", cards: ["SA", "H2", "D3", "C4", "S5"] }))
      .toBe("a play is 1 to " + MAX_PER_PLAY + " cards");
    expect(def.validate!(state, 0, { t: "play", cards: [] })).not.toBeNull();
  });

  it("refuses a card sitting in somebody else's hand", () => {
    // Ids are suit+rank and entirely guessable, so this is reachable from a
    // socket by a player whose turn it genuinely is.
    expect(def.validate!(mid(), 0, { t: "play", cards: ["HK"] }))
      .toBe("a card this seat does not hold");
  });

  it("refuses the same card named twice to fake a pair", () => {
    expect(def.validate!(mid(), 0, { t: "play", cards: ["SA", "SA"] }))
      .toBe("the same card twice");
  });

  it("refuses an action that is not an object, rather than throwing on it", () => {
    // The wire hands `action` through untouched, so `{"t":"action"}` with no
    // action at all arrives here as `undefined` - and reading `.t` off it
    // threw, which the router turned into a generic `bad-message` and a log
    // line per attempt. A refusal is an answer; an exception is not.
    const state = mid();
    for (const bad of [undefined, null, "play", 7, true]) {
      expect(() => def.validate!(state, 0, bad as never)).not.toThrow();
      expect(def.validate!(state, 0, bad as never)).not.toBeNull();
    }
  });

  it("refuses a malformed payload without believing any of it", () => {
    const state = mid();
    expect(def.validate!(state, 0, { t: "play", cards: "SA" as never })).toBe("cards must be an array");
    expect(def.validate!(state, 0, { t: "play", cards: [7 as never] })).toBe("card ids must be strings");
    expect(def.validate!(state, 0, { t: "nope" } as never)).toBe("unknown action");
  });

  it("refuses a play out of turn, and a call from outside the window", () => {
    const state = mid();
    expect(def.validate!(state, 1, { t: "play", cards: ["HK"] })).toBe("not this seat's turn to play");
    expect(def.validate!(state, 1, { t: "callBs", seat: 1 }))
      .toBe("this seat is not in the challenge window");
  });

  it("stamps the acting seat over whatever the client claimed", () => {
    const state = mid();
    expect(def.completeAction!(state, { t: "callBs", seat: 3 }, 2, createRng(1)))
      .toEqual({ t: "callBs", seat: 2 });
    expect(def.completeAction!(state, { t: "play", cards: ["SA"] }, 0, createRng(1)))
      .toEqual({ t: "play", cards: ["SA"] });
  });
});

/* ============================================================
   Keeping the table moving
   ============================================================ */

describe("bs — deadline and turnHold", () => {
  const windowed = () => {
    const state = fixture({ hands: { 0: ["H2"], 1: ["D3"], 2: ["C4"], 3: ["C5"] } });
    return reduce(state, { t: "play", cards: ["H2"] }).state;
  };

  it("acts FOR a silent seat, and the action is a pass rather than a call", () => {
    // The engine must never call BS on a person's behalf: silence means you
    // let it go. Rummy's claim deadline passes for the same reason.
    const state = windowed();
    const seat = def.currentSeat(state)!;
    const due = def.deadline!(state, seat);
    expect(due!.action).toEqual({ t: "declineBs", seat });
    expect(due!.ms).toBe(state.windowMs + 900);
  });

  it("waits longer than the ring the player is watching", () => {
    const state = windowed();
    const seat = def.currentSeat(state)!;
    // Deliberately not tuned to fire together — a client whose tab is
    // backgrounded has its timers throttled to about one a minute, and if
    // the two agreed, a buzzer-beater call would be decided by latency.
    expect(def.deadline!(state, seat)!.ms).toBeGreaterThan(state.windowMs);
  });

  it("picks the pile up for a player who has nothing to decide", () => {
    let state = windowed();
    ({ state } = reduce(state, { t: "callBs", seat: 2 }));
    expect(def.currentSeat(state)).toBe(0);
    expect(def.deadline!(state, 0)).toEqual({ ms: 1400, action: { t: "takePile", seat: 0 } });
  });

  it("waits each bot's own reaction time inside a window, and leaves every other beat alone", () => {
    const state = windowed();
    const [a, b] = state.window!.pending;
    // The first seat waits its whole reaction time...
    expect(def.turnHold!(state, a!.seat)).toBe(Math.max(120, a!.ms));
    // ...and the next only the rest of its own once the first let it go,
    // so a window costs its longest reaction time, not the sum of them.
    const after = reduce(state, { t: "declineBs", seat: a!.seat }).state;
    expect(after.window!.elapsed).toBe(a!.ms);
    expect(def.turnHold!(after, b!.seat)).toBe(Math.max(120, b!.ms - a!.ms));
    const settled = fixture({ hands: { 0: ["SA"], 1: ["H2"], 2: ["D3"], 3: ["C4"] } });
    expect(def.turnHold!(settled, 0)).toBeUndefined();
  });

  it("never parks the table on nobody while there is a round to play", () => {
    // The stall this shape is most prone to: a window whose pending list has
    // emptied, or a reveal nobody is asked to clear up. Seat 0 keeps a card
    // back so the round does not simply end under the test.
    let state = fixture({ hands: { 0: ["H2", "S9"], 1: ["D3"], 2: ["C4"], 3: ["C5"] } });
    ({ state } = reduce(state, { t: "play", cards: ["H2"] }));
    expect(def.currentSeat(state)).not.toBeNull();
    for (const seat of state.window!.pending.map((p) => p.seat)) {
      ({ state } = reduce(state, { t: "declineBs", seat }));
      if (state.result === null) expect(def.currentSeat(state)).not.toBeNull();
    }
    expect(def.currentSeat(state)).toBe(state.turn);
  });
});

/* ============================================================
   Whole matches
   ============================================================ */

/**
 * Counters for the REACHABILITY suite below. Correctness tests cannot see
 * a feature that never happens — Rummy's claim window shipped dead at
 * exactly zero windows in 453 rounds and was reported twice as a missing
 * button before anybody measured it.
 */
interface Tally {
  plays: number;
  lies: number;
  calls: number;
  caught: number;
  survived: number;
  wrongly: number;
  goingOutCalled: number;
  blocked: number;
}

function tally(): Tally {
  return {
    plays: 0,
    lies: 0,
    calls: 0,
    caught: 0,
    survived: 0,
    wrongly: 0,
    goingOutCalled: 0,
    blocked: 0,
  };
}

function runMatch(
  seed: number,
  seats: number,
  tier: "casual" | "steady" | "sharp" = "steady",
  into: Tally = tally(),
  guard = 20_000,
) {
  const game = createBs({ target: 2 });
  const rng = createRng(seed);
  let state = game.setup({ seats, rng });
  ({ state } = startRound(state, rng));
  const where = `seed ${seed}/${seats}/${tier}`;

  let steps = 0;
  while (!game.isOver(state) && steps++ < guard) {
    if (game.isRoundOver!(state)) {
      ({ state } = startRound(state, rng));
      continue;
    }
    const seat = game.currentSeat(state);
    expect(seat, `${where}: nobody to act at step ${steps}`).not.toBeNull();

    const legal = game.legalActions(state, seat!);
    expect(legal.length, `${where}: no legal action for seat ${seat}`).toBeGreaterThan(0);

    // Unlike Rummy's claim window, BS's is driven by bots as well as people
    // — every seat gets a turn in it — so the bot answers here exactly as it
    // does in the real runtime.
    const action = game.bots[tier].choose(game.playerView(state, seat!), seat!, rng);
    expect(game.validate!(state, seat!, action), `${where}: refused ${JSON.stringify(action)}`)
      .toBeNull();

    const before = state;
    const goingOut = before.window !== null && (() => {
      const live = before.plays[before.window.play];
      return live !== undefined && (before.hands[live.seat] ?? []).length === 0;
    })();

    ({ state } = game.reduce(state, action));
    expect(state, `${where}: ${JSON.stringify(action)} was a no-op`).not.toBe(before);

    if (action.t === "play") {
      into.plays++;
      const laid = state.plays[state.plays.length - 1]!;
      if (laid.cards.some((id) => id[0] !== undefined && id.slice(1) !== laid.claimed)) into.lies++;
    }
    if (action.t === "callBs") {
      into.calls++;
      if (goingOut) into.goingOutCalled++;
      if (state.reveal!.truthful) into.wrongly++;
      else into.caught++;
    }
    if (action.t === "declineBs" && state.window === null && before.window!.pending.length === 1) {
      const live = before.plays[before.window!.play]!;
      if (live.cards.some((id) => id.slice(1) !== live.claimed)) into.survived++;
    }
    if (state.result?.blocked) into.blocked++;

    // 52 distinct ids across every hand and the pile is exactly "the deck is
    // intact", and it is cheap enough to assert on every single step.
    const cards = allCards(state);
    expect(cards.length, `${where}: a card went missing`).toBe(52);
    expect(new Set(cards).size, `${where}: a card was duplicated`).toBe(52);
    for (const hand of Object.values(state.hands)) {
      expect(hand, `${where}: a stand-in leaked into real state`).not.toContain(HIDDEN_CARD);
    }
    expect(pileCardsOf(state.plays).length, `${where}: pile exceeded the deck`)
      .toBeLessThanOrEqual(52);
  }
  expect(game.isOver(state), `${where}: never finished in ${guard} steps`).toBe(true);
  return state;
}

describe("bs — full-match simulation invariants", () => {
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

  it("sweeps 120 seeds end to end", { timeout: 120_000 }, () => {
    for (let seed = 1; seed <= 120; seed++) runMatch(seed, 2 + (seed % 5));
  });

  it("ends a round that genuinely cannot progress", () => {
    // A table where everybody is caught every time can cycle forever: the
    // only thing that removes cards from hands is a play that SURVIVES, and
    // a challenge puts every one of them straight back. Driven here by
    // calling BS on every single play, which is legal and which no bot does.
    const game = createBs({ target: 1 });
    const rng = createRng(5);
    let state = game.setup({ seats: 4, rng });
    ({ state } = startRound(state, rng));
    let steps = 0;
    while (!game.isOver(state) && steps++ < 5000) {
      const seat = game.currentSeat(state)!;
      const legal = game.legalActions(state, seat);
      // Prefer a call, then a take, then the smallest play.
      const action = legal.find((a) => a.t === "callBs") ?? legal[0]!;
      ({ state } = game.reduce(state, action));
    }
    expect(game.isOver(state)).toBe(true);
    expect(state.result?.blocked, "the backstop should be what ended it").toBe(true);
    expect(state.noProgressStreak).toBeGreaterThanOrEqual(NO_PROGRESS_LIMIT);
  });
});
