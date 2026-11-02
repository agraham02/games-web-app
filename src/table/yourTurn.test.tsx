// @vitest-environment jsdom

/**
 * The cue for "it is your turn": a sound and a buzz on the way up, and
 * nothing else — not on arriving mid-turn, not while the turn is held.
 */

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TURN_BUZZ_MS, useYourTurnCue } from "./yourTurn";
import * as sounds from "./tableSounds";

const vibrate = vi.fn();

beforeEach(() => {
  vibrate.mockClear();
  Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
});
afterEach(() => vi.restoreAllMocks());

function cue(initial: boolean, vibration = true) {
  const emit = vi.spyOn(sounds, "emitTableSound").mockImplementation(() => {});
  const hook = renderHook((p: { yourTurn: boolean; vibration: boolean }) => useYourTurnCue(p), {
    initialProps: { yourTurn: initial, vibration },
  });
  return { emit, ...hook };
}

describe("the your-turn cue", () => {
  it("sounds and buzzes when the turn becomes yours", () => {
    const { emit, rerender } = cue(false);
    rerender({ yourTurn: true, vibration: true });
    expect(emit).toHaveBeenCalledWith({ t: "turn" });
    expect(vibrate).toHaveBeenCalledWith(TURN_BUZZ_MS);
  });

  it("says nothing on arriving in the middle of your own turn", () => {
    // A reload, or a seat taken back: you did not just get the turn.
    const { emit } = cue(true);
    expect(emit).not.toHaveBeenCalled();
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("says nothing while the turn stays yours, or when it leaves", () => {
    const { emit, rerender } = cue(false);
    rerender({ yourTurn: true, vibration: true });
    rerender({ yourTurn: true, vibration: true });
    rerender({ yourTurn: false, vibration: true });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it("fires again each time it comes round", () => {
    const { emit, rerender } = cue(false);
    for (let i = 0; i < 3; i++) {
      rerender({ yourTurn: true, vibration: true });
      rerender({ yourTurn: false, vibration: true });
    }
    expect(emit).toHaveBeenCalledTimes(3);
  });

  it("keeps the buzz to the Vibration setting, and the sound to the sound channel", () => {
    const { emit, rerender } = cue(false, false);
    rerender({ yourTurn: true, vibration: false });
    expect(vibrate).not.toHaveBeenCalled();
    // The Sound setting is the channel's to honour (`useTableSounds`).
    expect(emit).toHaveBeenCalledWith({ t: "turn" });
  });

  it("is quiet where the browser cannot vibrate", () => {
    Object.defineProperty(navigator, "vibrate", { value: undefined, configurable: true });
    const { emit, rerender } = cue(false);
    expect(() => rerender({ yourTurn: true, vibration: true })).not.toThrow();
    expect(emit).toHaveBeenCalled();
  });
});
