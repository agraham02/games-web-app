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
import type { GameDefinition, GameEvent, PieceId, PlacementMap } from "@/engine/types";
import { createSpades } from "@/games/spades/rules";
import { createPoker } from "@/games/poker/rules";
import { createDominoes } from "@/games/dominoes/rules";
import { createRummy } from "@/games/rummy/rules";
import { GAME_IDS, GAMES, type GameId } from "./registry";
import { GameSession } from "./GameSession";
import { TestClock } from "./clock";
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

  it("conceals a piece that was not on the table before the batch at all", () => {
    // The case that leaked every poker hole card. "Not placed yet, so
    // nothing to conceal" is wrong for a deal: the card is face-down in
    // somebody else's hand the moment it lands, and naming it in the deal
    // event hands it over regardless of `faceUp: false`.
    const before: PlacementMap = {};
    const after: PlacementMap = { "H10": hand(1, 0, 2, false) };
    const out = projectEvents(
      [{ t: "deal", piece: "H10", to: 1, faceUp: false }],
      before,
      after,
    );
    expect(JSON.stringify(out)).not.toContain("H10");
    // And it is still a deal to seat 1 — the motion is unchanged, only
    // the identity is withheld.
    expect(out[0]).toMatchObject({ t: "deal", to: 1, faceUp: false });
  });

  it("still names a card dealt face-up to the viewer themselves", () => {
    const before: PlacementMap = {};
    const after: PlacementMap = { "HQ": hand(0, 0, 2, true) };
    const out = projectEvents([{ t: "deal", piece: "HQ", to: 0, faceUp: true }], before, after);
    expect(out).toEqual([{ t: "deal", piece: "HQ", to: 0, faceUp: true }]);
  });

  it("conceals a whole poker deal from every seat but the one it belongs to", () => {
    // End to end against the game that exposed the bug. Poker places no
    // cards at all before dealing, which is what made its pre-batch
    // placements empty and took the unsafe branch.
    const poker = createPoker();
    const rng = createRng(31337);
    const base = poker.setup({ seats: 4, rng });
    const { state: after, events } = poker.startRound!(base, rng);

    for (const viewer of [0, 1, 2, 3]) {
      const out = projectEvents(
        events,
        poker.placements(base, viewer),
        poker.placements(after, viewer),
      );
      const wire = JSON.stringify(out);
      for (const [id, owner] of Object.entries(after.cardOwner)) {
        if (typeof owner !== "number" || owner === viewer) continue;
        expect(wire).not.toContain(`"${id}"`);
      }
    }
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

  it("poker: heads-up, the opponent's hand cannot be deduced by elimination", () => {
    // The sharpest form of the leak, and the reason `cardOwner` matters
    // as much as `deck` did. A player does not need to be TOLD an
    // opponent's cards if they can name every other card in the deck:
    // whatever is left over is the hand. With two seats that is exact.
    const poker = createPoker();
    const rng = createRng(5);
    const base = poker.setup({ seats: 2, rng });
    const { state } = poker.startRound!(base, rng);

    const view = poker.playerView(state, 0);
    const nameable = new Set(
      Object.keys(view.cardOwner).filter((id) => !id.startsWith("??")),
    );
    const unnameable = Object.keys(state.cardOwner)
      .filter((id) => !nameable.has(id))
      .sort();
    const opponentHand = Object.entries(state.cardOwner)
      .filter(([, owner]) => owner === 1)
      .map(([id]) => id)
      .sort();

    expect(opponentHand).toHaveLength(2);
    // The set seat 0 cannot name has to be BIGGER than seat 1's hand —
    // the stub and the burns have to be in there too, or elimination
    // does the leaking that redaction was supposed to prevent.
    expect(unnameable).not.toEqual(opponentHand);
    expect(unnameable.length).toBeGreaterThan(opponentHand.length + 40);
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

/* ============================================================
   The invariant, over every game and every frame of a match
   ============================================================ */

/**
 * Everything above this point checks a FIELD. That is how poker's leak
 * survived being fixed: `playerView` was taught to mask `state.deck`, a
 * test was written asserting `view.deck` held no real ids, and the same
 * cards went on shipping under `state.cardOwner` — which nobody was
 * looking at, because the bug had been found somewhere else. The test
 * was shaped like the bug instead of like the rule.
 *
 * So this asserts the rule: **no id the viewer may not identify appears
 * anywhere in the frame they are sent** — state, placements and events
 * together, every frame of a real match, in all five games, for an
 * opponent and for a spectator.
 *
 * "May not identify" is read off the game's own `placements(state,
 * viewer)`, the same source `redactPlacements` consults, so a game that
 * changes its mind about what is face-down brings this test with it
 * rather than needing to be kept in step by hand.
 */

/**
 * Where a piece id can actually hide in each part of a frame.
 *
 * `state` and `events` are searched as raw JSON, because a game's state
 * has no fixed shape and an event's payload is half game-specific — a
 * structural walk would have to know all five.
 *
 * `placements` is searched by KEY ONLY, and that is exact rather than
 * lenient: not one field of `Placement` is typed `PieceId` (they are
 * zone, seat, index, count and presentation), so the key is the entire
 * identity channel. Searching its values instead produces false
 * positives that look alarming and are not — `ownerTag` holds a player's
 * two-letter initials, so a bot called Sam tags cards "SA" and a blunt
 * substring search reports the Ace of Spades leaking on every board
 * meld in Rummy.
 */
function frameNames(
  payload: { state: unknown; placements: PlacementMap; events: GameEvent[] },
  id: PieceId,
): boolean {
  const quoted = `"${id}"`;
  if (Object.keys(payload.placements).includes(id)) return true;
  return (
    (JSON.stringify(payload.state) ?? "").includes(quoted) ||
    JSON.stringify(payload.events).includes(quoted)
  );
}

/**
 * State a game may keep in the clear even though its placements are
 * face-down, because the cards passed through public view on their way
 * there. Concealing these would be theatre — every player watched them
 * land, and an attentive one has them written down.
 *
 * Narrow on purpose. Anything added here needs the same argument made
 * out loud: not "the UI does not show it" but "everyone already saw it".
 */
const PUBLIC_ONCE_SEEN: Partial<Record<GameId, string[]>> = {
  /** Tricks already taken — every card was played face-up to win them. */
  spades: ["won"],
  /**
   * A mandatory pickup and the discards that came with it. Taking from
   * the pile in Rummy 500 is done openly and takes everything above the
   * card you want, so the whole pool was face-up in front of the table
   * before it reached anybody's hand.
   */
  rummy: ["mandatory"],
};

function withoutPublicHistory(state: unknown, gameId: GameId): unknown {
  const drop = PUBLIC_ONCE_SEEN[gameId];
  if (!drop || typeof state !== "object" || state === null) return state;
  const copy = { ...(state as Record<string, unknown>) };
  for (const key of drop) delete copy[key];
  return copy;
}

describe("the whole frame, every game, every turn", () => {
  const SEATS: Record<GameId, number> = {
    spades: 4,
    dominoes: 4,
    poker: 6,
    lrc: 6,
    rummy: 4,
  };

  /**
   * LRC is the one game with nothing to hide: chips and dice are face-up
   * on the table and there is no hand to conceal. Asserted rather than
   * skipped, so if it ever grows a hidden zone this test says so instead
   * of quietly continuing to pass on an empty search.
   */
  const CONCEALS: Record<GameId, boolean> = {
    spades: true,
    dominoes: true,
    poker: true,
    lrc: false,
    rummy: true,
  };

  for (const gameId of GAME_IDS) {
    it(`${gameId}: names nothing an opponent or a spectator may not identify`, () => {
      const entry = GAMES[gameId];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const definition = entry.create(entry.parse({})) as GameDefinition<any, any>;
      const clock = new TestClock();
      const session = new GameSession({
        definition,
        seats: SEATS[gameId],
        seed: 99,
        clock,
        // Every seat a bot, so the clock alone plays the match out.
        isSeatLive: () => false,
        turnHoldMs: () => 0,
      });

      const leaks: string[] = [];
      let checked = 0;
      let previous: unknown = session.snapshot();

      session.setEmit((frame) => {
        const after = session.snapshot();
        // -1 is `SPECTATOR_SEAT`: a viewer number matching no seat, which
        // is how a spectator gets a table with every hand face down.
        for (const viewer of [-1, 1]) {
          const truthBefore = definition.placements(previous, viewer);
          const truthAfter = definition.placements(after, viewer);
          const forbidden = Object.entries(truthAfter)
            .filter(([, placement]) => !placement.faceUp)
            .map(([id]) => id);
          if (forbidden.length === 0) continue;
          checked++;

          const payload = {
            state: withoutPublicHistory(definition.playerView(after, viewer), gameId),
            placements: redactPlacements(truthAfter, session.pieceMeta()).placements,
            events: projectEvents(frame.events, truthBefore, truthAfter),
          };

          for (const id of forbidden) {
            if (frameNames(payload, id)) leaks.push(`viewer ${viewer} was sent ${id}`);
          }
        }
        previous = after;
      });

      session.start();
      for (let turn = 0; turn < 300 && !definition.isOver(session.snapshot()); turn++) {
        session.settled();
        clock.advance(10);
        if (definition.isRoundOver?.(session.snapshot())) session.nextRound();
      }

      // Guards the guard: a game that dealt nothing would pass vacuously.
      if (CONCEALS[gameId]) expect(checked).toBeGreaterThan(20);
      else expect(checked).toBe(0);
      expect(leaks.slice(0, 5)).toEqual([]);
    });
  }
});
