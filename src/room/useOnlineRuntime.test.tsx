// @vitest-environment jsdom

/**
 * The online runtime, fed a REAL frame off a real server.
 *
 * Not a hand-built fixture, deliberately. What went wrong here lived in
 * how a real frame's ids meet the client's store: an opponent's cards
 * arrive addressed by slot-named stand-ins (`#deck:-:-:17`), and a deal
 * aimed at a piece the store has never heard of is a silent no-op. A
 * fixture written by somebody who already knows the answer would name
 * pieces the way the fix expects and prove nothing.
 *
 * Fake timers throughout — the runtime paces itself on `setTimeout`, and
 * the point of most of these is WHEN things happen, which a real clock
 * would make slow and flaky. (Fake timers deadlock `waitFor`; nothing
 * here uses it.)
 */

import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpades } from "@/games/spades/rules";
import type { SpadesAction, SpadesState } from "@/games/spades/types";
import { TestClock } from "@/session/clock";
import { GAMES, type GameId } from "@/session/registry";
import { PROTOCOL_VERSION, type FrameView, type ServerMessage } from "@/session/protocol";
import { RoomRegistry } from "@/server/RoomRegistry";
import type { Connection } from "@/server/RoomRuntime";
import { makePeer, Router, type Peer } from "@/server/router";
import { useTableStore } from "@/table/store";
import { openingPosition, READY_BEAT_MS, useOnlineRuntime } from "./useOnlineRuntime";

/* ============================================================
   A real deal, as one player is sent it
   ============================================================ */

class Recorder implements Connection {
  readonly sent: ServerMessage[] = [];
  send(message: ServerMessage): void {
    this.sent.push(message);
  }
  close(): void {}
  bufferedAmount(): number {
    return 0;
  }
}

/** Starts a two-human table and returns what Ada was sent as the opening deal. */
function realDealFrame(gameId: GameId = "spades", seats = 4): FrameView {
  const clock = new TestClock();
  const registry = new RoomRegistry({ clock, seed: 4242 });
  const router = new Router(registry, () => clock.now());
  const say = (peer: Peer, message: unknown) => router.onMessage(peer, JSON.stringify(message));

  const adaConn = new Recorder();
  const ada = makePeer(adaConn, 0);
  say(ada, { t: "hello", token: "ada", protocol: PROTOCOL_VERSION });
  say(ada, { t: "createRoom", name: "Ada" });
  const code = (adaConn.sent.find((m) => m.t === "room") as Extract<ServerMessage, { t: "room" }>).room.code;

  const bo = makePeer(new Recorder(), 0);
  say(bo, { t: "hello", token: "bo", protocol: PROTOCOL_VERSION });
  say(bo, { t: "joinRoom", code, name: "Bo" });

  say(ada, { t: "selectGame", gameId, settings: {}, seats, difficulty: "steady" });
  say(ada, { t: "startGame" });

  const frames = adaConn.sent.filter((m): m is Extract<ServerMessage, { t: "frame" }> => m.t === "frame");
  // The opening deal: the first frame, the one carrying a round number.
  const deal = frames.find((m) => m.frame.dealtRound === 1);
  if (!deal) throw new Error("the server sent no opening deal");
  // What arrives over a socket is JSON, and nothing else.
  return JSON.parse(JSON.stringify(deal.frame)) as FrameView;
}

const definition = createSpades();

/**
 * Every frame Ada is sent over the first few tricks of a two-human table,
 * with both humans playing whatever their own frame says is legal.
 */
function playedFrames(): FrameView[] {
  const clock = new TestClock();
  const registry = new RoomRegistry({ clock, seed: 4242 });
  const router = new Router(registry, () => clock.now());
  const say = (peer: Peer, message: unknown) => router.onMessage(peer, JSON.stringify(message));
  const adaConn = new Recorder();
  const boConn = new Recorder();
  const ada = makePeer(adaConn, 0);
  const bo = makePeer(boConn, 0);
  say(ada, { t: "hello", token: "ada", protocol: PROTOCOL_VERSION });
  say(ada, { t: "createRoom", name: "Ada" });
  const code = (adaConn.sent.find((m) => m.t === "room") as Extract<ServerMessage, { t: "room" }>).room.code;
  say(bo, { t: "hello", token: "bo", protocol: PROTOCOL_VERSION });
  say(bo, { t: "joinRoom", code, name: "Bo" });
  say(ada, { t: "selectGame", gameId: "spades", settings: {}, seats: 4, difficulty: "steady" });
  say(ada, { t: "startGame" });

  const lastFrame = (conn: Recorder) =>
    [...conn.sent].reverse().find((m): m is Extract<ServerMessage, { t: "frame" }> => m.t === "frame")?.frame;
  const players = [
    { peer: ada, conn: adaConn },
    { peer: bo, conn: boConn },
  ];
  for (let turn = 0; turn < 30; turn++) {
    clock.drain();
    const on = (registry.get(code)!.debugDump().table as { currentSeat: number | null }).currentSeat;
    const who = players.find((p) => lastFrame(p.conn)?.seat === on);
    if (on === null || !who) break;
    const legal = definition.legalActions(lastFrame(who.conn)!.state as SpadesState, on);
    const action = legal.find((a) => a.t === "bid" && !a.nil) ?? legal[0];
    if (!action) break;
    say(who.peer, { t: "action", action });
  }
  return adaConn.sent
    .filter((m): m is Extract<ServerMessage, { t: "frame" }> => m.t === "frame")
    .map((m) => JSON.parse(JSON.stringify(m.frame)) as FrameView);
}



function mount(frame: FrameView, withStart = true) {
  return renderHook(() =>
    useOnlineRuntime<SpadesState, SpadesAction>({
      frame,
      submit: () => {},
      nextRound: () => {},
      initial: withStart ? () => openingPosition(definition, 4, frame.seat) : undefined,
    }),
  );
}

/** Pieces sitting in a hand, by seat. */
function handCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of Object.values(useTableStore.getState().placements)) {
    if (p.zone === "hand") out[String(p.seat)] = (out[String(p.seat)] ?? 0) + 1;
  }
  return out;
}

/**
 * Moves the clock in steps, each in its own `act`.
 *
 * Not one big advance: React defers effects until the `act` scope closes,
 * so a single advance past the ready timer fires it, flushes the effect
 * that starts the deal only AFTER the clock has finished moving, and
 * leaves the whole animation unplayed. A real clock interleaves the two;
 * this is how to make a fake one do the same.
 */
function tick(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function visibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("the opening deal, online", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom has no `matchMedia`, which `prefersReducedMotion()` reads.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    useTableStore.getState().reset({}, {});
    visibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("draws the table from the first frame instead of a loading screen", () => {
    // It returned null until the first frame had FINISHED playing, so the
    // whole deal ran with nothing mounted to show it and the table
    // appeared already dealt — the "Dealing you in" screen, and then a
    // deal that looked as though it had mostly happened offstage.
    const { result } = mount(realDealFrame());
    expect(result.current).not.toBeNull();
  });

  it("starts with a full deck and nobody holding anything", () => {
    mount(realDealFrame());
    const placed = Object.values(useTableStore.getState().placements);
    expect(placed).toHaveLength(52);
    expect(placed.every((p) => p.zone === "deck")).toBe(true);
    expect(handCounts()).toEqual({});
  });

  it("does not let anybody act, or light anybody, over an undealt table", () => {
    // Otherwise the bid panel opens over a deck that has not been dealt.
    const { result } = mount(realDealFrame());
    expect(result.current!.isHeroTurn).toBe(false);
    expect(result.current!.busy).toBe(true);
    expect(result.current!.animating).toBe(true);
  });

  it("holds the deal until this player's table has had its beat", () => {
    mount(realDealFrame());

    tick(READY_BEAT_MS - 50);
    // Nothing has moved. This is the guarantee: a player who has just
    // arrived sees the deck, not an animation already underway.
    expect(handCounts()).toEqual({});
  });

  it("then deals to EVERYONE, opponents included", () => {
    // The half of the bug that was silent. Opponents' cards are addressed
    // by stand-in ids, and `moveTo` does nothing to a piece the store is
    // not tracking — so with an empty store every one of their deals was
    // a no-op and their hands appeared whole when the batch reconciled.
    const frame = realDealFrame();
    const me = String(frame.seat);
    mount(frame);

    // Part-way through: some cards have left the deck, not all of them.
    tick(READY_BEAT_MS + 1); // The table is up; the deal begins.
    tick(900);
    const partway = handCounts();
    const others = Object.entries(partway).filter(([seat]) => seat !== me);
    expect(others.length, "opponents should be receiving cards mid-deal").toBeGreaterThan(0);
    const dealt = Object.values(partway).reduce((a, b) => a + b, 0);
    expect(dealt).toBeGreaterThan(0);
    expect(dealt, "the deal should still be in progress").toBeLessThan(52);

    tick(20_000);
    expect(Object.values(handCounts())).toEqual([13, 13, 13, 13]);
  });

  it("deals once under StrictMode, not twice", () => {
    // Reported as "the shuffle runs twice, only on the first round". The
    // frame effect queues whatever frame it is handed, and StrictMode runs
    // every effect twice on mount — so the opening deal was queued twice
    // and played twice: the viewer's cards unmasked back into the deck
    // and dealt all over again. Only the first round, because only the
    // opening frame is present at mount.
    const frame = realDealFrame();
    const me = String(frame.seat);
    const mine: number[] = [];
    const unsubscribe = useTableStore.subscribe(() => mine.push(handCounts()[me] ?? 0));
    renderHook(
      () =>
        useOnlineRuntime<SpadesState, SpadesAction>({
          frame,
          submit: () => {},
          nextRound: () => {},
          initial: () => openingPosition(definition, 4, frame.seat),
        }),
      { wrapper: StrictMode },
    );

    tick(READY_BEAT_MS + 1);
    for (let i = 0; i < 60; i++) tick(500);
    unsubscribe();

    expect(Math.max(...mine)).toBe(13);
    const full = mine.indexOf(13);
    expect(mine.slice(full).every((n) => n === 13), "the hand emptied and was dealt again").toBe(true);
  });

  it("leaves no phantom cards behind in the deck", () => {
    // A card dealt to this player arrives as `unmask` + `deal` under its
    // real id, at a slot the seed had already filled with a stand-in.
    // Seeding both would strand 13 backs in the deck for the whole deal.
    const frame = realDealFrame();
    mount(frame);

    const deckNow = Object.values(useTableStore.getState().placements).filter((p) => p.zone === "deck");
    expect(deckNow).toHaveLength(52);
    const mine = frame.events.filter((e) => e.t === "unmask").length;
    expect(mine, "the fixture should include this player's own cards").toBe(13);

    tick(READY_BEAT_MS + 1);
    tick(1500);
    // Mid-deal the deck must hold exactly what has not been dealt yet.
    const left = Object.values(useTableStore.getState().placements).filter((p) => p.zone === "deck");
    const inHands = Object.values(handCounts()).reduce((a, b) => a + b, 0);
    expect(left.length + inHands).toBe(52);
  });

  it("will not start in a hidden tab, and starts when it is looked at", () => {
    // Its timers are throttled, so the deal would play out unseen and the
    // player would come back to a finished one — the very report.
    visibility("hidden");
    mount(realDealFrame());

    tick(60_000);
    expect(handCounts(), "nothing should play to an empty room").toEqual({});

    act(() => visibility("visible"));
    tick(READY_BEAT_MS + 1);
    tick(900);
    expect(Object.keys(handCounts()).length).toBeGreaterThan(0);
  });

  it("adopts a bare position at once, with no beat", () => {
    // A refresh mid-game sends a position, not a batch. There is nothing
    // to watch, so the board should simply be right.
    const position: FrameView = { ...realDealFrame(), events: [], dealtRound: null, seq: 0 };
    const { result } = mount(position);

    tick(1);
    expect(Object.values(handCounts())).toEqual([13, 13, 13, 13]);
    expect(result.current).not.toBeNull();
  });

  it("does not seed a table it was not handed the deal of", () => {
    // A late arrival's first frame is somebody's move, not round one's
    // deal; seeding an undealt deck under it would be wrong for a moment
    // and then snap.
    const move: FrameView = { ...realDealFrame(), dealtRound: null, events: [] };
    useTableStore.getState().reset({}, {});
    mount(move);
    expect(Object.values(useTableStore.getState().placements).some((p) => p.zone === "deck")).toBe(false);
  });
});

/**
 * The same guarantees for every game that has a deal to watch.
 *
 * Spades is the case the rest of this file is written around; these are
 * the other undealt positions, each a different pile (a boneyard, a chip
 * bank) with a different mix of real and stand-in ids, which is exactly
 * where a seed built from the wrong assumption would fail quietly.
 *
 * Poker is left out deliberately, and not because it is fine: it places
 * nothing before its first deal (`deck` is empty until dealt), so its
 * opening deal has no pile to fly from OFFLINE either. Online matches
 * offline here, and changing poker's own placements is a separate job.
 */
describe.each([
  ["spades", 4],
  ["dominoes", 4],
  ["lrc", 6],
] as const)("the opening deal, online — %s", (gameId, seats) => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    useTableStore.getState().reset({}, {});
    visibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const start = (frame: FrameView) =>
    renderHook(() =>
      useOnlineRuntime({
        frame,
        submit: () => {},
        nextRound: () => {},
        initial: () => openingPosition(GAMES[gameId].create({}), seats, frame.seat),
      }),
    );

  it("tracks every piece the deal is about to move, before it moves anything", () => {
    // `moveTo` skips a piece the store is not tracking, so a deal aimed
    // at one is a silent no-op. Every piece named must already be there.
    const frame = realDealFrame(gameId, seats);
    start(frame);

    const tracked = new Set(Object.keys(useTableStore.getState().placements));
    const aimed = frame.events.flatMap((e) =>
      e.t === "deal" || e.t === "draw" || e.t === "move" ? [e.piece] : [],
    );
    expect(aimed.length, "the opening frame should deal something").toBeGreaterThan(0);
    const missing = aimed.filter((id) => !tracked.has(id));
    expect(missing, "pieces the deal names but the table has never heard of").toEqual([]);
  });

  it("actually moves pieces once the table is up, and lands on the server's position", () => {
    const frame = realDealFrame(gameId, seats);
    start(frame);
    const before = JSON.stringify(useTableStore.getState().placements);

    tick(READY_BEAT_MS + 1);
    tick(1500);
    expect(
      JSON.stringify(useTableStore.getState().placements),
      "the deal should be under way",
    ).not.toBe(before);

    tick(30_000);
    expect(new Set(Object.keys(useTableStore.getState().placements))).toEqual(
      new Set(Object.keys(frame.placements)),
    );
  });
});

describe("a trick, online", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    useTableStore.getState().reset({}, {});
    visibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("lets the collected cards finish flying to the winner before the board is adopted", () => {
    // The settled position holds the won trick as face-down stand-ins, so
    // adopting it swaps the real cards out. That used to happen the moment
    // the collect was APPLIED — the batch goes idle there — and the cards
    // were unmounted 20ms into a 580ms flight: no animation at all.
    const frames = playedFrames();
    let current = frames[0]!;
    const { rerender } = renderHook(() =>
      useOnlineRuntime<SpadesState, SpadesAction>({
        frame: current,
        submit: () => {},
        nextRound: () => {},
        initial: () => openingPosition(definition, 4, current.seat),
      }),
    );
    for (let i = 0; i < 40; i++) tick(500);

    const lifetimes: number[] = [];
    for (const frame of frames.slice(1)) {
      current = frame;
      rerender();
      const collect = frame.events.find((e) => e.t === "collect");
      let landed = -1;
      for (let t = 0; t < 8000; t += 20) {
        tick(20);
        if (!collect) continue;
        const map = useTableStore.getState().placements;
        const inPile = collect.pieces.some((id) => map[id]?.zone === "collected");
        if (landed < 0 && inPile) landed = t;
        if (landed >= 0 && !inPile) {
          lifetimes.push(t - landed);
          break;
        }
      }
    }
    expect(lifetimes.length, "the table should have finished some tricks").toBeGreaterThan(0);
    // DURATION.collect is 0.42s before the per-card stagger.
    for (const ms of lifetimes) expect(ms).toBeGreaterThanOrEqual(400);
  });
});
