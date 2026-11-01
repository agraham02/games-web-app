// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { doubleSixSet } from "@/games/_shared/tiles";
import { rummyDeck } from "@/games/rummy/cards";
import { HIDDEN_TILE } from "@/games/dominoes/state";
import { fxSelector, impact } from "./PieceLayer";

/**
 * The slam reaches its pieces by CSS selector rather than by per-piece
 * subscription (see `useSlamFx`), which buys the layer zero re-renders
 * and costs it one thing: if a piece id does not survive the round trip
 * into an attribute selector, the flourish silently animates nothing.
 *
 * Nothing else in the suite can catch that. A typecheck sees a string,
 * and the engine tests only prove the right ids were EMITTED.
 */

function findsItself(id: string): boolean {
  const host = document.createElement("div");
  const el = document.createElement("div");
  el.setAttribute("data-fx", id);
  host.append(el);
  return host.querySelector(fxSelector(id)) === el;
}

describe("fxSelector", () => {
  it("round-trips every domino id, hyphens and all", () => {
    // `6-3` is the case that made `CSS.escape` look necessary — it is
    // not, inside a quoted value, and CSS.escape is not guaranteed to
    // exist outside a browser anyway.
    for (const id of doubleSixSet()) {
      expect(findsItself(id), id).toBe(true);
    }
  });

  it("round-trips card ids, including the two-character rank", () => {
    for (const id of rummyDeck()) {
      expect(findsItself(id), id).toBe(true);
    }
  });

  it("round-trips the redaction sentinels", () => {
    // `?` and `??` stand in for pieces a viewer may not see. They are
    // real ids as far as the piece layer is concerned.
    for (const id of [HIDDEN_TILE, "??"]) {
      expect(findsItself(id), id).toBe(true);
    }
  });

  it("does not match a different piece", () => {
    const host = document.createElement("div");
    const el = document.createElement("div");
    el.setAttribute("data-fx", "6-3");
    host.append(el);
    expect(host.querySelector(fxSelector("6-4"))).toBeNull();
    // The neighbouring id that a sloppy prefix match would catch.
    expect(host.querySelector(fxSelector("6"))).toBeNull();
  });

  it("survives a quote or a backslash without breaking the selector", () => {
    // No game ships such an id today; this pins the escaping so that one
    // could not silently break the whole flourish if it ever did.
    for (const id of ['a"b', "a\\b", '"']) {
      expect(() => document.querySelector(fxSelector(id))).not.toThrow();
      expect(findsItself(id), id).toBe(true);
    }
  });
});

describe("a domino's impact", () => {
  function table() {
    const box = document.createElement("div");
    const root = document.createElement("div");
    const target = document.createElement("div");
    box.append(root);
    root.append(target);
    root.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;
    target.getBoundingClientRect = () => ({ left: 390, top: 290, width: 20, height: 40 }) as DOMRect;
    return { box, root, target };
  }

  it("puts a ring and dust where the tile lands, then takes them away", async () => {
    const { root, target } = table();
    let finish: () => void = () => {};
    const done = new Promise<void>((r) => (finish = r));
    const animate = vi.fn(() => done);
    impact(root, target, false, animate);
    const drawn = [...root.children].filter((c) => c !== target) as HTMLElement[];
    expect(drawn.length).toBeGreaterThan(5);
    // Centred on the tile, in the layer's own coordinates.
    expect(drawn.every((el) => el.style.left === "400px" && el.style.top === "310px")).toBe(true);
    finish();
    await done;
    await Promise.resolve();
    expect([...root.children]).toEqual([target]);
  });

  it("is bigger for the tile that ends the round, and jolts the table, leaving it untransformed", async () => {
    const plain = table();
    impact(plain.root, plain.target, false, () => Promise.resolve());
    const big = table();
    let jolted: Element | null = null;
    impact(big.root, big.target, true, (el) => {
      if (el === big.box) jolted = el;
      return Promise.resolve();
    });
    expect(big.root.children.length).toBeGreaterThan(plain.root.children.length);
    expect(jolted).toBe(big.box);
    await Promise.resolve();
    expect(big.box.style.transform).toBe("");
  });
});
