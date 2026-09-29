// @vitest-environment jsdom

/**
 * The settle-up list, read by the people in it: always from the reader's
 * side ("You pay Ada", "Bo pays you"), and saying what changes hands rather
 * than how the game went — with bots at the table the two differ.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SettlementView } from "@/session/protocol";
import { SettleUp } from "./SettleUp";

function settlement(over: Partial<SettlementView> = {}): SettlementView {
  return {
    gameId: "lrc",
    stake: "25¢ a chip",
    finished: true,
    results: [
      { session: "ada", name: "Ada", cents: 150 },
      { session: "bo", name: "Bo", cents: -75 },
      { session: "cy", name: "Cy", cents: -75 },
    ],
    payments: [
      { from: "bo", fromName: "Bo", to: "ada", toName: "Ada", cents: 75 },
      { from: "cy", fromName: "Cy", to: "ada", toName: "Ada", cents: 75 },
    ],
    botsLeftOut: false,
    ...over,
  };
}

describe("settling up, as each person reads it", () => {
  it("says who pays you, and what you are owed in all", () => {
    render(<SettleUp settlement={settlement()} you="ada" />);
    screen.getByText("You're owed $1.50");
    expect(screen.getAllByText("Bo pays you").length + screen.getAllByText("Cy pays you").length).toBe(2);
  });

  it("says who you pay, and names everyone else's payments too", () => {
    render(<SettleUp settlement={settlement()} you="bo" />);
    screen.getByText("You owe 75¢");
    screen.getByText("You pay Ada");
    screen.getByText("Cy pays Ada");
  });

  it("does not call a player who lost to a bot even", () => {
    // Both people lost to the bot: nobody owes anybody, and it says why.
    render(
      <SettleUp
        settlement={settlement({ results: [{ session: "ada", name: "Ada", cents: 0 }], payments: [], botsLeftOut: true })}
        you="ada"
      />,
    );
    expect(screen.queryByText(/even/)).toBeNull();
    screen.getByText(/went to or came from bots/);
  });

  it("says how an early end was counted", () => {
    render(<SettleUp settlement={settlement({ gameId: "poker", stake: "$20 buy-in", finished: false })} you="ada" />);
    screen.getByText(/hand still being played was called off/);
  });
});
