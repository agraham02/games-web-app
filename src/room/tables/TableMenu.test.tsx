// @vitest-environment jsdom

/**
 * The leader's way to end a room's game from the table. It ends it for
 * everybody, and settles up a game played for money, so one stray tap in
 * the Settings sheet must not be enough — a solo game already asked twice.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TableMenu } from "./TableMenu";

afterEach(cleanup);

function menu(leader: boolean) {
  const onEndGame = vi.fn();
  render(<TableMenu code="ABCD" spectator={false} leader={leader} onStepAway={() => {}} onEndGame={onEndGame} />);
  return onEndGame;
}

describe("ending a room's game from the table", () => {
  it("asks before ending it for everyone", () => {
    const onEndGame = menu(true);
    fireEvent.click(screen.getByRole("button", { name: "End the game for everyone" }));
    expect(onEndGame).not.toHaveBeenCalled();

    const ask = screen.getByRole("group", { name: "End the game for everyone?" });
    fireEvent.click(within(ask).getByRole("button", { name: "Keep playing" }));
    expect(onEndGame).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "End the game for everyone" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "End the game for everyone?" })).getByRole("button", {
        name: "End game",
      }),
    );
    expect(onEndGame).toHaveBeenCalledTimes(1);
  });

  it("is the leader's alone", () => {
    menu(false);
    expect(screen.queryByRole("button", { name: /end the game/i })).toBeNull();
  });
});
