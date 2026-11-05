// @vitest-environment jsdom

/**
 * Rummy's hand sort is a preference like Large symbols: chosen once, kept for
 * the next game on this device (the user, 2026-11-02). It was a `useState`
 * and went back to Smart every time.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useGameSettings } from "@/table/gameSettings";
import { HAND_SORT_SETTING, RUMMY_SETTINGS } from "./table";

const SETTINGS = [HAND_SORT_SETTING];
function useSort() {
  return useGameSettings("rummy", SETTINGS);
}
const mount = () => renderHook(() => useSort());

afterEach(() => window.localStorage.clear());

describe("Rummy's hand sort", () => {
  it("starts on Smart", () => {
    expect(mount().result.current[0].handSort).toBe("smart");
  });

  it("is kept for the next game", () => {
    const first = mount();
    act(() => first.result.current[1]("handSort", "suit"));
    expect(JSON.parse(window.localStorage.getItem("table-games:settings:rummy")!)).toMatchObject({ handSort: "suit" });
    first.unmount();

    // A new table mounting later reads what was kept.
    expect(mount().result.current[0].handSort).toBe("suit");
  });

  it("takes every sort the menu offers, and ignores a stored value it does not know", () => {
    const hook = mount();
    for (const choice of HAND_SORT_SETTING.choices) {
      act(() => hook.result.current[1]("handSort", choice.value));
      expect(hook.result.current[0].handSort).toBe(choice.value);
    }
    act(() => hook.result.current[1]("handSort", "nonsense"));
    expect(hook.result.current[0].handSort).toBe("smart");
  });

  it("is not listed in the Settings sheet: it has its own menu beside the hand", () => {
    expect(RUMMY_SETTINGS).not.toContain(HAND_SORT_SETTING);
  });
});
