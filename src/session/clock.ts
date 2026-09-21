/**
 * The one seam that lets the same game loop run in a browser, on a
 * server, and inside a test that finishes in microseconds.
 *
 * `GameSession` schedules real waits — a bot's deliberation, the beat
 * between one turn settling and the next being revealed — and later the
 * server schedules room expiry and action deadlines on top of them.
 * Every one of those is a number of milliseconds that a test needs to
 * skip past rather than sit through: the room-expiry rule is a full
 * minute, and a match is dozens of turn holds deep. Reaching for
 * `vi.useFakeTimers()` covers the browser case but not a plain Node
 * server test, and it patches globals for everything in the file rather
 * than for the one component under test.
 *
 * So time is a dependency, not an ambient global. Production passes
 * `realClock`; tests pass a `TestClock` and step it forward by hand.
 */

export type TimerHandle = number;

export interface Clock {
  /** Milliseconds since an arbitrary epoch. Only differences are meaningful. */
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/**
 * Wall-clock time and the platform's own timers. `setTimeout`'s return
 * type differs between the browser (`number`) and Node (`Timeout`), so
 * this narrows both to an opaque handle rather than leaking either.
 */
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as TimerHandle,
  clearTimeout: (handle) => globalThis.clearTimeout(handle as unknown as number),
};

interface ScheduledTask {
  handle: TimerHandle;
  dueAt: number;
  fn: () => void;
}

/**
 * A clock that only moves when told to.
 *
 * `advance(ms)` runs every task that comes due inside that window **in
 * due order**, and does so in a loop, so a task that schedules another
 * task inside the same window still fires. That is not a nicety: the
 * game loop is a chain of exactly that shape — a turn settles, which
 * schedules the next turn's hold, which reveals a bot move, which
 * settles. Draining only the tasks that existed when `advance` was
 * called would step one link per call and make a test read as though
 * the loop had stalled.
 */
export class TestClock implements Clock {
  private current = 0;
  private nextHandle = 1;
  private tasks: ScheduledTask[] = [];

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const handle = this.nextHandle++;
    this.tasks.push({ handle, dueAt: this.current + Math.max(0, ms), fn });
    return handle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.tasks = this.tasks.filter((task) => task.handle !== handle);
  }

  /** Tasks still scheduled. A loop that has genuinely parked has none. */
  get pending(): number {
    return this.tasks.length;
  }

  /**
   * Moves time forward, firing everything that comes due. Ties break by
   * insertion order (`handle`), matching how a real event loop drains
   * same-tick timers.
   */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = this.tasks
        .filter((task) => task.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt || a.handle - b.handle)[0];
      if (!due) break;
      this.tasks = this.tasks.filter((task) => task.handle !== due.handle);
      this.current = Math.max(this.current, due.dueAt);
      due.fn();
    }
    this.current = target;
  }

  /**
   * Runs the loop to a standstill without caring how much simulated time
   * that takes — what a "play this match out" test actually wants. The
   * cap is a guard against a genuine infinite reschedule, which would
   * otherwise hang the suite instead of failing it.
   */
  drain(maxSteps = 100_000): void {
    let steps = 0;
    while (this.tasks.length > 0) {
      if (++steps > maxSteps) {
        throw new Error(`TestClock.drain exceeded ${maxSteps} steps — a task is rescheduling forever`);
      }
      const next = this.tasks.reduce((a, b) => (b.dueAt < a.dueAt || (b.dueAt === a.dueAt && b.handle < a.handle) ? b : a));
      this.tasks = this.tasks.filter((task) => task.handle !== next.handle);
      this.current = Math.max(this.current, next.dueAt);
      next.fn();
    }
  }
}
