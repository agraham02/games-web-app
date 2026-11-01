import { describe, expect, it } from "vitest";
import { isProfane } from "./profanity";

describe("the family-safe filter", () => {
  it("lets ordinary words through, including ones that merely contain a rude fragment", () => {
    for (const w of ["dog", "ice cream", "assassin", "class", "scunthorpe", "cocktail", "bass", "Pennsylvania", "analysis", "grape"]) {
      expect(isProfane(w), w).toBe(false);
    }
  });

  it("catches a rude word in its usual disguises", () => {
    for (const w of ["sh1t", "SHIT", "shiiit"]) {
      expect(isProfane(w), w).toBe(true);
    }
  });

  it("says nothing about the empty string or a non-string", () => {
    expect(isProfane("")).toBe(false);
    expect(isProfane(undefined as never)).toBe(false);
  });
});
