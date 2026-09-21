// @vitest-environment node

/**
 * One assertion, guarding one real bug.
 *
 * The shared registry decides which games a room may START; this decides
 * which games a room can DRAW. They live apart because the registry is
 * imported by the server and tables are React components, and they drifted
 * the moment that was true: three games were marked online while only
 * Spades had a table, so choosing one would have dealt a genuine game onto
 * a screen drawing a different one.
 *
 * Nothing in the type system connects the two lists. This does.
 */

import { describe, expect, it } from "vitest";
import { GAMES, GAME_IDS } from "@/session/registry";
import { TABLES } from "./tables";

describe("online games and online tables", () => {
  it("never offers a game the room cannot draw", () => {
    const offered = GAME_IDS.filter((id) => GAMES[id].online);
    const drawable = offered.filter((id) => TABLES[id]);
    expect(drawable).toEqual(offered);
  });

  it("never ships a table for a game the server would refuse to start", () => {
    // The mirror image, and a real possibility while games are being
    // wired one at a time: a table nobody can reach is dead code that
    // looks finished.
    for (const id of Object.keys(TABLES) as (keyof typeof TABLES)[]) {
      expect(GAMES[id].online).toBe(true);
    }
  });
});
