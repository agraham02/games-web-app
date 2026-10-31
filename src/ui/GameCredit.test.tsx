// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GAME_IDS } from "@/session/registry";
import { SettingsSheet } from "@/table/gameSettings";
import { GameCredit, hasGameCredit } from "./GameCredit";
import { Credit } from "./primitives/Credit";
import { GameSetup } from "./setup/GameSetup";
import { defaultSetup } from "./setup/savedSetup";

/**
 * Mind Meld's bots are built on ConceptNet Numberbatch (CC BY-SA 4.0), which
 * asks for a visible credit — and the user wants it on Mind Meld's own screens,
 * not under every page of the app (2026-10-30).
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

describe("the Mind Meld credit", () => {
  it("names the data, its maker and its licence, with links", () => {
    render(<GameCredit game="mindmeld" />);
    expect(screen.getByRole("link", { name: "ConceptNet Numberbatch" })).toHaveAttribute(
      "href",
      "https://github.com/commonsense/conceptnet-numberbatch",
    );
    expect(screen.getByRole("link", { name: "CC BY-SA 4.0" })).toHaveAttribute(
      "href",
      "https://creativecommons.org/licenses/by-sa/4.0/",
    );
    expect(screen.getByText(/Luminoso Technologies, Inc\./)).toBeInTheDocument();
  });

  it("belongs to Mind Meld alone", () => {
    expect(GAME_IDS.filter(hasGameCredit)).toEqual(["mindmeld"]);
    for (const id of GAME_IDS.filter((g) => g !== "mindmeld")) {
      const { container, unmount } = render(<GameCredit game={id} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("is no longer in the footer every screen shares", () => {
    render(<Credit />);
    expect(screen.getByText(/Made by Ahmad Graham/)).toBeInTheDocument();
    expect(screen.queryByText(/Numberbatch/)).toBeNull();
  });

  it("is on Mind Meld's solo setup screen, and no other game's", () => {
    const setup = (game: "mindmeld" | "spades") => (
      <GameSetup game={game} value={defaultSetup(game)} onChange={() => {}} onStart={() => {}} />
    );
    const { unmount } = render(setup("mindmeld"));
    expect(screen.getByText(/ConceptNet Numberbatch/)).toBeInTheDocument();
    unmount();
    render(setup("spades"));
    expect(screen.queryByText(/Numberbatch/)).toBeNull();
  });

  it("is pinned at the bottom of the Settings drawer when the game has one", () => {
    const sheet = (footnote?: React.ReactNode) => (
      <SettingsSheet open onClose={() => {}} settings={[]} values={{}} onChange={() => {}} footnote={footnote} />
    );
    const { unmount } = render(sheet(<GameCredit game="mindmeld" />));
    const credit = screen.getByText(/ConceptNet Numberbatch/);
    const drawer = screen.getByRole("complementary", { name: "Settings" });
    expect(drawer).toContainElement(credit);
    // After the settings, not before them.
    expect(drawer.lastElementChild).toContainElement(credit);
    unmount();
    render(sheet(undefined));
    expect(screen.queryByText(/Numberbatch/)).toBeNull();
  });
});
