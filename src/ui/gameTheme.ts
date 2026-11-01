/**
 * Which surface each game sits on.
 *
 * The colours themselves live in `app/globals.css` under `[data-game="…"]`,
 * the single source of visual truth. What is here is the part JavaScript
 * needs and CSS cannot give it: the attribute to put on a subtree, the
 * colour to hand the browser's address bar, and a few swatches for places
 * that draw a game's colour from outside its subtree (the home carousel
 * fading between games). `tokens.test.ts` checks the swatches against the
 * stylesheet, so the two cannot drift.
 */

import type { GameId } from "@/session/registry";

export type SurfaceKind = "felt" | "wood" | "satin";

export interface GameTheme {
  surface: SurfaceKind;
  /** felt-950 — the page background and the browser's `theme-color`. */
  deep: string;
  /** felt-850 — panels. */
  mid: string;
  /** felt-700 — the lit centre of the table. */
  lit: string;
  /** brass-400 — the accent. */
  accent: string;
}

export const GAME_THEMES: Record<GameId, GameTheme> = {
  // Spades, Rummy 500 and BS share the house green: no stylesheet block.
  spades: { surface: "felt", deep: "#071310", mid: "#0f2a22", lit: "#1b4634", accent: "#d4af6a" },
  rummy: { surface: "felt", deep: "#071310", mid: "#0f2a22", lit: "#1b4634", accent: "#d4af6a" },
  bs: { surface: "felt", deep: "#071310", mid: "#0f2a22", lit: "#1b4634", accent: "#d4af6a" },
  poker: { surface: "felt", deep: "#060b18", mid: "#0e1b36", lit: "#1b3260", accent: "#e6cf9a" },
  dominoes: { surface: "wood", deep: "#170d07", mid: "#2f1d11", lit: "#4a2f1c", accent: "#d9a370" },
  chromaly: { surface: "felt", deep: "#1f0905", mid: "#3d140b", lit: "#7a2c14", accent: "#e8b92f" },
  lrc: { surface: "felt", deep: "#1e1504", mid: "#3f2d0a", lit: "#6e4f12", accent: "#efdfae" },
  mindmeld: { surface: "satin", deep: "#0b0a1c", mid: "#16153d", lit: "#2a2766", accent: "#bfb2f2" },
};

/** Spread onto the root of anything that should wear a game's colours. */
export function themeAttrs(id: string): { "data-game"?: GameId } {
  return id in GAME_THEMES ? { "data-game": id as GameId } : {};
}
