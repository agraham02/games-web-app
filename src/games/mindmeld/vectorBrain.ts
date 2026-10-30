/**
 * A bot's brain made of word vectors, steered by what people actually say.
 *
 * Each word is a point in a 300-dimensional space where related words sit close
 * together (ConceptNet Numberbatch, trimmed to the commonest 15,000 words and
 * kept as signed bytes: `scripts/build-mindmeld-numberbatch.ts`; CC BY-SA 4.0,
 * credited in `ui/primitives/Credit.tsx`). A word that connects "beach"
 * and "sun" is one near both, so the bridge is the vocabulary word closest to
 * the two - scored on the nearer AND the farther of them, because the average
 * alone drifts towards one input - and nudged towards COMMON words, because the
 * game is two minds landing on the same word and people land on common ones.
 *
 * It used to be GloVe, which knows only which words appear near each other in
 * news: it offered "palm" and "phoenix" for beach and sun, and "cowboy" for
 * wizard and hat. Numberbatch is built from what people say things are related
 * to, and says "sand" and "wand" instead (2026-10-30). Relatedness is still not
 * quite what a person blurts out, so the hand-written free associations
 * (`associations.ts`) are blended in: a word a person would say for
 * either input gets a bonus, and one they would say for both gets two.
 *
 * What separates the tiers is how many of the best bridges a bot considers and
 * how much it trusts what people say: casual draws from a wide shortlist and
 * rarely says what its partner does, sharp from the top few. Per-seat
 * temperament shifts how adventurous the draw is, because two bots in one pair
 * given the same words must not always choose the same one - that would be a
 * meld every time and no game.
 *
 * Pure and synchronous, like everything the engine touches; `vectorBrainFrom` is
 * the only part that reads what the build script wrote.
 */

import type { Rng } from "@/engine/rng";
import type { BotDifficulty } from "@/engine/types";
import { associationsOf } from "./associations";
import { STARTERS, type BridgeOptions, type WordBrain } from "./brain";
import { lemmas, normalize, tokens } from "./words";

/** The shipped files, versioned so a page with an old brain cached never reads a new one wrongly. */
export const VOCAB_FILE = "vocab-v2.json";
export const VECTORS_FILE = "vectors-v2.bin";

/**
 * How many of the best words a tier will draw its answer from, and how hot the
 * draw is (higher flattens it, so the better words are not always the ones said).
 *
 * Found by measurement, not taste: two bots in a pair see the SAME two words,
 * so a cold draw has them both say "summer" and meld on the second try every
 * time. These numbers make a pair of sharp bots meld in about three tries, steady
 * about four, casual about seven - which is roughly how long two people take -
 * and `brain.test.ts` holds them to it.
 */
const SHORTLIST: Record<BotDifficulty, number> = { casual: 10, steady: 6, sharp: 4 };
const HEAT: Record<BotDifficulty, number> = { casual: 0.32, steady: 0.2, sharp: 0.15 };
/** How strongly commonness counts beside closeness, by tier: sharp leans on it. */
const COMMON: Record<BotDifficulty, number> = { casual: 0.04, steady: 0.08, sharp: 0.14 };
/** How much a word a person would say counts, by tier: sharp says what people say. */
const PEOPLE: Record<BotDifficulty, number> = { casual: 0.12, steady: 0.3, sharp: 0.42 };
/** How much being near the FARTHER word counts beside being near both on average. */
const MIN_WEIGHT = 0.6;
/** What a word with no vector scores on closeness: middling, so the bonus decides it. */
const UNKNOWN = 0.3;

/*
 * Against a PERSON (`BridgeOptions.partner`). A bot is only worth meeting if
 * what it says is what people say, so the draw narrows to the very top, runs
 * cold, and leans harder on what people say; a word BOTH inputs bring to mind
 * is the one most people reach for; and a word far down the frequency order is
 * not asked of anybody. It gets colder still the longer the pair has missed.
 */
const HUMAN_SHORTLIST: Record<BotDifficulty, number> = { casual: 0.8, steady: 0.67, sharp: 0.5 };
const HUMAN_HEAT: Record<BotDifficulty, number> = { casual: 0.8, steady: 0.6, sharp: 0.25 };
const HUMAN_PEOPLE: Record<BotDifficulty, number> = { casual: 1, steady: 1.4, sharp: 1.6 };
const BOTH_BONUS = 0.3;
/** Rank in the frequency order past which a word is obscure, unless a person would say it. */
const FAMILIAR = 8000;

export class VectorBrain implements WordBrain {
  private readonly index = new Map<string, number>();
  /** Numbers per word: whatever the build script wrote (the file is words x dim bytes). */
  readonly dim: number;

  constructor(
    private readonly vocab: readonly string[],
    private readonly vectors: Int8Array,
  ) {
    vocab.forEach((w, i) => this.index.set(w, i));
    this.dim = vocab.length > 0 ? vectors.length / vocab.length : 0;
  }

  get size(): number {
    return this.vocab.length;
  }

  /** The vector for an entry, as one word or a phrase's average; null if nothing in it is known. */
  vectorOf(entry: string): Float32Array | null {
    const sum = new Float32Array(this.dim);
    let found = 0;
    for (const part of tokens(entry)) {
      let i = this.index.get(part);
      if (i === undefined) {
        for (const lemma of lemmas(part)) {
          i = this.index.get(lemma);
          if (i !== undefined) break;
        }
      }
      if (i === undefined) continue;
      for (let d = 0; d < this.dim; d++) sum[d]! += this.vectors[i * this.dim + d]! / 127;
      found++;
    }
    return found > 0 ? sum : null;
  }

  /**
   * How near the word at `i` is to what the targets have in common, plus a
   * little for being common: the average cosine, and the worst, so a word near
   * only one input does not win.
   */
  private closeness(i: number, units: Array<{ t: Float32Array; norm: number }>, common: number): number {
    const base = i * this.dim;
    let sum = 0;
    let worst = Infinity;
    for (const { t, norm } of units) {
      let dot = 0;
      for (let d = 0; d < this.dim; d++) dot += t[d]! * this.vectors[base + d]!;
      // The vectors are unit length scaled by 127, so this is a cosine.
      const cosine = dot / (norm * 127);
      sum += cosine;
      worst = Math.min(worst, cosine);
    }
    // Rank 0 is the commonest word, so commonness falls from 1 to 0 down the list.
    return sum / units.length + MIN_WEIGHT * worst + common * (1 - i / this.vocab.length);
  }

  /** The `limit` closest words, best first, leaving out whatever `skip` refuses. */
  private nearest(units: Array<{ t: Float32Array; norm: number }>, common: number, skip: (w: string) => boolean, limit: number) {
    const best: Array<{ word: string; score: number }> = [];
    let floor = -Infinity;
    for (let i = 0; i < this.vocab.length; i++) {
      const score = this.closeness(i, units, common);
      if (score <= floor && best.length >= limit) continue;
      const word = this.vocab[i]!;
      if (skip(word)) continue;
      best.push({ word, score });
      best.sort((x, y) => y.score - x.score);
      if (best.length > limit) best.pop();
      floor = best[best.length - 1]!.score;
    }
    return best;
  }

  /** A form of a word whose base form is in the vocabulary too: "winds" when "wind" is there. */
  private isInflection(word: string): boolean {
    for (const l of lemmas(word)) if (l !== word && this.index.has(l)) return true;
    return false;
  }

  bridge(a: string, b: string, { exclude, tier, personality, rng, partner = "bot", misses = 0 }: BridgeOptions): string {
    const human = partner === "human";
    const targets = [this.vectorOf(a), this.vectorOf(b)].filter((v): v is Float32Array => v !== null);

    // What people say for either input, best first: a bonus that fades down the list.
    const said = new Map<string, number>();
    const brought = new Map<string, number>();
    for (const entry of [a, b]) {
      const list = associationsOf(normalize(entry));
      const weight = PEOPLE[tier] * (human ? HUMAN_PEOPLE[tier] : 1);
      list.forEach((w, i) => {
        said.set(w, (said.get(w) ?? 0) + weight * (1 - (0.5 * i) / Math.max(1, list.length)));
        brought.set(w, (brought.get(w) ?? 0) + 1);
      });
    }
    if (human) for (const [w, n] of brought) if (n > 1) said.set(w, said.get(w)! + BOTH_BONUS);
    if (targets.length === 0 && said.size === 0) return this.starter(rng, exclude);

    // Never an answer already said, a form of one of the two words, a longer
    // word that merely contains one ("sunflower" for "sun"), or a plural or
    // tense of a word that is itself on offer.
    const blocked = new Set<string>();
    for (const e of [...exclude, a, b]) for (const t of tokens(e)) for (const l of lemmas(t)) blocked.add(l);
    // A word that CONTAINS an input ("sunflower" for "sun"), or a mere
    // fragment of one ("ate" in "water"). A real word inside a compound is
    // fine: this used to refuse "ball" for "football", the answer a person
    // gives, because "football" contains "ball".
    const containsInput = (word: string) =>
      [a, b].some((e) =>
        tokens(e).some((t) => t.length >= 3 && ((word !== t && word.includes(t)) || (word.length <= 3 && t.includes(word)))),
      );
    const obscure = (word: string) => human && !said.has(word) && (this.index.get(word) ?? 0) > FAMILIAR;
    const skip = (word: string) => blocked.has(word) || containsInput(word) || this.isInflection(word) || obscure(word);

    const shortlist = human ? Math.max(2, Math.round(SHORTLIST[tier] * HUMAN_SHORTLIST[tier])) : SHORTLIST[tier];
    const units = targets.map((t) => {
      let norm = 0;
      for (let d = 0; d < this.dim; d++) norm += t[d]! * t[d]!;
      return { t, norm: Math.sqrt(norm) || 1 };
    });

    const pool = new Map<string, number>();
    if (units.length > 0) {
      // Wider than the shortlist: a word people say may sit below the closest few.
      for (const { word, score } of this.nearest(units, COMMON[tier], skip, shortlist * 3)) pool.set(word, score);
    }
    // Every word a person would say, whether or not it has a vector.
    for (const word of said.keys()) {
      if (skip(word) || pool.has(word)) continue;
      const i = this.index.get(word);
      pool.set(word, i !== undefined && units.length > 0 ? this.closeness(i, units, COMMON[tier]) : UNKNOWN);
    }

    const ranked = [...pool.entries()]
      .map(([word, score]) => ({ word, score: score + (said.get(word) ?? 0) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, shortlist);
    if (ranked.length === 0) return this.starter(rng, exclude);
    const heat = HEAT[tier] * (0.6 + 0.8 * personality) * (human ? HUMAN_HEAT[tier] * Math.max(0.5, 1 - 0.1 * misses) : 1);
    return pickFrom(ranked, heat, rng);
  }

  starter(rng: Rng, exclude: readonly string[] = []): string {
    // By base form too: after "stars", "star" is not a fresh start.
    const used = new Set(exclude.flatMap((e) => tokens(e).flatMap((t) => [t, ...lemmas(t)])));
    const pool = STARTERS.filter((w) => !used.has(w) && ![...lemmas(w)].some((l) => used.has(l)));
    return pool[rng.int(pool.length)] ?? "thing";
  }
}

/** A weighted draw from a shortlist, better words likelier; `heat` flattens it. */
function pickFrom(shortlist: ReadonlyArray<{ word: string; score: number }>, heat: number, rng: Rng): string {
  const top = shortlist[0]!.score;
  const weights = shortlist.map((s) => Math.exp((s.score - top) / heat));
  const total = weights.reduce((x, y) => x + y, 0);
  let roll = rng.next() * total;
  for (let i = 0; i < shortlist.length; i++) {
    roll -= weights[i]!;
    if (roll <= 0) return shortlist[i]!.word;
  }
  return shortlist[0]!.word;
}

/** Builds a brain from the two files the build script writes. */
export function vectorBrainFrom(vocabJson: string, vectors: ArrayBuffer | Uint8Array): VectorBrain {
  const vocab = JSON.parse(vocabJson) as string[];
  const bytes = vectors instanceof Uint8Array ? vectors : new Uint8Array(vectors);
  const signed = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (vocab.length === 0 || signed.length % vocab.length !== 0 || signed.length / vocab.length < 16) {
    throw new Error(`vectors are ${signed.length} bytes for ${vocab.length} words`);
  }
  return new VectorBrain(vocab, signed);
}
