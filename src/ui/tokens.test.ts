/**
 * Every colour shade the source uses must exist in the theme.
 *
 * Tailwind generates no utility at all for a colour it has no token for,
 * and says nothing about it: `text-bone-500` produced no CSS, so the text
 * inherited `bone-50` — the brightest text on the screen, used exactly
 * where the dimmest was meant. Forty-four class names across sixteen files
 * did that before anybody noticed, because every one of them still
 * rendered *something*. The only reliable guard is to compare the class
 * names against `globals.css` directly.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");
const CSS = readFileSync(path.join(SRC, "app", "globals.css"), "utf8");

/** Every `--color-<name>` declared anywhere in globals.css. */
const DEFINED = new Set([...CSS.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]!));

/** The palette families with numbered steps — the ones a typo can miss. */
const FAMILIES = ["felt", "brass", "bone"] as const;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [full] : [];
  });
}

describe("theme tokens", () => {
  it("defines every numbered shade the source uses", () => {
    const pattern = new RegExp(`\\b(?:${FAMILIES.join("|")})-(\\d{2,3})\\b`, "g");
    const missing: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(pattern)) {
        const token = match[0];
        if (!DEFINED.has(token)) missing.push(`${path.relative(SRC, file)}: ${token}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  it("finds the palette it is guarding, so a moved stylesheet fails loudly", () => {
    for (const family of FAMILIES) {
      expect([...DEFINED].some((t) => t.startsWith(`${family}-`))).toBe(true);
    }
  });
});
