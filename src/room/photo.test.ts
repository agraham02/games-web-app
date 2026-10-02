// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { readSavedPhoto, savePhoto, squareCrop } from "./photo";

describe("squareCrop", () => {
  it("takes the middle of a landscape picture", () => {
    expect(squareCrop(4000, 3000)).toEqual([500, 0, 3000]);
  });

  it("takes the middle of a portrait one", () => {
    expect(squareCrop(1080, 1920)).toEqual([0, 420, 1080]);
  });

  it("leaves a square alone", () => {
    expect(squareCrop(640, 640)).toEqual([0, 0, 640]);
  });
});

describe("the photo kept for the session", () => {
  afterEach(() => window.sessionStorage.clear());

  it("is kept, and forgotten when taken down", () => {
    expect(readSavedPhoto()).toBeNull();
    savePhoto("data:image/jpeg;base64,AAAA");
    expect(readSavedPhoto()).toBe("data:image/jpeg;base64,AAAA");
    savePhoto(null);
    expect(readSavedPhoto()).toBeNull();
  });
});
