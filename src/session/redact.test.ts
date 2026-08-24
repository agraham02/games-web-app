// @vitest-environment node

/**
 * The claim under test is a security property, not a rendering one: after
 * redaction, nothing a viewer receives names a piece they are not allowed
 * to identify. So the assertions here are mostly of the form "this real id
 * appears nowhere in the payload", checked against real game states rather
 * than hand-built fixtures — a fixture can only ever contain the leaks I
 * already thought of.
 */

import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import type { GameEvent, PlacementMap } from "@/engine/types";
import { createSpades } from "@/games/spades/rules";
import { createPoker } from "@/games/poker/rules";
import { createDominoes } from "@/games/dominoes/rules";
import { createRummy } from "@/games/rummy/rules";
import { isSentinel, projectEvents, redactPlacements } from "./redact";

/** Deals a real game and returns the true placements plus piece meta. */
function dealt(definition: ReturnType<typeof createSpades>, seats: number, seed: number) {
  const rng = createRng(seed);
  const base = definition.setup({ seats, rng });
  const { state } = definition.startRound!(base, rng);
  return { state, meta: definition.pieces(state) };
}

describe("redactPlacements", () => {
  it("replaces every face-down id and keeps every face-up one", () => {
    const spades = createSpades();
    const { state, meta } = dealt(spades, 4, 909);
    const truth = spades.placements(state, 0);
    const { placements } = redactPlacements(truth, meta);

    for (const [id, p] of Object.entries(truth)) {
      if (p.faceUp) expect(placements[id]).toBeDefined();
      else expect(placements[id]).toBeUndefined();
    }
    // Nothing survives that is neither a real face-up piece nor a stand-in.
    for (const id of Object.keys(placements)) {
      expect(isSentinel(id) || truth[id]?.faceUp).toBeTruthy();
    }
  });

  it("leaks no opponent card id at all, for any viewer", () => {
    // The headline property. Spades deals every card to a hand, so for a
    // given viewer exactly one hand may appear and three must not.
    const spades = createSpades();
    const { state, meta } = dealt(spades, 4, 4242);

    for (const viewer of [0, 1, 2, 3]) {
      const { placements } = redactPlacements(spades.placements(state, viewer), meta);
      const wire = JSON.stringify(placements);
      for (const seat of [0, 1, 2, 3]) {
        if (seat === viewer) continue;
        for (const card of state.hands[seat]!) {
          expect(wire).not.toContain(card);
        }
      }
    }
  });

  it("hides poker's undealt deck and the burnt cards", () => {
    // Poker is the game whose `playerView` returns the whole future runout
    // intact, so the placement path has to be airtight independently.
    const poker = createPoker();
    const rng = createRng(77);
    const base = poker.setup({ seats: 4, rng });
    const { state } = poker.startRound!(base, rng);
    const meta = poker.pieces(state);

    const truth = poker.placements(state, 0);
    const { placements } = redactPlacements(truth, meta);
    const wire = JSON.stringify(placements);

    const concealed = Object.entries(truth).filter(([, p]) => !p.faceUp);
    expect(concealed.length).toBeGreaterThan(0);
    for (const [id] of concealed) expect(wire).not.toContain(`"${id}"`);
  });

  it("hides the dominoes boneyard", () => {
    const dominoes = createDominoes();
    const rng = createRng(31);
    const base = dominoes.setup({ seats: 4, rng });
    const { state } = dominoes.startRound!(base, rng);
    const meta = dominoes.pieces(state);

    const { placements } = redactPlacements(dominoes.placements(state, 0), meta);
    const wire = JSON.stringify(placements);
    for (const tile of state.boneyard) expect(wire).not.toContain(`"${tile}"`);
  });

  it("preserves layout exactly — same slots, same counts, same order", () => {
    // Redaction must be invisible to the eye. If it changed `index` or
    // `count` the fan maths would spread differently and an opponent's
    // hand would visibly differ from a real one.
    const spades = createSpades();
    const { state, meta } = dealt(spades, 4, 5150);
    const truth = spades.placements(state, 0);
    const { placements } = redactPlacements(truth, meta);

    expect(Object.keys(placements)).toHaveLength(Object.keys(truth).length);

    const shape = (m: PlacementMap) =>
      Object.values(m)
        .map((p) => `${p.zone}:${p.seat ?? "-"}:${p.group ?? "-"}:${p.index}/${p.count}:${p.faceUp}`)
        .sort();
    expect(shape(placements)).toEqual(shape(truth));
  });

  it("gives every stand-in the right piece kind so it renders as itself", () => {
    // A hidden domino must still be domino-shaped: the piece layer picks
    // its renderer from `kind`.
    const dominoes = createDominoes();
    const rng = createRng(8);
    const base = dominoes.setup({ seats: 4, rng });
    const { state } = dominoes.startRound!(base, rng);
    const meta = dominoes.pieces(state);

    const { meta: standIns } = redactPlacements(dominoes.placements(state, 0), meta);
    expect(Object.keys(standIns).length).toBeGreaterThan(0);
    for (const m of Object.values(standIns)) expect(m.kind).toBe("tile");
  });
});

describe("projectEvents", () => {
  const hand = (seat: number, index: number, count: number, faceUp: boolean) => ({
    zone: "hand" as const,
    seat,
    index,
    count,
    faceUp,
  });

  it("swaps the id of a piece hidden before and after", () => {
    const before: PlacementMap = { "S-A": hand(3, 0, 2, false) };
    const after: PlacementMap = { "S-A": hand(3, 0, 2, false) };
    const events: GameEvent[] = [{ t: "flip", piece: "S-A", faceUp: false }];

    const out = projectEvents(events, before, after);
    expect(JSON.stringify(out)).not.toContain("S-A");
    expect(out).toHaveLength(1);
  });

  it("passes a piece that was public all along straight through", () => {
    const before: PlacementMap = { "S-A": { zone: "trick", index: 0, count: 1, faceUp: true } };
    const after = before;
    const events: GameEvent[] = [{ t: "highlight", piece: "S-A", on: true }];

    expect(projectEvents(events, before, after)).toEqual(events);
  });

  it("rides an unmask in front when a concealed piece is revealed", () => {
    // The case the whole design turns on: an opponent playing from a hand
    // the viewer has only ever seen the back of.
    const before: PlacementMap = {
      "S-A": hand(3, 1, 3, false),
      "S-K": hand(3, 0, 3, false),
    };
    const after: PlacementMap = {
      "S-A": { zone: "trick", index: 0, count: 1, faceUp: true },
      "S-K": hand(3, 0, 2, false),
    };
    const events: GameEvent[] = [{ t: "play", piece: "S-A", from: 3, to: "trick" }];

    const out = projectEvents(events, before, after);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ t: "unmask", piece: "S-A", at: hand(3, 1, 3, false) });
    // The play must name the REAL card, because the unmask just put that
    // exact id on the board for it to fly out of.
    expect(out[1]).toEqual({ t: "play", piece: "S-A", from: 3, to: "trick" });
    // The card still in hand stays anonymous.
    expect(JSON.stringify(out)).not.toContain("S-K");
  });

  it("unmasks at the position the piece is leaving, not the one it lands on", () => {
    // If it used the destination the card would appear on the table and
    // then animate nowhere — the fly-out is the entire point.
    const before: PlacementMap = { "D6-3": hand(2, 4, 7, false) };
    const after: PlacementMap = { "D6-3": { zone: "line", index: 0, count: 1, faceUp: true } };
    const out = projectEvents([{ t: "play", piece: "D6-3", from: 2, to: "line" }], before, after);

    expect(out[0]).toMatchObject({ t: "unmask", at: { zone: "hand", seat: 2, index: 4 } });
  });

  it("handles a multi-piece event, concealing only what stays concealed", () => {
    const before: PlacementMap = {
      "S-A": { zone: "trick", index: 0, count: 2, faceUp: true },
      "S-K": hand(1, 0, 1, false),
    };
    const after: PlacementMap = {
      "S-A": { zone: "collected", seat: 1, index: 0, count: 2, faceUp: false },
      "S-K": { zone: "collected", seat: 1, index: 1, count: 2, faceUp: false },
    };
    const out = projectEvents([{ t: "collect", pieces: ["S-A", "S-K"], to: 1 }], before, after);

    const wire = JSON.stringify(out);
    // S-A was public before the collect, so naming it is not a leak — the
    // viewer watched it get played. S-K never was.
    expect(wire).not.toContain("S-K");
  });

  it("never emits a real id for a piece the viewer cannot see, across a real deal", () => {
    // End to end against a genuine Spades deal: take the events a real
    // round produces and assert the projection for seat 0 names no card
    // belonging to anyone else that is still face-down.
    const spades = createSpades();
    const rng = createRng(2024);
    const base = spades.setup({ seats: 4, rng });
    const beforeState = base;
    const { state: afterState, events } = spades.startRound!(base, rng);

    const before = spades.placements(beforeState, 0);
    const after = spades.placements(afterState, 0);
    const out = projectEvents(events, before, after);
    const wire = JSON.stringify(out);

    for (const seat of [1, 2, 3]) {
      for (const card of afterState.hands[seat]!) {
        expect(wire).not.toContain(`"${card}"`);
      }
    }
  });
});

describe("playerView — what the redacted STATE may contain", () => {
  /**
   * `placements` redaction protects the board; this protects the state
   * payload that rides alongside it, which every game screen reads for its
   * own UI. Two games were shipping the entire future of the deal here —
   * poker's `deck` and rummy's `stock` are the undrawn cards IN ORDER,
   * which is worth strictly more than seeing somebody's hand.
   *
   * Both went unnoticed for the same reason: single-player never sends a
   * view anywhere, so the only consumer was a bot, and nobody suspects a
   * bot of reading ahead.
   */

  it("spades: a viewer's own hand is visible and nobody else's is", () => {
    const spades = createSpades();
    const { state } = dealt(spades, 4, 606);

    for (const viewer of [0, 1, 2, 3]) {
      const view = spades.playerView(state, viewer);
      expect(view.hands[viewer]).toEqual(state.hands[viewer]);
      for (const seat of [0, 1, 2, 3]) {
        if (seat === viewer) continue;
        for (const card of state.hands[seat]!) {
          expect(JSON.stringify(view.hands[seat])).not.toContain(card);
        }
      }
    }
  });

  it("rummy: the stock is masked but its depth is preserved", () => {
    const rummy = createRummy();
    const rng = createRng(818);
    const base = rummy.setup({ seats: 4, rng });
    const { state } = rummy.startRound!(base, rng);

    expect(state.stock.length).toBeGreaterThan(0);
    const view = rummy.playerView(state, 0);

    for (const card of state.stock) {
      expect(JSON.stringify(view.stock)).not.toContain(`"${card}"`);
    }
    // Depth is legitimately public — a player can see how deep the pile is.
    expect(view.stock).toHaveLength(state.stock.length);
    // And distinct, because `legalActions` builds a Set from it: collapsing
    // them to one id would misreport the stock as nearly empty.
    expect(new Set(view.stock).size).toBe(state.stock.length);
  });

  it("poker: the undealt runout is masked but its depth is preserved", () => {
    const poker = createPoker();
    const rng = createRng(909);
    const base = poker.setup({ seats: 4, rng });
    const { state } = poker.startRound!(base, rng);

    expect(state.deck.length).toBeGreaterThan(0);
    const view = poker.playerView(state, 0);

    for (const card of state.deck) {
      expect(JSON.stringify(view.deck)).not.toContain(`"${card}"`);
    }
    expect(view.deck).toHaveLength(state.deck.length);
    expect(new Set(view.deck).size).toBe(state.deck.length);
  });

  it("dominoes: the boneyard stays face down", () => {
    const dominoes = createDominoes();
    const rng = createRng(1234);
    const base = dominoes.setup({ seats: 4, rng });
    const { state } = dominoes.startRound!(base, rng);

    const view = dominoes.playerView(state, 0);
    for (const tile of state.boneyard) {
      expect(JSON.stringify(view.boneyard)).not.toContain(`"${tile}"`);
    }
    expect(view.boneyard).toHaveLength(state.boneyard.length);
  });
});
