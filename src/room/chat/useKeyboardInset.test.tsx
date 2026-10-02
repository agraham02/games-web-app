// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useKeyboardInset } from "./useKeyboardInset";

/** A visual viewport that can be squeezed the way a keyboard squeezes it. */
function fakeViewport() {
  const listeners = new Set<() => void>();
  const vv = {
    height: window.innerHeight,
    offsetTop: 0,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal("visualViewport", vv);
  return {
    keyboard(px: number, scrolled = 0) {
      vv.height = window.innerHeight - px - scrolled;
      vv.offsetTop = scrolled;
      for (const fn of listeners) fn();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useKeyboardInset", () => {
  it("measures the keyboard from the visual viewport", () => {
    const vv = fakeViewport();
    const { result } = renderHook(() => useKeyboardInset(true));
    act(() => vv.keyboard(300));
    expect(result.current).toEqual({ top: 0, bottom: 300 });
    // iOS scrolls the page up to show the field: the sheet follows it.
    act(() => vv.keyboard(300, 40));
    expect(result.current).toEqual({ top: 40, bottom: 300 });
    act(() => vv.keyboard(0));
    expect(result.current).toEqual({ top: 0, bottom: 0 });
  });

  it("says nothing while the sheet is closed", () => {
    const vv = fakeViewport();
    const { result } = renderHook(() => useKeyboardInset(false));
    act(() => vv.keyboard(300));
    expect(result.current).toEqual({ top: 0, bottom: 0 });
  });
});
