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
  errorText,
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

  /**
   * The boundary between one client's message and the process.
   *
   * Everything a socket can reach is behind this, and it is a `try` for a
   * blunt reason: before it existed there was nothing at all. A room
   * command that threw — and one did, on a team index of `-1`, which a
   * leader is entirely allowed to send — escaped `applyCommand`, escaped
   * this router, escaped the `ws` message listener, and became an uncaught
   * exception that took every live room in the process with it. One
   * player's malformed frame ended everybody else's game.
   *
   * Catching leaves consistent state rather than papering over a mess:
   * `RoomRuntime.command` assigns `this.room` only after `applyCommand`
   * has returned, so a throw part-way through leaves the room exactly as
   * it was. The client is told, the server logs it, and the other five
   * people at the table never find out.
   */
  onMessage(peer: Peer, raw: string): void {
    try {
      this.route(peer, raw);
    } catch (error) {
      log.error("message handler threw", {
        session: peer.session ?? undefined,
        error: error instanceof Error ? error.message : String(error),
      });
      this.fail(peer, "bad-message", "that request could not be handled");
    }
  }

  private route(peer: Peer, raw: string): void {
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
          //
          // `move-refused` rather than `bad-message`, which is what this
          // used to send: a client switching on `code` could not tell a
          // lost race from a parse failure, so it could not sensibly
          // decide which of the two is worth interrupting somebody over.
          this.fail(peer, "move-refused", result.error ?? "rejected", message.reqId);
        }
        return;
      }

      case "nextRound":
        runtime.nextRound(session);
        return;

      case "leaveRoom": {
        const ok = runtime.command(session, { t: "leave" });
        if (!ok.ok) {
          this.fail(peer, ok.error, errorText(ok.error), message.reqId);
          return;
        }
        // Told first, let go of second: `left` goes down this peer's own
        // socket, but the roster broadcast inside `detach` must not.
        peer.connection.send({ t: "left", reason: "left" });
        // Forgetting the room is not the same as the room forgetting them.
        // Without this the socket stayed in the runtime's fan-out map, so a
        // departed player kept receiving roster updates for a room they had
        // left — and `useRoom` acts on a `room` message, so the next thing
        // anybody did in that room dragged them back into its lobby.
        //
        // It also strands the room itself: `onEmpty` is reachable only
        // through here, so a room everybody politely LEFT (as opposed to
        // dropping out of) was never handed to the reaper and held its code
        // and its memory for the life of the process.
        runtime.detach(session, peer.connection);
        this.registry.displace(session);
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
          this.fail(peer, result.error, errorText(result.error), message.reqId);
          return;
        }
        // A kick has to reach the person kicked, who is about to stop being
        // addressable through this room at all.
        if (command.t === "kick") {
          runtime.send(command.session, { t: "left", reason: "kicked" });
          // Unconditional detach — whichever socket they hold, they are out.
          runtime.detach(command.session);
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

  /**
   * Guarded for the same reason as `onMessage`, and with less recourse: a
   * socket closing is not a request anybody is waiting on an answer to, so
   * a throw here would be a crash with no user-visible cause at all.
   */
  onClose(peer: Peer): void {
    if (!peer.session) return;
    try {
      this.awaiting.delete(peer.session);
      const runtime = this.registry.roomOf(peer.session);
      runtime?.detach(peer.session, peer.connection);
    } catch (error) {
      log.error("close handler threw", {
        session: peer.session,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
  /**
   * Takes a peer out of whatever room it is currently in, if any.
   *
   * One person is in one room. Nothing downstream — not the registry's
   * `located` map, not a seat reservation, not the roster — is built to
   * represent somebody in two, and the failure mode if they are is quiet:
   * two rooms both broadcasting at one socket, each overwriting the
   * other's view of where its owner is.
   */
  private leaveCurrentRoom(peer: Peer, session: SessionId): void {
    const existing = this.registry.roomOf(session);
    if (!existing) return;
    existing.command(session, { t: "leave" });
    existing.detach(session, peer.connection);
    this.registry.displace(session);
  }

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

    // A socket may only speak for one identity at a time.
    //
    // Nothing stops a client sending a second `hello` with a different
    // token, and when it did, `peer.session` was simply overwritten — so
    // the room still held the FIRST session against this very socket, and
    // `onClose` later detached the second. The first was never detached,
    // ever, and the consequences were all permanent: it stayed
    // `connected`, so `isSeatLive` stayed true and a bot never took the
    // seat; `connectedCount` never reached zero, so the room was never
    // reaped; and every frame went on being pushed into a closed socket.
    //
    // Detaching the outgoing identity here is the same courtesy
    // `leaveCurrentRoom` does for a peer changing rooms — it keeps "who
    // the room thinks is holding this socket" true, which is the invariant
    // the whole connection-lifecycle suite exists to defend.
    if (peer.session && peer.session !== session) {
      const previous = this.registry.roomOf(peer.session);
      previous?.detach(peer.session, peer.connection);
      this.awaiting.delete(peer.session);
    }

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
    this.leaveCurrentRoom(peer, session);

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

    // Checked before joining, not after: a client that skips the UI and
    // sends `joinRoom` while already seated somewhere would otherwise be a
    // member of two rooms at once, holding a seat in each.
    if (this.registry.roomOf(session) !== runtime) this.leaveCurrentRoom(peer, session);

    const result = runtime.command(session, { t: "join", name });
    if (!result.ok) {
      this.fail(peer, result.error, errorText(result.error), reqId);
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
