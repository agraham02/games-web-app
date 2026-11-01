import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { FOREVER_SAFE } from "./presets";

/**
 * Every animation that never ends animates only what the compositor can play
 * on its own (see `FOREVER_SAFE`).
 *
 * Nothing at runtime can catch the alternative: a pulse on `scale` looks
 * exactly like one on `transform`, and only costs a frame's worth of work on
 * the main thread, forever. jsdom has no frames to count. So this reads the
 * source, the way `redact.test.ts` reads what leaves the server.
 */

const SRC = join(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".tsx") && !name.includes(".test.") ? [path] : [];
  });
}

/** From an opening `{`, the text up to its matching `}`. */
function braced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

/** Each `<motion.x ...>` opening tag, attributes and all. */
function motionTags(text: string): { tag: string; line: number }[] {
  const out: { tag: string; line: number }[] = [];
  for (const m of text.matchAll(/<motion\.\w+/g)) {
    let i = m.index! + m[0].length;
    let depth = 0;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    out.push({ tag: text.slice(m.index!, i + 1), line: text.slice(0, m.index!).split("\n").length });
  }
  return out;
}

/** The property names an `animate={...}` expression sets, strings stripped. */
function animatedKeys(tag: string): string[] {
  const at = tag.indexOf("animate={");
  if (at < 0) return [];
  const expr = braced(tag, at + "animate=".length).replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '""');
  // A key follows `{` or `,`; the `:` of a ternary (`still ? undefined : {`) does not.
  return [...expr.matchAll(/[{,]\s*([A-Za-z]\w*)\s*:/g)].map((m) => m[1]!);
}

describe("an animation that never ends", () => {
  it("animates only what the compositor plays by itself", () => {
    const safe = new Set<string>(FOREVER_SAFE);
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      for (const { tag, line } of motionTags(readFileSync(file, "utf8"))) {
        if (!/repeat:\s*Infinity/.test(tag)) continue;
        const bad = animatedKeys(tag).filter((k) => !safe.has(k));
        if (bad.length > 0) offenders.push(`${relative(SRC, file)}:${line} animates ${bad.join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("is found at all", () => {
    // The scan is only worth something while it still sees the pulses it
    // guards; a change to how they are written must not make it pass by
    // finding nothing.
    const found = sources(SRC).flatMap((file) =>
      motionTags(readFileSync(file, "utf8")).filter(({ tag }) => /repeat:\s*Infinity/.test(tag)),
    );
    expect(found.length).toBeGreaterThanOrEqual(8);
    expect(animatedKeys('<motion.span animate={{ opacity: [0, 1], scale: [1, 2] }}>')).toEqual(["opacity", "scale"]);
  });
});
