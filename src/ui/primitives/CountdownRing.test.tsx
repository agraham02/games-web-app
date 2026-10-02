// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CountdownBar, CountdownRing, bandOf, ringFraction, ringPath } from "./CountdownRing";

afterEach(cleanup);

/**
 * Walks the path the ring actually draws — straight runs, and quarter
 * circles at the corners — so `length` is checked against the drawing and
 * not against its own formula.
 */
function walk(d: string): { start: [number, number]; length: number } {
  const tokens = d.split(" ");
  let x = 0;
  let y = 0;
  let length = 0;
  let start: [number, number] = [0, 0];
  for (let i = 0; i < tokens.length; ) {
    const command = tokens[i++];
    if (command === "M") {
      x = Number(tokens[i++]);
      y = Number(tokens[i++]);
      start = [x, y];
    } else if (command === "V") {
      const to = Number(tokens[i++]);
      length += Math.abs(to - y);
      y = to;
    } else if (command === "H") {
      const to = Number(tokens[i++]);
      length += Math.abs(to - x);
      x = to;
    } else if (command === "A") {
      const r = Number(tokens[i++]);
      i += 4; // ry, rotation, large-arc, sweep
      x = Number(tokens[i++]);
      y = Number(tokens[i++]);
      length += (Math.PI * r) / 2;
    } else {
      throw new Error(`unexpected ${command}`);
    }
  }
  return { start, length };
}

describe("the ring's path", () => {
  it("measures what it draws", () => {
    for (const [w, h, r] of [
      [200, 46, 9999], // a pill button, much wider than tall
      [82, 96, 15], // a pod: rounded-xl plus the ring
      [100, 40, 0], // square corners
    ] as const) {
      const path = ringPath(w, h, r, 3);
      expect(walk(path.d).length, `${w}x${h} r${r}`).toBeCloseTo(path.length, 1);
    }
  });

  it("follows the middle of the band, with the corner the element's own", () => {
    // A 100x40 square-cornered box and a 4px ring: the middle of the band is
    // 2px in from every side.
    expect(ringPath(100, 40, 0, 4).length).toBe(2 * 96 + 2 * 36);
    // A pill's 9999px clamps to half the height, as CSS does.
    const pill = ringPath(100, 40, 9999, 4);
    expect(pill.length).toBeCloseTo(2 * (96 - 36) + 2 * Math.PI * 18);
  });

  it("starts at the middle of the left side, as before", () => {
    expect(walk(ringPath(200, 46, 9999, 3).d).start).toEqual([1.5, 23]);
  });
});

describe("CountdownRing", () => {
  /** jsdom lays nothing out; give the overlay a size. */
  function sized(width: number, height: number) {
    const proto = HTMLElement.prototype;
    const was = {
      w: Object.getOwnPropertyDescriptor(proto, "offsetWidth"),
      h: Object.getOwnPropertyDescriptor(proto, "offsetHeight"),
    };
    Object.defineProperty(proto, "offsetWidth", { configurable: true, get: () => width });
    Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => height });
    return () => {
      if (was.w) Object.defineProperty(proto, "offsetWidth", was.w);
      if (was.h) Object.defineProperty(proto, "offsetHeight", was.h);
    };
  }

  it("draws the full perimeter as one round-capped dash while the time is all there", async () => {
    const restore = sized(206, 52);
    try {
      // A minute out on a five-second clock: held full.
      const { container } = render(<CountdownRing totalMs={5_000} endsAt={Date.now() + 60_000} />);
      const path = container.querySelector("path")!;
      expect(path.getAttribute("stroke-linecap")).toBe("round");
      // Against the path as drawn: jsdom resolves no corner radius, so this
      // one has square corners, which a browser's would not.
      const { length } = walk(path.getAttribute("d")!);
      expect(length).toBeGreaterThan(400);
      await waitFor(() => {
        const [dash] = (path.style.strokeDasharray || path.getAttribute("stroke-dasharray") || "").split(/[ ,]+/);
        expect(Number.parseFloat(dash ?? "")).toBeCloseTo(length, 1);
      });
    } finally {
      restore();
    }
  });
});

describe("a countdown's fill", () => {
  it("is full until a clock's worth is left, then empties to the end", () => {
    // 5s of clock, ending at 10_000: still full at 4_000 (6s left, the lead).
    expect(ringFraction(4_000, 10_000, 5_000)).toBe(1);
    expect(ringFraction(5_000, 10_000, 5_000)).toBe(1);
    expect(ringFraction(7_500, 10_000, 5_000)).toBe(0.5);
    expect(ringFraction(10_000, 10_000, 5_000)).toBe(0);
    expect(ringFraction(12_000, 10_000, 5_000)).toBe(0);
  });

  it("starts part-empty when it is first seen late — a refresh, a slow frame", () => {
    expect(ringFraction(9_000, 10_000, 5_000)).toBeCloseTo(0.2);
  });

  it("turns amber at half and red at a fifth, the user's thresholds", () => {
    expect(bandOf(1)).toBe("safe");
    expect(bandOf(0.51)).toBe("safe");
    expect(bandOf(0.5)).toBe("warn");
    expect(bandOf(0.21)).toBe("warn");
    expect(bandOf(0.2)).toBe("danger");
    expect(bandOf(0)).toBe("danger");
  });
});

describe("CountdownBar", () => {
  // Here only: the ring's own test needs a clock that is held, not skipped.
  beforeAll(() => {
    MotionGlobalConfig.skipAnimations = true;
  });
  afterAll(() => {
    MotionGlobalConfig.skipAnimations = false;
  });

  it("warns once, on turning red", () => {
    // Arriving with a tenth left: already red.
    const onDanger = vi.fn();
    render(<CountdownBar totalMs={5_000} endsAt={Date.now() + 500} onDanger={onDanger} />);
    expect(onDanger).toHaveBeenCalledTimes(1);
  });

  it("says nothing while there is time", () => {
    const onDanger = vi.fn();
    render(<CountdownBar totalMs={5_000} endsAt={Date.now() + 60_000} onDanger={onDanger} />);
    expect(onDanger).not.toHaveBeenCalled();
  });
});
