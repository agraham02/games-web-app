import { createRng } from "@/engine/rng";
import { describe, expect, it } from "vitest";
import { deckIds, parseCard, points } from "./cards";
import { createChromaly } from "./rules";
import { act, everyCard, position } from "./testkit";

/**
 * Every ruling in the plan (docs: "rulings for rule interactions") is a named
 * test here, so a change that moves one has to say so. Positions are exact:
 * `position()` deals precisely these hands and the draw pile follows `draw`.
 */

const TOP = "R5.1";

describe("setting up and dealing", () => {
  it("deals seven to each seat and turns up a NUMBER card, whatever the seed", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const def = createChromaly();
      const rng = createRng(seed);
      const seats = 2 + (seed % 9);
      const { state } = def.startRound!(def.setup({ seats, rng }), rng);
      for (let s = 0; s < seats; s++) expect(state.hands[s]).toHaveLength(7);
      expect(parseCard(state.discard[0]!)?.kind).toBe("number");
      expect(everyCard(state)).toHaveLength(108);
      expect(state.color).toBe(parseCard(state.discard[0]!)!.color);
      expect(state.turn).toBe((state.dealer + 1) % seats);
    }
  });

  it("adds one card with Shuffle Hands", () => {
    const def = createChromaly({ shuffleHands: true });
    const rng = createRng(3);
    const { state } = def.startRound!(def.setup({ seats: 4, rng }), rng);
    expect(everyCard(state)).toHaveLength(109);
  });

  it("rotates the dealer each round", () => {
    const def = createChromaly();
    const rng = createRng(5);
    const first = def.startRound!(def.setup({ seats: 4, rng }), rng).state;
    const second = def.startRound!({ ...first, result: null }, rng).state;
    expect(second.dealer).toBe((first.dealer + 1) % 4);
  });

  it("places the whole deck on the draw pile before the first deal, for the deal to fly out of", () => {
    const def = createChromaly();
    const state = def.setup({ seats: 4, rng: createRng(1) });
    const placed = def.placements(state, 0);
    expect(Object.keys(placed)).toHaveLength(108);
    expect(Object.values(placed).every((p) => p.zone === "deck")).toBe(true);
  });
});

describe("playing a card", () => {
  const { def, state } = position({
    hands: { 0: ["R3.1", "B5.2", "G9.1", "W.1"], 1: ["Y1.1"], 2: ["Y2.1"], 3: ["Y3.1"] },
    top: TOP,
  });

  it("matches on colour", () => {
    const r = act(def, state, 0, { t: "play", cards: ["R3.1"] });
    expect(r.state.discard.at(-1)).toBe("R3.1");
    expect(r.state.turn).toBe(1);
    expect(r.state.color).toBe("R");
  });

  it("matches on number, and the colour in force follows the card", () => {
    const r = act(def, state, 0, { t: "play", cards: ["B5.2"] });
    expect(r.state.color).toBe("B");
  });

  it("refuses a card that matches neither", () => {
    expect(def.validate!(state, 0, { t: "play", cards: ["G9.1"] })).toMatch(/cannot be played/);
  });

  it("makes a wild name its colour, and takes it", () => {
    expect(def.validate!(state, 0, { t: "play", cards: ["W.1"] })).toMatch(/colour/);
    const r = act(def, state, 0, { t: "play", cards: ["W.1"], color: "G" });
    expect(r.state.color).toBe("G");
  });

  it("refuses a colour on a card that takes none", () => {
    expect(def.validate!(state, 0, { t: "play", cards: ["R3.1"], color: "B" })).toMatch(/only a wild/);
  });

  it("refuses a card the seat does not hold, and a card named twice", () => {
    expect(def.validate!(state, 0, { t: "play", cards: ["Y1.1"] })).toMatch(/does not hold/);
    expect(def.validate!(state, 0, { t: "play", cards: ["R3.1", "R3.1"] })).toMatch(/twice/);
  });

  it("refuses a play out of turn, and malformed input", () => {
    expect(def.validate!(state, 1, { t: "play", cards: ["Y1.1"] })).toMatch(/turn/);
    expect(def.validate!(state, 0, undefined as never)).toMatch(/not an action/);
    expect(def.validate!(state, 0, { t: "play", cards: "R3.1" as never })).toMatch(/array/);
    expect(def.validate!(state, 0, { t: "nope" } as never)).toMatch(/unknown/);
  });

  it("stamps the real seat onto a call, whatever a client sent", () => {
    const stamped = def.completeAction!(state, { t: "callLast", seat: 3 }, 1, createRng(1));
    expect(stamped).toEqual({ t: "callLast", seat: 1 });
  });
});

describe("drawing", () => {
  it("may be chosen even while holding a playable card", () => {
    const { def, state } = position({ hands: { 0: ["R3.1", "B1.1"] }, top: TOP, draw: ["G1.1"] });
    const kinds = def.legalActions(state, 0).map((a) => a.t);
    expect(kinds).toContain("draw");
    expect(kinds).toContain("play");
  });

  it("takes one card, and the turn passes if it cannot be played", () => {
    const { def, state } = position({ hands: { 0: ["B1.1"] }, top: TOP, draw: ["G1.1", "G2.1"] });
    const r = act(def, state, 0, { t: "draw" });
    expect(r.state.hands[0]).toEqual(["B1.1", "G1.1"]);
    expect(r.state.turn).toBe(1);
    expect(r.state.drawn).toBeNull();
  });

  it("offers a drawn card that can be played: play it or keep it, and nothing else", () => {
    const { def, state } = position({ hands: { 0: ["B1.1", "B2.1"] }, top: TOP, draw: ["R9.1"] });
    const drew = act(def, state, 0, { t: "draw" });
    expect(drew.state.drawn).toBe("R9.1");
    expect(drew.state.turn).toBe(0);
    expect(def.validate!(drew.state, 0, { t: "play", cards: ["B1.1"] })).toMatch(/only the card just drawn/);
    expect(def.validate!(drew.state, 0, { t: "draw" })).toMatch(/already/);
    const kept = act(def, drew.state, 0, { t: "keep" });
    expect(kept.state.turn).toBe(1);
    expect(kept.state.hands[0]).toContain("R9.1");
    const played = act(def, drew.state, 0, { t: "play", cards: ["R9.1"] });
    expect(played.state.discard.at(-1)).toBe("R9.1");
  });

  it("rebuilds the draw pile from the discard, keeping the top card showing", () => {
    const { def, state } = position({ hands: { 0: ["B1.1"] }, top: TOP, draw: [] });
    const lean = {
      ...state,
      drawPile: [],
      discard: ["G1.1", "G2.1", "G3.1", "Y4.1", TOP],
    };
    const r = act(def, lean, 0, { t: "draw" });
    expect(r.state.discard).toEqual([TOP]);
    expect(r.state.hands[0]).toHaveLength(2);
    expect(r.state.drawPile).toHaveLength(3);
    expect(r.events.some((e) => e.t === "shuffle")).toBe(true);
    expect(everyCard(r.state)).toHaveLength(everyCard(lean).length);
  });

  it("does not let the rebuilt order be worked out from the public discard", () => {
    const { def, state } = position({ hands: { 0: ["B1.1"] }, top: TOP });
    const lean = { ...state, drawPile: [], discard: ["G1.1", "G2.1", "G3.1", "Y4.1", "Y5.1", "Y6.1", TOP] };
    const a = act(def, lean, 0, { t: "draw" }).state.drawPile;
    const b = act(def, { ...lean, secret: lean.secret + 1 }, 0, { t: "draw" }).state.drawPile;
    expect(a).not.toEqual(b);
  });
});

describe("action cards", () => {
  it("Skip jumps the next seat", () => {
    const { def, state } = position({ hands: { 0: ["RS.1", "B1.1"] }, top: TOP });
    const r = act(def, state, 0, { t: "play", cards: ["RS.1"] });
    expect(r.state.turn).toBe(2);
  });

  it("Reverse turns play round", () => {
    const { def, state } = position({ hands: { 0: ["RV.1", "B1.1"] }, top: TOP });
    const r = act(def, state, 0, { t: "play", cards: ["RV.1"] });
    expect(r.state.direction).toBe(-1);
    expect(r.state.turn).toBe(3);
  });

  it("with two players, Reverse is a Skip: you go again", () => {
    const { def, state } = position({ seats: 2, hands: { 0: ["RV.1", "B1.1"], 1: ["Y1.1"] }, top: TOP });
    const r = act(def, state, 0, { t: "play", cards: ["RV.1"] });
    expect(r.state.turn).toBe(0);
  });

  it("with two players, a Skip is the same: you go again", () => {
    const { def, state } = position({ seats: 2, hands: { 0: ["RS.1", "B1.1"], 1: ["Y1.1"] }, top: TOP });
    expect(act(def, state, 0, { t: "play", cards: ["RS.1"] }).state.turn).toBe(0);
  });

  it("Draw 2 makes the next seat draw two and lose its turn", () => {
    const { def, state } = position({
      hands: { 0: ["RD.1", "B1.1"], 1: ["Y1.1"] },
      top: TOP,
      draw: ["G1.1", "G2.1"],
    });
    const r = act(def, state, 0, { t: "play", cards: ["RD.1"] });
    expect(r.state.hands[1]).toEqual(["Y1.1", "G1.1", "G2.1"]);
    expect(r.state.turn).toBe(2);
  });
});

describe("Wild +4", () => {
  const bluffer = {
    hands: { 0: ["F.1", "R2.1", "B1.1"], 1: ["Y1.1"] },
    top: TOP,
    draw: ["G1.1", "G2.1", "G3.1", "G4.1", "G5.1", "G6.1"],
  };
  const honest = {
    hands: { 0: ["F.1", "B1.1", "W.1", "R2.1".replace("R", "B")], 1: ["Y1.1"] },
    top: TOP,
    draw: ["G1.1", "G2.1", "G3.1", "G4.1", "G5.1", "G6.1"],
  };

  it("is a bluff if the seat held the colour in force - and the verdict is hidden from everyone", () => {
    const { def, state } = position(bluffer);
    const r = act(def, state, 0, { t: "play", cards: ["F.1"], color: "G" });
    expect(r.state.challenge).toMatchObject({ offender: 0, onColor: "R", amount: 4, guilty: true });
    expect(r.state.turn).toBe(1);
    expect(def.playerView(r.state, 1).challenge?.guilty).toBe(false);
    expect(def.playerView(r.state, 2).challenge?.guilty).toBe(false);
  });

  it("counts only a card of the COLOUR: a matching number or a wild does not make it a bluff", () => {
    // Holding a Blue 5 on a red 5 (a number match), and a wild: still honest.
    const { def, state } = position({ ...honest, hands: { 0: ["F.1", "B5.2", "W.1"], 1: ["Y1.1"] } });
    const r = act(def, state, 0, { t: "play", cards: ["F.1"], color: "G" });
    expect(r.state.challenge?.guilty).toBe(false);
  });

  it("guilty: the player draws four instead, and the challenger plays on", () => {
    const { def, state } = position(bluffer);
    const played = act(def, state, 0, { t: "play", cards: ["F.1"], color: "G" }).state;
    const r = act(def, played, 1, { t: "challenge" });
    expect(r.state.hands[0]).toHaveLength(2 + 4);
    expect(r.state.hands[1]).toEqual(["Y1.1"]);
    expect(r.state.turn).toBe(1);
    expect(r.state.color).toBe("G");
    expect(r.events.some((e) => e.t === "cue" && e.kind === "bluff")).toBe(true);
  });

  it("clean: the challenger draws six and loses the turn", () => {
    const { def, state } = position(honest);
    const played = act(def, state, 0, { t: "play", cards: ["F.1"], color: "G" }).state;
    const r = act(def, played, 1, { t: "challenge" });
    expect(r.state.hands[1]).toHaveLength(1 + 6);
    expect(r.state.turn).toBe(2);
    expect(r.state.color).toBe("G");
    expect(r.events.some((e) => e.t === "cue" && e.kind === "clean")).toBe(true);
  });

  it("taken: the victim draws four and loses the turn", () => {
    const { def, state } = position(bluffer);
    const played = act(def, state, 0, { t: "play", cards: ["F.1"], color: "G" }).state;
    const r = act(def, played, 1, { t: "acceptPenalty" });
    expect(r.state.hands[1]).toHaveLength(1 + 4);
    expect(r.state.turn).toBe(2);
    expect(r.state.challenge).toBeNull();
  });

  it("while a +4 is open the victim can only challenge or take it", () => {
    const { def, state } = position(bluffer);
    const played = act(def, state, 0, { t: "play", cards: ["F.1"], color: "G" }).state;
    const kinds = def.legalActions(played, 1).map((a) => a.t).sort();
    expect(kinds).toEqual(["acceptPenalty", "challenge"]);
    expect(def.validate!(played, 1, { t: "draw" })).toMatch(/penalty/);
  });

  it("No Bluffing: playable any time, drawn at once, and nothing to challenge", () => {
    const { def, state } = position({ ...bluffer, rules: { plusFour: "free" } });
    const r = act(def, state, 0, { t: "play", cards: ["F.1"], color: "G" });
    expect(r.state.challenge).toBeNull();
    expect(r.state.hands[1]).toHaveLength(1 + 4);
    expect(r.state.turn).toBe(2);
  });

  it("Honest only: refused while holding the colour, allowed without", () => {
    const rules = { plusFour: "honest" as const };
    const bad = position({ ...bluffer, rules });
    expect(bad.def.validate!(bad.state, 0, { t: "play", cards: ["F.1"], color: "G" })).toMatch(/cannot be played/);
    expect(bad.def.legalActions(bad.state, 0).some((a) => a.t === "play" && a.cards[0] === "F.1")).toBe(false);
    const good = position({ ...honest, rules });
    expect(act(good.def, good.state, 0, { t: "play", cards: ["F.1"], color: "G" }).state.challenge).toBeNull();
  });
});

describe("calling the last card", () => {
  const twoLeft = { hands: { 0: ["R3.1", "R4.1"], 1: ["R9.1", "Y2.1"], 2: ["Y3.1"], 3: ["Y4.1"] }, top: TOP };

  it("opens a window when a seat reaches one card without calling", () => {
    const { def, state } = position(twoLeft);
    const r = act(def, state, 0, { t: "play", cards: ["R3.1"] });
    expect(r.state.window?.offenders).toEqual([0]);
    // Everyone is in the race, the seat itself included.
    expect(r.state.window?.pending.map((p) => p.seat).sort()).toEqual([0, 1, 2, 3]);
  });

  it("a pre-call on two cards, then the play, opens nothing", () => {
    const { def, state } = position(twoLeft);
    const called = act(def, state, 0, { t: "callLast", seat: 0 });
    expect(called.state.calls[0]).toBe("called");
    expect(act(def, called.state, 0, { t: "play", cards: ["R3.1"] }).state.window).toBeNull();
  });

  it("a bot's call rides on its play", () => {
    const { def, state } = position(twoLeft);
    const r = act(def, state, 0, { t: "play", cards: ["R3.1"], call: true });
    expect(r.state.window).toBeNull();
    expect(r.state.calls[0]).toBe("called");
  });

  it("is offered on two cards, on or off turn, and never on three", () => {
    const { def, state } = position(twoLeft);
    expect(def.legalActions(state, 1).map((a) => a.t)).toEqual(["callLast"]);
    const three = position({ ...twoLeft, hands: { ...twoLeft.hands, 1: ["Y1.1", "Y2.1", "Y5.1"] } });
    expect(three.def.legalActions(three.state, 1)).toEqual([]);
    expect(three.def.validate!(three.state, 1, { t: "callLast", seat: 1 })).toMatch(/two cards/);
  });

  it("catching: anyone else's call makes the seat draw two", () => {
    const { def, state } = position({ ...twoLeft, draw: ["G1.1", "G2.1"] });
    const opened = act(def, state, 0, { t: "play", cards: ["R3.1"] }).state;
    const r = act(def, opened, 2, { t: "callLast", seat: 2 });
    expect(r.state.hands[0]).toHaveLength(1 + 2);
    expect(r.state.window).toBeNull();
    expect(r.events.some((e) => e.t === "cue" && e.kind === "caught")).toBe(true);
  });

  it("saving: the seat's own call before anyone else's costs nothing", () => {
    const { def, state } = position(twoLeft);
    const opened = act(def, state, 0, { t: "play", cards: ["R3.1"] }).state;
    const r = act(def, opened, 0, { t: "callLast", seat: 0 });
    expect(r.state.hands[0]).toHaveLength(1);
    expect(r.state.calls[0]).toBe("called");
    expect(r.state.window).toBeNull();
  });

  it("getting away with it is final: the window closing makes a seat safe, and it is not reopened", () => {
    const { def, state } = position(twoLeft);
    const opened = act(def, state, 0, { t: "play", cards: ["R3.1"] }).state;
    const closed = act(def, opened, 1, { t: "closeWindow" }).state;
    expect(closed.window).toBeNull();
    expect(closed.calls[0]).toBe("passed");
    // The next play does not open another against the same seat.
    const next = act(def, closed, 1, { t: "play", cards: ["R9.1"] }).state;
    expect(next.window?.offenders ?? []).not.toContain(0);
  });

  it("a seat that goes back up past two cards starts afresh", () => {
    const { def, state } = position({ ...twoLeft, draw: ["G1.1", "G2.1"] });
    const called = act(def, state, 0, { t: "callLast", seat: 0 }).state;
    const drew = act(def, { ...called, hands: { ...called.hands, 0: ["R3.1", "R4.1", "R6.1"] } }, 0, { t: "draw" }).state;
    expect(drew.calls[0]).toBeUndefined();
  });

  it("opens too when a swap leaves a seat on one card (the 2022 wording is reaching one)", () => {
    const { def, state } = position({
      rules: { sevenZero: true },
      hands: { 0: ["R7.1", "B1.1"], 1: ["Y1.1"], 2: ["Y2.1", "Y3.1"], 3: ["Y4.1", "Y5.1"] },
      top: TOP,
    });
    const r = act(def, state, 0, { t: "play", cards: ["R7.1"], swapWith: 1 });
    // Seat 0 now holds seat 1's single card without having played a second-to-last.
    expect(r.state.hands[0]).toEqual(["Y1.1"]);
    expect(r.state.window?.offenders).toContain(0);
  });
});

describe("going out and scoring", () => {
  it("scores the cards left in the other hands: numbers at face value, actions 20, wilds 50", () => {
    const { def, state } = position({
      hands: { 0: ["R3.1"], 1: ["B7.1", "GS.1"], 2: ["W.1", "Y9.1"], 3: ["F.1"] },
      top: TOP,
    });
    const r = act(def, state, 0, { t: "play", cards: ["R3.1"] });
    expect(r.state.result?.winner).toBe(0);
    const expected = 7 + 20 + 50 + 9 + 50;
    expect(r.state.scores[0]).toBe(expected);
    expect(r.state.result?.deltas).toEqual({ 0: expected, 1: 0, 2: 0, 3: 0 });
    expect(r.events.map((e) => e.t)).toContain("roundEnd");
  });

  it("a final Draw 2 is still drawn, and the cards drawn count", () => {
    const { def, state } = position({
      hands: { 0: ["RD.1"], 1: ["B7.1"], 2: ["Y1.1"], 3: ["Y2.1"] },
      top: TOP,
      draw: ["G9.1", "G8.1"],
    });
    const r = act(def, state, 0, { t: "play", cards: ["RD.1"] });
    expect(r.state.hands[1]).toEqual(["B7.1", "G9.1", "G8.1"]);
    expect(r.state.scores[0]).toBe(7 + 9 + 8 + 1 + 2);
  });

  it("a final Wild +4 is drawn rather than challenged", () => {
    const { def, state } = position({
      hands: { 0: ["F.1"], 1: ["B7.1"], 2: ["Y1.1"], 3: ["Y2.1"] },
      top: TOP,
      draw: ["G9.1", "G8.1", "G7.1", "G6.1"],
    });
    const r = act(def, state, 0, { t: "play", cards: ["F.1"], color: "B" });
    expect(r.state.challenge).toBeNull();
    expect(r.state.hands[1]).toHaveLength(1 + 4);
    expect(r.state.result?.winner).toBe(0);
  });

  it("the match ends when a seat reaches the target", () => {
    const { def, state } = position({
      rules: { target: 100 },
      hands: { 0: ["R3.1"], 1: ["W.1", "F.1"], 2: ["Y1.1"], 3: ["Y2.1"] },
      top: TOP,
    });
    const r = act(def, state, 0, { t: "play", cards: ["R3.1"] });
    expect(r.state.scores[0]).toBeGreaterThanOrEqual(100);
    expect(r.state.winner).toBe(0);
    expect(def.isOver(r.state)).toBe(true);
    expect(r.events.map((e) => e.t)).toContain("gameEnd");
  });

  it("a round ends the turn loop until the next deal", () => {
    const { def, state } = position({ hands: { 0: ["R3.1"], 1: ["Y1.1"], 2: ["Y2.1"], 3: ["Y3.1"] }, top: TOP });
    const r = act(def, state, 0, { t: "play", cards: ["R3.1"] });
    expect(def.isRoundOver!(r.state)).toBe(true);
    expect(def.currentSeat(r.state)).toBeNull();
    expect(def.legalActions(r.state, 1)).toEqual([]);
  });
});

describe("stacking", () => {
  const stack = (stacking: "same" | "upward") =>
    position({
      rules: { stacking },
      hands: { 0: ["RD.1", "B1.1", "B2.1"], 1: ["GD.1", "F.1", "Y1.1"], 2: ["Y2.1", "Y5.1"], 3: ["Y3.1"] },
      top: TOP,
      draw: ["G1.1", "G2.1", "G3.1", "G4.1"],
    });

  it("without it, a Draw 2 is taken at once (stacking is a house rule)", () => {
    const { def, state } = position({
      hands: { 0: ["RD.1", "B1.1"], 1: ["GD.1"], 2: ["Y2.1"], 3: ["Y3.1"] },
      top: TOP,
      draw: ["G1.1", "G2.1"],
    });
    const r = act(def, state, 0, { t: "play", cards: ["RD.1"] });
    expect(r.state.pendingDraw).toBeNull();
    expect(r.state.turn).toBe(2);
  });

  it("with it, a Draw 2 becomes a penalty the next seat can answer", () => {
    const { def, state } = stack("same");
    const r = act(def, state, 0, { t: "play", cards: ["RD.1"] });
    expect(r.state.pendingDraw).toEqual({ amount: 2, kind: "draw2" });
    expect(r.state.turn).toBe(1);
    expect(r.state.hands[1]).toHaveLength(3);
  });

  it("a +2 goes on a +2, and the penalty grows", () => {
    const { def, state } = stack("same");
    const a = act(def, state, 0, { t: "play", cards: ["RD.1"] }).state;
    const b = act(def, a, 1, { t: "play", cards: ["GD.1"] });
    expect(b.state.pendingDraw).toEqual({ amount: 4, kind: "draw2" });
    expect(b.state.turn).toBe(2);
    const c = act(def, b.state, 2, { t: "acceptPenalty" });
    expect(c.state.hands[2]).toHaveLength(2 + 4);
    expect(c.state.turn).toBe(3);
    expect(c.state.pendingDraw).toBeNull();
  });

  it("same: a +4 does not go on a +2; upward: it does", () => {
    const same = stack("same");
    const a = act(same.def, same.state, 0, { t: "play", cards: ["RD.1"] }).state;
    expect(same.def.validate!(a, 1, { t: "play", cards: ["F.1"], color: "B" })).toMatch(/cannot be played/);
    const up = stack("upward");
    const b = act(up.def, up.state, 0, { t: "play", cards: ["RD.1"] }).state;
    const c = act(up.def, b, 1, { t: "play", cards: ["F.1"], color: "B" });
    expect(c.state.pendingDraw?.amount).toBe(6);
  });

  it("upward: a +2 never goes on a +4", () => {
    const { def, state } = position({
      rules: { stacking: "upward", plusFour: "free" },
      hands: { 0: ["F.1", "B1.1", "B2.1"], 1: ["GD.1", "Y1.1"], 2: ["Y2.1"], 3: ["Y3.1"] },
      top: TOP,
    });
    const a = act(def, state, 0, { t: "play", cards: ["F.1"], color: "G" }).state;
    expect(def.validate!(a, 1, { t: "play", cards: ["GD.1"] })).toMatch(/cannot be played/);
  });

  it("while a penalty stands the seat cannot simply draw, play an ordinary card, or pass", () => {
    const { def, state } = stack("same");
    const a = act(def, state, 0, { t: "play", cards: ["RD.1"] }).state;
    expect(def.validate!(a, 1, { t: "draw" })).toMatch(/penalty/);
    expect(def.validate!(a, 1, { t: "play", cards: ["Y1.1"] })).toMatch(/cannot be played/);
    expect(def.legalActions(a, 1).some((x) => x.t === "draw")).toBe(false);
  });

  it("only the LAST +4 in a chain can be challenged, by the seat it lands on", () => {
    const { def, state } = position({
      rules: { stacking: "same" },
      hands: { 0: ["F.1", "R2.1", "R4.1"], 1: ["F.2", "R3.1", "R6.1"], 2: ["Y2.1", "Y3.1"], 3: ["Y4.1"] },
      top: TOP,
      draw: Array.from({ length: 12 }, (_, i) => `G${(i % 9) + 1}.${i < 9 ? 1 : 2}`),
    });
    // Seat 0 names red, so seat 1 - holding red - is bluffing when it answers.
    const a = act(def, state, 0, { t: "play", cards: ["F.1"], color: "R" }).state;
    expect(a.challenge?.offender).toBe(0);
    // Seat 1 answers with its own +4 instead of challenging: that voids the first.
    const b = act(def, a, 1, { t: "play", cards: ["F.2"], color: "G" }).state;
    expect(b.challenge).toMatchObject({ offender: 1, onColor: "R", amount: 8, guilty: true });
    expect(b.turn).toBe(2);
    // Seat 2 challenges seat 1's +4 and takes nothing: seat 1 draws all eight.
    const c = act(def, b, 2, { t: "challenge" }).state;
    expect(c.hands[1]).toHaveLength(2 + 8);
    expect(c.hands[0]).toHaveLength(3 - 1);
  });

  it("a clean challenge costs the challenger the whole stack plus two", () => {
    const { def, state } = position({
      rules: { stacking: "same" },
      hands: { 0: ["F.1", "B2.1", "B4.1"], 1: ["F.2", "B3.1", "B6.1"], 2: ["Y2.1", "Y3.1"], 3: ["Y4.1"] },
      top: TOP,
      draw: Array.from({ length: 12 }, (_, i) => `G${(i % 9) + 1}.${i < 9 ? 1 : 2}`),
    });
    // Seat 0 names green; seat 1 holds only blue, so its +4 is honest.
    const a = act(def, state, 0, { t: "play", cards: ["F.1"], color: "G" }).state;
    const b = act(def, a, 1, { t: "play", cards: ["F.2"], color: "R" }).state;
    expect(b.challenge?.guilty).toBe(false);
    const c = act(def, b, 2, { t: "challenge" }).state;
    expect(c.hands[2]).toHaveLength(2 + 8 + 2);
  });
});

describe("Draw to Match and Force Play", () => {
  it("keeps drawing until a card can be played", () => {
    const { def, state } = position({
      rules: { drawToMatch: true },
      hands: { 0: ["B1.1"] },
      top: TOP,
      draw: ["B2.1", "G2.1", "R9.1", "Y9.1"],
    });
    const r = act(def, state, 0, { t: "draw" });
    expect(r.state.hands[0]).toEqual(["B1.1", "B2.1", "G2.1", "R9.1"]);
    expect(r.state.drawn).toBe("R9.1");
  });

  it("passes the turn if the pile runs out before a match", () => {
    const { def, state } = position({ rules: { drawToMatch: true }, hands: { 0: ["B1.1"] }, top: TOP });
    const lean = { ...state, drawPile: ["B2.1", "G2.1"], discard: [TOP] };
    const r = act(def, lean, 0, { t: "draw" });
    expect(r.state.turn).toBe(1);
    expect(r.state.drawn).toBeNull();
  });

  it("Force Play: a drawn card that can be played must be - no Keep", () => {
    const { def, state } = position({ rules: { forcePlay: true }, hands: { 0: ["B1.1", "B2.1"] }, top: TOP, draw: ["R9.1"] });
    const drew = act(def, state, 0, { t: "draw" }).state;
    expect(def.validate!(drew, 0, { t: "keep" })).toMatch(/must be/);
    expect(def.legalActions(drew, 0).some((a) => a.t === "keep")).toBe(false);
    // ...and an unplayable draw just ends the turn, as ever.
    const miss = position({ rules: { forcePlay: true }, hands: { 0: ["B1.1"] }, top: TOP, draw: ["G2.1"] });
    expect(act(miss.def, miss.state, 0, { t: "draw" }).state.turn).toBe(1);
  });
});

describe("Jump-In", () => {
  const jump = {
    rules: { jumpIn: true },
    hands: { 0: ["R7.1", "B1.1", "B2.1"], 1: ["Y1.1", "Y9.1"], 2: ["R7.2", "G1.1", "G2.1"], 3: ["Y4.1", "Y5.1"] },
    top: "R5.1",
  };

  it("opens only when someone holds the identical card - and says nothing about who", () => {
    const { def, state } = position(jump);
    const r = act(def, state, 0, { t: "play", cards: ["R7.1"] }).state;
    expect(r.window?.jumpers).toEqual([2]);
    expect(r.window?.pending.map((p) => p.seat)).toEqual([2]);
    // Everyone else is shown a window, and not who is in it.
    expect(def.playerView(r, 1).window).toMatchObject({ jumpers: [], pending: [] });
    expect(def.playerView(r, 2).window).toMatchObject({ jumpers: [2] });
  });

  it("does not open when nobody can jump, so most turns cost nothing", () => {
    const { def, state } = position({ ...jump, hands: { ...jump.hands, 2: ["R8.1", "G1.1", "G2.1"] } });
    expect(act(def, state, 0, { t: "play", cards: ["R7.1"] }).state.window).toBeNull();
  });

  it("is off unless the house rule is on", () => {
    const { def, state } = position({ ...jump, rules: {} });
    expect(act(def, state, 0, { t: "play", cards: ["R7.1"] }).state.window).toBeNull();
  });

  it("needs the same colour AND the same number", () => {
    const { def, state } = position({ ...jump, hands: { ...jump.hands, 2: ["B7.1", "G1.1", "G2.1"] } });
    expect(act(def, state, 0, { t: "play", cards: ["R7.1"] }).state.window).toBeNull();
  });

  it("plays on from the jumper's seat", () => {
    const { def, state } = position(jump);
    const opened = act(def, state, 0, { t: "play", cards: ["R7.1"] }).state;
    const r = act(def, opened, 2, { t: "jumpIn", seat: 2, card: "R7.2" });
    expect(r.state.discard.slice(-2)).toEqual(["R7.1", "R7.2"]);
    expect(r.state.turn).toBe(3);
    expect(r.state.window).toBeNull();
    expect(r.events.some((e) => e.t === "cue" && e.kind === "jump")).toBe(true);
  });

  it("refuses a jump from a seat that does not hold the twin, and a card that is not identical", () => {
    const { def, state } = position(jump);
    const opened = act(def, state, 0, { t: "play", cards: ["R7.1"] }).state;
    expect(def.validate!(opened, 1, { t: "jumpIn", seat: 1, card: "Y1.1" })).toMatch(/nothing to jump in on/);
    expect(def.validate!(opened, 2, { t: "jumpIn", seat: 2, card: "G1.1" })).toMatch(/identical/);
    expect(def.validate!(opened, 2, { t: "jumpIn", seat: 2, card: "R7.1" })).toMatch(/does not hold/);
  });

  it("the seat on turn cannot play while the window is open", () => {
    const { def, state } = position(jump);
    const opened = act(def, state, 0, { t: "play", cards: ["R7.1"] }).state;
    expect(def.validate!(opened, 1, { t: "play", cards: ["Y1.1"] })).toMatch(/answered/);
    expect(def.legalActions(opened, 1)).toEqual([]);
  });

  it("closing the window leaves the turn where the play put it", () => {
    const { def, state } = position(jump);
    const opened = act(def, state, 0, { t: "play", cards: ["R7.1"] }).state;
    const closed = act(def, opened, 2, { t: "closeWindow" }).state;
    expect(closed.window).toBeNull();
    expect(closed.turn).toBe(1);
  });

  it("a jumped-in +2 with stacking ADDS to the penalty, and lands on the seat after the jumper", () => {
    const { def, state } = position({
      rules: { jumpIn: true, stacking: "same" },
      hands: { 0: ["RD.1", "B1.1", "B2.1"], 1: ["Y1.1", "Y9.1"], 2: ["RD.2", "G1.1", "G2.1"], 3: ["Y4.1", "Y5.1"] },
      top: TOP,
    });
    const opened = act(def, state, 0, { t: "play", cards: ["RD.1"] }).state;
    expect(opened.pendingDraw?.amount).toBe(2);
    const r = act(def, opened, 2, { t: "jumpIn", seat: 2, card: "RD.2" }).state;
    expect(r.pendingDraw).toEqual({ amount: 4, kind: "draw2" });
    expect(r.turn).toBe(3);
  });

  it("without stacking, a jumped-in +2 hits the seat after the jumper normally", () => {
    const { def, state } = position({
      rules: { jumpIn: true },
      hands: { 0: ["RD.1", "B1.1", "B2.1"], 1: ["Y1.1", "Y9.1"], 2: ["RD.2", "G1.1", "G2.1"], 3: ["Y4.1", "Y5.1"] },
      top: TOP,
      draw: ["G2.1", "G3.1", "G4.1", "G5.1"],
    });
    const opened = act(def, state, 0, { t: "play", cards: ["RD.1"] }).state;
    const r = act(def, opened, 2, { t: "jumpIn", seat: 2, card: "RD.2" }).state;
    expect(r.hands[3]).toHaveLength(2 + 2);
    expect(r.turn).toBe(0);
  });

  it("a Wild cannot be jumped in on", () => {
    const { def, state } = position({
      rules: { jumpIn: true },
      hands: { 0: ["W.1", "B1.1", "B2.1"], 1: ["Y1.1"], 2: ["W.2", "G1.1"], 3: ["Y4.1"] },
      top: TOP,
    });
    expect(act(def, state, 0, { t: "play", cards: ["W.1"], color: "B" }).state.window).toBeNull();
  });

  it("a seat cannot jump in on its own play", () => {
    const { def, state } = position({
      rules: { jumpIn: true },
      hands: { 0: ["R7.1", "R7.2", "B1.1"], 1: ["Y1.1"], 2: ["Y2.1"], 3: ["Y4.1"] },
      top: TOP,
    });
    expect(act(def, state, 0, { t: "play", cards: ["R7.1"] }).state.window).toBeNull();
  });

  it("races: the reaction times are in the position, so a seed replays them", () => {
    const { def, state } = position(jump);
    const a = act(def, state, 0, { t: "play", cards: ["R7.1"] }).state.window!.pending;
    const b = act(def, state, 0, { t: "play", cards: ["R7.1"] }).state.window!.pending;
    expect(a).toEqual(b);
    expect(a[0]!.ms).toBeGreaterThanOrEqual(700);
    expect(a[0]!.ms).toBeLessThan(state.rules.windowMs);
  });
});

describe("the clock", () => {
  const { def, state } = position({
    rules: { jumpIn: true, windowMs: 3000 },
    hands: { 0: ["R7.1", "B1.1", "B2.1"], 1: ["Y1.1", "Y9.1"], 2: ["R7.2", "G1.1", "G2.1"], 3: ["Y4.1", "Y5.1"] },
    top: TOP,
  });
  const opened = act(def, state, 0, { t: "play", cards: ["R7.1"] }).state;

  it("gives a person the window plus the grace, and the whole table one deadline", () => {
    const d = def.deadline!(opened, 2);
    expect(d).toMatchObject({ ms: 3900, action: { t: "closeWindow" } });
    expect(d?.key).toBe(`1:${opened.window!.id}`);
    expect(def.deadline!(opened, 1)).toBeNull();
  });

  it("counts a deadline from the window opening, not from when the seat came to be waited on", () => {
    const later = { ...opened, window: { ...opened.window!, elapsed: 1000 } };
    expect(def.deadline!(later, 2)!.ms).toBe(2900);
  });

  it("has a bot wait out the rest of its reaction time, never less than the beat", () => {
    const ms = opened.window!.pending[0]!.ms;
    expect(def.turnHold!(opened, 2)).toBe(ms);
    expect(def.turnHold!({ ...opened, window: { ...opened.window!, elapsed: ms } }, 2)).toBe(120);
    expect(def.turnHold!(state, 0)).toBeUndefined();
  });

  it("names the soonest as who pacing waits on, and entitles them all", () => {
    expect(def.currentSeat(opened)).toBe(2);
    expect(def.currentSeat(state)).toBe(0);
  });

  it("makes a timed-out turn the cautious one: draw, keep, or take the penalty", () => {
    expect(def.timeoutAction!(state, 0)).toEqual({ t: "draw" });
    const drew = position({ hands: { 0: ["B1.1", "B2.1"] }, top: TOP, draw: ["R9.1"] });
    const d = act(drew.def, drew.state, 0, { t: "draw" }).state;
    expect(drew.def.timeoutAction!(d, 0)).toEqual({ t: "keep" });
    const pen = position({
      rules: { stacking: "same" },
      hands: { 0: ["RD.1", "B1.1", "B2.1"], 1: ["Y1.1"] },
      top: TOP,
    });
    const a = act(pen.def, pen.state, 0, { t: "play", cards: ["RD.1"] }).state;
    expect(pen.def.timeoutAction!(a, 1)).toEqual({ t: "acceptPenalty" });
  });
});

describe("7-0", () => {
  const sevenZero = {
    rules: { sevenZero: true },
    hands: { 0: ["R7.1", "R0.1", "B1.1"], 1: ["Y1.1"], 2: ["Y2.1", "Y3.1"], 3: ["Y4.1", "Y5.1", "Y6.1"] },
    top: TOP,
  };

  it("a 7 swaps hands with the seat of your choice, and it must be chosen", () => {
    const { def, state } = position(sevenZero);
    expect(def.validate!(state, 0, { t: "play", cards: ["R7.1"] })).toMatch(/choose another seat/);
    expect(def.validate!(state, 0, { t: "play", cards: ["R7.1"], swapWith: 0 })).toMatch(/choose another seat/);
    expect(def.validate!(state, 0, { t: "play", cards: ["R7.1"], swapWith: 9 })).toMatch(/choose another seat/);
    const r = act(def, state, 0, { t: "play", cards: ["R7.1"], swapWith: 3 });
    expect(r.state.hands[0]).toEqual(["Y4.1", "Y5.1", "Y6.1"]);
    expect(r.state.hands[3]).toEqual(["R0.1", "B1.1"]);
    expect(everyCard(r.state)).toHaveLength(108);
  });

  it("a 0 passes every hand one seat along, the way play is going", () => {
    const { def, state } = position(sevenZero);
    const r = act(def, state, 0, { t: "play", cards: ["R0.1"] });
    // Clockwise: seat 0's hand goes to seat 1, and so on round.
    expect(r.state.hands[1]).toEqual(["R7.1", "B1.1"]);
    expect(r.state.hands[0]).toEqual(["Y4.1", "Y5.1", "Y6.1"]);
    expect(r.state.hands[2]).toEqual(["Y1.1"]);
    expect(r.state.hands[3]).toEqual(["Y2.1", "Y3.1"]);
  });

  it("a 0 passes the other way when play runs the other way", () => {
    const { def, state } = position({ ...sevenZero, direction: -1 });
    const r = act(def, state, 0, { t: "play", cards: ["R0.1"] });
    expect(r.state.hands[3]).toEqual(["R7.1", "B1.1"]);
    expect(r.state.hands[0]).toEqual(["Y1.1"]);
  });

  it("a 7 or a 0 as your LAST card means you have gone out: no swap", () => {
    const { def, state } = position({ ...sevenZero, hands: { ...sevenZero.hands, 0: ["R7.1"] } });
    expect(def.validate!(state, 0, { t: "play", cards: ["R7.1"], swapWith: 1 })).toMatch(/nothing to swap/);
    const r = act(def, state, 0, { t: "play", cards: ["R7.1"] });
    expect(r.state.result?.winner).toBe(0);
    expect(r.state.hands[1]).toEqual(["Y1.1"]);
  });

  it("without the rule, a 7 and a 0 are ordinary cards", () => {
    const { def, state } = position({ ...sevenZero, rules: {} });
    const r = act(def, state, 0, { t: "play", cards: ["R7.1"] });
    expect(r.state.hands[3]).toEqual(["Y4.1", "Y5.1", "Y6.1"]);
  });
});

describe("doubles", () => {
  const doubles = {
    rules: { doubles: true },
    hands: { 0: ["R3.1", "R3.2", "B3.1", "G3.1", "B8.1"], 1: ["Y1.1"], 2: ["Y2.1"], 3: ["Y4.1"] },
    top: "R5.1",
  };

  it("two of a number in the SAME colour is a Skip", () => {
    const { def, state } = position({ ...doubles, rules: { doubles: true } });
    const r = act(def, state, 0, { t: "play", cards: ["R3.1", "R3.2"] });
    expect(r.state.turn).toBe(2);
    expect(r.state.direction).toBe(1);
    expect(r.state.discard.slice(-2)).toEqual(["R3.1", "R3.2"]);
  });

  it("two of a number in DIFFERENT colours is a Reverse", () => {
    const { def, state } = position(doubles);
    const r = act(def, state, 0, { t: "play", cards: ["B3.1", "R3.1"] });
    expect(r.state.direction).toBe(-1);
    expect(r.state.turn).toBe(3);
    // The last named is the top, and sets the colour.
    expect(r.state.color).toBe("R");
  });

  it("with two players a Reverse pair is a Skip, so both kinds of pair are", () => {
    const { def, state } = position({ ...doubles, seats: 2, hands: { 0: ["R3.1", "B3.1", "B8.1"], 1: ["Y1.1"] } });
    expect(act(def, state, 0, { t: "play", cards: ["B3.1", "R3.1"] }).state.turn).toBe(0);
  });

  it("three or more is a plain dump: no Skip, no Reverse - it pays to dump fewer", () => {
    const { def, state } = position(doubles);
    const r = act(def, state, 0, { t: "play", cards: ["R3.1", "R3.2", "B3.1"] });
    expect(r.state.turn).toBe(1);
    expect(r.state.direction).toBe(1);
    expect(r.state.hands[0]).toEqual(["G3.1", "B8.1"]);
  });

  it("needs at least one of the cards to go on the pile", () => {
    const { def, state } = position({ ...doubles, hands: { ...doubles.hands, 0: ["G3.1", "B3.1", "B8.1"] } });
    expect(def.validate!(state, 0, { t: "play", cards: ["G3.1", "B3.1"] })).toMatch(/together/);
    // R3 would match; G3 and B3 do not, but a pair containing a match does.
    const ok = position({ ...doubles });
    expect(ok.def.validate!(ok.state, 0, { t: "play", cards: ["G3.1", "R3.1"] })).toBeNull();
  });

  it("is for numbers only, and only of one number", () => {
    const { def, state } = position({
      ...doubles,
      hands: { ...doubles.hands, 0: ["RS.1", "RS.2", "R3.1", "B4.1", "R4.1"] },
    });
    expect(def.validate!(state, 0, { t: "play", cards: ["RS.1", "RS.2"] })).toMatch(/together/);
    expect(def.validate!(state, 0, { t: "play", cards: ["R3.1", "R4.1"] })).toMatch(/together/);
  });

  it("is off unless the house rule is on", () => {
    const { def, state } = position({ ...doubles, rules: {} });
    expect(def.validate!(state, 0, { t: "play", cards: ["R3.1", "R3.2"] })).toMatch(/together/);
  });

  it("a pair of 7s or 0s does its Skip or Reverse INSTEAD of a swap", () => {
    const { def, state } = position({
      rules: { doubles: true, sevenZero: true },
      hands: { 0: ["R7.1", "R7.2", "B1.1"], 1: ["Y1.1"], 2: ["Y2.1"], 3: ["Y4.1"] },
      top: TOP,
    });
    expect(def.validate!(state, 0, { t: "play", cards: ["R7.1", "R7.2"], swapWith: 1 })).toMatch(/nothing to swap/);
    const r = act(def, state, 0, { t: "play", cards: ["R7.1", "R7.2"] });
    expect(r.state.turn).toBe(2);
    expect(r.state.hands[1]).toEqual(["Y1.1"]);
  });

  it("a pair cannot be jumped in on", () => {
    const { def, state } = position({
      rules: { doubles: true, jumpIn: true },
      hands: { 0: ["R3.1", "R3.2", "B1.1", "B2.1"], 1: ["Y1.1"], 2: ["B3.1", "B3.2"], 3: ["Y4.1"] },
      top: TOP,
    });
    expect(act(def, state, 0, { t: "play", cards: ["R3.1", "R3.2"] }).state.window).toBeNull();
  });

  it("going from three cards to one opens the call race like any other way", () => {
    const { def, state } = position({
      rules: { doubles: true },
      hands: { 0: ["R3.1", "R3.2", "B8.1"], 1: ["Y1.1"], 2: ["Y2.1"], 3: ["Y4.1"] },
      top: TOP,
    });
    expect(act(def, state, 0, { t: "play", cards: ["R3.1", "R3.2"] }).state.window?.offenders).toEqual([0]);
  });

  it("a pair can go out", () => {
    const { def, state } = position({
      rules: { doubles: true },
      hands: { 0: ["R3.1", "R3.2"], 1: ["Y1.1"], 2: ["Y2.1"], 3: ["Y4.1"] },
      top: TOP,
    });
    expect(act(def, state, 0, { t: "play", cards: ["R3.1", "R3.2"] }).state.result?.winner).toBe(0);
  });
});

describe("Wild Shuffle Hands", () => {
  it("gathers every hand and deals it out again from the seat after the player", () => {
    const { def, state } = position({
      rules: { shuffleHands: true },
      hands: { 0: ["X.1", "B1.1"], 1: ["Y1.1", "Y2.1", "Y3.1"], 2: ["G1.1"], 3: ["G2.1", "G3.1"] },
      top: TOP,
    });
    const r = act(def, state, 0, { t: "play", cards: ["X.1"], color: "G" });
    const sizes = [0, 1, 2, 3].map((s) => r.state.hands[s]!.length);
    // Seven cards among four seats, the first seats after the player getting the extra.
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(7);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(r.state.hands[1]!.length).toBeGreaterThanOrEqual(r.state.hands[0]!.length);
    expect(r.state.color).toBe("G");
    expect(everyCard(r.state)).toHaveLength(109);
    expect(r.events.some((e) => e.t === "cue" && e.kind === "shuffleHands")).toBe(true);
  });

  it("is a wild: it can be played on anything and names a colour", () => {
    const { def, state } = position({ rules: { shuffleHands: true }, hands: { 0: ["X.1", "B1.1"] }, top: TOP });
    expect(def.validate!(state, 0, { t: "play", cards: ["X.1"] })).toMatch(/colour/);
    expect(def.validate!(state, 0, { t: "play", cards: ["X.1"], color: "B" })).toBeNull();
  });

  it("as the last card, simply goes out", () => {
    const { def, state } = position({
      rules: { shuffleHands: true },
      hands: { 0: ["X.1"], 1: ["Y1.1"], 2: ["Y2.1"], 3: ["Y4.1"] },
      top: TOP,
    });
    const r = act(def, state, 0, { t: "play", cards: ["X.1"], color: "G" });
    expect(r.state.result?.winner).toBe(0);
    expect(r.state.scores[0]).toBe(1 + 2 + 4);
  });
});

describe("what a viewer is told", () => {
  it("shows only the viewer's own hand, hides the draw pile and the secret", () => {
    const { def, state } = position({ hands: { 0: ["R3.1", "B1.1"], 1: ["Y1.1", "Y2.1"] }, top: TOP });
    const view = def.playerView(state, 0);
    expect(view.hands[0]).toEqual(["R3.1", "B1.1"]);
    expect(view.hands[1]).toEqual(["??", "??"]);
    expect(view.drawPile.every((c) => c === "??")).toBe(true);
    expect(view.drawPile).toHaveLength(state.drawPile.length);
    expect(view.secret).toBe(0);
    expect(JSON.stringify(view)).not.toContain("Y1.1");
  });

  it("shows a drawn card only to the seat that drew it", () => {
    const { def, state } = position({ hands: { 0: ["B1.1", "B2.1"] }, top: TOP, draw: ["R9.1"] });
    const drew = act(def, state, 0, { t: "draw" }).state;
    expect(def.playerView(drew, 0).drawn).toBe("R9.1");
    expect(def.playerView(drew, 1).drawn).toBe("??");
  });

  it("places the viewer's own cards face up and everyone else's face down", () => {
    const { def, state } = position({ hands: { 0: ["R3.1"], 1: ["Y1.1"] }, top: TOP });
    const p = def.placements(state, 0);
    expect(p["R3.1"]).toMatchObject({ zone: "hand", seat: 0, faceUp: true });
    expect(p["Y1.1"]).toMatchObject({ zone: "hand", seat: 1, faceUp: false });
    expect(p[TOP]).toMatchObject({ zone: "discard", faceUp: true });
    // A spectator (-1) sees no hand at all.
    expect(def.placements(state, -1)["R3.1"]!.faceUp).toBe(false);
  });

  it("fades all but the newest discards in place rather than dropping them", () => {
    const { def, state } = position({ hands: { 0: ["R3.1"] }, top: TOP });
    const deep = { ...state, discard: ["G1.1", "G2.1", "G3.1", "G4.1", "G5.1", TOP] };
    const p = def.placements(deep, 0);
    expect(p["G1.1"]!.hidden).toBe(true);
    expect(p[TOP]!.hidden).toBeUndefined();
    expect(Object.values(p).filter((x) => x.zone === "discard" && !x.hidden)).toHaveLength(3);
  });

  it("is a closed piece set that matches the deck, with the extra card only when asked", () => {
    const plain = createChromaly();
    const withX = createChromaly({ shuffleHands: true });
    const s1 = plain.setup({ seats: 4, rng: createRng(1) });
    const s2 = withX.setup({ seats: 4, rng: createRng(1) });
    expect(Object.keys(plain.pieces(s1))).toHaveLength(108);
    expect(Object.keys(withX.pieces(s2))).toHaveLength(109);
    expect(Object.values(plain.pieces(s1)).every((m) => m.kind === "chroma")).toBe(true);
    expect(new Set(Object.keys(plain.pieces(s1)))).toEqual(new Set(deckIds()));
    expect(points("F.1")).toBe(50);
  });
});

describe("rules are clamped, whatever arrives", () => {
  it("pulls hostile rules inside the ranges", () => {
    const def = createChromaly({
      target: Number.NaN,
      windowMs: Number.POSITIVE_INFINITY,
      stacking: "weird" as never,
      plusFour: "weird" as never,
    });
    const state = def.setup({ seats: 99, rng: createRng(1) });
    expect(state.seats).toBe(10);
    expect(state.rules.target).toBe(500);
    expect(state.rules.windowMs).toBe(3000);
    expect(state.rules.stacking).toBe("off");
    expect(state.rules.plusFour).toBe("challenge");
    expect(def.setup({ seats: 0, rng: createRng(1) }).seats).toBe(2);
  });
});
