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
}: ChoreographerOptions): Choreographer {
  const [isPlaying, setPlaying] = useState(false);

  // Refs so the timer loop never restarts when a caller re-renders.
  const applyRef = useRef(apply);
  const onIdleRef = useRef(onIdle);
  const speedRef = useRef(speed);
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
  }, [apply, onIdle, speed]);

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
    // before it arrived.
    const [next] = choreograph([queue.current[0]!]);
    const factor = prefersReducedMotion() ? 0 : 1 / Math.max(0.05, speedRef.current);
    const wait = (next?.offset || beatOf(event)) * factor;

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

  useEffect(() => stopTimer, []);

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
