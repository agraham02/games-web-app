/**
 * SUPERSEDED for the vectors by `build-mindmeld-numberbatch.ts` (2026-10-30).
 * Kept because its filters made the VOCABULARY — and its frequency order — that
 * the Numberbatch build still uses (`vocab-v2.json`). Its own output (`-v1`
 * files) is no longer shipped.
 *
 * Builds Mind Meld's word vectors: `npx tsx scripts/build-mindmeld-words.ts <glove.gz>`.
 *
 * Run by hand, with the output committed (`public/mindmeld/`). Nothing here is
 * part of the app: the app ships a ~2 MB file, not the 134 MB it was cut from.
 *
 * Input: GloVe 6B (Pennington, Socher, Manning; public domain, PDDL), the 100
 * dimension set as `glove-wiki-gigaword-100.gz` from gensim-data. GloVe lists
 * its words most frequent first, which is the one ordering this needs.
 *
 * What is kept, and why each filter is there:
 *  - 3 to 14 lowercase letters only: no numbers, no punctuation, no tokens;
 *  - a word in a real English dictionary (SCOWL, via `wordlist-english`, common
 *    levels only): GloVe is full of names, places and typos that make poor
 *    answers, and a dictionary is the cheapest way to leave them out;
 *  - not a function word: "the" is no-one's bridge between two ideas;
 *  - not rude (`obscenity`): a family game, and a bot must never say one;
 *  - the first `KEEP` that survive, in frequency order, because people meet on
 *    common words, and the bot ranks by frequency as well as by closeness.
 *
 * Output: `vectors-v1.bin` (KEEP x 100 signed bytes, each vector made unit length
 * after the mean of the kept set is taken out) and `vocab-v1.json` (the words, in
 * the same order). The mean is removed because raw GloVe vectors all lean the same
 * way, which makes every word look a little like every other.
 */

import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import wordListEnglish from "wordlist-english";
import { isProfane } from "../src/games/mindmeld/profanity";

const GLOVE = process.argv[2];
if (!GLOVE) throw new Error("usage: build-mindmeld-words.ts <glove-wiki-gigaword-100.gz>");

const OUT = new URL("../public/mindmeld/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DIM = 100;
const KEEP = 15_000;
/** How far down GloVe's frequency order to look before stopping. */
const LOOK = 90_000;

const STOP = new Set(
  (
    "the and for are but not you all any can had her was one our out day get has him his how man new now old see two way " +
    "who boy did its let put say she too use that this with have from they will been were what when your said each which " +
    "their time there about would these other into more than them then some could make like him just over also back only " +
    "come its well even very after most such here those while where being because before between both during each few " +
    "since through under until upon within without again against among around away often once ever never always still " +
    "much many may might must shall should whom whose whose does done doing going gone got having let lets yet nor off " +
    "own same than too via per etc whether either neither another anything everything something nothing anyone someone " +
    "everyone somebody nobody everybody itself himself herself themselves myself yourself ourselves"
  ).split(" "),
);

/** Common levels of the dictionary: ordinary words, not archaisms and rarities. */
function dictionary(): Set<string> {
  const lists = ["10", "20", "35", "40", "50"];
  const out = new Set<string>();
  for (const level of lists) {
    for (const key of [`english/${level}`, `english/american/${level}`]) {
      for (const w of (wordListEnglish as Record<string, string[]>)[key] ?? []) out.add(w.toLowerCase());
    }
  }
  return out;
}

async function main() {
  const dict = dictionary();
  const words: string[] = [];
  const vectors: number[][] = [];

  const lines = createInterface({ input: createReadStream(GLOVE).pipe(createGunzip()), crlfDelay: Infinity });
  let seen = 0;
  for await (const line of lines) {
    if (++seen > LOOK || words.length >= KEEP) break;
    const space = line.indexOf(" ");
    const word = line.slice(0, space);
    if (!/^[a-z]{3,14}$/.test(word) || STOP.has(word) || !dict.has(word) || isProfane(word)) continue;
    const parts = line.slice(space + 1).split(" ").map(Number);
    if (parts.length !== DIM || parts.some((x) => !Number.isFinite(x))) continue;
    words.push(word);
    vectors.push(parts);
  }

  // Take the mean of the kept set out of every vector, then make each unit length.
  const mean = new Array<number>(DIM).fill(0);
  for (const v of vectors) for (let i = 0; i < DIM; i++) mean[i]! += v[i]! / vectors.length;
  const bytes = new Int8Array(words.length * DIM);
  vectors.forEach((v, n) => {
    const centred = v.map((x, i) => x - mean[i]!);
    const length = Math.hypot(...centred) || 1;
    for (let i = 0; i < DIM; i++) bytes[n * DIM + i] = Math.round((centred[i]! / length) * 127);
  });

  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}vectors-v1.bin`, bytes);
  writeFileSync(`${OUT}vocab-v1.json`, JSON.stringify(words));
  console.log(`kept ${words.length} of the first ${seen} words -> ${(bytes.length / 1024).toFixed(0)} KB of vectors`);
  console.log(`first: ${words.slice(0, 12).join(", ")}   last: ${words.slice(-6).join(", ")}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
