/**
 * One room, live: its state machine, its game session, and everyone
 * currently attached to it.
 *
 * Everything genuinely hard about multiplayer that is not pure logic lives
 * here, and it is worth naming what those things are before reading on.
 *
 * **Nobody waits for a slow client.** Frames are pushed and forgotten. A
 * client that cannot keep up gets its backlog dropped and the newest frame
 * instead, which it can apply on its own because every frame is a complete
 * snapshot rather than a delta. So a player on a bad connection sees the
 * table jump to the present rather than crawl through history, and the
 * other five players never notice they were there.
 *
 * **Every recipient gets a different payload.** The same server-side turn
 * produces a different `state`, `placements` and even `events` for each
 * viewer, because each is redacted for that seat. This is the one place
 * those diverge, and the one place a mistake would hand somebody else's
 * hand to a spectator.
 *
 * **The session is told who is human, not who is connected.** A seat is
 * played by a bot whenever its owner is disconnected OR has stepped back to
 * the lobby, and the changeover is immediate — `isSeatLive` is a live read,
 * so the very next turn routes to a bot with no reshuffling of state.
 */

import type { BotDifficulty, PieceId, PieceMeta, PlacementMap, SeatId } from "@/engine/types";
import type { Rng } from "@/engine/rng";
import { DEFAULT_TURN_HOLD_MS, GameSession, type SessionFrame } from "@/session/GameSession";
import { READY_BEAT_MS, playbackMs } from "@/motion/choreographer";
import { gameEntry, type GameId, type RawSettings } from "@/session/registry";
import { piecesNamed, projectEvents, redactPlacements } from "@/session/redact";
import {
  applyCommand,
  connectedCount,
  holdsSeat,
  isIdle,
  isSeatLive,
  LOBBY_GRACE_MS,
  mayContinueRound,
  openSeats,
  seatOf,
  seatingOrder,
  seatingPlan,
  teamOfSeat,
  type Room,
  type RoomCommand,
  type RoomEffect,
  type RoomError,
  type SessionId,
} from "@/session/room";
import {
  extractRound,
  extractRoundWinner,
  extractWinner,
  resolveRoundWinningSeats,
  resolveWinningSeats,
} from "@/session/structural";
import type { FrameView, MemberView, RoomView, ServerMessage, SettlementView } from "@/session/protocol";
import { seatNets, settleUp, type Stint } from "@/session/settle";
import type { Clock, TimerHandle } from "@/session/clock";
import { AUTO_CONTINUE_GRACE_MS, AUTO_CONTINUE_MS, ROUND_END_HOLD_MS } from "@/session/roundEnd";
import { log } from "./log";
import { decodePhoto, newPhotoId, type StoredPhoto } from "./photo";

/**
 * The seat a spectator "occupies". Every game's `placements` and
 * `playerView` compare `seat === viewer` to decide what is face-up, so a
 * viewer number that matches no seat yields a table with every hand face
 * down — which is exactly a spectator's entitlement, achieved without a
 * single game knowing spectators exist.
 */
export const SPECTATOR_SEAT: SeatId = -1;

/**
 * How far behind a socket may fall before it is caught up rather than fed.
 * Measured in bytes still queued by the transport, which is the only
 * honest signal available: a client that has stopped reading shows up as a
 * send buffer that never drains.
 */
const BACKPRESSURE_BYTES = 256 * 1024;

/**
 * How long after a forced move is played for somebody their own press of it
 * still counts as the same move, arriving second (`GameSession.playedFor`).
 * Generous against a slow phone, and far short of their next turn.
 */
const LATE_PRESS_MS = 3_000;

/** The refusal that is not one: see `LATE_PRESS_MS`. The router says nothing. */
export const PLAYED_FOR_YOU = "played-for-you";

export interface Connection {
  send(message: ServerMessage): void;
  close(): void;
  /** Bytes written but not yet flushed to the network. */
  bufferedAmount(): number;
}

export interface RoomRuntimeOptions {
  room: Room;
  clock: Clock;
  rng: Rng;
  /** Called when the room has no reason to exist any more. */
  onEmpty: (code: string) => void;
  /**
   * Called when a member has been let go of without asking — their
   * `LOBBY_GRACE_MS` ran out — so whoever keeps the map of who is in which
   * room can forget them. Leaving on purpose goes through the router, which
   * does that itself.
   */
  onDeparted?: (session: SessionId) => void;
  /** `LOBBY_GRACE_MS` unless a test (or a dev server) wants it shorter. */
  graceMs?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySession = GameSession<any, any>;

export class RoomRuntime {
  room: Room;

  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly onEmpty: (code: string) => void;
  private readonly onDeparted: (session: SessionId) => void;
  private readonly graceMs: number;
  private readonly connections = new Map<SessionId, Connection>();
  /**
   * Members who have dropped with nothing to hold, each with the timer that
   * lets them go (`LOBBY_GRACE_MS`). Kept up to date after every command by
   * `maintainGrace`, which asks what is true now rather than reacting to
   * particular commands — so a game ending while a seat holder is away
   * starts their clock too, with nobody having to remember that it should.
   */
  private readonly grace = new Map<SessionId, TimerHandle>();

  private session: AnySession | null = null;
  /**
   * The state as it stood before the frame currently being processed.
   * Redaction needs both sides: `projectEvents` works out that a card was
   * concealed a moment ago and is public now by comparing them, which is
   * what tells it to send an `unmask` ahead of the play.
   */
  private previous: unknown = null;
  /**
   * How long the frame most recently broadcast takes to WATCH. See
   * `startSession` for why the next bot turn is spaced by it.
   */
  private lastFramePlaybackMs = 0;
  /** When that frame went out, so "still playing" can be asked later. */
  private lastFrameAt = 0;
  /** Whether it was a deal, whose start waits on each screen (`READY_BEAT_MS`). */
  private lastFrameDealt = false;
  /** The running game's turn timer, ms, or null — fixed when it starts. */
  private turnMs: number | null = null;
  /** Turn-timer timeouts in a row, by person. Two and a bot takes over. */
  private readonly timeouts = new Map<SessionId, number>();
  /** The clock the table was last told about (its key), so it is said once. */
  private sentClockKey: string | null = null;
  /** The next round, dealt if nobody continues in time. See `syncAutoContinue`. */
  private continueTimer: TimerHandle | null = null;
  /**
   * Members' photos, by member. Kept here rather than on the room, which is
   * a pure description that goes to every client; only the id goes out
   * (`MemberView.photo`), and the bytes are fetched once by URL.
   */
  private readonly photos = new Map<SessionId, StoredPhoto>();
  /**
   * Who pays whom for the last game played for money (see `settle.ts`).
   * Worked out here because only the server still holds the position when
   * the leader ends a game — the table is gone from every screen the
   * moment it does. Kept until the next game starts, so it is still in the
   * lobby for anyone who backed out to it first.
   */
  private settlement: SettlementView | null = null;
  /**
   * Whether the game has been played to a winner and settled on it. From
   * then on the settlement is final: leaving the winner's sheet ends the
   * session, and settling again there would read seats that people have
   * since left — a loser who walked out would count as a bot and owe
   * nothing, and the lobby would disagree with the sheet everyone saw.
   */
  private settledAtEnd = false;
  /**
   * Who has sat in which seat of the running game, and where the seat stood
   * when they sat down and got up (see `Stint`): a game played for money is
   * settled between people, each for the time the seat was theirs.
   */
  private stints: Stint<SessionId>[] = [];
  /** The name of everyone with a stint, as last seen — some will have left. */
  private stintNames = new Map<SessionId, string>();
  /** The running game, and its settings parsed — the stake is read from them. */
  private sessionGameId: GameId | null = null;
  private sessionSettings: RawSettings = {};

  constructor(opts: RoomRuntimeOptions) {
    this.room = opts.room;
    this.clock = opts.clock;
    this.rng = opts.rng;
    this.onEmpty = opts.onEmpty;
    this.onDeparted = opts.onDeparted ?? (() => {});
    this.graceMs = opts.graceMs ?? LOBBY_GRACE_MS;
  }

  get code(): string {
    return this.room.code;
  }

  get hasGame(): boolean {
    return this.session !== null;
  }

  /* ---------- connections ---------- */

  attach(session: SessionId, connection: Connection): void {
    // A second tab for the same identity replaces the first rather than
    // doubling it: the seat belongs to the person, not to the socket, and
    // two live sockets for one seat would double every frame and leave
    // "who is really here" ambiguous on disconnect.
    const existing = this.connections.get(session);
    if (existing && existing !== connection) {
      // Told, then closed. A bare close is indistinguishable from the
      // network dropping, so the replaced tab used to retry — which
      // closed the tab that had just taken over, which retried, at about
      // four round trips a second for as long as both were open. Saying
      // WHY is what lets the old tab stand down instead of fighting.
      existing.send({ t: "superseded" });
      existing.close();
    }
    this.connections.set(session, connection);
    this.command(session, { t: "setConnected", connected: true });
    this.broadcastRoom();
    this.sendCurrentFrame(session);
  }

  /**
   * Lets go of one member's socket.
   *
   * `connection` names WHICH socket is going, and passing it is what makes
   * a second tab survivable. `attach` replaces a duplicate identity's old
   * socket with the new one under the same key, and `ws.close()` is
   * asynchronous — so the old socket's close event lands AFTER the
   * replacement is already in the map. Deleting by session id alone
   * therefore evicted the tab that had just arrived: the server decided the
   * player was gone, a bot took their seat, and both tabs went quiet while
   * the person sat looking at the table.
   *
   * Omitting `connection` is the deliberate unconditional form, for a kick
   * or a room being torn down, where the point is that whoever is on the
   * other end goes regardless of which socket they hold.
   */
  detach(session: SessionId, connection?: Connection): void {
    const current = this.connections.get(session);
    if (!current) return;
    if (connection && current !== connection) return;

    this.connections.delete(session);
    if (this.room.members[session]) {
      this.command(session, { t: "setConnected", connected: false });
    }
    this.broadcastRoom();
    if (connectedCount(this.room) === 0) this.onEmpty(this.room.code);
  }

  isAttached(session: SessionId): boolean {
    return this.connections.has(session);
  }

  /* ---------- commands ---------- */

  /**
   * Runs one room command and carries out whatever it asks for.
   *
   * Serialised by construction — this is ordinary synchronous JavaScript,
   * so two clients racing the same action genuinely observe each other's
   * results rather than interleaving halfway through. That is what makes
   * the simultaneous-start case resolve correctly without a lock.
   */
  command(session: SessionId, command: RoomCommand): { ok: true } | { ok: false; error: RoomError } {
    const liveBefore = this.liveSignature();
    const result = applyCommand(this.room, command, {
      actor: session,
      now: this.clock.now(),
      rng: this.rng,
    });
    if (!result.ok) {
      log.debug("command refused", {
        room: this.code,
        session,
        event: command.t,
        error: result.error,
      });
      return result;
    }

    // Before the effects, which may end the session: a seat that has just
    // changed hands is measured against the position it changed hands at.
    const before = this.room;
    this.room = result.room;
    this.trackStints(before, this.room);
    for (const effect of result.effects) this.runEffect(effect);

    // A seat changing hands between a person and a bot is a change to the
    // TABLE, not merely to the roster — every pod says whether a bot is
    // playing it, and `botSeats` rides on a FRAME. Without this the news
    // waited for the next one, and the next one is whenever somebody
    // moves: park the table on a human and their opponent could step away
    // for minutes with nothing on screen saying so. Which is precisely
    // when it matters, since the player left looking at it is the one
    // wondering why nothing is happening.
    //
    // Compared as a signature rather than switched on the command, so
    // every route to it is covered — stepping out, being kicked, a socket
    // dropping, coming back — including ones added later.
    //
    // And then SETTLE, because a seat changing hands changes whose turn
    // it is to take. `settled()` is how a bot turn gets scheduled, and on
    // this server it is only ever reached from `onFrame` — which is to
    // say, from somebody ACTING. Park the table on a live seat and that
    // player drops, and the four games with no `deadline?()` arm nothing:
    // the seat is bot-played, no bot is ever invoked, and the person
    // still at the table waits forever. Asking again here is the whole
    // fix, and it is safe to ask at any time — `settled()` no-ops when
    // the game is over, the round is over, or the seat it lands on is
    // live, so the one case it adds is the one that was missing.
    //
    // After the broadcast, matching `onFrame`'s order: everyone sees the
    // position, and nobody waits for a client.
    if (liveBefore !== "" && this.liveSignature() !== liveBefore) {
      this.broadcastCurrentFrame();
      this.session?.settled();
    }

    this.maintainGrace();
    this.syncTurnClock();
    // Whoever has gone takes their photo with them.
    for (const owner of this.photos.keys()) {
      if (!this.room.members[owner]) this.photos.delete(owner);
    }
    log.info("command", { room: this.code, session, event: command.t });
    return { ok: true };
  }

  /* ---------- photos ---------- */

  /**
   * Sets (or, with null, removes) a member's photo. False when it is not a
   * member or not a photo we will keep (`decodePhoto`). Every new photo gets
   * a new id, so the old URL stops working and nobody is shown a stale one
   * from their cache.
   */
  setPhoto(session: SessionId, image: unknown): boolean {
    if (!this.room.members[session]) return false;
    if (image === null) {
      this.photos.delete(session);
      return true;
    }
    const photo = decodePhoto(image);
    if (!photo) return false;
    this.photos.set(session, { id: newPhotoId(), ...photo });
    return true;
  }

  /** The photo with this id, if a member of this room still has it. */
  photoById(id: string): StoredPhoto | null {
    for (const photo of this.photos.values()) if (photo.id === id) return photo;
    return null;
  }

  /* ---------- letting go of the absent ---------- */

  /** Gone, with nothing waiting for them: the ones `LOBBY_GRACE_MS` is for. */
  private exposed(session: SessionId): boolean {
    const member = this.room.members[session];
    return Boolean(member) && !member!.connected && !holdsSeat(this.room, session);
  }

  private maintainGrace(): void {
    for (const [session, handle] of this.grace) {
      if (this.exposed(session)) continue;
      this.clock.clearTimeout(handle);
      this.grace.delete(session);
    }
    for (const session of Object.keys(this.room.members)) {
      if (!this.exposed(session) || this.grace.has(session)) continue;
      this.grace.set(
        session,
        this.clock.setTimeout(() => this.lapse(session), this.graceMs),
      );
    }
  }

  /**
   * Their grace ran out: they leave, exactly as if they had pressed Leave —
   * the same "X left" everybody would have seen, and leadership handed on.
   */
  private lapse(session: SessionId): void {
    this.grace.delete(session);
    // Re-asked rather than assumed. Every route back cancels the timer, but
    // it costs nothing to be sure before removing somebody.
    if (!this.exposed(session)) return;
    if (!this.command(session, { t: "leave" }).ok) return;
    log.info("member lapsed", { room: this.code, session });
    this.broadcastRoom();
    this.onDeparted(session);
  }

  /**
   * Which seats a connected human is actually playing, as a comparable
   * string. Empty when no game is running, which is what lets the caller
   * tell "the seats changed" from "a game just started or ended" — the
   * latter sends its own frames and does not want a second one.
   */
  private liveSignature(): string {
    const seats = this.room.game?.seats ?? 0;
    let out = "";
    for (let i = 0; i < seats; i++) out += isSeatLive(this.room, i) ? "1" : "0";
    return out;
  }

  /** The current position, to everybody at the table. */
  private broadcastCurrentFrame(): void {
    if (!this.session || !this.room.game) return;
    for (const viewer of this.room.game.present) this.sendCurrentFrame(viewer);
  }

  private runEffect(effect: RoomEffect): void {
    switch (effect.t) {
      case "startSession":
        this.startSession(effect.gameId, effect.settings, effect.seats, effect.difficulty);
        break;
      case "stopSession":
        log.info("session stopped", { room: this.code, event: effect.reason });
        // Before the session goes: this is the last look at the position.
        // Not for a game already played to a winner, whose settlement is
        // final.
        if (!this.settledAtEnd) this.settle();
        this.stopSession();
        break;
      case "notice":
        this.notify(effect.text);
        break;
      case "close":
        this.closeOut(effect.by);
        break;
    }
  }

  /**
   * Tells everybody attached that the room is gone, and lets go of their
   * sockets WITHOUT closing them. The registry destroys the room next
   * (the router does, once this command returns), and its `dispose` closes
   * whatever is still attached — which a client reads as the network
   * dropping, reconnects, and loses the screen that says why. The sockets
   * stay open for whatever each person does next.
   *
   * Whatever was last settled goes with it: a game ended by closing has just
   * been settled by the `stopSession` before this, and one finished earlier
   * is still on the lobby's SettleUp, which is about to vanish with the room.
   */
  private closeOut(by: string): void {
    const settlement = this.settlement;
    for (const connection of this.connections.values()) {
      this.push(connection, { t: "left", reason: "room-closed", by, settlement });
    }
    this.connections.clear();
  }

  /* ---------- the game ---------- */

  private startSession(
    gameId: GameId,
    settings: RawSettings,
    seats: number,
    difficulty: BotDifficulty,
  ): void {
    this.stopSession();
    const definition = gameEntry(gameId).create(settings);
    this.previous = null;
    this.turnMs = this.room.turnTimer.on ? this.room.turnTimer.seconds * 1000 : null;
    this.timeouts.clear();
    this.sessionGameId = gameId;
    this.sessionSettings = gameEntry(gameId).parse(settings);
    this.settlement = null;
    this.settledAtEnd = false;
    // Everybody dealt in starts square: nothing is won or lost before the
    // first card. (The room's game is already the new one — the command's
    // result is in place before its effects run.)
    this.stints = [];
    this.stintNames.clear();
    this.room.game?.seatOwner.forEach((who, seat) => {
      if (who !== null) this.openStint(who, seat, 0);
    });

    const session: AnySession = new GameSession({
      definition,
      seats,
      // From the room's own generator rather than left to `GameSession`,
      // which would otherwise reach for a fresh random one. A registry is
      // seeded randomly in production, so this changes nothing there; it
      // means a seeded registry replays a game's deals and bot choices
      // exactly, which is what lets a test assert on the bots.
      seed: this.rng.int(0x7fffffff),
      difficulty: Array.from({ length: seats }, () => difficulty),
      clock: this.clock,
      // The live read that makes bot takeover instant. Asked fresh on every
      // turn, so a player dropping between two turns is picked up by a bot
      // on the very next one with nothing to reconcile.
      isSeatLive: (seat) => isSeatLive(this.room, seat),
      // How long to wait before the NEXT bot turn is revealed: what the
      // last frame takes to play, plus the same beat offline has.
      //
      // Offline the hold starts when the animation FINISHES, because the
      // browser only calls `settled()` then. Here it starts when the frame
      // is broadcast — the server never waits on a client — and the hold
      // was a flat 900ms. But a bot's `think` (600-1000ms) rides inside
      // the frame and is played out by every client, so each turn took a
      // client longer to watch than the server allowed it: the queue grew
      // by a fraction of a second per bot turn until it passed the
      // catch-up limit, at which point clients dropped the backlog and
      // skipped straight to the present. On a table of bots that meant
      // most animations, and every dice tumble, were skipped.
      //
      // Counting the playback here gives a client at normal speed exactly
      // offline's rhythm. It is still not waiting on anybody: a slow
      // client falls behind and catches up on its own, and nobody else's
      // game is any slower for it.
      //
      // The game may ask for a different beat on a particular turn (see
      // `GameDefinition.turnHold`); the playback measurement is added
      // either way, because that part is the driver's job and not
      // something a game can know.
      turnHoldMs: (state, seat) =>
        this.lastFramePlaybackMs +
        (definition.turnHold?.(state, seat) ?? DEFAULT_TURN_HOLD_MS),
      // A person cannot make a forced move while the frame that handed it to
      // them is still playing on their screen, so their wait starts
      // after it. What is LEFT of it, not all of it: a seat that comes live
      // long after the frame went out has already watched it.
      //
      // A deal adds the beat each screen waits before starting one
      // (`READY_BEAT_MS`): the first move of a round is not the player's to
      // make until their own deal has begun, and then played.
      deadlineLeadMs: () =>
        Math.max(
          0,
          this.lastFrameAt +
            this.lastFramePlaybackMs +
            (this.lastFrameDealt ? READY_BEAT_MS : 0) -
            this.clock.now(),
        ),
      turnTimerMs: () => this.turnMs,
      emit: (frame) => this.onFrame(frame),
    });

    this.session = session;
    this.previous = session.snapshot();
    session.start();
    this.syncTurnClock();
  }

  private stopSession(): void {
    this.clearAutoContinue();
    this.timeouts.clear();
    this.session?.dispose();
    this.session = null;
    this.previous = null;
  }

  /**
   * Deals the next round if nobody has pressed Continue within
   * `AUTO_CONTINUE_MS` of the scorecard appearing (the user, 2026-09-29).
   *
   * The leader's own screen sends Continue the moment its ring empties, so
   * this is the backstop — for a leader whose tab is hidden (its timers
   * throttled) or who has simply walked off. Counted from when the card
   * shows on their screen: the last move still has to play, then the board
   * is held (`ROUND_END_HOLD_MS`), and only then does the card go up.
   */
  private syncAutoContinue(): void {
    const session = this.session;
    const state = session?.snapshot();
    const waiting =
      session !== null &&
      !session.definition.isOver(state) &&
      Boolean(session.definition.isRoundOver?.(state));
    if (!waiting) {
      this.clearAutoContinue();
      return;
    }
    if (this.continueTimer !== null) return;
    this.continueTimer = this.clock.setTimeout(
      () => {
        this.continueTimer = null;
        this.session?.nextRound();
      },
      this.lastFramePlaybackMs + ROUND_END_HOLD_MS + AUTO_CONTINUE_MS + AUTO_CONTINUE_GRACE_MS,
    );
  }

  private clearAutoContinue(): void {
    if (this.continueTimer === null) return;
    this.clock.clearTimeout(this.continueTimer);
    this.continueTimer = null;
  }

  /**
   * A settled batch from the session, fanned out one redaction per viewer.
   *
   * The server settles immediately after broadcasting rather than waiting
   * for anyone to acknowledge. That is the whole of "a slow client never
   * bogs down the table": the authoritative clock keeps its own time, and
   * catching up is the laggard's problem to solve locally.
   */
  private onFrame(frame: SessionFrame<unknown>): void {
    const session = this.session;
    if (!session) return;

    const after = session.snapshot();
    const before = this.previous ?? after;

    for (const [viewer, connection] of this.connections) {
      if (!this.room.game?.present.includes(viewer)) continue;
      const view = this.buildFrame(frame, viewer, before, after);
      this.push(connection, { t: "frame", frame: view });
    }

    this.previous = after;
    // Before `settled()`, which is what reads it to schedule the next turn.
    this.lastFramePlaybackMs = playbackMs(frame.events);
    this.lastFrameAt = this.clock.now();
    this.lastFrameDealt = frame.dealtRound !== null;
    // Played to a winner: settle up now, while everyone is still at the
    // table to see it on the winner's sheet. Once — frames after the end
    // (a show or muck) must not settle, or broadcast, all over again.
    if (!this.settledAtEnd && session.definition.isOver(after) && this.room.game) {
      this.settledAtEnd = true;
      this.settle();
      this.broadcastRoom();
    }
    session.settled();
    this.syncAutoContinue();
    if (frame.timedOut !== undefined) this.countTimeout(frame.timedOut);
    this.syncTurnClock();
  }

  /* ---------- the turn timer ---------- */

  /**
   * The turn timer made somebody's move. Twice in a row and they have
   * walked away: a bot takes their seat until they come back (the user,
   * 2026-09-29), through the same live-signature edge a disconnect takes,
   * so the table moves on at a bot's pace rather than a timer's.
   */
  private countTimeout(seat: SeatId): void {
    const owner = this.room.game?.seatOwner[seat];
    if (!owner) return;
    const count = (this.timeouts.get(owner) ?? 0) + 1;
    this.timeouts.set(owner, count);
    if (count >= 2) {
      this.timeouts.delete(owner);
      this.command(owner, { t: "markIdle" });
      // Started here, not by a message, so nothing else re-sends the room:
      // without this their own screen never learns it, and "I'm back" never
      // appears (found by the test that asserts it does).
      this.broadcastRoom();
    }
  }

  /**
   * Tells the table whose clock is running, when that has changed. Read
   * from the session after it has settled, so it is the final answer for
   * the position: a clear followed at once by a re-arm is never sent.
   */
  private syncTurnClock(): void {
    const clock = this.session?.turnClock ?? null;
    const key = clock?.key ?? null;
    if (key === this.sentClockKey) return;
    this.sentClockKey = key;
    for (const viewer of this.room.game?.present ?? []) this.sendTurnClock(viewer);
  }

  /** The clock as it stands now, to one person — with the time actually left. */
  private sendTurnClock(viewer: SessionId): void {
    const connection = this.connections.get(viewer);
    if (!connection) return;
    const clock = this.session?.turnClock ?? null;
    this.push(connection, {
      t: "turnClock",
      clock: clock
        ? {
            seat: clock.seat,
            key: clock.key,
            totalMs: clock.totalMs,
            endsInMs: Math.max(0, clock.endsAt - this.clock.now()),
          }
        : null,
    });
  }

  /**
   * Closes the stint of anybody who has just given up a seat, and opens one
   * for anybody who has just taken one, at the position this moment. Mid-game
   * that is `enterGame` into an open seat and leaving (or being removed from)
   * the room — compared rather than switched on, like `liveSignature`, so a
   * route added later is covered too. A command that ends the game leaves
   * the stints open, and `settle` measures them to the final position.
   */
  private trackStints(before: Room, after: Room): void {
    const session = this.session;
    const was = before.game;
    const is = after.game;
    if (!session || !was || !is || this.settledAtEnd || !this.sessionGameId) return;
    if (was.seatOwner.every((owner, seat) => owner === is.seatOwner[seat])) return;
    const now = seatNets(this.sessionGameId, session.snapshot(), this.sessionSettings);
    if (!now) return;
    was.seatOwner.forEach((left, seat) => {
      const came = is.seatOwner[seat] ?? null;
      if (left === came) return;
      if (left !== null) {
        const stint = this.stints.find((s) => s.who === left && s.seat === seat && s.to === null);
        if (stint) stint.to = now[seat] ?? 0;
        // Read from the room they were still in, since they may be gone now.
        const name = before.members[left]?.name;
        if (name) this.stintNames.set(left, name);
      }
      if (came !== null) this.openStint(came, seat, now[seat] ?? 0);
    });
  }

  private openStint(who: SessionId, seat: SeatId, from: number): void {
    this.stints.push({ who, seat, from, to: null });
    const name = this.room.members[who]?.name;
    if (name) this.stintNames.set(who, name);
  }

  /**
   * The payments for the game now ending, from its position this moment:
   * between everybody who sat at the table, each for the time their seat was
   * theirs, and never with a bot (see `Stint` and `amongPeople`).
   */
  private settle(): void {
    const session = this.session;
    const gameId = this.sessionGameId;
    if (!session || !gameId) return;
    const state = session.snapshot();
    const settled = settleUp(gameId, state, this.sessionSettings, this.stints);
    if (!settled) {
      this.settlement = null;
      return;
    }
    // A current member by their name now, in case they renamed; somebody who
    // has left by the name they had when they did.
    const nameOf = (who: SessionId) => this.room.members[who]?.name ?? this.stintNames.get(who) ?? "Someone";
    this.settlement = {
      gameId,
      stake: settled.stake,
      finished: session.definition.isOver(state),
      results: settled.results
        .map((r) => ({ session: r.who, name: nameOf(r.who), cents: r.cents }))
        .sort((a, b) => b.cents - a.cents),
      payments: settled.payments.map((p) => ({
        from: p.from,
        fromName: nameOf(p.from),
        to: p.to,
        toName: nameOf(p.to),
        cents: p.cents,
      })),
      botsLeftOut: settled.botsLeftOut,
    };
  }

  private buildFrame(
    frame: SessionFrame<unknown>,
    viewer: SessionId,
    before: unknown,
    after: unknown,
  ): FrameView {
    const session = this.session!;
    const definition = session.definition;
    const seat = seatOf(this.room, viewer);
    const asSeat = seat ?? SPECTATOR_SEAT;

    const truthBefore: PlacementMap = definition.placements(before, asSeat);
    const truthAfter: PlacementMap = definition.placements(after, asSeat);
    const allMeta = session.pieceMeta();
    const { placements, meta: standInMeta } = redactPlacements(truthAfter, allMeta);

    // Meta for everything on this viewer's board, not just the stand-ins.
    //
    // Sending only the stand-ins left every face-up piece without a
    // `PieceMeta`, and `PieceLayer` renders nothing for a piece it cannot
    // describe — so an online table drew all 39 concealed cards and none
    // of the viewer's own thirteen. Their whole hand was missing.
    //
    // It leaks nothing: these are exactly the pieces the redaction has
    // already decided this seat may identify, and a card they can name is
    // a card whose face they are entitled to.
    const events = projectEvents(frame.events, truthBefore, truthAfter);
    const meta: Record<PieceId, PieceMeta> = { ...standInMeta };
    // ...and for anything the batch names on the way, which the settled
    // board may no longer hold: the last card of a trick is played face up
    // and collected face down in one reduce. See `piecesNamed`.
    for (const id of [...Object.keys(placements), ...piecesNamed(events)]) {
      if (!meta[id] && allMeta[id]) meta[id] = allMeta[id];
    }
    // ...and for the stand-ins a `mask` puts on the table mid-batch, which
    // the settled board names differently. Shaped like what they replace —
    // a hidden domino is still domino-shaped — and faceless, like every
    // stand-in.
    for (const event of events) {
      if (event.t !== "mask") continue;
      const kind = allMeta[event.drop[0]!]?.kind ?? "card";
      for (const { piece } of event.add) meta[piece] ??= { kind, face: "" };
    }

    const game = this.room.game;
    const seatNames: Array<string | null> = Array.from({ length: game?.seats ?? 0 }, (_, i) => {
      const owner = game?.seatOwner[i];
      return owner ? (this.room.members[owner]?.name ?? null) : null;
    });
    const botSeats: SeatId[] = [];
    for (let i = 0; i < (game?.seats ?? 0); i++) if (!isSeatLive(this.room, i)) botSeats.push(i);

    return {
      seq: frame.seq,
      events,
      state: definition.playerView(after, asSeat),
      placements,
      meta,
      seat,
      currentSeat: definition.currentSeat(after),
      round: extractRound(after),
      dealtRound: frame.dealtRound,
      isOver: definition.isOver(after),
      isRoundOver: definition.isRoundOver?.(after) ?? false,
      winner: definition.isOver(after) ? extractWinner(after) : null,
      winningSeats: definition.isOver(after) ? resolveWinningSeats(after) : null,
      roundWinner: extractRoundWinner(after),
      roundWinningSeats: resolveRoundWinningSeats(after),
      seatNames,
      botSeats,
      lastAction: safeLastAction(frame.lastAction, truthAfter),
    };
  }

  /** Re-sends the table's current position to one viewer — the whole of reconnection. */
  sendCurrentFrame(viewer: SessionId): void {
    const session = this.session;
    const connection = this.connections.get(viewer);
    if (!session || !connection) return;
    if (!this.room.game?.present.includes(viewer)) return;

    const now = session.snapshot();
    // No events: nothing "happened", this is a position. The client
    // reconciles its board from `placements` and carries on. That frames
    // are whole snapshots rather than deltas is what makes reconnection
    // this cheap — there is no log to replay.
    this.push(connection, {
      t: "frame",
      frame: this.buildFrame({ seq: 0, events: [], lastAction: null, dealtRound: null }, viewer, now, now),
    });
    // Arriving mid-move: the clock as it stands, never a fresh one.
    this.sendTurnClock(viewer);
  }

  submitAction(session: SessionId, action: unknown): { ok: boolean; error?: string } {
    if (!this.session) return { ok: false, error: "no-game-running" };
    const seat = seatOf(this.room, session);
    if (seat === null) return { ok: false, error: "not-in-game" };
    // A spectator has no seat, so they never reach here; a seated player
    // who is not on turn is refused by the session's own gate.
    const result = this.session.submit(seat, action);
    if (!result.ok) {
      const auto = this.session.autoPlayed(seat, LATE_PRESS_MS);
      // Their last card, a moment after it was played for them: the same
      // move, arriving second. Nothing to tell them.
      if (auto === "forced") return { ok: false, error: PLAYED_FOR_YOU };
      // Their clock ran out just before this arrived: say so, rather than
      // "not your turn", which is true and baffling.
      if (auto === "timeout") return { ok: false, error: "timed-out" };
      return { ok: false, error: result.reason };
    }
    // A move they made themselves: they are here.
    this.timeouts.delete(session);
    // And if the timer had given their seat to a bot, a move is also
    // "I'm back" — the session's gate asks whose turn it is, not who is live.
    if (isIdle(this.room, session)) {
      this.command(session, { t: "resume" });
      this.broadcastRoom();
    }
    if (!result.animated) this.session.settled();
    this.syncTurnClock();
    return { ok: true };
  }


  nextRound(session: SessionId): boolean {
    if (!this.session) return false;
    // The leader's call while they are at the table, and anyone seated's
    // when they are not — see `mayContinueRound`. It used to be anyone
    // seated, always, and the user wants the leader to continue.
    // Deliberately not deduped: `GameSession.nextRound` already no-ops
    // unless a round is genuinely over.
    if (!mayContinueRound(this.room, session)) return false;
    this.session.nextRound();
    return true;
  }

  /* ---------- fan-out ---------- */

  /**
   * Sends to one socket, dropping the message if that socket has stopped
   * draining. Silence beats a queue that grows without bound: the next
   * frame is a full snapshot, so anything skipped is superseded rather
   * than lost.
   */
  private push(connection: Connection, message: ServerMessage): void {
    if (connection.bufferedAmount() > BACKPRESSURE_BYTES) {
      log.warn("dropping frame for a backed-up socket", { room: this.code });
      return;
    }
    connection.send(message);
  }

  /** Same text to everyone attached — a room notice is public by nature. */
  private notify(text: string): void {
    for (const connection of this.connections.values()) {
      this.push(connection, { t: "notice", text });
    }
  }

  broadcastRoom(): void {
    for (const [session, connection] of this.connections) {
      this.push(connection, { t: "room", room: this.viewFor(session) });
    }
  }

  /**
   * The room as one member is allowed to see it.
   *
   * `pending` is the field that matters: it carries the names of people
   * knocking on a private room, and only the leader — the one person who
   * can act on them — is shown the list.
   */
  viewFor(session: SessionId): RoomView {
    const room = this.room;
    const isLeader = room.leader === session;
    const game = room.game;

    // In seating order: the roster IS the seating plan (`seatingPlan`).
    const plan = seatingPlan(room);
    const members: MemberView[] = seatingOrder(room).map((m) => {
      const seat = seatOf(room, m.session);
      return {
        session: m.session,
        name: m.name,
        // Silent, as the user asked: somebody inside their grace looks
        // exactly as they did, and simply goes if it runs out.
        connected: m.connected || this.grace.has(m.session),
        photo: this.photos.get(m.session)?.id ?? null,
        idle: isIdle(room, m.session),
        seat,
        spectating: Boolean(game?.present.includes(m.session)) && seat === null,
        // The seat decides the side: the one they hold in a running game,
        // or the one the plan gives them for the next.
        team: teamOfSeat(room, game ? (seat ?? -1) : plan.indexOf(m.session)),
        isLeader: room.leader === m.session,
      };
    });

    return {
      code: room.code,
      privacy: room.privacy,
      you: session,
      youAreLeader: isLeader,
      members,
      seatPlan: plan,
      pending: isLeader
        ? Object.values(room.pending).map((p) => ({ session: p.session, name: p.name }))
        : [],
      gameId: room.gameId,
      settings: room.settings,
      seats: room.seats,
      difficulty: room.difficulty,
      gameRunning: game !== null,
      openSeats: openSeats(room),
      inGame: Boolean(game?.present.includes(session)),
      youMayContinue: mayContinueRound(room, session),
      settlement: this.settlement,
      turnTimer: room.turnTimer,
    };
  }

  send(session: SessionId, message: ServerMessage): void {
    const connection = this.connections.get(session);
    if (connection) this.push(connection, message);
  }

  /**
   * Hangs up on one client deliberately — fault injection for reconnection
   * tests, which otherwise have to wait for a real network to misbehave at
   * exactly the right moment.
   *
   * Closes the socket rather than quietly forgetting it, so the client sees
   * a genuine disconnect and takes its real reconnect path instead of a
   * simulated one.
   */
  dropConnection(session: SessionId): void {
    const connection = this.connections.get(session);
    if (!connection) return;
    connection.close();
    this.detach(session, connection);
  }

  /** For the debug endpoint — the authoritative truth, never redacted. */
  debugDump(): Record<string, unknown> {
    return {
      code: this.room.code,
      privacy: this.room.privacy,
      leader: this.room.leader,
      members: this.room.members,
      pending: this.room.pending,
      gameId: this.room.gameId,
      settings: this.room.settings,
      seats: this.room.seats,
      seatPlan: seatingPlan(this.room),
      game: this.room.game,
      attached: [...this.connections.keys()],
      sessionRunning: this.session !== null,
      liveSeats: this.room.game
        ? Array.from({ length: this.room.game.seats }, (_, i) => isSeatLive(this.room, i))
        : [],
      turnClock: this.session?.turnClock ?? null,
      timeouts: Object.fromEntries(this.timeouts),
      // Enough of the table for a test to assert that something did or did
      // not move, without publishing the actual cards — this endpoint is
      // dev-only, but a dump that casually included every hand would be
      // one careless deploy away from being the leak it exists to detect.
      table: this.session
        ? {
            currentSeat: this.session.definition.currentSeat(this.session.snapshot()),
            round: extractRound(this.session.snapshot()),
            isOver: this.session.definition.isOver(this.session.snapshot()),
            fingerprint: fingerprint(this.session.snapshot()),
          }
        : null,
    };
  }

  dispose(): void {
    for (const handle of this.grace.values()) this.clock.clearTimeout(handle);
    this.grace.clear();
    this.photos.clear();
    this.stopSession();
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }
}

/**
 * A cheap, order-stable digest of a game state, so a test can say "nothing
 * moved" without needing to understand any game's shape — and without the
 * dump having to carry the state itself.
 */
function fingerprint(state: unknown): string {
  const json = JSON.stringify(state) ?? "";
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/**
 * An action is safe to forward only if every piece it names is one this
 * viewer may already identify.
 *
 * Checked by scanning the serialised action for concealed ids rather than
 * by understanding any game's action shape — there are five games and the
 * shapes have nothing in common, and a per-game allowlist is a thing to
 * forget to update. Withholding one costs a screen a flourish; forwarding
 * one leaks a card.
 */
function safeLastAction(
  last: { seat: SeatId; action: unknown } | null,
  truth: PlacementMap,
): { seat: SeatId; action: unknown } | null {
  if (!last) return null;
  const wire = JSON.stringify(last.action);
  if (wire === undefined) return null;
  for (const [id, placement] of Object.entries(truth)) {
    if (placement.faceUp) continue;
    if (wire.includes(`"${id}"`)) return null;
  }
  return last;
}
