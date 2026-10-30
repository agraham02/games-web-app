import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import type { BotDifficulty } from "@/engine/types";
import { associationsOf } from "./associations";
import { fallbackBrain } from "./brain";
import { isProfane } from "./profanity";
import { VECTORS_FILE, VOCAB_FILE, vectorBrainFrom } from "./vectorBrain";
import { sameWord, tokens } from "./words";

/**
 * The bot's brain, held to two claims.
 *
 * It says what a person would (a panel of prompts with answers a person would
 * accept), and a pair of bots takes about as long to meet as a pair of people
 * (a simulation). Both are measured rather than assumed, because the second is
 * easy to get wrong in the direction that matters: given the same two words,
 * two bots with the best possible answer both say it and meld on the second try
 * every time, which is no game at all.
 */

const vocabJson = readFileSync(`public/mindmeld/${VOCAB_FILE}`, "utf8");
const vectors = readFileSync(`public/mindmeld/${VECTORS_FILE}`);
const brain = vectorBrainFrom(vocabJson, vectors);
const TIERS: BotDifficulty[] = ["casual", "steady", "sharp"];

/** Pairs of words and what a person would say to connect them. */
const PANEL: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ["beach", "sun", ["summer", "sand", "ocean", "sea", "vacation", "hot", "tan", "water", "warm", "shore"]],
  ["dog", "cat", ["pet", "animal", "puppy", "kitten", "fur", "mouse", "bone", "house"]],
  ["fire", "ice", ["water", "cold", "hot", "snow", "melt", "winter", "frozen", "steam", "flame"]],
  ["night", "star", ["moon", "sky", "dark", "space", "bright", "twinkle", "light", "sleep"]],
  ["school", "summer", ["vacation", "break", "holiday", "teacher", "student", "class", "camp", "home", "sun"]],
  ["pizza", "cheese", ["food", "italian", "pepperoni", "dough", "tomato", "slice", "sauce", "sandwich", "eat"]],
  ["king", "castle", ["queen", "crown", "prince", "knight", "royal", "palace", "tower", "throne"]],
  ["ocean", "sky", ["blue", "sea", "water", "horizon", "wave", "cloud", "beach"]],
  ["bread", "butter", ["toast", "jam", "milk", "cheese", "breakfast", "knife", "food", "sandwich"]],
  ["rain", "umbrella", ["wet", "storm", "cloud", "weather", "water", "drop", "puddle", "dry"]],
  ["doctor", "hospital", ["nurse", "sick", "medicine", "patient", "health", "medical", "clinic"]],
  ["snow", "christmas", ["winter", "santa", "cold", "tree", "ice", "white", "presents", "gift"]],
  ["moon", "night", ["star", "dark", "sky", "sleep", "light", "space", "stars"]],
  ["apple", "tree", ["fruit", "red", "leaf", "orchard", "green", "branch", "garden", "pie"]],
  ["bird", "sky", ["fly", "wing", "cloud", "blue", "feather", "eagle", "air", "nest"]],
  ["cow", "milk", ["farm", "cheese", "barn", "moo", "grass", "cream", "butter"]],
  ["bed", "night", ["sleep", "pillow", "dream", "dark", "rest", "blanket", "tired", "moon"]],
  ["book", "school", ["read", "teacher", "student", "library", "learn", "pencil", "class", "study"]],
  ["car", "road", ["drive", "truck", "street", "highway", "travel", "wheel", "bus", "trip"]],
  ["fish", "water", ["swim", "ocean", "sea", "lake", "river", "boat", "pond", "shark", "fin"]],
  ["cake", "birthday", ["party", "candle", "sweet", "gift", "present", "balloon", "celebrate", "frosting"]],
  ["horse", "farm", ["cow", "barn", "ride", "pig", "animal", "field", "saddle", "hay", "tractor"]],
  ["tree", "forest", ["woods", "leaf", "green", "wood", "nature", "animals", "bear", "branch"]],
  ["train", "station", ["track", "railroad", "travel", "ticket", "platform", "bus", "ride", "engine"]],
  ["football", "game", ["team", "ball", "sport", "field", "play", "score", "stadium", "win"]],
  ["music", "dance", ["party", "song", "band", "rhythm", "fun", "beat", "move", "club"]],
  ["coffee", "morning", ["breakfast", "tea", "cup", "wake", "sun", "caffeine", "mug", "awake"]],
  ["queen", "crown", ["king", "royal", "palace", "gold", "princess", "throne", "jewel"]],
  ["pirate", "ship", ["sea", "treasure", "ocean", "captain", "sail", "boat", "parrot", "flag"]],
  ["wizard", "hat", ["magic", "wand", "witch", "spell", "pointy", "cap", "robe", "cloak"]],
  ["winter", "coat", ["cold", "snow", "warm", "jacket", "scarf", "ice", "hat", "boots"]],
  ["mountain", "snow", ["cold", "ski", "winter", "peak", "ice", "climb", "white", "hill"]],
  ["farm", "tractor", ["field", "corn", "barn", "crops", "cow", "dirt", "plow", "harvest", "wheat"]],
  ["kitchen", "dinner", ["food", "cook", "stove", "eat", "table", "oven", "meal", "chef"]],
  ["garden", "flower", ["rose", "bloom", "plant", "spring", "bee", "grow", "seed", "green", "petal"]],
  ["space", "rocket", ["moon", "astronaut", "star", "planet", "launch", "mars", "ship", "fly"]],
  ["baby", "bottle", ["milk", "cry", "crib", "diaper", "feed", "formula", "sleep", "toy"]],
  ["wedding", "cake", ["bride", "groom", "marriage", "dress", "party", "ring", "flower", "love", "white"]],
  ["lion", "zoo", ["tiger", "animal", "cage", "elephant", "monkey", "king", "jungle", "roar", "bear"]],
  ["swim", "pool", ["water", "summer", "wet", "dive", "lake", "ocean", "towel", "float", "lap"]],
];

/** Of many single answers across personalities, the share a person would accept. */
function hitRate(tier: BotDifficulty): number {
  let hits = 0;
  let total = 0;
  for (const [a, b, ok] of PANEL) {
    for (let i = 0; i < 12; i++) {
      const word = brain.bridge(a, b, { exclude: [], tier, personality: (i % 6) / 5, rng: createRng(i * 7 + 3) });
      total++;
      if (ok.some((w) => sameWord(w, word))) hits++;
    }
  }
  return hits / total;
}

describe("it says what a person would", () => {
  const rates = Object.fromEntries(TIERS.map((t) => [t, hitRate(t)])) as Record<BotDifficulty, number>;

  it("accepts most of a sharp bot's answers, and more than a casual one's", () => {
    expect(rates.sharp, JSON.stringify(rates)).toBeGreaterThan(0.55);
    expect(rates.steady, JSON.stringify(rates)).toBeGreaterThan(0.4);
    expect(rates.sharp).toBeGreaterThan(rates.steady);
    expect(rates.steady).toBeGreaterThan(rates.casual);
  });

  it("gives some answer a person would accept for at least seven in ten prompts, even for a steady bot", () => {
    let covered = 0;
    for (const [a, b, ok] of PANEL) {
      const draws = Array.from({ length: 24 }, (_, i) =>
        brain.bridge(a, b, { exclude: [], tier: "steady", personality: (i % 6) / 5, rng: createRng(i + 1) }),
      );
      if (draws.some((w) => ok.some((o) => sameWord(o, w)))) covered++;
    }
    expect(covered / PANEL.length, `${covered}/${PANEL.length}`).toBeGreaterThanOrEqual(0.7);
  });
});

/**
 * What a person would say, as a distribution over the panel's answers: the
 * list is written most-likely first, so the chance of the i-th is 1/(i+1),
 * normalised. A MODEL — the panel's order is this repo's own judgement, not
 * measured people — so it supports comparisons (does this change help?) and
 * not absolute claims about how often a real partner will be met.
 */
function personSays(ok: readonly string[], word: string): number {
  const total = ok.reduce((t, _, i) => t + 1 / (i + 1), 0);
  const i = ok.findIndex((w) => sameWord(w, word));
  return i < 0 ? 0 : 1 / (i + 1) / total;
}

describe("a bot with a person for a partner", () => {
  /** Mean chance, over the panel, that the bot's word is the one a modelled person writes. */
  function meets(tier: BotDifficulty, partner: "human" | "bot"): number {
    let sum = 0;
    let n = 0;
    for (const [a, b, ok] of PANEL) {
      for (let k = 0; k < 24; k++) {
        const word = brain.bridge(a, b, {
          exclude: [],
          tier,
          personality: (k % 6) / 5,
          rng: createRng(k * 11 + 5),
          partner,
          misses: k % 4,
        });
        sum += personSays(ok, word);
        n++;
      }
    }
    return sum / n;
  }
  const bot = Object.fromEntries(TIERS.map((t) => [t, meets(t, "bot")])) as Record<BotDifficulty, number>;
  const person = Object.fromEntries(TIERS.map((t) => [t, meets(t, "human")])) as Record<BotDifficulty, number>;

  it("is met more often than the loose draw that keeps two bots apart, at every tier", () => {
    // Recorded before the change (partner "bot", which is unchanged): casual
    // 0.066, steady 0.168, sharp 0.234.
    for (const tier of TIERS) {
      expect(person[tier], `${tier}: ${JSON.stringify({ bot, person })}`).toBeGreaterThan(bot[tier] * 1.1);
    }
    expect(person.casual).toBeGreaterThan(bot.casual * 1.8);
    expect(person.steady).toBeGreaterThan(0.2);
  });

  it("is still a better partner the higher the tier", () => {
    expect(person.casual, JSON.stringify(person)).toBeLessThan(person.steady);
    expect(person.steady).toBeLessThanOrEqual(person.sharp + 0.02);
    expect(person.sharp).toBeGreaterThan(person.casual * 1.5);
  });

  it("does not ask a person to guess an obscure word it only knows from vectors", () => {
    // Words people say (the hand-written associations) are exempt: a frequency
    // order trained on news calls "sandwich" and "witch" rare, and people do
    // not. It is the vector-only picks — "palm" for beach — this holds back.
    const vocab = JSON.parse(vocabJson) as string[];
    let obscure = 0;
    let n = 0;
    for (const [a, b] of PANEL) {
      const said = new Set([...associationsOf(a), ...associationsOf(b)]);
      for (let k = 0; k < 10; k++) {
        const w = brain.bridge(a, b, { exclude: [], tier: "steady", personality: (k % 5) / 4, rng: createRng(k), partner: "human" });
        n++;
        if (!said.has(w) && vocab.indexOf(w) > 8000) obscure++;
      }
    }
    expect(obscure, `${obscure}/${n}`).toBe(0);
  });

  it("still never repeats a word, says an input, or contains one", () => {
    const said = ["summer", "sand", "ocean"];
    for (let i = 0; i < 40; i++) {
      const w = brain.bridge("beach", "sun", { exclude: said, tier: TIERS[i % 3]!, personality: (i % 5) / 4, rng: createRng(i), partner: "human" });
      expect(said.some((x) => sameWord(x, w)), w).toBe(false);
      for (const input of ["beach", "sun"]) {
        expect(sameWord(w, input), w).toBe(false);
        expect(w.includes(input), w).toBe(false);
      }
    }
  });

  it("can say a real word that is merely inside an input: ball for football", () => {
    // Reachable, not necessarily preferred ("play" and "team" bridge the two
    // better): keep excluding what it prefers until it has nothing better.
    const exclude: string[] = [];
    for (let i = 0; i < 60; i++) {
      const w = brain.bridge("football", "game", { exclude, tier: "sharp", personality: 0.5, rng: createRng(i), partner: "human" });
      if (w === "ball") return;
      exclude.push(w);
    }
    expect.fail(`never said "ball"; said ${exclude.join(", ")}`);
  });

  it("does not start afresh on a word whose base form was just said", () => {
    for (let i = 0; i < 120; i++) expect(brain.starter(createRng(i), ["stars"])).not.toBe("star");
  });
});

describe("a pair of bots takes about as long to meet as a pair of people", () => {
  /** Tries two bots of one tier take to say the same word, from a free start. */
  function tries(tier: BotDifficulty, seed: number, cap = 10): number {
    const rng = createRng(seed);
    const chain: string[] = [];
    for (let t = 1; t <= cap; t++) {
      const two = chain.length >= 2 ? ([chain[chain.length - 2]!, chain[chain.length - 1]!] as const) : null;
      const say = (personality: number) =>
        two ? brain.bridge(two[0], two[1], { exclude: chain, tier, personality, rng }) : brain.starter(rng, chain);
      const a = say(0.1 + (seed % 5) * 0.1);
      const b = say(0.7 - (seed % 3) * 0.1);
      if (sameWord(a, b)) return t;
      chain.push(a, b);
    }
    return cap + 1;
  }

  const results = Object.fromEntries(
    TIERS.map((tier) => {
      const all = Array.from({ length: 150 }, (_, i) => tries(tier, i + 1)).sort((x, y) => x - y);
      return [tier, { median: all[75]!, stuck: all.filter((n) => n > 10).length / all.length }];
    }),
  ) as Record<BotDifficulty, { median: number; stuck: number }>;

  it("meets faster the better the bot, and never on the second try every time", () => {
    expect(results.sharp.median, JSON.stringify(results)).toBeGreaterThanOrEqual(3);
    expect(results.sharp.median).toBeLessThanOrEqual(5);
    expect(results.steady.median).toBeGreaterThanOrEqual(results.sharp.median);
    expect(results.casual.median).toBeGreaterThan(results.sharp.median);
    expect(results.casual.median).toBeGreaterThanOrEqual(6);
  });

  it("leaves few rounds with no meld for a good partner, and not most of them for a poor one", () => {
    expect(results.sharp.stuck, JSON.stringify(results)).toBeLessThan(0.08);
    expect(results.steady.stuck).toBeLessThan(0.2);
    expect(results.casual.stuck).toBeLessThan(0.5);
  });
});

describe("what it will not say", () => {
  it("never repeats a word already said, in any form", () => {
    const said = ["summer", "sand", "ocean", "sea", "vacation"];
    for (let i = 0; i < 40; i++) {
      const w = brain.bridge("beach", "sun", { exclude: said, tier: "sharp", personality: (i % 5) / 4, rng: createRng(i) });
      expect(said.some((s) => sameWord(s, w)), w).toBe(false);
    }
  });

  it("never says one of the two words, a form of one, or a word that merely contains one", () => {
    for (const [a, b] of [["sun", "beach"], ["rain", "umbrella"], ["fish", "water"], ["dog", "cat"]] as const) {
      for (let i = 0; i < 30; i++) {
        const w = brain.bridge(a, b, { exclude: [], tier: TIERS[i % 3]!, personality: (i % 5) / 4, rng: createRng(i) });
        for (const input of [a, b]) {
          expect(sameWord(w, input), `${w} for ${a}+${b}`).toBe(false);
          expect(w.includes(input) || input.includes(w), `${w} contains ${input}`).toBe(false);
        }
      }
    }
  });

  it("is deterministic given the same draw", () => {
    const one = brain.bridge("beach", "sun", { exclude: [], tier: "steady", personality: 0.4, rng: createRng(9) });
    const two = brain.bridge("beach", "sun", { exclude: [], tier: "steady", personality: 0.4, rng: createRng(9) });
    expect(one).toBe(two);
  });

  it("copes with a word it has never heard: it answers from the other, or starts afresh", () => {
    const w = brain.bridge("zzyzx", "beach", { exclude: [], tier: "steady", personality: 0.5, rng: createRng(1) });
    expect(w.length).toBeGreaterThan(1);
    const v = brain.bridge("zzyzx", "qqqqq", { exclude: [], tier: "steady", personality: 0.5, rng: createRng(1) });
    expect(v.length).toBeGreaterThan(1);
  });
});

describe("the shipped data", () => {
  const vocab = JSON.parse(vocabJson) as string[];

  it("is the size the build script says, and small enough to ship", () => {
    // 15,000 common words, less the few Numberbatch does not know.
    expect(vocab.length).toBeGreaterThan(14_900);
    expect(brain.dim).toBe(300);
    expect(vectors.length).toBe(vocab.length * brain.dim);
    // Solo Mind Meld fetches these before its first deal.
    expect(vectors.length + vocabJson.length).toBeLessThan(5 * 1024 * 1024);
  });

  it("is lowercase words of three to fourteen letters, with no duplicates", () => {
    expect(vocab.every((w) => /^[a-z]{3,14}$/.test(w))).toBe(true);
    expect(new Set(vocab).size).toBe(vocab.length);
  });

  it("has nothing rude in it", () => {
    expect(vocab.filter((w) => isProfane(w))).toEqual([]);
  });

  it("refuses vectors that do not match the vocabulary", () => {
    expect(() => vectorBrainFrom(JSON.stringify(["a", "b"]), new Uint8Array(10))).toThrow(/bytes for 2 words/);
  });
});

describe("the stand-in", () => {
  it("answers when the real brain has not loaded, and never repeats", () => {
    const said = ["sand", "sun"];
    for (let i = 0; i < 20; i++) {
      const w = fallbackBrain.bridge("beach", "ocean", { exclude: said, tier: "steady", personality: 0.5, rng: createRng(i) });
      expect(w.length).toBeGreaterThan(1);
      expect(said).not.toContain(w);
    }
    expect(tokens(fallbackBrain.starter(createRng(3))).length).toBe(1);
  });
});
