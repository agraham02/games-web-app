/**
 * How good a connection is, from the pings sent down it.
 *
 * Shared by both ends, so "slow" means the same thing on the pod everyone
 * else sees and on the icon in your own corner (the user, 2026-10-02: "a
 * translucent pulsing icon"). The server times the socket's own
 * websocket pings; the browser times its `ping` messages.
 *
 * Two ways to be slow. A slow round trip, judged by the median of the last
 * few (one bad sample is noise). And silence: a ping nobody has answered for
 * `STALL_MS` is slow already, without waiting for an answer that may never
 * come — a half-open socket can take a minute to be declared gone, and the
 * player is gone from the table long before that.
 *
 * Hysteresis, so a link hovering around the line does not make the icon
 * blink: slow above `WEAK_RTT_MS`, fine again only below `CLEAR_RTT_MS`.
 */

/** A median round trip above this is a slow link. */
export const WEAK_RTT_MS = 450;
/** ...and it is fine again only below this. */
export const CLEAR_RTT_MS = 300;
/** A ping unanswered this long is a slow link, whatever came before. */
export const STALL_MS = 1500;
/** Round trips remembered. */
const SAMPLES = 5;

export class LinkMonitor {
  private readonly rtts: number[] = [];
  /** Pings sent and not yet answered, oldest first: id and when. */
  private readonly outstanding: Array<{ id: number; at: number }> = [];
  private slow = false;

  /** A ping went out. */
  sent(id: number, now: number): void {
    this.outstanding.push({ id, at: now });
    // Never answered, ever (a ping lost on a socket that then came back):
    // keep the list bounded. The oldest is still the stall that counts.
    if (this.outstanding.length > 20) this.outstanding.splice(1, 1);
  }

  /**
   * Its answer came back. Answers that match nothing outstanding are
   * ignored. Returns whether `weak` changed.
   */
  answered(id: number, now: number): boolean {
    const at = this.outstanding.findIndex((p) => p.id === id);
    if (at < 0) return false;
    const rtt = now - this.outstanding[at]!.at;
    // Everything older was lost along the way; an answer means the line is
    // open again.
    this.outstanding.splice(0, at + 1);
    if (rtt >= 0) {
      this.rtts.push(rtt);
      if (this.rtts.length > SAMPLES) this.rtts.shift();
    }
    return this.judge(now);
  }

  /**
   * Time has passed with nothing heard — called at `stallAt`. Returns
   * whether `weak` changed.
   */
  tick(now: number): boolean {
    return this.judge(now);
  }

  /**
   * The quickest recent round trip, or null before there is one: the one
   * least delayed by anything but the distance (`RoomConnection.oneWayMs`).
   */
  minRttMs(): number | null {
    return this.rtts.length === 0 ? null : Math.min(...this.rtts);
  }

  /**
   * When the oldest unanswered ping turns into a stall, or null with none
   * outstanding. Silence is noticed by a timer armed for this moment and
   * re-armed after every `sent` and `answered`, rather than by polling.
   */
  stallAt(): number | null {
    return this.outstanding.length === 0 ? null : this.outstanding[0]!.at + STALL_MS;
  }

  /** The median recent round trip, or null before there is one. */
  rttMs(): number | null {
    if (this.rtts.length === 0) return null;
    const sorted = [...this.rtts].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  }

  get weak(): boolean {
    return this.slow;
  }

  private judge(now: number): boolean {
    const stalled = this.outstanding.length > 0 && now - this.outstanding[0]!.at >= STALL_MS;
    const rtt = this.rttMs();
    const next = stalled
      ? true
      : rtt === null
        ? false
        : this.slow
          ? rtt >= CLEAR_RTT_MS
          : rtt > WEAK_RTT_MS;
    if (next === this.slow) return false;
    this.slow = next;
    return true;
  }
}
