// @vitest-environment jsdom

/**
 * `useSliderDraft` — the value under the finger, for a slider whose owner
 * hears only where a gesture ends.
 *
 * Driven through the hook's own props rather than a rendered slider: jsdom
 * lays nothing out, so Base UI cannot turn a pointer position into a value
 * there. The live check (one message per drag in a room) was done in
 * Chrome; these hold the rules that make it safe.
 */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSliderDraft } from "./slider";

function setup(initial: number, locked = false) {
  const onCommit = vi.fn();
  const hook = renderHook(({ value, locked }) => useSliderDraft(value, onCommit, locked), {
    initialProps: { value: initial, locked },
  });
  return { ...hook, onCommit };
}

describe("useSliderDraft", () => {
  it("follows the finger without telling the owner, then commits once", () => {
    const { result, onCommit } = setup(6);

    act(() => result.current.props.onValueChange(7));
    act(() => result.current.props.onValueChange(9));
    expect(result.current.value).toBe(9);
    expect(onCommit).not.toHaveBeenCalled();

    act(() => result.current.props.onValueCommitted(9));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(9);
  });

  it("holds the committed value until the echo arrives, so the thumb does not flick back", () => {
    const { result, rerender } = setup(6);

    act(() => result.current.props.onValueChange(9));
    act(() => result.current.props.onValueCommitted(9));
    act(() => result.current.props.onLostPointerCapture());
    // The room has not answered yet: still 6 as far as `value` knows.
    expect(result.current.value).toBe(9);

    rerender({ value: 9, locked: false });
    expect(result.current.value).toBe(9);
  });

  it("gives way to whatever the owner says next", () => {
    const { result, rerender } = setup(6);

    act(() => result.current.props.onValueChange(9));
    act(() => result.current.props.onValueCommitted(9));
    // The server clamped it, or somebody else moved it first.
    rerender({ value: 4, locked: false });
    expect(result.current.value).toBe(4);
  });

  it("drops a gesture that ended without committing", () => {
    // A cancelled pointer (the system took the touch) never commits, and a
    // draft nobody committed would show a value the room does not have.
    const { result, onCommit } = setup(6);

    act(() => result.current.props.onValueChange(3));
    act(() => result.current.props.onLostPointerCapture());
    expect(result.current.value).toBe(6);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("drops the draft when the slider locks", () => {
    const { result, rerender } = setup(6);

    act(() => result.current.props.onValueChange(9));
    act(() => result.current.props.onValueCommitted(9));
    rerender({ value: 6, locked: true });
    expect(result.current.value).toBe(6);

    // And it does not come back when the lock lifts.
    rerender({ value: 6, locked: false });
    expect(result.current.value).toBe(6);
  });
});
