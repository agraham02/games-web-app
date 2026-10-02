// @vitest-environment jsdom

/**
 * A room's next round is the party leader's to deal. Everyone else is told
 * who they are waiting on, instead of being handed a button (reported: the
 * other player saw "Next round" too).
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { continueWaitingFor } from "@/room/useOnlineRuntime";
import type { RoomView } from "@/session/protocol";
import { RoundEndScorecard } from "./PhaseScreens";

describe("RoundEndScorecard", () => {
  it("offers the button to whoever continues", () => {
    render(
      <RoundEndScorecard show eyebrow="Round 1" title="Bo takes the round" rows={[]} onContinue={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Next round" })).toBeTruthy();
  });

  it("says who everybody else is waiting on, with no button", () => {
    render(
      <RoundEndScorecard
        show
        eyebrow="Round 1"
        title="Bo takes the round"
        rows={[]}
        onContinue={vi.fn()}
        waiting="Waiting for Ada to continue"
      />,
    );
    expect(screen.queryByRole("button", { name: "Next round" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Waiting for Ada to continue");
  });
});

describe("a room's scorecard deals the next round itself", () => {
  afterEach(() => vi.useRealTimers());

  function card(opts: { waiting?: string; auto?: number } = {}) {
    const onContinue = vi.fn();
    const view = render(
      <RoundEndScorecard
        show
        eyebrow="Round 1"
        title="Bo takes the round"
        rows={[]}
        onContinue={onContinue}
        waiting={opts.waiting}
        autoContinueMs={"auto" in opts ? opts.auto : 20_000}
      />,
    );
    return { onContinue, view };
  }

  it("presses Continue for whoever may, when twenty seconds run out", () => {
    vi.useFakeTimers();
    const { onContinue } = card();
    act(() => vi.advanceTimersByTime(19_999));
    expect(onContinue).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("keeps counting while the player looks at the table", () => {
    // Peeking unmounts the button; the twenty seconds are not restarted.
    vi.useFakeTimers();
    const { onContinue } = card();
    act(() => vi.advanceTimersByTime(15_000));
    fireEvent.click(screen.getByRole("button", { name: "Look at the table" }));
    fireEvent.click(screen.getByRole("button", { name: "Show scores" }));
    act(() => vi.advanceTimersByTime(5_000));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("tells everybody else how long they are waiting, and presses nothing", () => {
    vi.useFakeTimers();
    const { onContinue } = card({ waiting: "Waiting for Ada to continue" });
    act(() => vi.advanceTimersByTime(6_000));
    expect(screen.getByRole("status").textContent).toBe("Waiting for Ada to continue · next round in 14s");
    act(() => vi.advanceTimersByTime(20_000));
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("waits for the player at a table with nobody else to wait for", () => {
    vi.useFakeTimers();
    const { onContinue } = card({ auto: undefined });
    act(() => vi.advanceTimersByTime(60_000));
    expect(onContinue).not.toHaveBeenCalled();
  });
});

describe("continueWaitingFor", () => {
  const room = (youMayContinue: boolean) =>
    ({
      youMayContinue,
      members: [
        { session: "a", name: "Ada", isLeader: true },
        { session: "b", name: "Bo", isLeader: false },
      ],
    }) as unknown as RoomView;

  it("names the leader for everyone who is not to continue", () => {
    expect(continueWaitingFor(room(false))).toBe("Waiting for Ada to continue");
  });

  it("says nothing to whoever continues", () => {
    expect(continueWaitingFor(room(true))).toBeUndefined();
  });
});
