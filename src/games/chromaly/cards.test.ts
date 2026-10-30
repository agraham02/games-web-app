import { describe, expect, it } from "vitest";
import {
  COLORS,
  deckIds,
  drawAmount,
  handDisplayOrder,
  identical,
  isDraw,
  matches,
  parseCard,
  points,
  sameFace,
  type Top,
} from "./cards";

const card = (id: string) => {
  const c = parseCard(id);
  if (!c) throw new Error(`not a card: ${id}`);
  return c;
};

describe("the deck", () => {
  it("is 108 cards, 109 with Shuffle Hands, with no duplicate ids", () => {
    expect(deckIds()).toHaveLength(108);
    expect(deckIds(true)).toHaveLength(109);
    expect(new Set(deckIds(true)).size).toBe(109);
  });

  it("has the official counts of each kind", () => {
    const kinds = deckIds().map((id) => card(id).kind);
    const count = (k: string) => kinds.filter((x) => x === k).length;
    expect(count("number")).toBe(76); // 4 x (one 0 + two each of 1-9)
    expect(count("skip")).toBe(8);
    expect(count("reverse")).toBe(8);
    expect(count("draw2")).toBe(8);
    expect(count("wild")).toBe(4);
    expect(count("wild4")).toBe(4);
  });

  it("has one 0 and two of each other number per colour", () => {
    for (const color of COLORS) {
      const numbers = deckIds()
        .map(card)
        .filter((c) => c.kind === "number" && c.color === color)
        .map((c) => c.value);
      expect(numbers.filter((v) => v === 0)).toHaveLength(1);
      for (let n = 1; n <= 9; n++) expect(numbers.filter((v) => v === n)).toHaveLength(2);
    }
  });

  it("names no id that parses to something else, and nothing else parses", () => {
    for (const id of deckIds(true)) expect(parseCard(id)?.id).toBe(id);
    for (const junk of ["??", "#hand:2:-:3", "", "R7", "Z9.1", "R10.1", "SA"]) {
      expect(parseCard(junk)).toBeNull();
    }
  });

  it("uses ids that are safe in a CSS attribute and never start with #", () => {
    for (const id of deckIds(true)) expect(id).toMatch(/^[A-Z0-9.]+$/);
  });
});

describe("points", () => {
  it("scores numbers at face value, actions 20, wilds 50, Shuffle Hands 40", () => {
    expect(points("R0.1")).toBe(0);
    expect(points("B7.2")).toBe(7);
    expect(points("GS.1")).toBe(20);
    expect(points("YV.2")).toBe(20);
    expect(points("RD.1")).toBe(20);
    expect(points("W.1")).toBe(50);
    expect(points("F.4")).toBe(50);
    expect(points("X.1")).toBe(40);
    expect(points("??")).toBe(0);
  });

  it("totals a whole deck to 1,240", () => {
    // Per colour: the numbers (2 x 45 = 90) + six action cards x 20 = 120 -> 210, x4 = 840.
    // Plus eight wilds x 50 = 400.
    expect(deckIds().reduce((n, id) => n + points(id), 0)).toBe(1240);
  });
});

describe("matching", () => {
  const top = (id: string, color = card(id).color!): Top => ({ card: card(id), color });

  it("matches on colour or on number", () => {
    expect(matches(card("R3.1"), top("R7.1"))).toBe(true);
    expect(matches(card("B7.1"), top("R7.1"))).toBe(true);
    expect(matches(card("B3.1"), top("R7.1"))).toBe(false);
  });

  it("matches a symbol with the same symbol in another colour", () => {
    expect(matches(card("GS.1"), top("RS.1"))).toBe(true);
    expect(matches(card("GV.1"), top("RS.1"))).toBe(false);
    expect(matches(card("GD.1"), top("RD.2"))).toBe(true);
  });

  it("matches a wild on anything, and anything on a wild's chosen colour", () => {
    expect(matches(card("W.1"), top("R7.1"))).toBe(true);
    expect(matches(card("F.1"), top("R7.1"))).toBe(true);
    const wild: Top = { card: card("W.2"), color: "G" };
    expect(matches(card("G4.1"), wild)).toBe(true);
    expect(matches(card("R4.1"), wild)).toBe(false);
  });

  it("does not match a number against a symbol of another kind", () => {
    expect(matches(card("B0.1"), top("RS.1"))).toBe(false);
  });
});

describe("identical (Jump-In)", () => {
  it("is the same colour and the same face, never a wild", () => {
    expect(identical(card("R7.1"), card("R7.2"))).toBe(true);
    expect(identical(card("R7.1"), card("B7.1"))).toBe(false);
    expect(identical(card("RS.1"), card("RS.2"))).toBe(true);
    expect(identical(card("RS.1"), card("RV.1"))).toBe(false);
    expect(identical(card("W.1"), card("W.2"))).toBe(false);
    expect(identical(card("F.1"), card("F.2"))).toBe(false);
  });

  it("sameFace ignores colour", () => {
    expect(sameFace(card("R5.1"), card("G5.2"))).toBe(true);
    expect(sameFace(card("R5.1"), card("G6.2"))).toBe(false);
  });
});

describe("draw cards", () => {
  it("knows which are draw cards and how many they make you take", () => {
    expect(isDraw(card("RD.1"))).toBe(true);
    expect(isDraw(card("F.1"))).toBe(true);
    expect(isDraw(card("W.1"))).toBe(false);
    expect(drawAmount(card("RD.1"))).toBe(2);
    expect(drawAmount(card("F.1"))).toBe(4);
    expect(drawAmount(card("R3.1"))).toBe(0);
  });
});

describe("handDisplayOrder", () => {
  it("groups by colour, orders by face, puts wilds last, and does not mutate", () => {
    const hand = ["W.1", "B3.1", "R9.1", "R2.1", "RS.1", "F.2", "G0.1"];
    const copy = [...hand];
    const sorted = handDisplayOrder(hand);
    expect(hand).toEqual(copy);
    expect(sorted).toEqual(["R2.1", "R9.1", "RS.1", "G0.1", "B3.1", "W.1", "F.2"]);
  });
});
