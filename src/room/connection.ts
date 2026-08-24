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

import type { ClientMessage, ServerMessage } from "@/session/protocol";
import { PROTOCOL_VERSION } from "@/session/protocol";

const TOKEN_KEY = "table-games.session-token";

/**
 * Backoff between reconnection attempts. Short at first — the common case
 * is a blip that resolves in under a second and the player should barely
 * notice — then widening, so a server that is genuinely down is not hammered
 * by every open tab.
 */
const RETRY_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface ConnectionListener {
  onMessage: (message: ServerMessage) => void;
  onStatus: (status: ConnectionStatus) => void;
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
  private socket: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;
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
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    this.closedByUs = false;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");

    const socket = new WebSocket(socketUrl());
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setStatus("open");
      // Always first, and always before anything queued: it is what tells
      // the server who this is, and the reply is what restores the room.
      this.raw({ t: "hello", token: this.token, protocol: PROTOCOL_VERSION });
      for (const message of this.queue.splice(0)) this.raw(message);
    };

    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return; // Nothing useful to do with a frame we cannot read.
      }
      for (const listener of this.listeners) listener.onMessage(message);
    };

    socket.onclose = () => {
      this.socket = null;
      if (this.closedByUs) {
        this.setStatus("closed");
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

  private raw(message: ClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.listeners) listener.onStatus(status);
  }

  close(): void {
    this.closedByUs = true;
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
