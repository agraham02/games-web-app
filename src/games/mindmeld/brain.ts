/**
 * What a bot thinks of when it is asked for a word.
 *
 * The engine is pure and synchronous, so a bot's word comes from an object it is
 * handed rather than from anything it loads: `WordBrain`. The real one is a few
 * thousand word vectors (`vectorBrain.ts`), loaded by the server at startup and
 * by the page before a solo game; a small built-in one stands in whenever the
 * real one has not arrived, so a game never fails for want of one - it is only a
 * worse partner. The interface is the seam an LLM brain could be plugged into
 * later without touching a rule.
 */

import type { Rng } from "@/engine/rng";
import type { BotDifficulty } from "@/engine/types";

export interface BridgeOptions {
  /** Everything already said in this chain: never answered again. */
  exclude: readonly string[];
  tier: BotDifficulty;
  /** Stable per seat, so two bots in one pair do not think alike. */
  personality: number;
  rng: Rng;
  /**
   * Who is on the other end. Two bots in a pair must not always say the same
   * word (that is a meld every time, and no game), so with `bot` — the
   * default — the draw is deliberately loose. A PERSON writing the obvious
   * bridge is trying to meet you, so against `human` the bot says the most
   * likely answer instead: a partner that drifts is a partner that cannot be
   * met (the user, 2026-10-30).
   */
  partner?: "human" | "bot";
  /** Reveals this pair has already missed on: a human partner is met harder the longer it takes. */
  misses?: number;
}

export interface WordBrain {
  /** A word that connects `a` and `b`. */
  bridge(a: string, b: string, opts: BridgeOptions): string;
  /** A word to begin with, or to be dealt. */
  starter(rng: Rng, exclude?: readonly string[]): string;
}

/**
 * Common, concrete, family-friendly nouns. The fallback's whole vocabulary and
 * the real brain's pool of starting words: a game that begins on "and" is not a
 * game people enjoy, and these are the words people actually reach for.
 */
export const STARTERS: readonly string[] = [
  "apple", "banana", "beach", "bed", "bicycle", "bird", "book", "bread", "bridge", "butter",
  "cake", "camera", "candle", "castle", "cat", "chair", "cheese", "clock", "cloud", "coffee",
  "cookie", "cow", "dinner", "dog", "door", "dragon", "dream", "drum", "duck", "eagle",
  "farm", "feather", "fire", "fish", "flower", "forest", "fox", "garden", "ghost", "gift",
  "glass", "grass", "guitar", "hammer", "hat", "horse", "hotel", "house", "ice", "island",
  "jacket", "jungle", "key", "kitchen", "kite", "ladder", "lake", "lamp", "lemon", "library",
  "lion", "magic", "map", "market", "milk", "mirror", "moon", "mountain", "mouse", "music",
  "night", "ocean", "orange", "paper", "park", "party", "pencil", "piano", "pillow", "pirate",
  "pizza", "planet", "pocket", "queen", "rabbit", "rain", "river", "robot", "rocket", "salt",
  "sand", "school", "shadow", "ship", "shoe", "snow", "soap", "star", "storm", "summer",
  "sun", "table", "tea", "tiger", "train", "tree", "umbrella", "village", "water", "window",
  "winter", "wizard", "yellow", "zebra",
];

/** A tiny association list, enough to be a partner of sorts before the real one loads. */
const NEAR: Readonly<Record<string, readonly string[]>> = {
  beach: ["sand", "sun", "ocean", "summer", "water"],
  sun: ["summer", "hot", "light", "sky", "beach"],
  water: ["ocean", "rain", "river", "drink", "swim"],
  dog: ["cat", "puppy", "bone", "pet", "bark"],
  cat: ["dog", "kitten", "pet", "milk", "mouse"],
  fire: ["hot", "smoke", "red", "flame", "burn"],
  ice: ["cold", "snow", "winter", "cream", "freeze"],
  snow: ["winter", "cold", "white", "ice", "christmas"],
  moon: ["night", "star", "sky", "space", "dark"],
  star: ["night", "sky", "moon", "space", "shine"],
  night: ["dark", "moon", "sleep", "star", "dream"],
  tree: ["leaf", "forest", "wood", "green", "bird"],
  house: ["home", "door", "roof", "family", "garden"],
  book: ["read", "library", "story", "school", "page"],
  music: ["song", "dance", "guitar", "piano", "band"],
  food: ["eat", "dinner", "hungry", "pizza", "cook"],
};

/**
 * The stand-in. Chooses from its own small lists by the numbers it is given, so
 * it is deterministic; and it never returns something already said.
 */
export const fallbackBrain: WordBrain = {
  bridge(a, b, { exclude, rng }) {
    const used = new Set(exclude.map((w) => w.toLowerCase()));
    const near = [...(NEAR[a.toLowerCase()] ?? []), ...(NEAR[b.toLowerCase()] ?? [])].filter((w) => !used.has(w));
    const pool = near.length > 0 ? near : STARTERS.filter((w) => !used.has(w));
    return pool[rng.int(pool.length)] ?? "thing";
  },
  starter(rng, exclude = []) {
    const used = new Set(exclude.map((w) => w.toLowerCase()));
    const pool = STARTERS.filter((w) => !used.has(w));
    return pool[rng.int(pool.length)] ?? "thing";
  },
};

let installed: WordBrain | null = null;

/** Installs the real brain, once it has loaded. */
export function installBrain(brain: WordBrain | null): void {
  installed = brain;
}

/** The brain in use: the real one if it has arrived, else the stand-in. */
export function currentBrain(): WordBrain {
  return installed ?? fallbackBrain;
}
