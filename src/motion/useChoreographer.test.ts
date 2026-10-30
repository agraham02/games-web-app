// @vitest-environment jsdom
/**
 * Tests for the PLAYBACK LOOP, not for `choreograph()`.
 *
 * That distinction is the reason this file exists. `choreograph()` is
 * always called over a whole batch at once, and choreographer.test.ts
 * asserts on the offsets it returns — so a bug in how those offsets are
 * CONSUMED, one frame at a time, passes every one of those tests. The
 * `0 || fallback` bug lived in exactly that gap: `choreograph` correctly
 * emitted `offset: 0` for a concurrent batch, and the playback loop
 * treated the 0 as falsy and substituted a real delay, turning every
 * multi-card pickup into a one-by-one crawl.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameEvent } from "@/engine/types";
import { STAGGER } from "./presets";
import { useChoreographer } from "./useChoreographer";

/**
 * A batch that genuinely runs concurrently. Plays, not draws: a run of draws
 * now streams in on purpose (`STAGGER.draw`), so it is no longer the example
 * of "offset 0".
 */
function concurrentBatch(n: number): GameEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    t: "play" as const,
    piece: `C${i + 2}`,
    from: 0,
    to: "discard" as const,
    faceUp: true,
  }));
}

describe("useChoreographer — playback timing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom implements no media queries, and `prefersReducedMotion()`
    // asks for one on every drain. `matches: false` is the case that
    // actually exercises the timing — reduced motion collapses every
    // wait to zero, which would make these assertions vacuous.
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: false,
      media,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("plays a concurrent batch concurrently — offset 0 means no wait", () => {
    const applied: GameEvent[] = [];
    const { result } = renderHook(() =>
      useChoreographer({ apply: (e) => applied.push(e) }),
    );

    act(() => result.current.push(concurrentBatch(6)));
    act(() => void vi.advanceTimersByTime(50));

    // `choreograph` gives every `play` an offset of 0. Six of them must
    // therefore land together, not spread across ~1.3s of `beatOf`
    // fallbacks — which is what a falsy-0 check produces.
    expect(applied).toHaveLength(6);
  });

  it("applies a hand handed over whole in one tick, so it renders and leaves as one", () => {
    const applied: GameEvent[] = [];
    const { result } = renderHook(() =>
      useChoreographer({ apply: (e) => applied.push(e) }),
    );
    const handOver: GameEvent[] = Array.from({ length: 12 }, (_, i) => ({
      t: "deal" as const,
      piece: `C${i + 2}`,
      to: 1,
      faceUp: false,
      together: true,
    }));

    // No timers advanced at all: one `setTimeout(0)` per card put a render
    // between each, and twenty cards visibly left one by one.
    act(() => result.current.push(handOver));
    expect(applied).toHaveLength(12);
  });

  it("streams a run of draws one after another, so a penalty can be counted", () => {
    const applied: GameEvent[] = [];
    const { result } = renderHook(() =>
      useChoreographer({ apply: (e) => applied.push(e) }),
    );
    const draws: GameEvent[] = Array.from({ length: 4 }, (_, i) => ({
      t: "draw" as const,
      piece: `D${i}`,
      from: "deck" as const,
      to: 1,
      faceUp: false,
    }));
    act(() => result.current.push(draws));
    act(() => void vi.advanceTimersByTime(50));
    expect(applied).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(4 * STAGGER.draw * 1000));
    expect(applied).toHaveLength(4);
  });

  it("still waits where an offset is genuinely absent", () => {
    const applied: GameEvent[] = [];
    const { result } = renderHook(() =>
      useChoreographer({ apply: (e) => applied.push(e) }),
    );

    // A `collect` carries a real HOLD.trick offset (900ms) so the player
    // can read who won before the sweep starts.
    const events: GameEvent[] = [
      { t: "play", piece: "SA", from: 0, to: "trick", faceUp: true },
      { t: "collect", pieces: ["SA"], to: 0 },
    ];
    act(() => result.current.push(events));
    act(() => void vi.advanceTimersByTime(50));
    expect(applied).toHaveLength(1);

    act(() => void vi.advanceTimersByTime(1000));
    expect(applied).toHaveLength(2);
  });

  it("staggers a real deal rather than dumping it", () => {
    const applied: GameEvent[] = [];
    const { result } = renderHook(() =>
      useChoreographer({ apply: (e) => applied.push(e), dealStaggerMs: 65 }),
    );

    const deal: GameEvent[] = Array.from({ length: 8 }, (_, i) => ({
      t: "deal" as const,
      piece: `C${i + 2}`,
      to: i % 4,
      faceUp: false,
    }));
    act(() => result.current.push(deal));
    act(() => void vi.advanceTimersByTime(10));
    // The first lands immediately; the rest are spaced by the stagger,
    // so they must NOT all be here yet.
    expect(applied.length).toBeLessThan(8);

    act(() => void vi.advanceTimersByTime(8 * 65 + 50));
    expect(applied).toHaveLength(8);
  });

  it("makes a bot's deliberation actually take time", () => {
    // The regression this exists for: a `think` renders nothing, so its
    // only effect is elapsed time — and the events that follow it in the
    // same batch carry `offset: 0`. Honouring only the next event's
    // offset made every bot act in the same frame it started thinking.
    // Live, that read as a bot claiming a discard before the player had
    // seen it land.
    const applied: GameEvent[] = [];
    const { result } = renderHook(() =>
      useChoreographer({ apply: (e) => applied.push(e) }),
    );

    const events: GameEvent[] = [
      { t: "think", seat: 1, ms: 700 },
      { t: "draw", piece: "SA", from: "discard", to: 1, faceUp: false },
      { t: "play", piece: "SA", from: 1, to: "board", faceUp: true, group: 1 },
    ];
    act(() => result.current.push(events));

    act(() => void vi.advanceTimersByTime(50));
    expect(applied, "nothing may happen while the bot is thinking").toHaveLength(1);

    act(() => void vi.advanceTimersByTime(700));
    expect(applied.length).toBeGreaterThan(1);
  });

  it("still lets a concurrent batch stay concurrent after the think", () => {
    const applied: GameEvent[] = [];
    const { result } = renderHook(() =>
      useChoreographer({ apply: (e) => applied.push(e) }),
    );
    act(() => result.current.push([{ t: "think", seat: 1, ms: 300 }, ...concurrentBatch(5)]));
    act(() => void vi.advanceTimersByTime(400));
    expect(applied).toHaveLength(6);
  });

  it("reports idle once the queue empties", () => {
    const onIdle = vi.fn();
    const { result } = renderHook(() =>
      useChoreographer({ apply: () => {}, onIdle }),
    );
    act(() => result.current.push(concurrentBatch(3)));
    act(() => void vi.advanceTimersByTime(100));
    expect(onIdle).toHaveBeenCalled();
  });
});
