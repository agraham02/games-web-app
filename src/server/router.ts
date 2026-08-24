/**
 * Turns raw socket traffic into room commands.
 *
 * Deliberately knows nothing about `ws`. It takes a `Connection` — an
 * object with `send`, `close` and `bufferedAmount` — which means the whole
 * server can be driven from a test with a fake one, no ports and no
 * sockets, and the adversarial cases the spec asks for (malformed frames,
 * out-of-turn moves, a stale token, two clients racing) are ordinary
 * function calls.
 *
 * The rule everything here follows: **a client is never trusted with
 * anything but its own token.** It does not say which room it is in, which
 * seat it holds, or who it is. Those come from the registry, keyed off the
 * token it presented. A message that tried to name them would be a message
 * that could name somebody else's.
 */

import {
  parseClientMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerErrorCode,
} from "@/session/protocol";
import { isGameId } from "@/session/registry";
import type { RoomCommand, SessionId } from "@/session/room";
import type { Connection } from "./RoomRuntime";
import type { RoomRegistry } from "./RoomRegistry";
import { log } from "./log";

/**
 * A generous ceiling — real play is a handful of messages per turn, and
 * anything near this is either a bug or somebody probing. Enforced per
 * connection so one misbehaving client cannot spend anybody else's budget.
 */
const MAX_MESSAGES_PER_WINDOW = 120;
const RATE_WINDOW_MS = 10_000;

/** A payload beyond this is refused unread. */
const MAX_MESSAGE_BYTES = 64 * 1024;

export interface Peer {
  connection: Connection;
  /** Null until a valid `hello` has been seen. */
  session: SessionId | null;
  windowStartedAt: number;
  countInWindow: number;
}

export function makePeer(connection: Connection, now: number): Peer {
  return { connection, session: null, windowStartedAt: now, countInWindow: 0 };
}

export class Router {
  /**
   * Peers who have knocked on a private room and are waiting to be let in.
   *
   * They cannot be attached to the room yet — they are not members, and
   * attaching would put them in the roster the leader has not agreed to.
   * But their socket has to be findable at the moment approval lands, or
   * being approved does nothing observable and they sit on a waiting screen
   * forever while their membership quietly exists without them.
   */
  private readonly awaiting = new Map<SessionId, { peer: Peer; code: string }>();

  constructor(
    private readonly registry: RoomRegistry,
    private readonly now: () => number,
  ) {}

  onMessage(peer: Peer, raw: string): void {
    if (raw.length > MAX_MESSAGE_BYTES) {
      this.fail(peer, "bad-message", "message too large");
      return;
    }
    if (this.rateLimited(peer)) {
      this.fail(peer, "rate-limited", "slow down");
      return;
    }

    const message = parseClientMessage(raw);
    if (!message) {
      // Malformed input is answered, not tolerated silently and not fatal:
      // a garbled frame from a flaky client should not cost somebody their
      // seat, and an answer is what makes a probe legible in the logs.
      this.fail(peer, "bad-message", "unrecognised message");
      return;
    }

    if (message.t === "ping") {
      peer.connection.send({ t: "pong" });
      return;
    }

    if (message.t === "hello") {
      this.hello(peer, message.token, message.protocol);
      return;
    }

    const session = peer.session;
    if (!session) {
      this.fail(peer, "bad-message", "say hello first", message.reqId);
      return;
    }

    if (message.t === "createRoom") {
      this.createRoom(peer, session, message.name, message.reqId);
      return;
    }

    if (message.t === "joinRoom") {
      this.joinRoom(peer, session, message.code, message.name, message.reqId);
      return;
    }

    const runtime = this.registry.roomOf(session);
    if (!runtime) {
      this.fail(peer, "no-room", "you are not in a room", message.reqId);
      return;
    }

    switch (message.t) {
      case "action": {
        const result = runtime.submitAction(session, message.action);
        if (!result.ok) {
          // An out-of-turn or illegal move is an ordinary answer, not a
          // disconnect. The client's own view is stale or its user was
          // quick; either way the authoritative board is unchanged and the
          // next frame will put them right.
          this.fail(peer, "bad-message", result.error ?? "rejected", message.reqId);
        }
        return;
      }

      case "nextRound":
        runtime.nextRound(session);
        return;

      case "leaveRoom": {
        const ok = runtime.command(session, { t: "leave" });
        if (!ok.ok) {
          this.fail(peer, ok.error, ok.error, message.reqId);
          return;
        }
        this.registry.displace(session);
        peer.connection.send({ t: "left", reason: "left" });
        runtime.broadcastRoom();
        return;
      }

      default: {
        const command = toCommand(message);
        if (!command) {
          this.fail(peer, "bad-message", "unrecognised message", message.reqId);
          return;
        }
        const result = runtime.command(session, command);
        if (!result.ok) {
          this.fail(peer, result.error, result.error, message.reqId);
          return;
        }
        // A kick has to reach the person kicked, who is about to stop being
        // addressable through this room at all.
        if (command.t === "kick") {
          runtime.send(command.session, { t: "left", reason: "kicked" });
          this.registry.displace(command.session);
        }
        // Approval is the moment a waiting socket becomes a member's
        // socket. Without this the membership exists and the person never
        // hears about it.
        if (command.t === "approve") this.admit(command.session, runtime.code);
        if (command.t === "deny") {
          const waiting = this.awaiting.get(command.session);
          waiting?.peer.connection.send({ t: "left", reason: "room-closed" });
          this.awaiting.delete(command.session);
        }
        runtime.broadcastRoom();
        if (command.t === "enterGame") runtime.sendCurrentFrame(session);
        return;
      }
    }
  }

  onClose(peer: Peer): void {
    if (!peer.session) return;
    this.awaiting.delete(peer.session);
    const runtime = this.registry.roomOf(peer.session);
    runtime?.detach(peer.session);
  }

  /**
   * Connects somebody the leader has just approved.
   *
   * Silently does nothing if they have gone, and that is correct rather
   * than merely tolerable: the membership is already recorded, so when they
   * come back their `hello` finds the room and lets them straight in. The
   * spec's "approved after the requester disconnected" case needs no
   * special handling anywhere — it falls out of admitting the identity
   * rather than the socket.
   */
  private admit(session: SessionId, code: string): void {
    const waiting = this.awaiting.get(session);
    this.awaiting.delete(session);
    this.registry.place(session, code);
    const runtime = this.registry.get(code);
    if (!runtime || !waiting) return;
    runtime.attach(session, waiting.peer.connection);
  }

  /* ---------- handlers ---------- */

  /**
   * Establishes who is speaking, and — if that identity is already in a
   * room — puts them straight back into it.
   *
   * This single path covers every kind of return: a refresh, a dropped
   * connection, an accidental back button. None of them need special
   * handling because none of them are distinguishable from the server's
   * side, and none of them should be.
   */
  private hello(peer: Peer, token: string, protocol: number): void {
    if (protocol !== PROTOCOL_VERSION) {
      // Refused rather than best-effort: a mismatched client will
      // misinterpret frames in ways that look like game bugs.
      this.fail(peer, "bad-message", `protocol ${PROTOCOL_VERSION} required`);
      peer.connection.close();
      return;
    }

    const session = this.registry.sessionFor(token);
    peer.session = session;
    peer.connection.send({ t: "hello", session, protocol: PROTOCOL_VERSION });

    const runtime = this.registry.roomOf(session);
    if (!runtime) return; // A token nobody has seen in a room is simply new.

    log.info("session returned", { room: runtime.code, session });
    this.registry.place(session, runtime.code);
    // `attach` re-marks them connected, re-broadcasts the roster and
    // replays the table's current position — the seat they own is still
    // theirs because nothing ever gave it away.
    runtime.attach(session, peer.connection);
  }

  private createRoom(peer: Peer, session: SessionId, name: string, reqId?: string): void {
    const existing = this.registry.roomOf(session);
    if (existing) {
      // Leaving first keeps one person out of two rooms, which nothing
      // downstream is built to represent.
      existing.command(session, { t: "leave" });
      existing.broadcastRoom();
      this.registry.displace(session);
    }

    const runtime = this.registry.create(session, name.trim().slice(0, 20) || "Player");
    this.registry.place(session, runtime.code);
    runtime.attach(session, peer.connection);
    void reqId;
  }

  private joinRoom(
    peer: Peer,
    session: SessionId,
    code: string,
    name: string,
    reqId?: string,
  ): void {
    const runtime = this.registry.get(code);
    if (!runtime) {
      this.fail(peer, "no-such-room", "no room with that code", reqId);
      return;
    }

    const result = runtime.command(session, { t: "join", name });
    if (!result.ok) {
      this.fail(peer, result.error, result.error, reqId);
      return;
    }

    // A private room queues the request instead of admitting them, so they
    // are told to wait rather than being handed a roster they are not in.
    if (runtime.room.pending[session]) {
      this.awaiting.set(session, { peer, code: runtime.code });
      peer.connection.send({ t: "pending", code: runtime.code });
      runtime.broadcastRoom();
      return;
    }

    this.registry.place(session, runtime.code);
    runtime.attach(session, peer.connection);
  }

  /* ---------- plumbing ---------- */

  private rateLimited(peer: Peer): boolean {
    const now = this.now();
    if (now - peer.windowStartedAt > RATE_WINDOW_MS) {
      peer.windowStartedAt = now;
      peer.countInWindow = 0;
    }
    peer.countInWindow += 1;
    return peer.countInWindow > MAX_MESSAGES_PER_WINDOW;
  }

  private fail(peer: Peer, code: ServerErrorCode, message: string, reqId?: string): void {
    peer.connection.send({ t: "error", code, message, reqId });
  }
}

/**
 * Maps the remaining wire messages onto room commands.
 *
 * A near-identity mapping, and kept explicit anyway: the two vocabularies
 * are allowed to diverge (the wire has `leaveRoom`, the machine has
 * `leave`; the machine has `setConnected`, which no client may ever send)
 * and a blanket cast would quietly hand clients the ones they should not
 * have.
 */
function toCommand(message: ClientMessage): RoomCommand | null {
  switch (message.t) {
    case "rename":
      return { t: "rename", name: message.name };
    case "promote":
      return { t: "promote", session: message.session };
    case "kick":
      return { t: "kick", session: message.session };
    case "approve":
      return { t: "approve", session: message.session };
    case "deny":
      return { t: "deny", session: message.session };
    case "setPrivacy":
      return { t: "setPrivacy", privacy: message.privacy };
    case "selectGame":
      // The parser lets any string through as a game id because the list
      // of games lives in the registry, not the wire format. This is where
      // it actually gets checked.
      return isGameId(message.gameId)
        ? {
            t: "selectGame",
            gameId: message.gameId,
            settings: message.settings,
            seats: message.seats,
            difficulty: message.difficulty,
          }
        : null;
    case "assignTeam":
      return { t: "assignTeam", session: message.session, team: message.team };
    case "randomizeTeams":
      return { t: "randomizeTeams" };
    case "startGame":
      return { t: "startGame" };
    case "enterGame":
      return { t: "enterGame", as: message.as };
    case "exitGame":
      return { t: "exitGame" };
    case "endGame":
      return { t: "endGame" };
    default:
      return null;
  }
}
