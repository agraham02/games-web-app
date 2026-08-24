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
import {
  applyCommand,
  createRoom,
  isSeatLive,
  makeCode,
  openSeats,
  seatOf,
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

  it("refuses a game that is not wired for online play", () => {
    const r = withMembers([]);
    expect(
      applyCommand(
        r,
        { t: "selectGame", gameId: "rummy", settings: {}, seats: 4, difficulty: "steady" },
        { actor: LEADER, now: 1 },
      ),
    ).toEqual({ ok: false, error: "game-not-online" });
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

  it("seats partners across, not side by side", () => {
    // Partnership games in this app are seats 0/2 against 1/3. A team
    // assignment that ignored seat parity would put both partners on the
    // same side and quietly break the game.
    let r = withMembers(["Sam", "Kofi", "Jo"]);
    r = spades(r, 4);
    r = ok(r, { t: "assignTeam", session: LEADER, team: 0 }, { actor: LEADER });
    r = ok(r, { t: "assignTeam", session: "s-0", team: 1 }, { actor: LEADER });
    r = ok(r, { t: "assignTeam", session: "s-1", team: 0 }, { actor: LEADER });
    r = ok(r, { t: "assignTeam", session: "s-2", team: 1 }, { actor: LEADER });
    r = ok(r, { t: "startGame" }, { actor: LEADER });

    const seats = r.game!.seatOwner;
    expect([seats[0], seats[2]].sort()).toEqual([LEADER, "s-1"].sort());
    expect([seats[1], seats[3]].sort()).toEqual(["s-0", "s-2"].sort());
  });

  it("shuffles teams deterministically from a seed", () => {
    const build = (seed: number) => {
      let r = withMembers(["Sam", "Kofi", "Jo"]);
      r = spades(r);
      return ok(r, { t: "randomizeTeams" }, { actor: LEADER, rng: createRng(seed) }).teams;
    };
    expect(build(7)).toEqual(build(7));
    // Both sides get two of the four.
    const counts = Object.values(build(7)!).reduce<Record<number, number>>(
      (acc, t) => ({ ...acc, [t]: (acc[t] ?? 0) + 1 }),
      {},
    );
    expect(counts).toEqual({ 0: 2, 1: 2 });
  });
});

describe("seats, presence and bots", () => {
  function started(extra: string[] = ["Sam"]): Room {
    let r = withMembers(extra);
    r = spades(r, 4);
    return ok(r, { t: "startGame" }, { actor: LEADER });
  }

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
    const r = started([]);
    expect(r.game).not.toBeNull();
    const res = applyCommand(r, { t: "setConnected", connected: false }, { actor: LEADER, now: 30 });
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
  it("clamps hostile numbers instead of trusting them", () => {
    let r = withMembers([]);
    r = ok(
      r,
      {
        t: "selectGame",
        gameId: "poker",
        settings: { startingStack: Number.POSITIVE_INFINITY, bigBlind: -5 },
        seats: 999,
        difficulty: "steady",
      },
      { actor: LEADER },
    );

    expect(Number.isFinite(r.settings.startingStack as number)).toBe(true);
    expect(r.settings.bigBlind as number).toBeGreaterThanOrEqual(2);
    expect(r.seats).toBe(10); // poker's real maximum
  });

  it("drops team assignments when switching to a game without partnerships", () => {
    let r = withMembers(["Sam"]);
    r = spades(r);
    r = ok(r, { t: "assignTeam", session: "s-0", team: 1 }, { actor: LEADER });
    expect(r.teams).not.toBeNull();

    r = ok(
      r,
      { t: "selectGame", gameId: "poker", settings: {}, seats: 6, difficulty: "steady" },
      { actor: LEADER },
    );
    expect(r.teams).toBeNull();
  });
});

describe("spectating is opt-in", () => {
  function started(): Room {
    let r = withMembers(["Sam"]);
    r = spades(r, 4);
    return ok(r, { t: "startGame" }, { actor: LEADER });
  }

  it("seats a newcomer who does not say otherwise", () => {
    // The overwhelmingly common intent behind "join the game".
    let r = started();
    r = ok(r, { t: "join", name: "Late" }, { actor: "s-late", now: 40 });
    r = ok(r, { t: "enterGame" }, { actor: "s-late" });
    expect(seatOf(r, "s-late")).not.toBeNull();
  });

  it("lets someone choose to watch even with seats going spare", () => {
    // Without this the only route to spectating would be waiting for a
    // full table, and the spec calls watching opt-in.
    let r = started();
    expect(openSeats(r).length).toBeGreaterThan(0);
    r = ok(r, { t: "join", name: "Watcher" }, { actor: "s-watch", now: 41 });
    r = ok(r, { t: "enterGame", as: "spectator" }, { actor: "s-watch" });

    expect(seatOf(r, "s-watch")).toBeNull();
    expect(r.game!.present).toContain("s-watch");
    // And they did not consume a seat on the way past.
    expect(openSeats(r).length).toBeGreaterThan(0);
  });

  it("returns a seat owner to their own seat even if they ask to watch", () => {
    // Entering is a reclaim for anyone who owns a seat; giving it up is
    // what leaving the room is for.
    let r = started();
    const seat = seatOf(r, LEADER);
    r = ok(r, { t: "exitGame" }, { actor: LEADER });
    r = ok(r, { t: "enterGame", as: "spectator" }, { actor: LEADER });
    expect(seatOf(r, LEADER)).toBe(seat);
  });
});
