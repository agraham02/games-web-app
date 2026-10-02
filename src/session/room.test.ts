// @vitest-environment node

/**
 * The room machine, exercised as plain function calls.
 *
 * Every scenario the spec singles out as worth testing explicitly is in
 * here — simultaneous starts, two players racing the last seat, a private
 * approval landing after the requester has gone, a leader disconnecting
 * mid-game — and the reason they are cheap to write is that this module
 * has no sockets and no clock in it. Getting these right against real
 * connections would mean orchestrating timing; here it is a sequence of
 * calls with an explicit `now`.
 */

import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import { GAMES, GAME_IDS, gameEntry } from "./registry";
import {
  applyCommand,
  createRoom,
  holdsSeat,
  isIdle,
  isSeatLive,
  makeCode,
  mayContinueRound,
  openSeats,
  MAX_ROOM_MEMBERS,
  MIN_ROOM_PLAYERS,
  seatOf,
  seatingOrder,
  seatingPlan,
  teamOfSeat,
  type Room,
  type RoomCommand,
  type RoomContext,
  type SessionId,
} from "./room";

const LEADER = "s-leader";

function room(now = 0): Room {
  return createRoom({ code: "ABCD", leader: LEADER, leaderName: "Ada", now });
}

/** Applies a command and fails loudly if it was rejected. */
function ok(r: Room, cmd: RoomCommand, ctx: Partial<RoomContext> & { actor: SessionId }): Room {
  const res = applyCommand(r, cmd, { now: 1, ...ctx });
  if (!res.ok) throw new Error(`expected ok, got ${res.error} for ${cmd.t}`);
  return res.room;
}

function effectsOf(r: Room, cmd: RoomCommand, ctx: Partial<RoomContext> & { actor: SessionId }) {
  const res = applyCommand(r, cmd, { now: 1, ...ctx });
  if (!res.ok) throw new Error(`expected ok, got ${res.error}`);
  return res.effects;
}

/** A public room with the leader plus `names.length` other members. */
function withMembers(names: string[]): Room {
  let r = room(0);
  names.forEach((name, i) => {
    r = ok(r, { t: "join", name }, { actor: `s-${i}`, now: i + 1 });
  });
  return r;
}

function spades(r: Room, seats = 4): Room {
  return ok(
    r,
    { t: "selectGame", gameId: "spades", settings: {}, seats, difficulty: "steady" },
    { actor: LEADER },
  );
}

describe("join codes", () => {
  it("are four characters and never contain the letters people mistype", () => {
    const rng = createRng(12345);
    for (let i = 0; i < 500; i++) {
      const code = makeCode(rng);
      expect(code).toHaveLength(4);
      expect(code).toMatch(/^[A-Z]{4}$/);
      expect(code).not.toMatch(/[IO]/); // read aloud as 1 and 0
    }
  });
});

describe("membership", () => {
  it("requires a name that is not blank or already taken", () => {
    const r = withMembers(["Sam"]);
    expect(applyCommand(r, { t: "join", name: "   " }, { actor: "s-x", now: 5 })).toEqual({
      ok: false,
      error: "name-required",
    });
    // Case-insensitively taken: "sam" and "Sam" in one roster is exactly
    // the confusion the uniqueness rule exists to prevent.
    expect(applyCommand(r, { t: "join", name: "sam" }, { actor: "s-x", now: 5 })).toEqual({
      ok: false,
      error: "name-taken",
    });
  });

  it("treats a re-join from a known session as a reconnect, not an error", () => {
    // A lobby refresh arrives exactly like this. Rejecting it would make an
    // ordinary page reload look like a failure.
    let r = withMembers(["Sam"]);
    r = ok(r, { t: "setConnected", connected: false }, { actor: "s-0" });
    expect(r.members["s-0"]!.connected).toBe(false);

    r = ok(r, { t: "join", name: "Sam" }, { actor: "s-0", now: 9 });
    expect(r.members["s-0"]!.connected).toBe(true);
    expect(Object.keys(r.members)).toHaveLength(2);
  });

  it("puts a private room's newcomers in a queue instead of the roster", () => {
    let r = withMembers([]);
    r = ok(r, { t: "setPrivacy", privacy: "private" }, { actor: LEADER });
    r = ok(r, { t: "join", name: "Sam" }, { actor: "s-0", now: 5 });

    expect(r.members["s-0"]).toBeUndefined();
    expect(r.pending["s-0"]!.name).toBe("Sam");

    r = ok(r, { t: "approve", session: "s-0" }, { actor: LEADER });
    expect(r.members["s-0"]!.name).toBe("Sam");
    expect(r.pending["s-0"]).toBeUndefined();
  });

  it("still admits a requester who gave up and disconnected before approval", () => {
    // Named in the spec as worth testing. The membership simply waits for
    // them; nothing about admitting someone requires them to be attached.
    let r = withMembers([]);
    r = ok(r, { t: "setPrivacy", privacy: "private" }, { actor: LEADER });
    r = ok(r, { t: "join", name: "Ghost" }, { actor: "s-gone", now: 5 });

    r = ok(r, { t: "approve", session: "s-gone" }, { actor: LEADER, now: 90 });
    expect(r.members["s-gone"]).toBeDefined();
    expect(r.members["s-gone"]!.connected).toBe(false);
  });

  it("refuses leader-only powers to everyone else", () => {
    const r = withMembers(["Sam"]);
    for (const cmd of [
      { t: "kick", session: LEADER },
      { t: "promote", session: LEADER },
      { t: "setPrivacy", privacy: "private" },
      { t: "startGame" },
      { t: "endGame" },
    ] as RoomCommand[]) {
      const res = applyCommand(r, cmd, { actor: "s-0", now: 5 });
      expect(res.ok).toBe(false);
    }
    // And to a total stranger, who is not even a member.
    expect(applyCommand(r, { t: "startGame" }, { actor: "nobody", now: 5 })).toEqual({
      ok: false,
      error: "not-a-member",
    });
  });
});

describe("leadership", () => {
  it("passes to the longest-standing connected member when the leader drops", () => {
    let r = withMembers(["Sam", "Kofi"]);
    r = ok(r, { t: "setConnected", connected: false }, { actor: LEADER });
    expect(r.leader).toBe("s-0"); // Sam joined before Kofi.
  });

  it("skips members who are themselves disconnected", () => {
    let r = withMembers(["Sam", "Kofi"]);
    r = ok(r, { t: "setConnected", connected: false }, { actor: "s-0" });
    r = ok(r, { t: "setConnected", connected: false }, { actor: LEADER });
    expect(r.leader).toBe("s-1");
  });

  it("does not hand leadership back when the old leader reconnects", () => {
    // Deliberate: yanking it out of the new leader's hands the moment a
    // phone reconnects is worse than asking them to hand it over.
    let r = withMembers(["Sam"]);
    r = ok(r, { t: "setConnected", connected: false }, { actor: LEADER });
    expect(r.leader).toBe("s-0");
    r = ok(r, { t: "setConnected", connected: true }, { actor: LEADER });
    expect(r.leader).toBe("s-0");
  });

  it("passes on when the leader leaves outright", () => {
    let r = withMembers(["Sam"]);
    r = ok(r, { t: "leave" }, { actor: LEADER });
    expect(r.leader).toBe("s-0");
    expect(r.members[LEADER]).toBeUndefined();
  });

  it("gives an emptied room to whoever walks in next", () => {
    // The last one out has nobody to hand the lead to, so the room still
    // names them; the next person in would otherwise be in a room nobody
    // can start.
    let r = ok(room(), { t: "leave" }, { actor: LEADER });
    expect(r.members).toEqual({});
    r = ok(r, { t: "join", name: "Late" }, { actor: "s-late" });
    expect(r.leader).toBe("s-late");
  });

  it("lets the next person straight into an emptied private room", () => {
    // There is nobody left to answer a knock.
    let r = ok(room(), { t: "setPrivacy", privacy: "private" }, { actor: LEADER });
    r = ok(r, { t: "leave" }, { actor: LEADER });
    r = ok(r, { t: "join", name: "Late" }, { actor: "s-late" });
    expect(r.pending).toEqual({});
    expect(r.members["s-late"]).toBeDefined();
    expect(r.leader).toBe("s-late");
  });

  it("still makes a newcomer knock while somebody is there to answer", () => {
    let r = ok(room(), { t: "setPrivacy", privacy: "private" }, { actor: LEADER });
    r = ok(r, { t: "join", name: "Knocker" }, { actor: "s-knock" });
    expect(r.pending["s-knock"]).toBeDefined();
    expect(r.leader).toBe(LEADER);
  });

  it("closes the room, stopping a game first so it can be settled", () => {
    let r = spades(withMembers(["Sam"]));
    r = ok(r, { t: "startGame" }, { actor: LEADER });
    expect(applyCommand(r, { t: "closeRoom" }, { actor: "s-0", now: 2 })).toEqual({
      ok: false,
      error: "not-leader",
    });
    const res = applyCommand(r, { t: "closeRoom" }, { actor: LEADER, now: 2 });
    if (!res.ok) throw new Error(res.error);
    expect(res.room.game).toBeNull();
    // The order is the point: the stop settles money, the close carries it.
    expect(res.effects.map((e) => e.t)).toEqual(["stopSession", "close"]);
    expect(res.effects[1]).toEqual({ t: "close", by: "Ada" });
  });

  it("closes a lobby with nothing to stop", () => {
    expect(effectsOf(room(), { t: "closeRoom" }, { actor: LEADER })).toEqual([{ t: "close", by: "Ada" }]);
  });

  it("lets a freshly promoted leader immediately use a leader-only power", () => {
    // The spec's scenario: leader drops mid-game, the new one acts at once.
    let r = withMembers(["Sam", "Kofi"]);
    r = spades(r);
    r = ok(r, { t: "startGame" }, { actor: LEADER });
    r = ok(r, { t: "setConnected", connected: false }, { actor: LEADER });

    expect(r.leader).toBe("s-0");
    const res = applyCommand(r, { t: "endGame" }, { actor: "s-0", now: 20 });
    expect(res.ok).toBe(true);
  });
});

describe("starting a game", () => {
  it("refuses to start for one person on their own", () => {
    // A room game with a single human is the offline game plus a round
    // trip per bot turn, and the lobby sends them to the solo screens
    // instead. The button there is disabled; this is the rule behind it.
    let r = room();
    r = spades(r);
    expect(applyCommand(r, { t: "startGame" }, { actor: LEADER, now: 10 })).toEqual({
      ok: false,
      error: "needs-two-players",
    });
  });

  it("counts who is actually here, not who is on the roster", () => {
    // A member whose phone has slept gets a bot seat the instant the deal
    // happens, so counting them would admit exactly the game the rule
    // exists to prevent — one human against three bots, over a socket.
    let r = withMembers(["Sam"]);
    r = spades(r);
    r = ok(r, { t: "setConnected", connected: false }, { actor: "s-0" });
    expect(applyCommand(r, { t: "startGame" }, { actor: LEADER, now: 10 })).toEqual({
      ok: false,
      error: "needs-two-players",
    });

    // Back on, and the same command goes through.
    r = ok(r, { t: "setConnected", connected: true }, { actor: "s-0" });
    expect(applyCommand(r, { t: "startGame" }, { actor: LEADER, now: 10 }).ok).toBe(true);
  });

  it("starts as soon as MIN_ROOM_PLAYERS are here", () => {
    // Pinned to the constant rather than to the number two, so raising it
    // cannot leave this test asserting the old rule.
    let r = withMembers(
      Array.from({ length: MIN_ROOM_PLAYERS - 1 }, (_, i) => `Player${String(i)}`),
    );
    r = spades(r);
    expect(applyCommand(r, { t: "startGame" }, { actor: LEADER, now: 10 }).ok).toBe(true);
  });

  it("refuses a second start — the simultaneous-click race", () => {
    let r = withMembers(["Sam"]);
    r = spades(r);
    const first = applyCommand(r, { t: "startGame" }, { actor: LEADER, now: 10 });
    expect(first.ok).toBe(true);

    // The second caller genuinely observes the first one's game, because a
    // room's commands are serialised. No second session gets stacked on.
    const second = applyCommand(first.ok ? first.room : r, { t: "startGame" }, { actor: LEADER, now: 10 });
    expect(second).toEqual({ ok: false, error: "game-already-running" });
  });

  /**
   * The lobby stays reachable while a match runs — that is what "Step
   * away" goes back to — and its game picker was gated only on being
   * leader. `startGame` has carried this guard forever; `selectGame`
   * never did.
   */
  describe("changing the game under a running match", () => {
    it("refuses a different game", () => {
      let r = withMembers(["Sam"]);
      r = spades(r);
      r = ok(r, { t: "startGame" }, { actor: LEADER, now: 10 });

      const res = applyCommand(
        r,
        { t: "selectGame", gameId: "poker", settings: {}, seats: 6, difficulty: "steady" },
        { actor: LEADER, now: 11 },
      );

      // Allowed, this used to swap every client's table component to
      // poker while the live session went on dealing spades.
      expect(res).toEqual({ ok: false, error: "game-already-running" });
    });

    it("refuses a different seat count for the same game", () => {
      // The same door, and the more plausible accident: re-laying the
      // geometry for a seat count the running game does not have.
      let r = withMembers(["Sam"]);
      r = spades(r);
      r = ok(r, { t: "startGame" }, { actor: LEADER, now: 10 });

      const res = applyCommand(
        r,
        { t: "selectGame", gameId: "spades", settings: {}, seats: 2, difficulty: "steady" },
        { actor: LEADER, now: 11 },
      );
      expect(res.ok).toBe(false);
    });

    it("holds a bounded number of people, and still lets them back in", () => {
      // Nothing capped this. A room is an in-memory object on one process
      // and every member is broadcast to on every roster change, so the
      // number wanted a ceiling whether or not anybody would ever reach
      // it. Well above the ten seats of the largest game, because
      // spectators are real and a room may hold more people than chairs.
      const names = Array.from({ length: MAX_ROOM_MEMBERS - 1 }, (_, i) => `P${i}`);
      const r = withMembers(names);
      expect(Object.keys(r.members)).toHaveLength(MAX_ROOM_MEMBERS);

      expect(
        applyCommand(r, { t: "join", name: "Late" }, { actor: "s-late", now: 99 }),
      ).toEqual({ ok: false, error: "room-full" });

      // But somebody already in it is RECONNECTING, not arriving. A cap
      // that refused them would turn a full room into one nobody could
      // get back into after a dropped socket.
      const back = applyCommand(r, { t: "join", name: "P0" }, { actor: "s-0", now: 100 });
      expect(back.ok).toBe(true);
    });

    it("refuses to move the seats once a game has dealt", () => {
      // The same door again, and the one that looked like it WORKED.
      // `seatMembers` reads the plan once, at `startGame`, and the running
      // session keeps what it was handed — so rearranging mid-match would
      // update the list on every screen while the table carried on exactly
      // as before. A change that appears to take and does nothing is worse
      // than a refusal.
      let r = withMembers(["Sam", "Ali", "Kit"]);
      r = spades(r);
      r = ok(r, { t: "startGame" }, { actor: LEADER, now: 10 });

      expect(
        applyCommand(
          r,
          { t: "arrangeSeats", plan: ["s-0", LEADER, "s-1", "s-2"] },
          { actor: LEADER, now: 11 },
        ),
      ).toEqual({ ok: false, error: "game-already-running" });
    });

    it("allows it again once the game has ended", () => {
      let r = withMembers(["Sam"]);
      r = spades(r);
      r = ok(r, { t: "startGame" }, { actor: LEADER, now: 10 });
      r = ok(r, { t: "endGame" }, { actor: LEADER, now: 11 });

      const res = applyCommand(
        r,
        { t: "selectGame", gameId: "poker", settings: {}, seats: 6, difficulty: "steady" },
        { actor: LEADER, now: 12 },
      );
      expect(res.ok).toBe(true);
    });
  });

  it("refuses a game that is not wired for online play", () => {
    // Every game is online now — Rummy was the last one in — so there is
    // no longer a real game that trips this guard. The guard still has to
    // work: a game half-wired is exactly the state this repo has been in
    // four times, and shipping a lobby that offers an unplayable table is
    // the failure it exists to stop.
    //
    // So the flag is flipped for the length of the test rather than the
    // assertion being deleted. Deleting it would mean the next game added
    // in pieces has nothing watching it.
    const entry = GAMES.rummy;
    const wasOnline = entry.online;
    entry.online = false;
    try {
      const r = withMembers([]);
      expect(
        applyCommand(
          r,
          { t: "selectGame", gameId: "rummy", settings: {}, seats: 4, difficulty: "steady" },
          { actor: LEADER, now: 1 },
        ),
      ).toEqual({ ok: false, error: "game-not-online" });
    } finally {
      entry.online = wasOnline;
    }
  });

  it("asks the runtime to stand up a session with the agreed shape", () => {
    let r = withMembers(["Sam"]);
    r = spades(r);
    const effects = effectsOf(r, { t: "startGame" }, { actor: LEADER });
    expect(effects[0]).toMatchObject({ t: "startSession", gameId: "spades", seats: 4 });
  });

  it("fills seats first and overflows the rest into spectators", () => {
    // Six members, four seats: four sit, two watch.
    let r = withMembers(["Sam", "Kofi", "Jo", "Ada2", "Rui"]);
    r = spades(r, 4);
    r = ok(r, { t: "startGame" }, { actor: LEADER });

    const seated = r.game!.seatOwner.filter(Boolean);
    expect(seated).toHaveLength(4);
    expect(r.game!.present).toHaveLength(6);
    const watching = r.game!.present.filter((s) => seatOf(r, s) === null);
    expect(watching).toHaveLength(2);
  });

  it("seats partners across, not side by side — the seat is the team", () => {
    // Partnership games in this app are seats 0/2 against 1/3, so arranging
    // somebody into a seat IS putting them on that team.
    let r = withMembers(["Sam", "Kofi", "Jo"]);
    r = spades(r, 4);
    r = ok(r, { t: "arrangeSeats", plan: [LEADER, "s-0", "s-1", "s-2"] }, { actor: LEADER });
    expect([0, 1, 2, 3].map((i) => teamOfSeat(r, i))).toEqual([0, 1, 0, 1]);
    r = ok(r, { t: "startGame" }, { actor: LEADER });

    const seats = r.game!.seatOwner;
    expect([seats[0], seats[2]].sort()).toEqual([LEADER, "s-1"].sort());
    expect([seats[1], seats[3]].sort()).toEqual(["s-0", "s-2"].sort());
  });
});

describe("the seating plan", () => {
  /** Poker: no partnerships, so seats follow the plan exactly. */
  function poker(r: Room, seats = 6): Room {
    return ok(
      r,
      { t: "selectGame", gameId: "poker", settings: {}, seats, difficulty: "steady" },
      { actor: LEADER },
    );
  }

  it("starts from join order, with bots in the seats nobody fills", () => {
    const r = poker(withMembers(["Sam", "Kofi"]), 4);
    expect(seatingPlan(r)).toEqual([LEADER, "s-0", "s-1", null]);
    expect(seatingOrder(r).map((m) => m.name)).toEqual(["Ada", "Sam", "Kofi"]);
  });

  it("deals the seats as the leader arranged them, bots between people included", () => {
    let r = poker(withMembers(["Sam", "Kofi"]), 4);
    r = ok(r, { t: "arrangeSeats", plan: ["s-1", null, LEADER, "s-0"] }, { actor: LEADER });
    expect(seatingPlan(r)).toEqual(["s-1", null, LEADER, "s-0"]);

    r = ok(r, { t: "startGame" }, { actor: LEADER, now: 10 });
    expect(r.game!.seatOwner).toEqual(["s-1", null, LEADER, "s-0"]);
  });

  it("gives somebody who joins later the first bot seat", () => {
    let r = poker(withMembers(["Sam"]), 4);
    r = ok(r, { t: "arrangeSeats", plan: [null, "s-0", null, LEADER] }, { actor: LEADER });
    r = ok(r, { t: "join", name: "Jo" }, { actor: "s-jo", now: 5 });
    expect(seatingPlan(r)).toEqual(["s-jo", "s-0", null, LEADER]);
  });

  it("leaves a bot in the arranged seat of somebody who left", () => {
    let r = poker(withMembers(["Sam", "Kofi"]), 4);
    r = ok(r, { t: "arrangeSeats", plan: [LEADER, "s-0", "s-1", null] }, { actor: LEADER });
    r = ok(r, { t: "leave" }, { actor: "s-0", now: 5 });
    expect(seatingPlan(r)).toEqual([LEADER, null, "s-1", null]);
  });

  it("follows the game's seat count, and never leaves a person watching while a bot sits", () => {
    let r = poker(withMembers(["Sam", "Kofi", "Jo"]), 6);
    r = ok(
      r,
      { t: "arrangeSeats", plan: [null, null, null, null, "s-2", LEADER] },
      { actor: LEADER },
    );
    // Down to four seats: the two past the end come up into bot seats.
    r = poker(r, 4);
    expect(seatingPlan(r).slice(0, 4).filter(Boolean)).toHaveLength(4);
    // Three seats for four people: one watches.
    r = poker(r, 3);
    const plan = seatingPlan(r);
    expect(plan.slice(0, 3).every(Boolean)).toBe(true);
    expect(plan.slice(3)).toHaveLength(1);
  });

  it("is the leader's to change, and only between games", () => {
    let r = poker(withMembers(["Sam"]), 4);
    expect(
      applyCommand(r, { t: "arrangeSeats", plan: ["s-0", LEADER] }, { actor: "s-0", now: 2 }),
    ).toEqual({ ok: false, error: "not-leader" });

    r = ok(r, { t: "startGame" }, { actor: LEADER, now: 10 });
    expect(
      applyCommand(r, { t: "shuffleSeats" }, { actor: LEADER, now: 11, rng: createRng(1) }),
    ).toEqual({ ok: false, error: "game-already-running" });
  });

  it("refuses a plan naming a stranger, or somebody twice", () => {
    const r = poker(withMembers(["Sam"]), 4);
    for (const plan of [["s-nobody"], [LEADER, LEADER], [42 as unknown as string]]) {
      expect(applyCommand(r, { t: "arrangeSeats", plan }, { actor: LEADER, now: 2 })).toEqual({
        ok: false,
        error: "bad-seat-plan",
      });
    }
  });

  it("shuffles people and bots together, from the seed, keeping everybody", () => {
    const r = poker(withMembers(["Sam", "Kofi"]), 5);
    const shuffle = (seed: number) =>
      seatingPlan(ok(r, { t: "shuffleSeats" }, { actor: LEADER, rng: createRng(seed) }));
    expect(shuffle(3)).toEqual(shuffle(3));
    expect(shuffle(3).filter(Boolean).sort()).toEqual([LEADER, "s-0", "s-1"].sort());
    expect(shuffle(3).filter((s) => s === null)).toHaveLength(2);
  });

  it("shuffles the people a full table leaves watching in with everybody else", () => {
    // Five people, four seats: whoever watches is only watching because
    // the table is full, so a shuffle has to be able to seat them.
    const r = poker(withMembers(["Sam", "Kofi", "Jo", "Rui"]), 4);
    const watching = (seed: number) =>
      seatingPlan(ok(r, { t: "shuffleSeats" }, { actor: LEADER, rng: createRng(seed) }))[4];
    const seen = new Set(Array.from({ length: 20 }, (_, seed) => watching(seed)));
    expect(seen.size).toBeGreaterThan(1);
    expect(seatingPlan(r)).toHaveLength(5);
  });

  it("has teams only in a partnership game", () => {
    const r = poker(withMembers(["Sam"]), 4);
    expect(teamOfSeat(r, 0)).toBeNull();
    expect(teamOfSeat(spades(r), 3)).toBe(1);
    // Past the last seat is nobody's team.
    expect(teamOfSeat(spades(r), 4)).toBeNull();
  });
});

describe("seats, presence and bots", () => {
  function started(extra: string[] = ["Sam"]): Room {
    let r = withMembers(extra);
    r = spades(r, 4);
    return ok(r, { t: "startGame" }, { actor: LEADER });
  }

  it("says who has a seat waiting for them, whether or not they are at it", () => {
    // The line between a member the room keeps while they are gone and one
    // it lets go of after LOBBY_GRACE_MS.
    const lobby = spades(withMembers(["Sam", "Kofi", "Jo", "Rui"]), 4);
    expect(holdsSeat(lobby, LEADER)).toBe(false);

    const r = ok(lobby, { t: "startGame" }, { actor: LEADER });
    const away = ok(r, { t: "exitGame" }, { actor: LEADER });
    expect(holdsSeat(away, LEADER), "stepped away, seat still theirs").toBe(true);
    // Five people, four seats: whoever did not fit is only watching.
    const watcher = seatingPlan(lobby)[4]!;
    expect(holdsSeat(r, watcher)).toBe(false);
  });

  it("counts a seat live only when its owner is connected AND at the table", () => {
    const r = started();
    expect(isSeatLive(r, 0)).toBe(true);

    // Backed out to the lobby: still theirs, no longer live.
    const away = ok(r, { t: "exitGame" }, { actor: LEADER });
    expect(away.game!.seatOwner[0]).toBe(LEADER);
    expect(isSeatLive(away, 0)).toBe(false);

    // Disconnected while at the table: same answer, different cause.
    const dropped = ok(r, { t: "setConnected", connected: false }, { actor: LEADER });
    expect(dropped.game!.seatOwner[0]).toBe(LEADER);
    expect(isSeatLive(dropped, 0)).toBe(false);
  });

  it("keeps a seat out of reach while its owner is away", () => {
    // The spec's "two players racing the last open seat" — except the seat
    // is not open, it is being sat out, and that is the whole point.
    let r = started();
    r = ok(r, { t: "exitGame" }, { actor: "s-0" });
    const theirSeat = r.game!.seatOwner.indexOf("s-0");
    expect(theirSeat).toBeGreaterThanOrEqual(0);

    r = ok(r, { t: "join", name: "Latecomer" }, { actor: "s-late", now: 50 });
    r = ok(r, { t: "enterGame" }, { actor: "s-late" });

    expect(r.game!.seatOwner[theirSeat]).toBe("s-0");
    expect(seatOf(r, "s-late")).not.toBe(theirSeat);
  });

  it("hands a returning player the same seat with no re-picking", () => {
    let r = started();
    const seat = seatOf(r, LEADER);
    r = ok(r, { t: "setConnected", connected: false }, { actor: LEADER });
    r = ok(r, { t: "setConnected", connected: true }, { actor: LEADER });

    expect(seatOf(r, LEADER)).toBe(seat);
    expect(isSeatLive(r, seat!)).toBe(true);
  });

  it("gives only one of two racers the last free seat", () => {
    // Two seats filled by the two members, two genuinely open. Both
    // newcomers enter; each must get a distinct seat, and when they run
    // out the next one watches instead.
    let r = started();
    const free = openSeats(r);
    expect(free).toHaveLength(2);

    r = ok(r, { t: "join", name: "A" }, { actor: "s-a", now: 40 });
    r = ok(r, { t: "join", name: "B" }, { actor: "s-b", now: 41 });
    r = ok(r, { t: "join", name: "C" }, { actor: "s-c", now: 42 });
    r = ok(r, { t: "enterGame" }, { actor: "s-a" });
    r = ok(r, { t: "enterGame" }, { actor: "s-b" });
    r = ok(r, { t: "enterGame" }, { actor: "s-c" });

    expect(seatOf(r, "s-a")).not.toBeNull();
    expect(seatOf(r, "s-b")).not.toBeNull();
    expect(seatOf(r, "s-a")).not.toBe(seatOf(r, "s-b"));
    // Table full: the third is a spectator whether or not they wanted to be.
    expect(seatOf(r, "s-c")).toBeNull();
    expect(r.game!.present).toContain("s-c");
  });

  it("frees the seat of somebody who leaves the room outright", () => {
    // Distinct from backing out. A non-member cannot hold a seat, or a
    // room could strand itself with no way to seat anyone.
    let r = started();
    const seat = seatOf(r, "s-0")!;
    r = ok(r, { t: "leave" }, { actor: "s-0" });
    expect(r.game!.seatOwner[seat]).toBeNull();
    expect(openSeats(r)).toContain(seat);
  });

  it("ends the game once no seat has a live human left", () => {
    const r = started();
    const first = applyCommand(r, { t: "exitGame" }, { actor: LEADER, now: 10 });
    expect(first.ok && first.room.game).not.toBeNull();

    const second = applyCommand(first.ok ? first.room : r, { t: "exitGame" }, { actor: "s-0", now: 11 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.room.game).toBeNull();
    expect(second.effects).toContainEqual({ t: "stopSession", reason: "all-bots" });
  });

  it("ends the game when the last human disconnects rather than playing on to an empty room", () => {
    // Two of them, because a game cannot start with fewer
    // (MIN_ROOM_PLAYERS) — so "the last human" is genuinely the second one
    // to go, and the first dropping must NOT end anything.
    let r = started(["Sam"]);
    expect(r.game).not.toBeNull();
    r = ok(r, { t: "setConnected", connected: false }, { actor: "s-0", now: 30 });
    expect(r.game, "one of two leaving is a bot takeover, not the end").not.toBeNull();

    const res = applyCommand(r, { t: "setConnected", connected: false }, { actor: LEADER, now: 31 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.room.game).toBeNull();
  });

  it("returns everyone to the lobby when the leader ends it", () => {
    const r = started();
    const effects = effectsOf(r, { t: "endGame" }, { actor: LEADER });
    expect(effects).toContainEqual({ t: "stopSession", reason: "ended-by-leader" });
    const after = ok(r, { t: "endGame" }, { actor: LEADER });
    expect(after.game).toBeNull();
    // The room itself survives — ending a game is not ending the room.
    expect(Object.keys(after.members)).toHaveLength(2);
  });
});

describe("settings coming off the wire", () => {
  it("clamps hostile numbers before they reach a game factory", () => {
    // Clamping lives in the registry's `parse`, so that is what is tested
    // here — directly, and independently of which games happen to have an
    // online table this week.
    const poker = gameEntry("poker").parse({
      startingStack: Number.POSITIVE_INFINITY,
      bigBlind: -5,
    });
    expect(Number.isFinite(poker.startingStack as number)).toBe(true);
    expect(poker.bigBlind as number).toBeGreaterThanOrEqual(2);

    const lrc = gameEntry("lrc").parse({ target: Number.NaN });
    expect(Number.isFinite(lrc.target as number)).toBe(true);
  });

  it("clamps a seat count to what the game actually supports", () => {
    let r = withMembers([]);
    r = ok(
      r,
      { t: "selectGame", gameId: "spades", settings: {}, seats: 999, difficulty: "steady" },
      { actor: LEADER },
    );
    expect(r.seats).toBe(4); // Spades is exactly four.
  });

  it("clamps to the RULESET's seats — Caribbean dominoes is four-handed", () => {
    // The entry allows 2–4 because Block & Draw does. A room left on three
    // started a session the engine dealt four hands into, and the fourth
    // seat played on with no pod on anybody's table.
    let r = withMembers([]);
    r = ok(
      r,
      { t: "selectGame", gameId: "dominoes", settings: { mode: "caribbean" }, seats: 3, difficulty: "steady" },
      { actor: LEADER },
    );
    expect(r.seats).toBe(4);
    r = ok(
      r,
      { t: "selectGame", gameId: "dominoes", settings: { mode: "classic" }, seats: 3, difficulty: "steady" },
      { actor: LEADER },
    );
    expect(r.seats).toBe(3);
  });

  it("starts a Caribbean session with four seats even from a stale three", () => {
    let r = withMembers(["Bo"]);
    r = ok(
      r,
      { t: "selectGame", gameId: "dominoes", settings: { mode: "caribbean" }, seats: 4, difficulty: "steady" },
      { actor: LEADER },
    );
    const stale: Room = { ...r, seats: 3 };
    const start = effectsOf(stale, { t: "startGame" }, { actor: LEADER, now: 10 }).find(
      (e) => e.t === "startSession",
    );
    expect(start && start.t === "startSession" ? start.seats : null).toBe(4);
  });

  it("refuses any game the room has no table for", () => {
    // Derived from the registry rather than naming games, so this cannot
    // go stale as they are wired up one at a time — which it did, once.
    //
    // The list is empty today, and that is the answer rather than a gap:
    // all five games are playable in a room. The loop stays because it is
    // the thing that will catch the sixth.
    const r = withMembers([]);
    const offline = GAME_IDS.filter((id) => !GAMES[id].online);

    for (const gameId of offline) {
      expect(
        applyCommand(
          r,
          { t: "selectGame", gameId, settings: {}, seats: 4, difficulty: "steady" },
          { actor: LEADER, now: 1 },
        ),
      ).toEqual({ ok: false, error: "game-not-online" });
    }
  });
});

describe("the turn timer, as a room setting", () => {
  it("is on in a new room, at thirty seconds", () => {
    expect(room().turnTimer).toEqual({ on: true, seconds: 30 });
  });

  it("is the leader's to change, in steps of five from five to sixty", () => {
    const r = withMembers(["Sam"]);
    expect(applyCommand(r, { t: "setTurnTimer", seconds: 10 }, { actor: "s-0", now: 1 })).toEqual({
      ok: false,
      error: "not-leader",
    });
    const at = (seconds: number) => ok(r, { t: "setTurnTimer", seconds }, { actor: LEADER }).turnTimer.seconds;
    expect(at(45)).toBe(45);
    expect(at(12)).toBe(10); // snapped to a step
    expect(at(2)).toBe(5);
    expect(at(999)).toBe(60);
    expect(applyCommand(r, { t: "setTurnTimer", seconds: Number.NaN }, { actor: LEADER, now: 1 })).toEqual({
      ok: false,
      error: "bad-turn-timer",
    });
  });

  it("keeps its length while switched off, so switching it on restores it", () => {
    let r = ok(room(), { t: "setTurnTimer", seconds: 20 }, { actor: LEADER });
    r = ok(r, { t: "setTurnTimer", on: false }, { actor: LEADER });
    expect(r.turnTimer).toEqual({ on: false, seconds: 20 });
    r = ok(r, { t: "setTurnTimer", on: true }, { actor: LEADER });
    expect(r.turnTimer).toEqual({ on: true, seconds: 20 });
  });

  it("is fixed while a game is running", () => {
    let r = spades(withMembers(["Sam"]));
    r = ok(r, { t: "startGame" }, { actor: LEADER });
    expect(applyCommand(r, { t: "setTurnTimer", on: false }, { actor: LEADER, now: 2 })).toEqual({
      ok: false,
      error: "game-already-running",
    });
  });
});

describe("idle: the timer gave somebody's seat to a bot", () => {
  function started(): Room {
    const r = spades(withMembers(["Sam"]));
    return ok(r, { t: "startGame" }, { actor: LEADER });
  }

  it("hands the seat to a bot, and says so", () => {
    const r = started();
    const seat = seatOf(r, "s-0")!;
    const res = applyCommand(r, { t: "markIdle" }, { actor: "s-0", now: 2 });
    if (!res.ok) throw new Error(res.error);
    expect(isSeatLive(res.room, seat)).toBe(false);
    expect(isIdle(res.room, "s-0")).toBe(true);
    expect(res.effects).toContainEqual({ t: "notice", text: "A bot is playing for Sam" });
  });

  it("gives it back when they say they are back, or come back to the table", () => {
    const idle = ok(started(), { t: "markIdle" }, { actor: "s-0" });
    const seat = seatOf(idle, "s-0")!;
    expect(isSeatLive(ok(idle, { t: "resume" }, { actor: "s-0" }), seat)).toBe(true);
    expect(isSeatLive(ok(idle, { t: "enterGame" }, { actor: "s-0" }), seat)).toBe(true);
  });

  it("does NOT give it back on a reconnect alone", () => {
    // A phone left on the table whose network flaps has not come back.
    let r = ok(started(), { t: "markIdle" }, { actor: "s-0" });
    r = ok(r, { t: "setConnected", connected: false }, { actor: "s-0" });
    r = ok(r, { t: "setConnected", connected: true }, { actor: "s-0" });
    expect(isIdle(r, "s-0")).toBe(true);
  });

  it("is not who the next round waits on", () => {
    const r = ok(started(), { t: "markIdle" }, { actor: LEADER });
    expect(mayContinueRound(r, LEADER)).toBe(false);
    expect(mayContinueRound(r, "s-0")).toBe(true);
  });

  it("ends the game when everybody is idle — the user's call", () => {
    let r = ok(started(), { t: "markIdle" }, { actor: "s-0" });
    const res = applyCommand(r, { t: "markIdle" }, { actor: LEADER, now: 3 });
    if (!res.ok) throw new Error(res.error);
    r = res.room;
    expect(r.game).toBeNull();
    expect(res.effects).toContainEqual({ t: "stopSession", reason: "all-bots" });
    expect(res.effects).toContainEqual({ t: "notice", text: "Everyone is away — game ended" });
  });

  it("is only for somebody holding a seat in a running game", () => {
    expect(applyCommand(room(), { t: "markIdle" }, { actor: LEADER, now: 1 }).ok).toBe(false);
  });
});

describe("who deals the next round", () => {
  /**
   * The user's rule (2026-09-25): the party leader continues, and everyone
   * else waits. But a table must never be left with nobody able to move it
   * on, so while the leader is away from it a seated player may.
   */
  function running(): Room {
    let r = spades(withMembers(["Bo"]));
    r = ok(r, { t: "startGame" }, { actor: LEADER, now: 10 });
    return r;
  }

  it("is the leader's call, not the other players'", () => {
    const r = running();
    expect(mayContinueRound(r, LEADER)).toBe(true);
    expect(mayContinueRound(r, "s-0")).toBe(false);
  });

  it("falls to a seated player while the leader has stepped away to the lobby", () => {
    const r = ok(running(), { t: "exitGame" }, { actor: LEADER });
    expect(mayContinueRound(r, LEADER)).toBe(false);
    expect(mayContinueRound(r, "s-0")).toBe(true);
  });

  it("follows the leadership when the leader drops", () => {
    // Leadership moves to a connected member, and the call moves with it.
    const r = ok(running(), { t: "setConnected", connected: false }, { actor: LEADER });
    expect(r.leader).toBe("s-0");
    expect(mayContinueRound(r, "s-0")).toBe(true);
  });

  it("belongs to nobody when no game is running", () => {
    expect(mayContinueRound(withMembers(["Bo"]), LEADER)).toBe(false);
  });
});
