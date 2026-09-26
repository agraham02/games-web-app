/**
 * The room and lobby, as a pure state machine.
 *
 * Shaped deliberately like the engine's own `reduce`: a command goes in,
 * a new room and a list of effects come out, and nothing in here touches a
 * socket, a timer or a `GameSession`. That is what makes the awkward parts
 * of this feature — a leader disconnecting mid-hand, two people racing for
 * the last seat, a private-room approval landing after the requester has
 * already gone — testable as plain function calls instead of as a
 * choreography of real connections.
 *
 * The one distinction worth reading before changing anything here is
 * between the three ways a seat can be "not being played by a human", and
 * why they are not the same thing:
 *
 *   - **Unowned** (`seatOwner[i] === null`): nobody has ever claimed it, or
 *     its owner left the room. Free for the taking.
 *   - **Reserved but absent**: owned by someone who disconnected or backed
 *     out to the lobby. A bot plays it and it is NOT up for grabs — this
 *     is what stops a returning player finding a stranger holding their
 *     hand and their score.
 *   - **Live**: owned by someone connected who is currently looking at the
 *     table.
 *
 * Only the third is played by a human, which is exactly what
 * `isSeatLive` reports to `GameSession`.
 */

import type { BotDifficulty, SeatId } from "@/engine/types";
import type { Rng } from "@/engine/rng";
import { gameEntry, type GameId, type RawSettings } from "./registry";

export type SessionId = string;
export type RoomCode = string;
export type Privacy = "public" | "private";

export const MAX_NAME_LENGTH = 20;

/**
 * How many people a room needs before it will start a game.
 *
 * A room with one person in it is a single-player game with extra steps —
 * and worse than the offline one, because every bot turn makes a round
 * trip. The lobby says so and offers the solo screens instead; this is the
 * authority behind that, since a client can be told anything.
 *
 * Counted over CONNECTED members, which is what "here" means everywhere
 * else in this file (`connectedCount`, `seatMembers`) — a member whose
 * phone is asleep gets a bot seat the moment the deal happens, so counting
 * them would let a room start exactly the game this rule exists to
 * prevent.
 */
export const MIN_ROOM_PLAYERS = 2;

/**
 * The most people one room will hold.
 *
 * Comfortably above the ten seats of the largest game, because spectators
 * are real and a room is allowed to have more people in it than chairs.
 * It exists so that the number is BOUNDED at all: a room is an in-memory
 * object on a single process, every member is broadcast to on every
 * roster change, and nothing anywhere said no.
 */
export const MAX_ROOM_MEMBERS = 24;

/**
 * Codes are uppercase and skip I and O, which are the two letters people
 * reliably mistype as 1 and 0 when reading a code off someone else's
 * screen. 24^4 is still 331,776 rooms.
 */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 4;

export interface Member {
  session: SessionId;
  name: string;
  connected: boolean;
  /** Ordering for seat assignment and for who inherits leadership. */
  joinedAt: number;
}

export interface PendingRequest {
  session: SessionId;
  name: string;
  requestedAt: number;
}

export interface GameParticipation {
  gameId: GameId;
  seats: number;
  /** Index is the SeatId. See the header on what `null` means. */
  seatOwner: (SessionId | null)[];
  /**
   * Who is currently looking at the table, players and spectators alike.
   * Kept separate from `seatOwner` because backing out to the lobby has to
   * surrender presence WITHOUT surrendering the seat.
   *
   * A disconnected player stays in here on purpose: it is what makes a
   * refresh put them straight back at the table rather than into a lobby
   * they then have to re-enter.
   */
  present: SessionId[];
}

export interface Room {
  code: RoomCode;
  createdAt: number;
  privacy: Privacy;
  leader: SessionId;
  members: Record<SessionId, Member>;
  pending: Record<SessionId, PendingRequest>;
  gameId: GameId | null;
  settings: RawSettings;
  seats: number;
  difficulty: BotDifficulty;
  /** session -> 0 | 1, for games that play in partnerships. */
  teams: Record<SessionId, number> | null;
  game: GameParticipation | null;
}

export type RoomError =
  | "not-leader"
  | "not-a-member"
  | "name-required"
  | "name-taken"
  | "needs-approval"
  | "no-such-request"
  | "no-game-selected"
  | "needs-two-players"
  | "game-not-online"
  | "game-already-running"
  | "no-game-running"
  | "not-in-game"
  | "cannot-target-self"
  | "bad-seat-count"
  | "room-full";

export type RoomEffect =
  | { t: "startSession"; gameId: GameId; settings: RawSettings; seats: number; difficulty: BotDifficulty }
  | { t: "stopSession"; reason: "ended-by-leader" | "all-bots" }
  /** Surfaced to everyone in the room as a toast. Past tense, names the actor. */
  | { t: "notice"; text: string };

export type RoomResult =
  | { ok: true; room: Room; effects: RoomEffect[] }
  | { ok: false; error: RoomError };

export type RoomCommand =
  | { t: "join"; name: string }
  | { t: "approve"; session: SessionId }
  | { t: "deny"; session: SessionId }
  /** The REQUESTER taking their own knock back. Not leader-gated. */
  | { t: "withdraw" }
  | { t: "leave" }
  | { t: "rename"; name: string }
  | { t: "promote"; session: SessionId }
  | { t: "kick"; session: SessionId }
  | { t: "setPrivacy"; privacy: Privacy }
  | {
      t: "selectGame";
      gameId: GameId;
      settings: RawSettings;
      seats: number;
      difficulty: BotDifficulty;
    }
  | { t: "assignTeam"; session: SessionId; team: number }
  | { t: "randomizeTeams" }
  | { t: "startGame" }
  | {
      t: "enterGame";
      /**
       * What they are asking for. Spectating is opt-in per the spec, so
       * "spectator" means "do not seat me even if a seat is free" — without
       * it, the only way to watch would be to wait for a full table.
       *
       * Defaults to taking a seat, because that is what somebody pressing
       * "join the game" almost always means.
       */
      as?: "player" | "spectator";
    }
  | { t: "exitGame" }
  | { t: "endGame" }
  | { t: "setConnected"; connected: boolean };

export interface RoomContext {
  actor: SessionId;
  now: number;
  /** Only `randomizeTeams` needs one. Never `Math.random`. */
  rng?: Rng;
}

/* ============================================================
   Construction
   ============================================================ */

export function makeCode(rng: Rng): RoomCode {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[rng.int(CODE_ALPHABET.length)];
  return out;
}

export function createRoom(opts: {
  code: RoomCode;
  leader: SessionId;
  leaderName: string;
  now: number;
}): Room {
  return {
    code: opts.code,
    createdAt: opts.now,
    privacy: "public",
    leader: opts.leader,
    members: {
      [opts.leader]: {
        session: opts.leader,
        name: opts.leaderName,
        connected: true,
        joinedAt: opts.now,
      },
    },
    pending: {},
    gameId: null,
    settings: {},
    seats: 0,
    difficulty: "steady",
    teams: null,
    game: null,
  };
}

/* ============================================================
   Reads
   ============================================================ */

export function orderedMembers(room: Room): Member[] {
  return Object.values(room.members).sort((a, b) => a.joinedAt - b.joinedAt);
}

export function connectedCount(room: Room): number {
  return Object.values(room.members).filter((m) => m.connected).length;
}

/**
 * "Is a connected human currently sitting at this seat?" — the single
 * question `GameSession` asks, and the reason the three seat states in the
 * header are modelled apart.
 */
export function isSeatLive(room: Room, seat: SeatId): boolean {
  const game = room.game;
  if (!game) return false;
  const owner = game.seatOwner[seat];
  if (!owner) return false;
  const member = room.members[owner];
  return Boolean(member?.connected) && game.present.includes(owner);
}

/**
 * Who may deal the next round: the party leader, while they are at the
 * table (the user's rule, 2026-09-25). Everyone else sees "waiting for the
 * leader".
 *
 * But never a table that nobody can move on. A leader who drops has their
 * leadership handed on already (see `reassignLeader`), but one who steps
 * away to the lobby keeps it and cannot see the round's end, so while the
 * leader is not at the table any seated player who is may continue.
 */
export function mayContinueRound(room: Room, session: SessionId): boolean {
  const game = room.game;
  if (!game) return false;
  const here = (s: SessionId) => Boolean(room.members[s]?.connected) && game.present.includes(s);
  if (session === room.leader) return here(session);
  if (here(room.leader)) return false;
  return seatOf(room, session) !== null && here(session);
}

export function seatOf(room: Room, session: SessionId): SeatId | null {
  const idx = room.game?.seatOwner.indexOf(session) ?? -1;
  return idx === -1 ? null : idx;
}

export function isSpectator(room: Room, session: SessionId): boolean {
  const game = room.game;
  if (!game) return false;
  return game.present.includes(session) && seatOf(room, session) === null;
}

/** Every seat still open to a newcomer — never one merely being sat out. */
export function openSeats(room: Room): SeatId[] {
  const game = room.game;
  if (!game) return [];
  const out: SeatId[] = [];
  for (let i = 0; i < game.seats; i++) if (game.seatOwner[i] === null) out.push(i);
  return out;
}

export function nameTaken(room: Room, name: string, except?: SessionId): boolean {
  const wanted = name.trim().toLowerCase();
  return Object.values(room.members).some(
    (m) => m.session !== except && m.name.toLowerCase() === wanted,
  );
}

/**
 * Forces anything at all into a real team index, 0 or 1.
 *
 * `team % 2` looks like it does this and does not: `-1 % 2` is `-1` and
 * `0.5 % 2` is `0.5`, both of which are perfectly good numbers and
 * neither of which is a team. `seatMembers` then indexes its queue array
 * with one, gets `undefined`, and throws — which used to take the whole
 * process down, because a leader is allowed to send `assignTeam` and
 * nothing between the socket and here was checking.
 *
 * Applied at BOTH ends deliberately: once where a client's number is
 * stored, so a bad one never enters the room, and once where it is read,
 * so a room that acquired one some other way still seats everybody.
 */
export function teamIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.abs(Math.round(value)) % 2;
}

export function cleanName(raw: string): string {
  // Collapse whitespace so " Sam " and "Sam" cannot both exist, and so a
  // name of nothing but spaces fails the emptiness check below.
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
}

/* ============================================================
   Internals
   ============================================================ */

function fail(error: RoomError): RoomResult {
  return { ok: false, error };
}

function nameOf(room: Room, session: SessionId): string {
  return room.members[session]?.name ?? "Someone";
}

/**
 * Hands leadership to the longest-standing connected member, falling back
 * to the longest-standing member of any kind.
 *
 * A disconnected leader does NOT get it back on reconnect. Leadership is
 * about who is steering the room right now, and silently yanking it back
 * out of someone's hands the moment a phone reconnects would be worse than
 * asking them to hand it over.
 */
function reassignLeader(room: Room): Room {
  if (room.members[room.leader]?.connected) return room;
  const candidates = orderedMembers(room).filter((m) => m.session !== room.leader);
  const next = candidates.find((m) => m.connected) ?? candidates[0];
  if (!next) return room;
  return { ...room, leader: next.session };
}

/**
 * Drops a session out of the game entirely — presence AND its seat claim.
 * For leaving or being removed from the ROOM, never for backing out to the
 * lobby, which keeps the claim.
 */
function releaseFromGame(room: Room, session: SessionId): Room {
  if (!room.game) return room;
  return {
    ...room,
    game: {
      ...room.game,
      seatOwner: room.game.seatOwner.map((o) => (o === session ? null : o)),
      present: room.game.present.filter((s) => s !== session),
    },
  };
}

/**
 * Ends a running game once no seat has a live human in it.
 *
 * Checked after every command that can change who is where, rather than on
 * a timer, because "everybody left" can be reached from a disconnect, a
 * back-out, a kick or a leave, and a bot table playing on to a winner in an
 * empty room is nobody's idea of a running game.
 */
function endIfAllBots(room: Room, effects: RoomEffect[]): Room {
  if (!room.game) return room;
  for (let i = 0; i < room.game.seats; i++) if (isSeatLive(room, i)) return room;
  effects.push({ t: "stopSession", reason: "all-bots" });
  effects.push({ t: "notice", text: "Everyone left — game ended" });
  return { ...room, game: null };
}

/**
 * Seats the room's members for a fresh game.
 *
 * Teams, where a game uses them, decide WHICH seats rather than merely how
 * many: this app's partnership games are partners-across, seats 0/2 against
 * 1/3, so a team assignment that ignored seat parity would put both
 * partners on the same side of the table and quietly break the game.
 * Everyone who does not fit becomes a spectator, per the spec's
 * fill-seats-then-overflow rule.
 */
function seatMembers(
  room: Room,
  seats: number,
): { seatOwner: (SessionId | null)[]; present: SessionId[] } {
  const seatOwner: (SessionId | null)[] = Array.from({ length: seats }, () => null);
  const members = orderedMembers(room).filter((m) => m.connected);
  const present = members.map((m) => m.session);

  const usesTeams = room.teams !== null && gameEntry(room.gameId!).teams(room.settings);

  if (usesTeams) {
    const even: SeatId[] = [];
    const odd: SeatId[] = [];
    for (let i = 0; i < seats; i++) (i % 2 === 0 ? even : odd).push(i);
    const queues = [even, odd];
    const leftovers: SessionId[] = [];

    for (const m of members) {
      const queue = queues[teamIndex(room.teams?.[m.session])]!;
      const seat = queue.shift();
      if (seat === undefined) leftovers.push(m.session);
      else seatOwner[seat] = m.session;
    }
    // A lopsided assignment (three on one team) still has to seat people
    // somewhere rather than dropping them: whoever overflowed their own
    // side takes whatever is left before anyone becomes a spectator.
    const spare = [...queues[0]!, ...queues[1]!].sort((a, b) => a - b);
    for (const session of leftovers) {
      const seat = spare.shift();
      if (seat !== undefined) seatOwner[seat] = session;
    }
  } else {
    members.forEach((m, i) => {
      if (i < seats) seatOwner[i] = m.session;
    });
  }

  return { seatOwner, present };
}

/* ============================================================
   The reducer
   ============================================================ */

export function applyCommand(room: Room, command: RoomCommand, ctx: RoomContext): RoomResult {
  const { actor, now } = ctx;
  const effects: RoomEffect[] = [];
  const isMember = Boolean(room.members[actor]);
  const isLeader = room.leader === actor;

  const requireMember = (): RoomError | null => (isMember ? null : "not-a-member");
  const requireLeader = (): RoomError | null =>
    !isMember ? "not-a-member" : isLeader ? null : "not-leader";

  switch (command.t) {
    /* ---------- membership ---------- */

    case "join": {
      const name = cleanName(command.name);
      if (!name) return fail("name-required");

      // A refresh in the lobby arrives as a fresh join from a session the
      // room already knows. Treating it as an error would make an ordinary
      // page reload look like a failure; treating it as a reconnect is
      // both simpler and what the spec asks for.
      if (isMember) {
        if (nameTaken(room, name, actor)) return fail("name-taken");
        return {
          ok: true,
          room: {
            ...room,
            members: {
              ...room.members,
              [actor]: { ...room.members[actor]!, name, connected: true },
            },
          },
          effects,
        };
      }

      if (nameTaken(room, name)) return fail("name-taken");

      // Checked for newcomers only: somebody already in the room is
      // reconnecting, and a cap that refused THEM would turn a full room
      // into one nobody could rejoin after a dropped socket.
      if (Object.keys(room.members).length >= MAX_ROOM_MEMBERS) return fail("room-full");

      if (room.privacy === "private") {
        return {
          ok: true,
          room: {
            ...room,
            pending: { ...room.pending, [actor]: { session: actor, name, requestedAt: now } },
          },
          effects: [{ t: "notice", text: `${name} asked to join` }],
        };
      }

      return {
        ok: true,
        room: {
          ...room,
          members: {
            ...room.members,
            [actor]: { session: actor, name, connected: true, joinedAt: now },
          },
        },
        effects: [{ t: "notice", text: `${name} joined` }],
      };
    }

    case "approve": {
      const err = requireLeader();
      if (err) return fail(err);
      const request = room.pending[command.session];
      if (!request) return fail("no-such-request");
      // The requester may well have given up and closed the tab by now.
      // Admitting them anyway is correct and cheap: the membership is
      // waiting if they come back, and nothing here depends on them
      // being live to receive it.
      if (nameTaken(room, request.name)) return fail("name-taken");

      const pending = { ...room.pending };
      delete pending[command.session];
      return {
        ok: true,
        room: {
          ...room,
          pending,
          members: {
            ...room.members,
            [command.session]: {
              session: command.session,
              name: request.name,
              // Truthful until the socket says otherwise: the runtime
              // reconciles this against whether they are actually attached.
              connected: false,
              joinedAt: now,
            },
          },
        },
        effects: [{ t: "notice", text: `${request.name} was let in` }],
      };
    }

    case "deny": {
      const err = requireLeader();
      if (err) return fail(err);
      if (!room.pending[command.session]) return fail("no-such-request");
      const pending = { ...room.pending };
      delete pending[command.session];
      return { ok: true, room: { ...room, pending }, effects };
    }

    case "withdraw": {
      // Deliberately not leader-gated, and deliberately not an error when
      // there is nothing to withdraw: a person cancelling their own
      // request may well be doing it just as the leader approves them,
      // and either outcome is fine.
      if (!room.pending[actor]) return { ok: true, room, effects };
      const pending = { ...room.pending };
      delete pending[actor];
      return { ok: true, room: { ...room, pending }, effects };
    }

    case "leave":
    case "kick": {
      const target = command.t === "leave" ? actor : command.session;
      if (command.t === "kick") {
        const err = requireLeader();
        if (err) return fail(err);
        if (target === actor) return fail("cannot-target-self");
      }
      if (!room.members[target]) return fail("not-a-member");

      const name = nameOf(room, target);
      const members = { ...room.members };
      delete members[target];
      const teams = room.teams ? { ...room.teams } : null;
      if (teams) delete teams[target];

      // Leaving the room releases the seat outright, unlike backing out to
      // the lobby. The spec reserves a seat for a player who disconnects or
      // steps away; someone who is no longer in the room at all is neither,
      // and holding seats for departed strangers would let a room strand
      // itself with no way to seat anybody.
      let next = releaseFromGame({ ...room, members, teams }, target);
      next = reassignLeader(next);
      effects.push({
        t: "notice",
        text: command.t === "kick" ? `${name} was removed` : `${name} left`,
      });
      next = endIfAllBots(next, effects);
      return { ok: true, room: next, effects };
    }

    case "rename": {
      const err = requireMember();
      if (err) return fail(err);
      const name = cleanName(command.name);
      if (!name) return fail("name-required");
      if (nameTaken(room, name, actor)) return fail("name-taken");
      const was = nameOf(room, actor);
      return {
        ok: true,
        room: {
          ...room,
          members: { ...room.members, [actor]: { ...room.members[actor]!, name } },
        },
        effects: was === name ? [] : [{ t: "notice", text: `${was} is now ${name}` }],
      };
    }

    case "setConnected": {
      if (!isMember) return fail("not-a-member");
      let next: Room = {
        ...room,
        members: {
          ...room.members,
          [actor]: { ...room.members[actor]!, connected: command.connected },
        },
      };
      if (!command.connected) {
        next = reassignLeader(next);
        next = endIfAllBots(next, effects);
      }
      return { ok: true, room: next, effects };
    }

    /* ---------- leader powers ---------- */

    case "promote": {
      const err = requireLeader();
      if (err) return fail(err);
      if (!room.members[command.session]) return fail("not-a-member");
      if (command.session === actor) return fail("cannot-target-self");
      return {
        ok: true,
        room: { ...room, leader: command.session },
        effects: [{ t: "notice", text: `${nameOf(room, command.session)} is now the leader` }],
      };
    }

    case "setPrivacy": {
      const err = requireLeader();
      if (err) return fail(err);
      return { ok: true, room: { ...room, privacy: command.privacy }, effects };
    }

    case "selectGame": {
      const err = requireLeader();
      if (err) return fail(err);
      // The same guard `startGame` carries, and missing here for no
      // reason: the lobby stays reachable during a match (that is what
      // "Step away" goes back to), and its game picker was gated only on
      // being leader. Switching mid-match left `room.game` and the live
      // `GameSession` on the OLD game while every client's room view
      // described the new one — so the screen swapped to a different
      // table component and rendered it against frames from a game it
      // knows nothing about. Changing the seat count was the same shape,
      // re-laying the geometry for a table that does not exist.
      if (room.game) return fail("game-already-running");
      const entry = gameEntry(command.gameId);
      if (!entry.online) return fail("game-not-online");
      const settings = entry.parse(command.settings);
      const seats = Math.min(entry.maxSeats, Math.max(entry.minSeats, Math.round(command.seats)));
      if (!Number.isFinite(seats)) return fail("bad-seat-count");
      return {
        ok: true,
        room: {
          ...room,
          gameId: command.gameId,
          settings,
          seats,
          difficulty: command.difficulty,
          // Team assignments are per-game: carrying them across a switch
          // from Spades to Poker would silently apply a pairing nobody
          // chose to a game that has no partnerships.
          teams: entry.teams(settings) ? (room.teams ?? {}) : null,
        },
        effects,
      };
    }

    case "assignTeam": {
      const err = requireLeader();
      if (err) return fail(err);
      // Teams are dealt INTO a game: `seatMembers` reads them once, at
      // `startGame`, and the running session keeps whatever it was given.
      // Without this the roster happily reassigned somebody mid-match while
      // the table's actual partnerships did not move - a change that looks
      // like it worked and does nothing, which is worse than a refusal.
      if (room.game) return fail("game-already-running");
      if (!room.members[command.session]) return fail("not-a-member");
      if (room.teams === null) return fail("no-game-selected");
      return {
        ok: true,
        room: {
          ...room,
          teams: { ...room.teams, [command.session]: teamIndex(command.team) },
        },
        effects,
      };
    }

    case "randomizeTeams": {
      const err = requireLeader();
      if (err) return fail(err);
      // See `assignTeam`: partnerships are fixed once a game has dealt.
      if (room.game) return fail("game-already-running");
      if (room.teams === null) return fail("no-game-selected");
      const rng = ctx.rng;
      if (!rng) return fail("no-game-selected");
      const shuffled = rng.shuffle(orderedMembers(room).map((m) => m.session));
      const teams: Record<SessionId, number> = {};
      // Alternating rather than splitting down the middle, so an odd
      // number of members lands one extra on the first side instead of
      // failing to divide.
      shuffled.forEach((session, i) => {
        teams[session] = i % 2;
      });
      return {
        ok: true,
        room: { ...room, teams },
        effects: [{ t: "notice", text: "Teams were shuffled" }],
      };
    }

    /* ---------- the game ---------- */

    case "startGame": {
      const err = requireLeader();
      if (err) return fail(err);
      if (!room.gameId) return fail("no-game-selected");
      // The guard that resolves two people hitting Start at once. A room's
      // commands are serialised on one thread, so the second caller
      // genuinely observes the first one's game and is refused rather than
      // stacking a second session on top of it.
      if (room.game) return fail("game-already-running");
      const entry = gameEntry(room.gameId);
      if (!entry.online) return fail("game-not-online");
      // See MIN_ROOM_PLAYERS. Deliberately checked here rather than only in
      // the lobby: the button is disabled there, but a disabled button is a
      // courtesy and this is the rule.
      if (connectedCount(room) < MIN_ROOM_PLAYERS) return fail("needs-two-players");

      const seats = Math.min(entry.maxSeats, Math.max(entry.minSeats, room.seats || entry.defaultSeats));
      const { seatOwner, present } = seatMembers(room, seats);

      return {
        ok: true,
        room: { ...room, seats, game: { gameId: room.gameId, seats, seatOwner, present } },
        effects: [
          {
            t: "startSession",
            gameId: room.gameId,
            settings: room.settings,
            seats,
            difficulty: room.difficulty,
          },
          { t: "notice", text: `${entry.name} started` },
        ],
      };
    }

    case "enterGame": {
      const memberErr = requireMember();
      if (memberErr) return fail(memberErr);
      if (!room.game) return fail("no-game-running");
      const game = room.game;

      // Already seated: this is a reclaim, and it must not cost them the
      // seat they own. Being present again is the whole of it — the bot
      // stops playing because `isSeatLive` starts answering true.
      if (game.present.includes(actor)) return { ok: true, room, effects };

      const mine = game.seatOwner.indexOf(actor);
      if (mine !== -1) {
        return {
          ok: true,
          room: { ...room, game: { ...game, present: [...game.present, actor] } },
          effects: [{ t: "notice", text: `${nameOf(room, actor)} came back` }],
        };
      }

      // Asking to watch is honoured even with seats going spare. Asking to
      // play and finding none is the spec's other route to the same place.
      const free = command.as === "spectator" ? undefined : openSeats(room)[0];
      const seatOwner = [...game.seatOwner];
      if (free !== undefined) seatOwner[free] = actor;
      return {
        ok: true,
        room: { ...room, game: { ...game, seatOwner, present: [...game.present, actor] } },
        effects: [
          {
            t: "notice",
            // Named honestly: a full table makes you a spectator whether or
            // not that is what you asked for.
            text:
              free !== undefined
                ? `${nameOf(room, actor)} sat down`
                : `${nameOf(room, actor)} is watching`,
          },
        ],
      };
    }

    case "exitGame": {
      const memberErr = requireMember();
      if (memberErr) return fail(memberErr);
      if (!room.game) return fail("no-game-running");
      if (!room.game.present.includes(actor)) return fail("not-in-game");

      // Presence goes, the seat claim stays — a bot picks the hand up and
      // holds it until they come back.
      let next: Room = {
        ...room,
        game: { ...room.game, present: room.game.present.filter((s) => s !== actor) },
      };
      const seat = seatOf(room, actor);
      effects.push({
        t: "notice",
        text: seat === null ? `${nameOf(room, actor)} stopped watching` : `${nameOf(room, actor)} stepped away`,
      });
      next = endIfAllBots(next, effects);
      return { ok: true, room: next, effects };
    }

    case "endGame": {
      const err = requireLeader();
      if (err) return fail(err);
      if (!room.game) return fail("no-game-running");
      return {
        ok: true,
        room: { ...room, game: null },
        effects: [
          { t: "stopSession", reason: "ended-by-leader" },
          { t: "notice", text: "The game was ended" },
        ],
      };
    }
  }
}
