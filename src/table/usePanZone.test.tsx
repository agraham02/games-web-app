// @vitest-environment jsdom

/**
 * The hand's pan listens on the whole document and decides by coordinates
 * alone, so anything drawn over the table that takes a swipe of its own —
 * the chat's sideways row of quick replies, over the hand strip on a phone —
 * has to be able to say "not yours" (`data-pan-ignore`).
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePanZone } from "./usePanZone";

afterEach(cleanup);

function Zone({ onChange }: { onChange: (v: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  usePanZone({ ref, axis: "x", value: 0, min: -500, max: 500, onChange });
  return (
    <div ref={ref} data-testid="zone">
      <div data-testid="card">a card</div>
      <div data-pan-ignore>
        <button type="button">a quick reply</button>
      </div>
    </div>
  );
}

function swipe(from: Element) {
  fireEvent.pointerDown(from, { clientX: 100, clientY: 100 });
  fireEvent.pointerMove(document, { clientX: 160, clientY: 100 });
  fireEvent.pointerUp(document);
}

describe("usePanZone", () => {
  // jsdom lays nothing out: make the zone cover the screen.
  const box = { left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0 };

  it("pans for a swipe over the hand", () => {
    const onChange = vi.fn();
    render(<Zone onChange={onChange} />);
    vi.spyOn(screen.getByTestId("zone"), "getBoundingClientRect").mockReturnValue(box as DOMRect);
    swipe(screen.getByTestId("card"));
    expect(onChange).toHaveBeenCalled();
  });

  it("leaves a swipe over something drawn on top alone", () => {
    const onChange = vi.fn();
    render(<Zone onChange={onChange} />);
    vi.spyOn(screen.getByTestId("zone"), "getBoundingClientRect").mockReturnValue(box as DOMRect);
    swipe(screen.getByText("a quick reply"));
    expect(onChange).not.toHaveBeenCalled();
  });
});
