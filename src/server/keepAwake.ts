/**
 * Stops a free host putting a game to sleep in the middle of it.
 *
 * A free web service on Render spins down after 15 minutes with no inbound
 * traffic, and a room lives in that process's memory, so a spin-down ends
 * every game in progress without warning. Render's docs say a WebSocket
 * message from an open connection counts as traffic, and the client sends
 * one every 25 seconds — but a game that was cut off at fifteen minutes in
 * an earlier project is exactly what this is here to make certain of, and
 * nobody can check a platform's idle accounting without losing a game to
 * it. So the server does not lean on that. While somebody is connected, it
 * makes an ordinary HTTP request to its own public URL, which is
 * indisputably inbound traffic however the platform chooses to count.
 *
 * Only while somebody is connected, which is the whole design:
 *
 *  - an active game is never cut off, which is the requirement;
 *  - an idle service still sleeps, so this does not turn a free instance
 *    into an always-on one, does not spend its monthly hours on an empty
 *    room, and is a request every few minutes for as long as people are
 *    actually playing rather than around the clock.
 *
 * Not for tests or local runs: it needs a URL to call, and only a
 * production host has one.
 */

import { realClock, type Clock, type TimerHandle } from "@/session/clock";
import { log } from "./log";

/**
 * Comfortably inside the 15-minute window, so that one request being lost
 * or delayed still leaves another before the deadline. Two more attempts
 * would fit; three would not.
 */
export const KEEP_AWAKE_INTERVAL_MS = 4 * 60_000;

/** A wake-up call is a single small GET; anything slower is not worth waiting for. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface KeepAwakeOptions {
  /** The service's own public address, e.g. `https://myapp.onrender.com`. */
  url: string;
  /** Is a person connected to anything? Asked fresh on every tick. */
  hasPeople: () => boolean;
  clock?: Clock;
  intervalMs?: number;
  /** Injected so a test never touches the network. */
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<unknown>;
}

export class KeepAwake {
  private timer: TimerHandle | null = null;
  private stopped = true;
  private readonly clock: Clock;
  private readonly intervalMs: number;
  private readonly request: NonNullable<KeepAwakeOptions["fetch"]>;
  private readonly target: string;

  constructor(private readonly opts: KeepAwakeOptions) {
    this.clock = opts.clock ?? realClock;
    this.intervalMs = opts.intervalMs ?? KEEP_AWAKE_INTERVAL_MS;
    this.request = opts.fetch ?? ((url, init) => fetch(url, init));
    // `/healthz` because it answers before Next and touches nothing.
    this.target = `${opts.url.replace(/\/+$/, "")}/healthz`;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    this.timer = this.clock.setTimeout(() => this.tick(), this.intervalMs);
  }

  private tick(): void {
    this.timer = null;
    if (this.stopped) return;
    // Re-armed first, so nothing below — a throw, a hung request — can
    // ever be the reason it stops.
    this.arm();

    if (!this.opts.hasPeople()) return;

    const abort = new AbortController();
    const cut = this.clock.setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    this.request(this.target, { signal: abort.signal })
      .then(() => log.debug("kept awake", { event: "keep-awake" }))
      // A failed ping is not an emergency: the next one is minutes away
      // and there are more of them than the platform needs.
      .catch((error: unknown) =>
        log.warn("keep-awake request failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => this.clock.clearTimeout(cut));
  }
}

/**
 * Decides from the environment whether to run at all, and against what.
 *
 * `RENDER_EXTERNAL_URL` is set by Render itself on every web service, so a
 * Render deploy needs no configuration. `KEEP_AWAKE_URL` is for any other
 * host with the same problem, and wins when both exist. `KEEP_AWAKE=0`
 * turns it off.
 *
 * Null outside production even when a URL is present: a developer with
 * `RENDER_EXTERNAL_URL` in their shell should not have a local server
 * phoning a live one.
 */
export function keepAwakeUrl(env: Record<string, string | undefined>): string | null {
  if (env.NODE_ENV !== "production") return null;
  if (env.KEEP_AWAKE === "0") return null;
  const url = (env.KEEP_AWAKE_URL ?? env.RENDER_EXTERNAL_URL ?? "").trim();
  return url === "" ? null : url;
}
