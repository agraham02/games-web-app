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
import { DURATION, HOLD, STAGGER } from "./presets";

export interface TimedStep {
  event: GameEvent;
  /** ms after the previous step starts, before this one starts. */
  offset: number;
  /** ms this step occupies before the queue is considered past it. */
  duration: number;
}

const MS = 1000;

/**
 * How long an `unmask` occupies before the event that moves the piece is
 * allowed to run.
 *
 * Zero looks right and is not. An unmask puts a piece the viewer has
 * never seen onto the board at the slot it is about to leave, and a
 * `<Piece>` mounts with `initial={false}` — it SNAPS to wherever it is
 * first rendered. If the move lands before that mount has been painted,
 * the piece's first painted position is its destination, so Motion has
 * nothing to animate from and the card simply appears on the table.
 *
 * That is what an opponent's play looked like online: the tile did not
 * fly out of their hand, it materialised in the middle of the board. The
 * fix is one painted frame at the origin, and this is deliberately a
 * couple of them rather than one — a device dropping frames under a deal
 * would otherwise fall back to the same snap.
 *
 * Small enough to be invisible against `DURATION.play` (300ms), and it
 * only ever costs anything on a move somebody else made.
 */
const UNMASK_SETTLE = 50;

export interface ChoreographOptions {
  /**
   * Overrides `STAGGER.deal` (ms between one deal event starting and the
   * next) — see devSettings' independent "Deal speed" slider. Deal-only:
   * `move`'s reuse of the same base constant below (LRC's multi-chip
   * roll) is deliberately a separate gesture from dealing and does not
   * respect this override.
   */
  dealStaggerMs?: number;
}

/**
 * Runs of the same kind of event overlap instead of queueing end to end
 * — dealing 52 cards at 380ms each would take twenty seconds. A deal
 * starts every `dealStaggerMs` (default `STAGGER.deal`) and the cards
 * fly concurrently.
 */
export function choreograph(
  events: readonly GameEvent[],
  opts: ChoreographOptions = {},
): TimedStep[] {
  const steps: TimedStep[] = [];
  const dealStagger = opts.dealStaggerMs ?? STAGGER.deal * MS;

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const prev = events[i - 1];
    const sameRunAsPrev = prev?.t === event.t;

    switch (event.t) {
      case "deal":
        steps.push({
          event,
          offset: sameRunAsPrev ? dealStagger : 0,
          duration: DURATION.deal * MS,
        });
        break;

      case "draw":
      case "play":
        steps.push({ event, offset: 0, duration: DURATION.play * MS });
        break;

      case "highlight":
        // Instant, like a flag flip — the actual READ time comes from
        // whatever follows it (e.g. `collect`'s own HOLD.trick offset),
        // not from this event having any duration of its own.
        steps.push({ event, offset: 0, duration: 0 });
        break;

      case "collect":
        steps.push({
          event,
          // See HOLD.trick — a completed trick sits fully visible for a
          // beat before it starts gathering, long enough to actually
          // read who played what and whose pod it's about to land in.
          offset: HOLD.trick * MS,
          // The sweep staggers inward across the collected cards.
          duration: DURATION.collect * MS + event.pieces.length * STAGGER.collect * MS,
        });
        break;

      case "flip":
        // Same "runs of the same event overlap" idea as `deal` above —
        // see STAGGER.flip's own doc for why a whole-hand reveal needs
        // this at all.
        steps.push({
          event,
          offset: sameRunAsPrev ? STAGGER.flip * MS : 0,
          duration: DURATION.flip * MS,
        });
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

      case "unmask":
        // Zero OFFSET, because this rides with the gesture rather than
        // queueing behind it — but a real duration, because the piece it
        // introduces has to be painted at its origin before anything
        // moves it. See `UNMASK_SETTLE`: with a duration of zero the
        // card materialised on the board instead of flying out of the
        // hand it came from, which is exactly the hitch the zero was
        // meant to avoid.
        steps.push({ event, offset: 0, duration: UNMASK_SETTLE });
        break;

      case "pause":
        // Same weight as a single ordinary `move` — DURATION.play, not
        // a fresh constant — because the whole point is that a turn
        // which moved nothing should still take roughly as long to
        // read as a turn that moved one piece. Making this shorter
        // would just relocate the exact inconsistency it exists to fix.
        steps.push({ event, offset: 0, duration: DURATION.play * MS });
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

      case "slam":
        // Needs a REAL duration, not the zero a missing case would give
        // it: a slam rides immediately before the `move` that relocates
        // the same piece, and the next event after that pair must not
        // start until the flourish has actually played. Offset 0 so the
        // `move` itself lands in the same frame — the tile has to be
        // travelling while it grows, or the two read as two gestures.
        // `final` gets its own, longer duration (`slamFinal`) — a bigger
        // motion needs more time to read, and this is the one place that
        // budget is reserved before the next turn is allowed to start.
        steps.push({
          event,
          offset: 0,
          duration: (event.final ? DURATION.slamFinal : DURATION.slam) * MS,
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

/**
 * How long a step blocks the queue on its own, regardless of what comes
 * next.
 *
 * Most events block nothing: their effect is an animation that runs on
 * the compositor while the queue moves on, and how soon the NEXT event
 * starts is that event's `offset`. Three are different, because they are
 * time itself rather than something that takes time:
 *
 *  - `think` renders nothing. It exists solely so an opponent appears to
 *    be deciding, so its whole `ms` has to run out.
 *  - `unmask` renders a piece that has never been on this screen, and the
 *    move that follows must not land in the same paint.
 *  - `pause` is a beat by definition. LRC emits one ahead of a roll's
 *    chip moves so the dice can be READ before the chips they decided
 *    start flying, and the draining loop used to honour only the first
 *    two — so the beat existed in `choreograph`, was documented as
 *    obeying skip and reduced motion, and did nothing at all.
 */
function blockingMs(event: GameEvent, step: TimedStep | undefined): number {
  if (event.t === "think") return event.ms;
  if (event.t === "unmask" || event.t === "pause") return step?.duration ?? 0;
  return 0;
}

/**
 * How long a step of the queue waits before the next one starts. The
 * single home for a rule that is easy to get subtly wrong, and that the
 * SERVER now needs as well as the browser.
 *
 * TWO clocks decide it, and the bug history is entirely about
 * conflating them: `next.offset` is how long the UPCOMING event wants to
 * wait (and `0` is meaningful — it is how `choreograph` says "these play
 * concurrently"), while `blockingMs` is how long THIS event holds the
 * queue no matter what. The wait is whichever is longer.
 */
export function gapAfter(
  event: GameEvent,
  next: GameEvent,
  opts: ChoreographOptions = {},
): number {
  // Both, not `next` alone: `choreograph`'s "same run" detection reads
  // the event before, so timing `next` in isolation would always see it
  // as the first of its kind and lose every stagger.
  const [current, upcoming] = choreograph([event, next], opts);
  return Math.max(blockingMs(event, current), upcoming?.offset ?? beatOf(event));
}

/**
 * How long a step takes when nothing overlaps or follows it: chained
 * slightly before the animation finishes, because a full stop between
 * every action reads as lag rather than as weight.
 */
export function beatOf(event: GameEvent): number {
  const [step] = choreograph([event]);
  if (!step) return 0;
  return step.duration * (event.t === "think" ? 1 : 0.72);
}

/**
 * Milliseconds from a batch starting to its playback going idle — the
 * moment the browser calls `onIdle` and the game is allowed to move on.
 *
 * Not `totalDuration`, though the two look alike. That is when the last
 * animation FINISHES; this is when the loop is done waiting, which is at
 * the last event being APPLIED (its animation carries on underneath the
 * hold that follows). What a turn costs to watch is this one.
 *
 * The server uses it to space out bot turns, because it does not wait on
 * any client to finish showing one — see `RoomRuntime`.
 */
export function playbackMs(events: readonly GameEvent[], opts: ChoreographOptions = {}): number {
  let total = 0;
  for (let i = 0; i < events.length - 1; i++) {
    total += gapAfter(events[i]!, events[i + 1]!, opts);
  }
  return total;
}

/**
 * Milliseconds from a batch going idle to its last animation finishing —
 * the part of a batch that `playbackMs` deliberately does not count.
 *
 * Playback goes idle when the last event is APPLIED, with its animation
 * still running underneath. That is right for pacing, and harmless offline,
 * where the reconcile that follows keeps every piece's id. Online it does
 * not: the settled position names a card that has just gone face down by a
 * stand-in, and swapping ids mid-flight unmounts the card that was flying.
 * A trick's `collect` is exactly that, and it vanished the instant it began.
 */
export function tailMs(events: readonly GameEvent[], opts: ChoreographOptions = {}): number {
  let start = 0;
  let end = 0;
  for (let i = 0; i < events.length; i++) {
    if (i > 0) start += gapAfter(events[i - 1]!, events[i]!, opts);
    const [step] = choreograph([events[i]!], opts);
    // `think` is a wait, not an animation, and it always blocks the queue
    // until it is over — so it can never still be running at the end.
    if (events[i]!.t === "think") continue;
    end = Math.max(end, start + (step?.duration ?? 0));
  }
  return Math.max(0, end - start);
}
