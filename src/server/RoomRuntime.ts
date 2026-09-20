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
import { playbackMs } from "@/motion/choreographer";
import { gameEntry, type GameId, type RawSettings } from "@/session/registry";
import { projectEvents, redactPlacements } from "@/session/redact";
import {
  applyCommand,
  connectedCount,
  isSeatLive,
  openSeats,
  orderedMembers,
  seatOf,
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
import type { FrameView, MemberView, RoomView, ServerMessage } from "@/session/protocol";
import type { Clock } from "@/session/clock";
import { log } from "./log";

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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySession = GameSession<any, any>;

export class RoomRuntime {
  room: Room;

  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly onEmpty: (code: string) => void;
  private readonly connections = new Map<SessionId, Connection>();

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

  constructor(opts: RoomRuntimeOptions) {
    this.room = opts.room;
    this.clock = opts.clock;
    this.rng = opts.rng;
    this.onEmpty = opts.onEmpty;
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

    this.room = result.room;
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

    log.info("command", { room: this.code, session, event: command.t });
    return { ok: true };
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
        this.stopSession();
        break;
      case "notice":
        this.notify(effect.text);
        break;
    }
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
      turnHoldMs: () => this.lastFramePlaybackMs + DEFAULT_TURN_HOLD_MS,
      emit: (frame) => this.onFrame(frame),
    });

    this.session = session;
    this.previous = session.snapshot();
    session.start();
  }

  private stopSession(): void {
    this.session?.dispose();
    this.session = null;
    this.previous = null;
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
    session.settled();
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
    const meta: Record<PieceId, PieceMeta> = { ...standInMeta };
    for (const id of Object.keys(placements)) {
      if (!meta[id] && allMeta[id]) meta[id] = allMeta[id];
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
      events: projectEvents(frame.events, truthBefore, truthAfter),
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
  }

  submitAction(session: SessionId, action: unknown): { ok: boolean; error?: string } {
    if (!this.session) return { ok: false, error: "no-game-running" };
    const seat = seatOf(this.room, session);
    if (seat === null) return { ok: false, error: "not-in-game" };
    // A spectator has no seat, so they never reach here; a seated player
    // who is not on turn is refused by the session's own gate.
    const result = this.session.submit(seat, action);
    if (!result.ok) return { ok: false, error: result.reason };
    if (!result.animated) this.session.settled();
    return { ok: true };
  }

  nextRound(session: SessionId): boolean {
    if (!this.session) return false;
    // A seat, not merely presence: a spectator has no round to continue.
    if (seatOf(this.room, session) === null) return false;
    // Deliberately not leader-gated and deliberately not deduped —
    // `GameSession.nextRound` already no-ops unless a round is genuinely
    // over, so the second of two players pressing Continue together is
    // harmless rather than a race to guard.
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

    const members: MemberView[] = orderedMembers(room).map((m) => ({
      session: m.session,
      name: m.name,
      connected: m.connected,
      seat: seatOf(room, m.session),
      spectating: Boolean(game?.present.includes(m.session)) && seatOf(room, m.session) === null,
      team: room.teams?.[m.session] ?? null,
      isLeader: room.leader === m.session,
    }));

    return {
      code: room.code,
      privacy: room.privacy,
      you: session,
      youAreLeader: isLeader,
      members,
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
      teams: this.room.teams,
      game: this.room.game,
      attached: [...this.connections.keys()],
      sessionRunning: this.session !== null,
      liveSeats: this.room.game
        ? Array.from({ length: this.room.game.seats }, (_, i) => isSeatLive(this.room, i))
        : [],
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
