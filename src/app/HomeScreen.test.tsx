// @vitest-environment jsdom

/**
 * The front door: the carousel is the game picker, and "Play with friends"
 * makes a room FOR the game on show.
 *
 * Real timers and the real components, as in the room screen's tests: a
 * Motion button does not click under fake ones.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GAME_IDS, GAMES } from "@/session/registry";
import { HomeScreen } from "./HomeScreen";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
}));

const INTENT_KEY = "table-games.entry-intent";
const NAME_KEY = "table-games.display-name";

const carousel = () => screen.getByRole("group", { name: "Games" });
const intent = () => JSON.parse(window.sessionStorage.getItem(INTENT_KEY) ?? "null");
const root = () => document.querySelector("[data-game]") as HTMLElement;

function next() {
  act(() => {
    fireEvent.keyDown(carousel(), { key: "ArrowRight" });
  });
}

describe("the home screen", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    push.mockClear();
  });
  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("opens on the first game, and the page wears its colours", () => {
    render(<HomeScreen />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(GAMES[GAME_IDS[0]!].name);
    expect(root().getAttribute("data-game")).toBe(GAME_IDS[0]);
    expect(screen.getByRole("button", { name: GAMES[GAME_IDS[0]!].name })).toHaveAttribute("aria-current", "true");
  });

  it("moves to the next game on →, and the page colour and the solo link follow", async () => {
    render(<HomeScreen />);
    next();
    const second = GAME_IDS[1]!;
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(GAMES[second].name));
    expect(root().getAttribute("data-game")).toBe(second);
    expect(screen.getByRole("link", { name: /play solo/i })).toHaveAttribute("href", `/play/${second}`);
  });

  it("never runs out: back from the first game is the last, on the keys and on the arrow", async () => {
    render(<HomeScreen />);
    const last = GAME_IDS[GAME_IDS.length - 1]!;
    act(() => {
      fireEvent.keyDown(carousel(), { key: "ArrowLeft" });
    });
    await waitFor(() => expect(root().getAttribute("data-game")).toBe(last));
    fireEvent.click(screen.getByRole("button", { name: "Next game" }));
    await waitFor(() => expect(root().getAttribute("data-game")).toBe(GAME_IDS[0]));
    fireEvent.click(screen.getByRole("button", { name: "Previous game" }));
    await waitFor(() => expect(root().getAttribute("data-game")).toBe(last));
  });

  it("goes to a game in view when it is pressed, the same before and after a drag", async () => {
    const { container } = render(<HomeScreen />);
    const slide = (label: string) => container.querySelector(`[aria-label="${label}"]`) as HTMLElement;
    const press = (el: HTMLElement) => {
      fireEvent.pointerDown(el);
      fireEvent.click(el);
    };
    press(slide(`2 of ${GAME_IDS.length}`));
    await waitFor(() => expect(root().getAttribute("data-game")).toBe(GAME_IDS[1]));
    // The one to the left of the first wraps round to the last.
    press(slide(`1 of ${GAME_IDS.length}`));
    await waitFor(() => expect(root().getAttribute("data-game")).toBe(GAME_IDS[0]));
    press(slide(`${GAME_IDS.length} of ${GAME_IDS.length}`));
    await waitFor(() => expect(root().getAttribute("data-game")).toBe(GAME_IDS[GAME_IDS.length - 1]));
  });

  it("goes straight to a game from its dot", async () => {
    render(<HomeScreen />);
    const third = GAME_IDS[2]!;
    fireEvent.click(screen.getByRole("button", { name: GAMES[third].name }));
    await waitFor(() => expect(root().getAttribute("data-game")).toBe(third));
    expect(screen.getByRole("button", { name: GAMES[third].name })).toHaveAttribute("aria-current", "true");
  });

  it("makes a room for the game on show, straight away, when the name is already known", async () => {
    window.localStorage.setItem(NAME_KEY, "Ada");
    render(<HomeScreen />);
    next();
    await waitFor(() => expect(root().getAttribute("data-game")).toBe(GAME_IDS[1]));

    fireEvent.click(screen.getByRole("button", { name: /play with friends/i }));

    expect(intent()).toEqual({ t: "make", game: GAME_IDS[1] });
    expect(push).toHaveBeenCalledWith("/room");
  });

  it("asks for a name first when there is none, and does not make a room yet", async () => {
    render(<HomeScreen />);
    fireEvent.click(screen.getByRole("button", { name: /play with friends/i }));

    expect(push).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(INTENT_KEY)).toBeNull();
    expect(await screen.findByLabelText(/your name/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Bo" } });
    fireEvent.click(screen.getByRole("button", { name: /make a room/i }));

    expect(intent()).toEqual({ t: "make", game: GAME_IDS[0] });
    expect(push).toHaveBeenCalledWith("/room");
    expect(window.localStorage.getItem(NAME_KEY)).toBe("Bo");
  });

  it("joins by code from the header, and carries the code to the room's own URL", async () => {
    render(<HomeScreen />);
    fireEvent.click(screen.getByRole("button", { name: /join with code/i }));
    fireEvent.change(await screen.findByLabelText(/your name/i), { target: { value: "Bo" } });
    const boxes = screen.getAllByRole("textbox");
    fireEvent.change(boxes[boxes.length - 1]!, { target: { value: "WXYZ" } });
    fireEvent.click(screen.getByRole("button", { name: /join room/i }));

    expect(intent()).toEqual({ t: "join", code: "WXYZ" });
    expect(push).toHaveBeenCalledWith("/room/WXYZ");
  });
});
