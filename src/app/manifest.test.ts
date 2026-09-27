import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "./manifest";

/**
 * Chromium installs a site only if its manifest names a 192px and a 512px
 * icon, and a manifest can name files that are not there, or not that size.
 * Read from the PNGs themselves (their IHDR), so regenerating the icons at
 * the wrong size (`scripts/app-icons.ts`) fails here, not on a phone.
 */
function pngSize(path: string): string {
  const png = readFileSync(path);
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
}

describe("the web app manifest", () => {
  const m = manifest();
  const root = join(__dirname, "..", "..");

  it("has what Chromium needs to install", () => {
    expect(m.name).toBeTruthy();
    expect(m.start_url).toBe("/");
    expect(m.display).toBe("standalone");
    const sizes = (m.icons ?? []).filter((i) => i.purpose !== "maskable").map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect((m.icons ?? []).some((i) => i.purpose === "maskable")).toBe(true);
  });

  it("names icons that exist, at the size it says", () => {
    for (const icon of m.icons ?? []) {
      expect(pngSize(join(root, "public", icon.src)), icon.src).toBe(icon.sizes);
    }
  });

  it("gives iOS a 180px home-screen icon", () => {
    expect(pngSize(join(root, "src", "app", "apple-icon.png"))).toBe("180x180");
  });
});
