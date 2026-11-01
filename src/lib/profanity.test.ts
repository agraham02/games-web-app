import { describe, expect, it } from "vitest";
import { isProfane, maskProfanity } from "./profanity";

describe("masking a sentence", () => {
  it("stars out a rude word, in its disguises too, and keeps the rest", () => {
    expect(maskProfanity("sh1t happens")).toBe("**** happens");
    expect(maskProfanity("fuuuuck this")).toBe("**** this");
    expect(maskProfanity("you are a fucking idiot")).toBe("you are a ****ing idiot");
  });

  it("leaves a clean sentence exactly as it was, including words that merely contain a fragment", () => {
    for (const s of ["good game everyone", "class assignment", "Scunthorpe is nice", "I love a cocktail"]) {
      expect(maskProfanity(s), s).toBe(s);
    }
  });

  it("says nothing about the empty string or a non-string", () => {
    expect(maskProfanity("")).toBe("");
    expect(maskProfanity(undefined as never)).toBeUndefined();
  });
});

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
