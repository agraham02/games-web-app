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
import { GAME_IDS } from "@/session/registry";
import { GAME_THEMES, themeAttrs } from "./gameTheme";

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

  it("maps every shadcn role a component uses onto the palette", () => {
    // The primitives in ui/base come from shadcn and speak in roles. A role
    // nobody mapped (a later `shadcn add` bringing `bg-sidebar`, say) would
    // render as nothing, silently, exactly like an undefined shade.
    const roles = new RegExp(
      "\\b(?:bg|text|border|ring|ring-offset|outline|fill|stroke|from|via|to|placeholder|caret|divide|decoration)-" +
        "((?:background|foreground|card|popover|primary|secondary|muted|accent|destructive|input|ring|border|sidebar|chart)(?:-[a-z0-9]+)*)\\b",
      "g",
    );
    const missing: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(roles)) {
        const role = match[1]!;
        if (!DEFINED.has(role)) missing.push(`${path.relative(SRC, file)}: ${match[0]}`);
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

/** A palette entry's hex, read from a declaration block's text. */
function declared(block: string, token: string): string | undefined {
  return new RegExp(`--color-${token}\\s*:\\s*(#[0-9a-fA-F]{6})`).exec(block)?.[1]?.toLowerCase();
}

/** What a `[data-game="…"]` subtree declares, merged across its blocks. */
function gameBlock(id: string): string {
  const blocks = [...CSS.matchAll(new RegExp(`\\[data-game="${id}"\\]\\s*\\{([^}]*)\\}`, "g"))];
  return blocks.map((m) => m[1]).join("\n");
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("per-game surfaces", () => {
  // The house green: everything declared before the first themed block.
  const root = (token: string) => declared(CSS.slice(0, CSS.indexOf("[data-game=")), token)!;

  it("gives every game a theme, and names it by the id the table reports", () => {
    expect(Object.keys(GAME_THEMES).sort()).toEqual([...GAME_IDS].sort());
    for (const id of GAME_IDS) expect(themeAttrs(id)).toEqual({ "data-game": id });
    expect(themeAttrs("not-a-game")).toEqual({});
  });

  it("keeps the swatches in gameTheme.ts equal to the stylesheet", () => {
    for (const id of GAME_IDS) {
      const block = gameBlock(id);
      const t = GAME_THEMES[id];
      // Spades, Rummy and BS have no block: they ARE :root.
      const read = (token: string) => declared(block, token) ?? root(token);
      expect({ deep: t.deep, mid: t.mid, lit: t.lit, accent: t.accent }, id).toEqual({
        deep: read("felt-950"),
        mid: read("felt-850"),
        lit: read("felt-700"),
        accent: read("brass-400"),
      });
    }
  });

  it("re-declares the roles inside a themed subtree", () => {
    // A role is a var() resolved where it is declared; left on :root alone
    // it keeps the house green inside a themed table.
    const match = /((?:\[data-game="[a-z]+"\],\s*)+\[data-game="[a-z]+"\])\s*\{([^}]*)\}/.exec(CSS);
    const selectors = match?.[1] ?? "";
    const grouped = match?.[2] ?? "";
    for (const role of ["background", "card", "popover", "primary", "primary-foreground", "ring"]) {
      expect(grouped, role).toContain(`--color-${role}:`);
    }
    for (const id of GAME_IDS) {
      if (id === "spades" || id === "rummy" || id === "bs") continue;
      expect(selectors, id).toContain(`[data-game="${id}"]`);
    }
  });

  it("stays readable on every surface", () => {
    const bone50 = root("bone-50");
    for (const id of GAME_IDS) {
      const t = GAME_THEMES[id];
      expect(contrast(bone50, t.mid), `${id} text on panel`).toBeGreaterThanOrEqual(7);
      expect(contrast(t.accent, t.deep), `${id} accent on page`).toBeGreaterThanOrEqual(4.5);
      // A card must stand off the lit centre of its own table.
      expect(contrast("#fbf8f1", t.lit), `${id} card on felt`).toBeGreaterThanOrEqual(3);
    }
  });
});
