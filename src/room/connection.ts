"use client";

/**
 * The browser's end of the wire.
 *
 * Deliberately not a React hook. A socket outlives any one render, has to
 * survive StrictMode's double-mount without opening two of itself, and
 * needs to reconnect on its own schedule — none of which is React's model.
 * The hook that wraps this ([useRoom](./useRoom.ts)) subscribes to it; it
 * does not own it.
 *
 * ## The token
 *
 * One value in `localStorage` is the entire identity system. It is how a
 * refresh gets your seat back, and it is a secret in the sense that
 * anybody holding it can BE you in a room — so it is generated locally,
 * sent only to this server, and never rendered.
 *
 * It is stored rather than kept in memory precisely because the case it
 * exists for is the page being torn down: a refresh, a crash, an
 * accidental back button. Memory does not survive any of those.
 */

import type { ClientMessage, ServerMessage, TurnClockView } from "@/session/protocol";
import { CHAT_HISTORY, type ChatMessage } from "@/session/chat";
import { PROTOCOL_VERSION } from "@/session/protocol";
import { LinkMonitor } from "@/session/link";

export const TOKEN_KEY = "table-games.session-token";

/**
 * Backoff between reconnection attempts. Short at first — the common case
 * is a blip that resolves in under a second and the player should barely
 * notice — then widening, so a server that is genuinely down is not hammered
 * by every open tab.
 */
const RETRY_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;

/**
 * How often the client says something, whether or not it has anything to
 * say.
 *
 * The server already pings its sockets to notice dead ones (see
 * `wsServer.ts`), which is the opposite direction and a different job.
 * This exists because of everything BETWEEN the two: proxies, load
 * balancers and free hosting tiers all reap connections that have been
 * quiet, typically after 60 seconds, and a game of Rummy where somebody
 * is thinking is exactly that. Losing the socket is survivable — the
 * client reconnects and reclaims its seat — but it is a visible stall for
 * no reason.
 *
 * Comfortably under a 60-second idle timeout, and nothing next to the
 * router's own 120-messages-per-10-seconds budget.
 *
 * Every five seconds rather than every twenty-five since 2026-10-02: each
 * ping is also a sample of the link, and a slow link has to show on your
 * own screen within a few seconds to be worth showing (`LinkMonitor`).
 */
const KEEPALIVE_MS = 5_000;

/** How often an unanswered ping is checked for (see `STALL_MS`). */
const LINK_TICK_MS = 500;

/**
 * Two early pings after connecting, timed (`sent`), so the turn clock has a
 * round trip to go on before the first keepalive would give it one.
 */
const PROBE_MS = [300, 2_000] as const;

/** Round trips remembered; the smallest is the least delayed by anything else. */
const RTT_SAMPLES = 5;

/** One way, before anything has been measured: an ordinary connection. */
const DEFAULT_ONE_WAY_MS = 75;

/** Never trusted beyond this: one bad sample must not swallow a short clock. */
const MAX_ONE_WAY_MS = 1_000;

/**
 * `superseded` is a deliberate stop, not a failure: another tab for this
 * same identity took the connection, and retrying would start a fight
 * neither tab can win. It is the only status a reconnect will not
 * recover from on its own — `resume()` is how the player says they want
 * it back here.
 */
export type ConnectionStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "superseded"
  /** Built against a different wire. Only a reload fixes it. */
  | "incompatible";

export interface ConnectionListener {
  onMessage: (message: ServerMessage) => void;
  onStatus: (status: ConnectionStatus) => void;
  /** This end's link turned slow, or fine again — see `RoomConnection.weak`. */
  onLink?: (weak: boolean) => void;
}

/**
 * Reads the browser's token, minting one on first visit.
 *
 * `crypto.randomUUID` where available, with a composed fallback for
 * insecure origins (a phone hitting a laptop's dev server over plain HTTP,
 * which is exactly how this gets tested). Storage itself can throw in a
 * locked-down browser, so a per-tab token is the last resort — reconnection
 * stops working across a refresh, which is a degradation rather than a
 * failure.
 */
export function sessionToken(): string {
  const generate = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  try {
    const existing = window.localStorage.getItem(TOKEN_KEY);
    if (existing) return existing;
    const fresh = generate();
    window.localStorage.setItem(TOKEN_KEY, fresh);
    return fresh;
  } catch {
    return generate();
  }
}

function socketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

export class RoomConnection {
  /**
   * The last of each thing the server told us, replayed to any new
   * subscriber.
   *
   * Without this, a client-side navigation is fatal. Creating a room
   * moves the address bar to `/room/ABCD`, which remounts the screen with
   * fresh React state — but the socket is already open and already
   * handshook, so nothing re-sends the roster and the new mount sits on
   * "Connecting…" forever, holding a live connection to a room it is in.
   *
   * Caching them here rather than lifting the state into a store keeps the
   * ownership honest: these are the last things the SERVER said, and the
   * connection is what heard them. Replaying a frame is safe because a
   * frame is a whole snapshot rather than a step.
   */
  session: string | null = null;
  lastRoom: unknown = null;
  lastFrame: unknown = null;
  /**
   * The knock we are still waiting on an answer to.
   *
   * Cached for the same reason the room is: a client-side navigation
   * remounts everything above this class, and without it the "waiting to
   * be let in" screen was simply lost - the person landed back on the
   * entry screen while the leader still had their request.
   */
  lastPending: unknown = null;
  /**
   * What has been said in the room, as the server last told it plus
   * everything since — replayed as one `chatLog`, so moving between the
   * lobby and the table does not empty the chat.
   */
  chatLog: ChatMessage[] = [];
  /**
   * The turn clock as last told, and when (`performance.now()`). Replayed
   * with what is left of it: the server only says again when the clock
   * changes, so a remount mid-move otherwise showed no ring at all.
   */
  private lastClock: { clock: TurnClockView; at: number } | null = null;

  private socket: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private probeTimers: ReturnType<typeof setTimeout>[] = [];
  /** Recent round trips, ms — see `oneWayMs`. */
  private rtts: number[] = [];
  /** This socket's link, judged as the server judges everyone's. */
  private link = new LinkMonitor();
  private linkTimer: ReturnType<typeof setInterval> | null = null;
  /** The hang-up scheduled for when no page is listening. See `closeWhenIdle`. */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Everyone waiting on `whenClosed`. */
  private closedWaiters: Array<() => void> = [];
  private closedByUs = false;
  /** Set by a `superseded` message; cleared only by `resume()`. */
  private superseded = false;
  /** Set by a `protocol-mismatch`; this client cannot speak this wire. */
  private incompatible = false;
  private readonly listeners = new Set<ConnectionListener>();
  /**
   * Messages composed before the socket was ready. Held rather than
   * dropped because the very first thing a room page does is send, and
   * losing that to a race would leave the page waiting on a reply to a
   * message that was never sent.
   */
  private readonly queue: ClientMessage[] = [];

  status: ConnectionStatus = "closed";

  constructor(readonly token: string = sessionToken()) {}

  subscribe(listener: ConnectionListener): () => void {
    // A page is listening again, so a hang-up scheduled for nobody is off.
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.listeners.add(listener);
    // Catch the newcomer up on what it missed. Order matters: `hello`
    // establishes identity, and the room and frame are meaningless before
    // it — the same order the server sends them in.
    if (this.session) {
      listener.onMessage({
        t: "hello",
        session: this.session,
        protocol: PROTOCOL_VERSION,
        // Replaying `true` unconditionally would re-assert a room this
        // connection may have since been told it is not in.
        inRoom: this.lastRoom !== null,
      });
    }
    if (this.lastRoom) listener.onMessage(this.lastRoom as ServerMessage);
    if (this.lastFrame) listener.onMessage(this.lastFrame as ServerMessage);
    if (this.lastFrame && this.lastClock) {
      const { clock, at } = this.lastClock;
      const endsInMs = Math.max(0, clock.endsInMs - (performance.now() - at));
      listener.onMessage({ t: "turnClock", clock: { ...clock, endsInMs } });
    }
    if (this.lastPending) listener.onMessage(this.lastPending as ServerMessage);
    if (this.lastRoom) listener.onMessage({ t: "chatLog", messages: this.chatLog });
    listener.onStatus(this.status);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.closeWhenIdle();
    };
  }

  /**
   * Hangs up once no page is listening, which means the player has left
   * the room's page without closing the tab: the back gesture, a link home.
   *
   * An open socket told the server the opposite, that they were still at
   * the table. So the seat stayed theirs, the bots played on up to their
   * turn and parked there, and a game with nobody real left in it was never
   * ended (the user, 2026-09-27: "all bots should not be playing, not even
   * for 1 second"). Hanging up makes leaving the page what closing the tab
   * already was: the server gives the seat to a bot, or ends the game when
   * no real player is left. "Back to room" still works, because being a
   * member of a room does not depend on the socket.
   *
   * What it heard is forgotten with it. The next page asks the server
   * afresh, rather than being shown a table that has moved on without it.
   *
   * One tick late on purpose. StrictMode unmounts and remounts every
   * effect, and moving from `/room` to `/room/ABCD` swaps one screen for
   * another in a single commit; both have subscribed again by then.
   *
   * It says `bye` first, which is what makes leaving the LOBBY this way
   * immediate (the user, 2026-09-29: "if they leave the lobby, then they
   * just leave"). A bare close looks to the server like a phone locking,
   * which it gives `LOBBY_GRACE_MS` to come back; `bye` says it is on
   * purpose. The server decides what that costs — a seat in a running game
   * is kept either way. A refresh or a closed tab never gets here: the page
   * is torn down without running this timer, so those still get the grace.
   */
  private closeWhenIdle(): void {
    if (this.idleTimer !== null) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.listeners.size > 0) return;
      if (this.session && this.socket?.readyState === WebSocket.OPEN) this.raw({ t: "bye" });
      this.session = null;
      this.lastRoom = null;
      this.lastFrame = null;
      this.lastClock = null;
      this.lastPending = null;
      this.chatLog = [];
      this.queue.length = 0;
      this.close();
    }, 0);
  }

  /**
   * Resolves once this tab holds no socket: at once when it holds none, or
   * when the one it is letting go of has finished closing.
   *
   * For the home page, which asks the server whether this browser is still
   * in a room. Arriving there FROM a room hangs that room's socket up, and
   * asked any sooner the server answered for the moment before the leaving
   * ("Spades in progress", for a game that leaving had just ended).
   */
  whenClosed(): Promise<void> {
    if (!this.socket && this.idleTimer === null) return Promise.resolve();
    return new Promise((resolve) => this.closedWaiters.push(resolve));
  }

  private flushClosedWaiters(): void {
    for (const resolve of this.closedWaiters.splice(0)) resolve();
  }

  connect(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    this.closedByUs = false;
    this.superseded = false;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");

    const socket = new WebSocket(socketUrl());
    this.socket = socket;

    // Every handler first asks whether this is still the socket in use. One
    // that `close()` has let go of goes on delivering events for a while —
    // the server's last frames, then its own close — and a page that left
    // and came straight back has a new socket by then. Unguarded, the old
    // close nulled the new socket (whose sends then queued forever) and old
    // frames refilled the cache `closeWhenIdle` had just emptied.
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.setStatus("open");
      // Always first, and always before anything queued: it is what tells
      // the server who this is, and the reply is what restores the room.
      this.raw({ t: "hello", token: this.token, protocol: PROTOCOL_VERSION });
      for (const message of this.queue.splice(0)) this.raw(message);
      this.startKeepalive();
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return; // Nothing useful to do with a frame we cannot read.
      }
      this.remember(message);
      for (const listener of this.listeners) listener.onMessage(message);
    };

    socket.onclose = () => {
      if (this.socket !== socket) {
        // One we let go of, finished closing. Unless another has been
        // opened since, this tab now holds no socket at all.
        if (this.socket === null) this.flushClosedWaiters();
        return;
      }
      this.socket = null;
      this.stopKeepalive();
      if (this.closedByUs) {
        this.setStatus("closed");
        return;
      }
      // Another tab has it. Standing down is the whole fix: retrying
      // here is what made two tabs trade the socket back and forth
      // forever.
      if (this.superseded) {
        this.setStatus("superseded");
        return;
      }
      if (this.incompatible) {
        this.setStatus("incompatible");
        return;
      }
      this.setStatus("reconnecting");
      this.scheduleRetry();
    };

    socket.onerror = () => {
      // `onclose` always follows, and that is where retrying belongs;
      // doing it here too would double every backoff.
    };
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    // Straight to the socket rather than through `send`, which would QUEUE
    // a ping while disconnected and then deliver a burst of stale ones the
    // moment the connection came back. Timed, so every answer is a sample.
    const ping = () => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      const sent = performance.now();
      this.link.sent(sent, sent);
      this.raw({ t: "ping", sent });
    };
    this.keepaliveTimer = setInterval(ping, KEEPALIVE_MS);
    this.probeTimers = PROBE_MS.map((ms) => setTimeout(ping, ms));
    this.linkTimer = setInterval(() => {
      if (this.link.tick(performance.now())) this.linkChanged();
    }, LINK_TICK_MS);
  }

  private stopKeepalive(): void {
    for (const t of this.probeTimers) clearTimeout(t);
    this.probeTimers = [];
    if (this.linkTimer !== null) clearInterval(this.linkTimer);
    this.linkTimer = null;
    // A new socket starts with a clean slate: a ping the old one never
    // answered is not a stall on this one. And while there is no socket the
    // "Reconnecting" strip says so; a slow-link icon on top would say it twice.
    const wasWeak = this.link.weak;
    this.link = new LinkMonitor();
    if (wasWeak) this.linkChanged();
    if (this.keepaliveTimer === null) return;
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  /**
   * Whether this end's link is slow right now: a slow round trip, or a ping
   * unanswered for a while. Shown as an icon in the table's corner, the
   * same judgement the server makes for everybody's pod (`LinkMonitor`).
   */
  get weak(): boolean {
    return this.link.weak;
  }

  private linkChanged(): void {
    const weak = this.link.weak;
    for (const listener of this.listeners) listener.onLink?.(weak);
  }

  /**
   * How long a message takes to get here from the server, as best this end
   * can tell: half the smallest recent round trip. What the turn clock takes
   * off the time it is told, since that time was measured when it was sent.
   */
  oneWayMs(): number {
    if (this.rtts.length === 0) return DEFAULT_ONE_WAY_MS;
    return Math.min(MAX_ONE_WAY_MS, Math.min(...this.rtts) / 2);
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    const delay = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)]!;
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.raw(message);
    else this.queue.push(message);
  }

  /** Keeps whatever a remount would otherwise have to ask for again. */
  private remember(message: ServerMessage): void {
    switch (message.t) {
      case "hello":
        this.session = message.session;
        // The server has just said whether this identity is in a room.
        // If it is not, whatever we cached describes one that is gone —
        // most often because the process restarted — and keeping it means
        // rendering a live-looking lobby whose every button fails
        // silently.
        if (!message.inRoom) {
          this.lastRoom = null;
          this.lastFrame = null;
          this.lastClock = null;
          this.chatLog = [];
          // A knock does not survive the socket that made it: the server
          // drops its `awaiting` entry when that socket closes, so a
          // request cached across a reconnect is one nobody can answer.
          // Forgetting it here is what lets the hook stop waiting.
          this.lastPending = null;
        }
        break;
      case "pending":
        this.lastPending = message;
        break;
      case "room":
        this.lastRoom = message;
        // Being in a room is the answer to the knock.
        this.lastPending = null;
        // A room view supersedes any frame from a game that is no longer
        // running, or the next mount would replay a table nobody is at.
        if (!message.room.gameRunning) {
          this.lastFrame = null;
          this.lastClock = null;
        }
        break;
      case "frame":
        this.lastFrame = message;
        break;
      case "left":
        this.lastRoom = null;
        this.lastFrame = null;
        this.lastClock = null;
        this.lastPending = null;
        this.chatLog = [];
        break;
      case "chatLog":
        this.chatLog = message.messages;
        break;
      case "turnClock":
        this.lastClock = message.clock ? { clock: message.clock, at: performance.now() } : null;
        break;
      case "chat":
        this.chatLog = [...this.chatLog, message.message].slice(-CHAT_HISTORY);
        break;
      case "error":
        // The one error a reconnect cannot fix. Retrying hides it behind
        // a "Reconnecting…" spinner that never resolves, because the
        // server refuses the handshake every time and the explanation is
        // never shown.
        if (message.code === "protocol-mismatch") this.incompatible = true;
        break;
      case "pong":
        if (typeof message.sent === "number") {
          const now = performance.now();
          const rtt = now - message.sent;
          if (rtt >= 0) this.rtts = [...this.rtts, rtt].slice(-RTT_SAMPLES);
          if (this.link.answered(message.sent, now)) this.linkChanged();
        }
        break;
      case "superseded":
        // Recorded before the close event, which is where it is acted on.
        // The cached room and frame are deliberately KEPT: the person is
        // still a member holding their seat, so `resume()` should land
        // them back at the table rather than on a blank screen.
        this.superseded = true;
        break;
      default:
        break;
    }
  }

  private raw(message: ClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.listeners) listener.onStatus(status);
  }

  /**
   * Takes the connection back after another tab claimed it.
   *
   * Deliberately a thing the PLAYER asks for rather than something this
   * does by itself, because doing it automatically is precisely the
   * fight `superseded` exists to end. The seat was never given up, so
   * this lands back at the same table.
   */
  resume(): void {
    if (this.status !== "superseded") return;
    this.attempt = 0;
    this.connect();
  }

  close(): void {
    // Nothing to wait for: `whenClosed` would otherwise hang on a socket
    // that was never there (a close while between reconnection attempts).
    if (!this.socket) queueMicrotask(() => this.flushClosedWaiters());
    this.closedByUs = true;
    this.stopKeepalive();
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.setStatus("closed");
  }
}

/**
 * One connection per tab, shared by every component that wants it.
 *
 * A module-level singleton for the same reason the placement store is one:
 * there is exactly one table per tab, and a second socket would be a second
 * identity racing the first for the same seat. It also makes StrictMode's
 * double-mount harmless — the second mount finds the connection already
 * open rather than opening another.
 */
let shared: RoomConnection | null = null;

export function roomConnection(): RoomConnection {
  if (!shared) shared = new RoomConnection();
  return shared;
}

/**
 * Resolves once this tab holds no room socket — at once in a tab that never
 * opened one. See `RoomConnection.whenClosed`.
 */
export function roomConnectionClosed(): Promise<void> {
  return shared ? shared.whenClosed() : Promise.resolve();
}

/**
 * Drops the shared connection so the next call builds a fresh one.
 *
 * For tests only. A module-level singleton is right in a browser — one
 * tab, one identity — but it means one test's socket would otherwise be
 * handed to the next, along with everything it had already received.
 */
export function __resetRoomConnectionForTests(): void {
  shared?.close();
  shared = null;
}
