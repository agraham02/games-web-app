/**
 * Every live room in the process, plus the identity table behind them.
 *
 * Rooms are in memory and die with the process, which is the right trade
 * for something whose longest-lived object is deleted a minute after the
 * last person leaves. Nothing here is worth a database; what it IS worth is
 * an injected clock, so the minute can be tested in a millisecond.
 *
 * ## Identity
 *
 * A client presents a `token` it generated and kept in `localStorage`. The
 * registry maps that to a `SessionId` — a separate, server-minted, public
 * id — and hands back the same one every time. That mapping is the whole of
 * "reconnection is identity-based, not first-to-reconnect": the returning
 * browser is recognisably the same person, so the seat reserved for it is
 * still theirs, while a stranger presenting a fresh token is simply
 * somebody new.
 *
 * The token never leaves this table. Only the SessionId is ever put on the
 * wire, because the roster is broadcast to everyone in the room and a token
 * in a roster is a credential handed to every other player.
 */

import { createRng, randomSeed, type Rng } from "@/engine/rng";
import { createRoom, makeCode, type Room, type RoomCode, type SessionId } from "@/session/room";
import { realClock, type Clock, type TimerHandle } from "@/session/clock";
import { RoomRuntime } from "./RoomRuntime";
import { log } from "./log";

/**
 * How long a room with nobody connected survives. Straight from the spec.
 * A grace period rather than an instant delete because the commonest way to
 * have zero connected members is everybody refreshing at once after a
 * deploy, and deleting the room out from under them would turn a blink into
 * a lost game.
 */
export const EMPTY_ROOM_TTL_MS = 60_000;

/** Enough attempts that exhausting them means something is genuinely wrong. */
const CODE_ATTEMPTS = 50;

/**
 * How many identities to remember before forgetting the oldest idle ones.
 *
 * The identity table is the one structure here with no natural end: a
 * room is reaped a minute after it empties, but `sessionFor` minted and
 * kept an entry for every distinct token ever presented, for the life of
 * the process. The rate limit is per-connection, so a client cycling
 * tokens — or simply a long-lived server — grows it without bound.
 *
 * An identity that is not in a room is worth nothing except the ability
 * to reclaim a seat, and there is no seat to reclaim, so those are the
 * ones to drop. Anybody in a room is kept regardless of how many there
 * are: forgetting them is what would actually cost somebody their seat.
 *
 * Generous against the ~10 players this is built for, and still bounded.
 */
const MAX_IDLE_IDENTITIES = 5_000;

export interface RegistryOptions {
  clock?: Clock;
  /** Seeded for tests; a real deployment wants a fresh one. */
  seed?: number;
}

export class RoomRegistry {
  private readonly rooms = new Map<RoomCode, RoomRuntime>();
  private readonly sessions = new Map<string, SessionId>();
  /** Which room a session is in, so a socket message needs no room code. */
  private readonly located = new Map<SessionId, RoomCode>();
  private readonly reapers = new Map<RoomCode, TimerHandle>();

  private readonly clock: Clock;
  private readonly rng: Rng;
  private nextSession = 1;

  constructor(opts: RegistryOptions = {}) {
    this.clock = opts.clock ?? realClock;
    this.rng = createRng(opts.seed ?? randomSeed());
  }

  /* ---------- identity ---------- */

  /**
   * The public id for a token, minting one on first sight.
   *
   * Deliberately never returns the token itself, and deliberately not a
   * hash of it either — a hash is still derived from the secret, and an id
   * that can be checked against a guessed token is a token oracle.
   */
  sessionFor(token: string): SessionId {
    const existing = this.sessions.get(token);
    if (existing) {
      // Touched: a `Map` keeps insertion order, so re-inserting moves
      // this to the young end and keeps `forgetIdleIdentities` honest
      // about which entries are actually idle.
      this.sessions.delete(token);
      this.sessions.set(token, existing);
      return existing;
    }
    const session = `s${this.nextSession++}-${this.rng.int(0xffffff).toString(36)}`;
    this.sessions.set(token, session);
    if (this.sessions.size > MAX_IDLE_IDENTITIES) this.forgetIdleIdentities();
    return session;
  }

  /**
   * Drops the least recently seen identities that are not in a room.
   *
   * Forgetting one costs only the ability to reclaim a seat with that
   * token — and an identity in no room has no seat — so this is a cache
   * eviction rather than a logout. Anyone currently in a room is skipped
   * however old their entry is.
   */
  private forgetIdleIdentities(): void {
    const target = Math.floor(MAX_IDLE_IDENTITIES / 2);
    for (const [token, session] of this.sessions) {
      if (this.sessions.size <= target) break;
      if (this.located.has(session)) continue;
      this.sessions.delete(token);
    }
  }

  roomOf(session: SessionId): RoomRuntime | null {
    const code = this.located.get(session);
    return code ? (this.rooms.get(code) ?? null) : null;
  }

  get(code: RoomCode): RoomRuntime | null {
    return this.rooms.get(code.toUpperCase()) ?? null;
  }

  get size(): number {
    return this.rooms.size;
  }

  codes(): RoomCode[] {
    return [...this.rooms.keys()];
  }

  /* ---------- lifecycle ---------- */

  create(leader: SessionId, leaderName: string): RoomRuntime {
    const code = this.freshCode();
    const room: Room = createRoom({
      code,
      leader,
      leaderName,
      now: this.clock.now(),
    });
    const runtime = new RoomRuntime({
      room,
      clock: this.clock,
      rng: this.rng,
      onEmpty: (c) => this.scheduleReap(c),
    });
    this.rooms.set(code, runtime);
    this.located.set(leader, code);
    log.info("room created", { room: code, session: leader });
    return runtime;
  }

  /** Records that a session now belongs to a room, and cancels any reaper. */
  place(session: SessionId, code: RoomCode): void {
    this.located.set(session, code);
    this.cancelReap(code);
  }

  displace(session: SessionId): void {
    this.located.delete(session);
  }

  private freshCode(): RoomCode {
    for (let i = 0; i < CODE_ATTEMPTS; i++) {
      const code = makeCode(this.rng);
      if (!this.rooms.has(code)) return code;
    }
    // 331,776 possible codes: reaching here means the process is holding an
    // implausible number of rooms, and failing loudly beats looping forever.
    throw new Error("could not allocate a free room code");
  }

  /* ---------- expiry ---------- */

  /**
   * Starts the countdown on an empty room. Rearming an existing timer would
   * let a flapping connection keep a dead room alive indefinitely, so an
   * already-scheduled reap is left exactly where it is.
   */
  private scheduleReap(code: RoomCode): void {
    if (this.reapers.has(code)) return;
    log.info("room empty, scheduling reap", { room: code });
    const handle = this.clock.setTimeout(() => {
      this.reapers.delete(code);
      const runtime = this.rooms.get(code);
      if (!runtime) return;
      // Re-checked rather than assumed: somebody may have reconnected
      // during the grace period, and the whole point of the grace period is
      // that they are allowed to.
      if (this.connectedIn(runtime) > 0) return;
      this.destroy(code);
    }, EMPTY_ROOM_TTL_MS);
    this.reapers.set(code, handle);
  }

  private cancelReap(code: RoomCode): void {
    const handle = this.reapers.get(code);
    if (handle === undefined) return;
    this.clock.clearTimeout(handle);
    this.reapers.delete(code);
  }

  private connectedIn(runtime: RoomRuntime): number {
    return Object.values(runtime.room.members).filter((m) => m.connected).length;
  }

  destroy(code: RoomCode): void {
    const runtime = this.rooms.get(code);
    if (!runtime) return;
    log.info("room destroyed", { room: code });
    for (const session of Object.keys(runtime.room.members)) this.located.delete(session);
    runtime.dispose();
    this.rooms.delete(code);
    this.cancelReap(code);
  }

  /** Test/shutdown affordance — leaves no timers behind. */
  disposeAll(): void {
    for (const code of [...this.rooms.keys()]) this.destroy(code);
    this.sessions.clear();
    this.located.clear();
  }
}
