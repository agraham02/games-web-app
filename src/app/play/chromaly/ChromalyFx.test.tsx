// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { emitCue } from "@/table/fx";
import { resolveTable } from "@/table/geometry";
import { useTableStore } from "@/table/store";
import { ChromalyFx } from "./ChromalyFx";

/**
 * Effects last under a second and fire on a beat, which a screenshot cannot
 * catch - so they are checked here: what each cue draws, that there is only
 * ever one ribbon, that nothing hangs off the edge of the table, and that
 * everything clears itself.
 */

const WIDTH = 390;
const HEIGHT = 844;

// Real timers throughout. Fake ones leave Motion's frame loop waiting on a fake
// requestAnimationFrame that never fires, and every exit animation after that
// in the file hangs - which reads as "the effect never clears".
beforeEach(() => {
  useTableStore.getState().setGeometry(resolveTable({ seats: 4, width: WIDTH, height: HEIGHT }));
});

const fx = () => render(<ChromalyFx names={(s) => `Seat ${s}`} />);
const cue = (c: Parameters<typeof emitCue>[0]) => act(() => emitCue(c));

describe("what each cue draws", () => {
  it("a jump-in is a ribbon", () => {
    fx();
    cue({ t: "cue", kind: "jump", seat: 3 });
    expect(screen.getByText("Jump in!")).toBeTruthy();
  });

  it("the cards on their way arrive as a numeral", () => {
    fx();
    cue({ t: "cue", kind: "draw", seat: 2, amount: 4 });
    expect(screen.getByText("+4")).toBeTruthy();
  });

  it("a last card said is a bubble, and a catch is another", () => {
    fx();
    cue({ t: "cue", kind: "called", seat: 1 });
    expect(screen.getByText("CHROMA!")).toBeTruthy();
    cue({ t: "cue", kind: "caught", seat: 2 });
    expect(screen.getByText("Caught!")).toBeTruthy();
  });

  it("a bluff names whoever was bluffing", () => {
    fx();
    cue({ t: "cue", kind: "bluff", seat: 2 });
    expect(screen.getByText("Seat 2: bluff!")).toBeTruthy();
  });

  it("draws nothing for a stack: the pile's own badge does", () => {
    const { container } = fx();
    cue({ t: "cue", kind: "stack", seat: 1, amount: 6 });
    expect(container.querySelector("[style*='left']")).toBeNull();
  });
});

describe("restraint", () => {
  it("never has two ribbons up at once: a new one replaces the old", async () => {
    // The old ribbon plays a short exit before it leaves the DOM.
    fx();
    cue({ t: "cue", kind: "jump", seat: 3 });
    cue({ t: "cue", kind: "reverse", seat: 0, dir: -1 });
    expect(screen.getByText("Reverse")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Jump in!")).toBeNull(), { timeout: 3000 });
    cue({ t: "cue", kind: "swap", seat: 0 });
    expect(screen.getByText("Swap hands")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Reverse")).toBeNull(), { timeout: 3000 });
  });

  it("lets a bubble and a ribbon share the table: only ribbons compete", () => {
    fx();
    cue({ t: "cue", kind: "jump", seat: 3 });
    cue({ t: "cue", kind: "called", seat: 1 });
    expect(screen.getByText("Jump in!")).toBeTruthy();
    expect(screen.getByText("CHROMA!")).toBeTruthy();
  });

  it("keeps a ribbon inside the table even for a seat on the rim", () => {
    const { container } = fx();
    cue({ t: "cue", kind: "jump", seat: 3 });
    const holder = screen.getByText("Jump in!").closest("div") as HTMLElement;
    const left = parseFloat(holder.style.left);
    expect(left).toBeGreaterThanOrEqual(90);
    expect(left).toBeLessThanOrEqual(WIDTH - 90);
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  it("never wraps a ribbon onto two lines", () => {
    fx();
    cue({ t: "cue", kind: "jump", seat: 3 });
    expect(screen.getByText("Jump in!").className).toContain("whitespace-nowrap");
  });
});

describe("clearing up", () => {
  it("removes every effect on its own once its time is up", async () => {
    fx();
    cue({ t: "cue", kind: "called", seat: 1 });
    cue({ t: "cue", kind: "draw", seat: 2, amount: 2 });
    expect(screen.getByText("CHROMA!")).toBeTruthy();
    await waitFor(
      () => {
        expect(screen.queryByText("CHROMA!")).toBeNull();
        expect(screen.queryByText("+2")).toBeNull();
      },
      { timeout: 4000 },
    );
  });

  it("is a no-op with nobody listening to a table that has no geometry", () => {
    useTableStore.setState({ geometry: null });
    const { container } = fx();
    cue({ t: "cue", kind: "jump", seat: 3 });
    expect(container.firstChild).toBeNull();
  });
});
