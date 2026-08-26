"use client";

/**
 * Plays a queue of engine events over time.
 *
 * Events arrive from `reduce` in batches ("you played the ace, three
 * bots thought and played, the trick was collected"). This walks that
 * batch at the pace `choreograph` assigns, applying each event to the
 * table store as its moment arrives.
 *
 * Guarantees the rest of the app relies on:
 *  - a batch pushed while another is playing is queued, never interleaved
 *  - `skip` drains everything instantly, leaving identical final state
 *  - reduced-motion collapses every delay to zero
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { GameEvent } from "@/engine/types";
import { choreograph } from "./choreographer";
import { prefersReducedMotion } from "./presets";

export interface ChoreographerOptions {
  /** Applies one event to whatever state the UI keeps. Must be idempotent. */
  apply: (event: GameEvent) => void;
  onIdle?: () => void;
  /** 1 = designed pace. The lab exposes this as a slider. */
  speed?: number;
  /** See `ChoreographOptions.dealStaggerMs` — deliberately independent
   * of `speed`, which is why it's threaded through separately rather
   * than folded into the same multiplier. */
  dealStaggerMs?: number;
}

export interface Choreographer {
  push: (events: readonly GameEvent[]) => void;
  /** Applies everything pending immediately. */
  skip: () => void;
  /** Drops everything pending without applying it. */
  clear: () => void;
  isPlaying: boolean;
}

export function useChoreographer({
  apply,
  onIdle,
  speed = 1,
  dealStaggerMs,
}: ChoreographerOptions): Choreographer {
  const [isPlaying, setPlaying] = useState(false);

  // Refs so the timer loop never restarts when a caller re-renders.
  const applyRef = useRef(apply);
  const onIdleRef = useRef(onIdle);
  const speedRef = useRef(speed);
  const dealStaggerRef = useRef(dealStaggerMs);
  const queue = useRef<GameEvent[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = useRef(false);
  /** Lets the timer loop re-enter itself without a forward reference. */
  const drainRef = useRef<() => void>(() => {});

  // Synced in an effect, not during render: writing a ref while
  // rendering is a tearing hazard under concurrent React. The initial
  // useRef values already cover the first render, and nothing drains
  // before effects have run.
  useEffect(() => {
    applyRef.current = apply;
    onIdleRef.current = onIdle;
    speedRef.current = speed;
    dealStaggerRef.current = dealStaggerMs;
  }, [apply, onIdle, speed, dealStaggerMs]);

  const stopTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const drain = useCallback(() => {
    const event = queue.current.shift();
    if (!event) {
      running.current = false;
      setPlaying(false);
      onIdleRef.current?.();
      return;
    }

    applyRef.current(event);

    if (queue.current.length === 0) {
      running.current = false;
      setPlaying(false);
      onIdleRef.current?.();
      return;
    }

    // Re-choreograph from the head each tick so a batch pushed mid-play
    // is timed against what is actually next, not against a plan made
    // before it arrived. Passes BOTH the event that just applied and the
    // upcoming one — not just the upcoming one in isolation — because
    // `choreograph`'s "same run" detection (what makes consecutive
    // deals/moves stagger tighter than a one-off) reads `events[i-1]`.
    // An isolated single-event lookup here always sees `prev` as
    // undefined, which silently defeats that detection for every run of
    // same-type events in real playback: it was never actually reachable
    // outside `choreograph`'s own unit tests, which call it over a whole
    // batch at once — a real deal was landing every ~beatOf(deal) (≈74%
    // of a single card's flight, ~270ms) rather than every
    // `dealStaggerMs`, more than 4x slower than intended.
    const [current, next] = choreograph(
      [event, queue.current[0]!],
      { dealStaggerMs: dealStaggerRef.current },
    );
    const factor = prefersReducedMotion() ? 0 : 1 / Math.max(0.05, speedRef.current);
    // beatOf needs no dealStaggerMs of its own — it only ever reads a
    // step's DURATION, which the override never touches (only `offset`,
    // computed just above, does).
    //
    // TWO different clocks decide this wait, and the bug history here is
    // entirely about conflating them.
    //
    // `next.offset` is how long the UPCOMING event wants to wait before
    // it starts. `0` is a deliberate, meaningful value there — it is how
    // `choreograph` says "these play CONCURRENTLY" (a multi-card draw
    // batch, `highlight`, `announce`). Reading that 0 as falsy and
    // substituting a real delay is what turned every multi-card pickup
    // into a one-by-one crawl.
    //
    // But some events ARE pure elapsed time, and their own duration has
    // to run out no matter what the next event wants. `think` is the
    // whole category: it renders nothing, it exists solely so an
    // opponent appears to be deciding. Honouring only `next.offset`
    // makes every bot act instantaneously — a bot claimed a card in the
    // same frame as the discard that freed it, which reads as the bot
    // having known in advance.
    //
    // So: wait for whichever is longer. Concurrency is preserved because
    // ordinary events hold for nothing.
    // `unmask` joins `think` in that category, for a different reason:
    // not that it renders nothing, but that what it renders has to reach
    // the screen. It introduces a piece this viewer has never seen, and
    // `<Piece>` mounts with `initial={false}` — so if the move that
    // follows lands in the same paint, the piece's first painted
    // position IS its destination and Motion has nothing to animate
    // from. The card appears on the table instead of leaving a hand.
    //
    // Its own duration, read back off `choreograph` rather than
    // duplicated here, so the number has one home.
    const hold =
      event.t === "think"
        ? event.ms
        : event.t === "unmask"
          ? (current?.duration ?? 0)
          : 0;
    const wait = Math.max(hold, next?.offset ?? beatOf(event)) * factor;

    timer.current = setTimeout(() => drainRef.current(), Math.max(0, wait));
  }, []);

  useEffect(() => {
    drainRef.current = drain;
  }, [drain]);

  const push = useCallback(
    (events: readonly GameEvent[]) => {
      if (events.length === 0) return;
      queue.current.push(...events);
      if (!running.current) {
        running.current = true;
        setPlaying(true);
        drain();
      }
    },
    [drain],
  );

  const skip = useCallback(() => {
    stopTimer();
    const pending = queue.current;
    queue.current = [];
    for (const e of pending) applyRef.current(e);
    running.current = false;
    setPlaying(false);
    onIdleRef.current?.();
  }, []);

  const clear = useCallback(() => {
    stopTimer();
    queue.current = [];
    running.current = false;
    setPlaying(false);
  }, []);

  /**
   * Stop the timer when this really unmounts — but pick a batch back up
   * if we are only being re-mounted.
   *
   * React StrictMode runs mount, cleanup, mount. Anything pushed from a
   * mount effect elsewhere in the tree therefore gets its drain timer
   * cleared halfway through and, because `running` stays true, nothing
   * ever restarts it: the queue is stranded and the batch silently never
   * finishes. That is not hypothetical — it is exactly what swallowed
   * dominoes' opening deal, which is the first thing in this app pushed
   * from a mount effect rather than from a later click. Resuming here
   * costs nothing on a genuine unmount (there is no second run) and
   * makes the queue's "a pushed batch always finishes" guarantee true
   * regardless of who pushed it or when.
   */
  useEffect(() => {
    if (running.current && queue.current.length > 0) drainRef.current();
    return stopTimer;
  }, []);

  return { push, skip, clear, isPlaying };
}

/**
 * How long to hold after an event when the next one carries no offset of
 * its own. Chained slightly before the animation finishes, because a
 * full stop between every action reads as lag rather than as weight.
 */
function beatOf(event: GameEvent): number {
  const [step] = choreograph([event]);
  if (!step) return 0;
  return step.duration * (event.t === "think" ? 1 : 0.72);
}
