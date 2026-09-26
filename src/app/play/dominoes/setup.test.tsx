// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import DominoesPlayPage from "./page";

/**
 * A render smoke test for the setup screen, and specifically for the
 * Caribbean branch of it.
 *
 * Worth its own file because neither of the other two checks can see
 * this: `tsc` proves the props typecheck, and the production build
 * prerenders the page in its DEFAULT state — which is classic, so the
 * entire Caribbean subtree (the stepper, the three rule toggles, the
 * fixed-seats notice) had never actually been rendered by anything. A
 * crash or a bad prop in there would first appear to a player clicking
 * the toggle.
 *
 * Deliberately stops at the setup screen: pressing "Deal in" mounts the
 * whole table, which wants layout and animation frames jsdom does not
 * meaningfully provide. The rules underneath are covered by
 * caribbean.test.ts.
 */

const setup = () => render(<DominoesPlayPage />);
const clickCaribbean = () => fireEvent.click(screen.getByRole("button", { name: "Caribbean" }));

describe("dominoes setup — classic", () => {
  it("opens on Block & Draw with its own controls", () => {
    setup();
    expect(screen.getByRole("button", { name: "Block & Draw" })).toBeTruthy();
    // The classic-only target row and seat slider.
    expect(screen.getByText("Play to")).toBeTruthy();
    expect(screen.getByText(/^Players/)).toBeTruthy();
    expect(screen.queryByText("Optional rules")).toBeNull();
  });
});

describe("dominoes setup — caribbean", () => {
  it("renders the whole branch without throwing", () => {
    setup();
    clickCaribbean();

    expect(screen.getByText(/seven tiles each/)).toBeTruthy();
    expect(screen.getByText("Games to win")).toBeTruthy();
    expect(screen.getByText("Optional rules")).toBeTruthy();
    // The seat slider is gone — Caribbean is four-handed, no more, no less.
    expect(screen.queryByLabelText("Players")).toBeNull();
    expect(screen.queryByText("Play to")).toBeNull();
  });

  it("defaults to ten games, stepped by the shared NumberStepper", () => {
    setup();
    clickCaribbean();

    expect(screen.getByText("10")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More games" }));
    expect(screen.getByText("11")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fewer games" }));
    expect(screen.getByText("10")).toBeTruthy();
  });

  it("offers six love only alongside partners, and says why", () => {
    setup();
    clickCaribbean();

    const sixLove = screen.getByRole("switch", { name: /Six love/ });
    // Disabled rather than hidden: a control that vanishes takes its own
    // explanation with it, so the player never learns the rule exists.
    expect(sixLove.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Needs partners/)).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: /Partners/ }));
    expect(screen.getByRole("switch", { name: /Six love/ }).hasAttribute("disabled")).toBe(false);
  });

  it("moves the target to six when six love goes on, and back when it goes off", () => {
    setup();
    clickCaribbean();
    fireEvent.click(screen.getByRole("switch", { name: /Partners/ }));

    fireEvent.click(screen.getByRole("switch", { name: /Six love/ }));
    // Six love is won on a STREAK, so ten would not realistically finish
    // — see `defaultTarget`. The default has to follow the rule.
    expect(screen.getByText("6")).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: /Six love/ }));
    expect(screen.getByText("10")).toBeTruthy();
  });

  it("keeps the two targets separate across a mode switch", () => {
    setup();
    // Classic's target is points; Caribbean's is games won. Sharing one
    // number meant flipping across and back left a match playing to 10
    // points or to 100 games.
    fireEvent.click(screen.getByRole("button", { name: "150" }));
    clickCaribbean();
    expect(screen.getByText("10")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Block & Draw" }));
    const chosen = screen.getByRole("button", { name: "150" });
    expect(chosen.className).toContain("brass");
  });

  it("keeps the key-tile bonus independent of the other two", () => {
    setup();
    clickCaribbean();
    const keyTile = screen.getByRole("switch", { name: /Key tile/ });
    expect(keyTile.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(keyTile);
    expect(screen.getByRole("switch", { name: /Key tile/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    // Turning partners on must not disturb it.
    fireEvent.click(screen.getByRole("switch", { name: /Partners/ }));
    expect(screen.getByRole("switch", { name: /Key tile/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });
});
