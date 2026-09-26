// @vitest-environment jsdom

/**
 * A room's next round is the party leader's to deal. Everyone else is told
 * who they are waiting on, instead of being handed a button (reported: the
 * other player saw "Next round" too).
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
