/**
 * Event timing.
 *
 * The engine emits what happened; this decides how long each thing takes
 * and how much it overlaps its neighbours. Keeping that here — rather
 * than sprinkling delays through components — means the pacing of the
 * whole app is one file a designer can retune.
 *
 * Pure. The React runtime that plays these lives in useChoreographer.
 */

import type { GameEvent } from "@/engine/types";
import { DURATION, STAGGER } from "./presets";

export interface TimedStep {
  event: GameEvent;
  /** ms after the previous step starts, before this one starts. */
  offset: number;
  /** ms this step occupies before the queue is considered past it. */
  duration: number;
}

const MS = 1000;

/**
 * Runs of the same kind of event overlap instead of queueing end to end
 * — dealing 52 cards at 380ms each would take twenty seconds. A deal
 * starts every 65ms and the cards fly concurrently.
 */
export function choreograph(events: readonly GameEvent[]): TimedStep[] {
  const steps: TimedStep[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const prev = events[i - 1];
    const sameRunAsPrev = prev?.t === event.t;

    switch (event.t) {
      case "deal":
        steps.push({
          event,
          offset: sameRunAsPrev ? STAGGER.deal * MS : 0,
          duration: DURATION.deal * MS,
        });
        break;

      case "draw":
      case "play":
        steps.push({ event, offset: 0, duration: DURATION.play * MS });
        break;

      case "collect":
        steps.push({
          event,
          offset: 0,
          // The sweep staggers inward across the collected cards.
          duration: DURATION.collect * MS + event.pieces.length * STAGGER.collect * MS,
        });
        break;

      case "flip":
        steps.push({ event, offset: 0, duration: DURATION.flip * MS });
        break;

      case "move":
        // Staggered like a run of deals when several genuinely
        // deliberate moves arrive back to back — e.g. LRC's multi-chip
        // roll. Without this, `useChoreographer` falls back to playing
        // each `move` fully end to end (see `beatOf`), fine for one or
        // two chips but a visible crawl for more. A batch RETURN to a
        // shared pile (a spent chain, spent hands at round end) is a
        // different gesture and uses `sweep` below instead — deliberate
        // single moves keep this pace unchanged either way.
        steps.push({
          event,
          offset: sameRunAsPrev ? STAGGER.deal * MS : 0,
          duration: DURATION.play * MS,
        });
        break;

      case "sweep":
        // See DURATION.sweep — a short, mostly flat step regardless of
        // how many pieces are in the pile, so a big gather (a full
        // round's worth of hands and a long chain) does not make the
        // player wait proportionally longer before the ordinarily-paced
        // deal that follows it is allowed to start.
        steps.push({
          event,
          offset: 0,
          duration: DURATION.sweep * MS + Math.min(event.pieces.length, 10) * STAGGER.sweep * MS,
        });
        break;

      case "think":
        // Deliberation is dead air by design — it is what sells a bot as
        // a person rather than a function that returns instantly.
        steps.push({ event, offset: 0, duration: event.ms });
        break;

      case "announce":
        // Toasts ride alongside whatever is moving; they never block.
        steps.push({ event, offset: 0, duration: 0 });
        break;

      case "score":
        steps.push({ event, offset: 0, duration: DURATION.count * MS });
        break;

      case "roundEnd":
      case "gameEnd":
        steps.push({ event, offset: 240, duration: 0 });
        break;

      default:
        steps.push({ event, offset: 0, duration: 0 });
    }
  }

  return steps;
}

/** Total wall-clock time a batch will take, in ms. */
export function totalDuration(steps: readonly TimedStep[]): number {
  let t = 0;
  let end = 0;
  for (const s of steps) {
    t += s.offset;
    end = Math.max(end, t + s.duration);
  }
  return end;
}
