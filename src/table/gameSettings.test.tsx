// @vitest-environment jsdom

/**
 * The shared in-game settings every game can add to. A game hands
 * `GameHost` a list; the player's choices are theirs, per device.
 */

import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HAND_SPACING_SETTING,
  SOUND_SETTING,
  SettingsSheet,
  TABLE_SETTINGS,
  useGameSettings,
  type GameSetting,
} from "./gameSettings";

const SETTINGS: readonly GameSetting[] = [
  { key: "hints", label: "Hints", description: "Explains things.", default: true },
  { key: "sounds", label: "Sounds", description: "Plays sounds.", default: false },
];

// Each test uses its own game id: the saved values are cached per game for
// the life of the page, exactly as they are in the app.
let n = 0;
const freshGame = () => `test-game-${++n}`;

describe("useGameSettings", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("starts from each setting's default", () => {
    const { result } = renderHook(() => useGameSettings(freshGame(), SETTINGS));
    expect(result.current[0]).toEqual({ hints: true, sounds: false });
  });

  it("applies a change at once and keeps it for the next table", () => {
    const game = freshGame();
    const first = renderHook(() => useGameSettings(game, SETTINGS));
    act(() => first.result.current[1]("hints", false));
    expect(first.result.current[0].hints).toBe(false);

    const later = renderHook(() => useGameSettings(game, SETTINGS));
    expect(later.result.current[0].hints).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(`table-games:settings:${game}`)!)).toEqual({ hints: false });
  });

  it("keeps each game's settings apart", () => {
    const a = freshGame();
    const b = freshGame();
    const hookA = renderHook(() => useGameSettings(a, SETTINGS));
    act(() => hookA.result.current[1]("sounds", true));
    const hookB = renderHook(() => useGameSettings(b, SETTINGS));
    expect(hookB.result.current[0].sounds).toBe(false);
  });

  it("keeps a SHARED setting once for every game", () => {
    // Turning the sound off at one table and finding it on at the next
    // would be a setting that did not stick.
    const withTable = [...SETTINGS, ...TABLE_SETTINGS];
    const a = renderHook(() => useGameSettings(freshGame(), withTable));
    act(() => a.result.current[1](SOUND_SETTING.key, false));
    const b = renderHook(() => useGameSettings(freshGame(), withTable));
    expect(b.result.current[0].sound).toBe(false);
    // ...while a per-game setting beside it still is not shared.
    act(() => a.result.current[1]("hints", false));
    expect(b.result.current[0].hints).toBe(true);
    act(() => a.result.current[1](SOUND_SETTING.key, true));
  });

  it("keeps a choice setting's value, and ignores one it cannot hold", () => {
    // Card spacing is one of three, shared by every game that offers it.
    const game = freshGame();
    const withSpacing = [...SETTINGS, HAND_SPACING_SETTING];
    const first = renderHook(() => useGameSettings(game, withSpacing));
    expect(first.result.current[0].handSpacing).toBe("comfortable");
    act(() => first.result.current[1]("handSpacing", "roomy"));
    const elsewhere = renderHook(() => useGameSettings(freshGame(), withSpacing));
    expect(elsewhere.result.current[0].handSpacing).toBe("roomy");

    // A value from some other version of the app, or a hand-edited one,
    // is not a choice the setting has: the default stands.
    act(() => first.result.current[1]("handSpacing", "enormous"));
    const later = renderHook(() => useGameSettings(freshGame(), withSpacing));
    expect(later.result.current[0].handSpacing).toBe("comfortable");
    act(() => first.result.current[1]("handSpacing", "comfortable"));
  });

  it("falls back to the defaults when storage refuses", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const game = freshGame();
    const { result } = renderHook(() => useGameSettings(game, SETTINGS));
    expect(result.current[0]).toEqual({ hints: true, sounds: false });
    // Still applied for this page, just not kept.
    act(() => result.current[1]("sounds", true));
    expect(result.current[0].sounds).toBe(true);
  });
});

describe("SettingsSheet", () => {
  it("shows one switch per setting, with what it does, and reports changes", () => {
    const onChange = vi.fn();
    render(
      <SettingsSheet
        open
        onClose={() => {}}
        settings={SETTINGS}
        values={{ hints: true, sounds: false }}
        onChange={onChange}
      />,
    );
    const hints = screen.getByRole("switch", { name: /Hints/ });
    expect(hints.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Explains things.")).toBeTruthy();
    fireEvent.click(hints);
    expect(onChange).toHaveBeenCalledWith("hints", false);
  });

  it("draws a choice setting as a row of choices, and reports the one picked", () => {
    const onChange = vi.fn();
    render(
      <SettingsSheet
        open
        onClose={() => {}}
        settings={[HAND_SPACING_SETTING]}
        values={{ handSpacing: "comfortable" }}
        onChange={onChange}
      />,
    );
    const row = screen.getByRole("group", { name: "Card spacing" });
    const comfortable = within(row).getByRole("button", { name: "Comfortable" });
    expect(comfortable.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(HAND_SPACING_SETTING.description)).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Roomy" }));
    expect(onChange).toHaveBeenCalledWith("handSpacing", "roomy");
  });

  it("puts a table's own buttons under the switches", () => {
    render(
      <SettingsSheet
        open
        onClose={() => {}}
        settings={SETTINGS}
        values={{ hints: true, sounds: false }}
        onChange={() => {}}
        actions={<button type="button">Return to the lobby</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "Return to the lobby" })).toBeInTheDocument();
  });

  it("dims the rest of the screen, and closes from the dim, the X or Esc", () => {
    const onClose = vi.fn();
    render(
      <SettingsSheet open onClose={onClose} settings={SETTINGS} values={{}} onChange={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("sheet-backdrop"));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("slides in from the right, where its button is", () => {
    // It rose from the bottom, over the player's own hand, while its
    // button sits top-right.
    render(
      <SettingsSheet open onClose={() => {}} settings={SETTINGS} values={{}} onChange={() => {}} />,
    );
    const drawer = document.querySelector("aside")!;
    expect(drawer.className).toContain("right-0");
    expect(drawer.className).not.toContain("bottom-0");
  });
});
