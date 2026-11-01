/**
 * Deciding whether two words are the same word.
 *
 * This is the heart of Mind Meld, and the user's call (2026-10-24) is a precise
 * one: matching is AUTOMATIC ONLY, and generous about everything a person would
 * call the same word - capitals, accents, plurals, "running" for "run", "ice
 * cream" for "ice-cream", "color" for "colour" - but a typo is a MISS. A friend
 * who cannot spell is the joke, and nothing here may forgive it. `soClose` says
 * a pair was near enough to be funny; it never makes a match.
 *
 * Everything is deterministic and pure, so the same normaliser drives the
 * match, the "already said" check and the bot's exclusions, and the three can
 * never disagree. `words.test.ts` holds a corpus of pairs that must match and
 * pairs that must not, and every change to this file runs against it.
 */

import { adjective, noun, verb } from "wink-lemmatizer";

/** Longest a single entry may be, and most words it may hold. */
export const MAX_LENGTH = 30;
export const MAX_WORDS = 3;

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
];

/** British spellings, to the American a player would be matched against. */
const SPELLING: Readonly<Record<string, string>> = {
  colour: "color",
  colours: "colors",
  coloured: "colored",
  favourite: "favorite",
  favourites: "favorites",
  flavour: "flavor",
  flavours: "flavors",
  honour: "honor",
  humour: "humor",
  labour: "labor",
  neighbour: "neighbor",
  neighbours: "neighbors",
  neighbourhood: "neighborhood",
  behaviour: "behavior",
  harbour: "harbor",
  rumour: "rumor",
  savour: "savor",
  vapour: "vapor",
  odour: "odor",
  armour: "armor",
  glamour: "glamor",
  parlour: "parlor",
  tumour: "tumor",
  grey: "gray",
  greys: "grays",
  theatre: "theater",
  theatres: "theaters",
  centre: "center",
  centres: "centers",
  metre: "meter",
  metres: "meters",
  litre: "liter",
  litres: "liters",
  fibre: "fiber",
  calibre: "caliber",
  sabre: "saber",
  spectre: "specter",
  lustre: "luster",
  maneuvre: "maneuver",
  organise: "organize",
  organised: "organized",
  organising: "organizing",
  realise: "realize",
  realised: "realized",
  recognise: "recognize",
  recognised: "recognized",
  apologise: "apologize",
  apologised: "apologized",
  criticise: "criticize",
  criticised: "criticized",
  emphasise: "emphasize",
  analyse: "analyze",
  analysed: "analyzed",
  paralyse: "paralyze",
  civilisation: "civilization",
  organisation: "organization",
  realisation: "realization",
  defence: "defense",
  offence: "offense",
  licence: "license",
  pretence: "pretense",
  practise: "practice",
  catalogue: "catalog",
  dialogue: "dialog",
  analogue: "analog",
  programme: "program",
  programmes: "programs",
  cheque: "check",
  cheques: "checks",
  tyre: "tire",
  tyres: "tires",
  kerb: "curb",
  plough: "plow",
  ploughs: "plows",
  jewellery: "jewelry",
  jewelry: "jewelry",
  moustache: "mustache",
  pyjamas: "pajamas",
  aluminium: "aluminum",
  mum: "mom",
  mummy: "mommy",
  mould: "mold",
  smoulder: "smolder",
  sceptic: "skeptic",
  sulphur: "sulfur",
  draught: "draft",
  storey: "story",
  gaol: "jail",
  arse: "ass",
  cosy: "cozy",
  doughnut: "donut",
  donut: "donut",
  towards: "toward",
  whilst: "while",
  amongst: "among",
  learnt: "learned",
  spelt: "spelled",
  burnt: "burned",
  dreamt: "dreamed",
  leapt: "leaped",
  spilt: "spilled",
  smelt: "smelled",
  sundae: "sundae",
};

/**
 * Irregular verb forms that are ALSO common nouns. `wink-lemmatizer` takes
 * "rose" to "rise" and "ground" to "grind", which would make a flower match a
 * verb. Words here keep their own noun reading and are never taken to a verb.
 */
const HOMOGRAPHS: ReadonlySet<string> = new Set([
  // A past tense that is also a common noun.
  "rose",
  "saw",
  "ground",
  "left",
  "wound",
  "bore",
  "felt",
  "fell",
  "bit",
  "bound",
  "spoke",
  "shed",
  "fit",
  "lay",
  "shot",
  "bent",
  "rung",
  "wove",
  // A plural or third person that is also a different noun.
  "leaves",
  "lives",
  "ties",
  "dies",
  "dice",
  "axes",
  "saws",
  "does",
  "tears",
  "lies",
  // A base form with a different verb of its own.
  "lead",
  "read",
  "dove",
  "mean",
  "means",
  "bear",
  "tear",
  "lie",
  "doe",
]);

/** Words whose plural is irregular and that the lemmatiser may get wrong. */
const IRREGULAR_NOUNS: Readonly<Record<string, string>> = {
  feet: "foot",
  teeth: "tooth",
  mice: "mouse",
  geese: "goose",
  men: "man",
  women: "woman",
  children: "child",
  people: "person",
  oxen: "ox",
  lice: "louse",
  dice: "die",
  leaves: "leaf",
  lives: "life",
  knives: "knife",
  wives: "wife",
  wolves: "wolf",
  halves: "half",
  shelves: "shelf",
  thieves: "thief",
  loaves: "loaf",
  calves: "calf",
  selves: "self",
  elves: "elf",
  scarves: "scarf",
  hooves: "hoof",
  potatoes: "potato",
  tomatoes: "tomato",
  heroes: "hero",
  echoes: "echo",
  cacti: "cactus",
  fungi: "fungus",
  nuclei: "nucleus",
  stimuli: "stimulus",
  syllabi: "syllabus",
  alumni: "alumnus",
  radii: "radius",
  criteria: "criterion",
  phenomena: "phenomenon",
  bacteria: "bacterium",
  data: "datum",
  media: "medium",
  crises: "crisis",
  analyses: "analysis",
  theses: "thesis",
  hypotheses: "hypothesis",
  diagnoses: "diagnosis",
  oases: "oasis",
  parentheses: "parenthesis",
  appendices: "appendix",
  indices: "index",
  vertices: "vertex",
  matrices: "matrix",
  sheep: "sheep",
  fish: "fish",
  deer: "deer",
  moose: "moose",
  series: "series",
  species: "species",
  aircraft: "aircraft",
  offspring: "offspring",
};

/** The text of an entry with everything a person would not call a difference removed. */
function fold(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/'s\b/g, "s")
    .replace(/'/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** "2" is "two": a player who types a digit and one who spells it are the same. */
function spellNumber(token: string): string {
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    if (n >= 0 && n < NUMBER_WORDS.length) return NUMBER_WORDS[n]!;
  }
  return token;
}

const ARTICLES = new Set(["a", "an", "the"]);

/**
 * The words of an entry, each folded and put in American spelling, with a
 * leading article dropped from a phrase ("the beach" is "beach").
 */
export function tokens(raw: string): string[] {
  let parts = fold(raw).split(" ").filter(Boolean);
  if (parts.length > 1 && ARTICLES.has(parts[0]!)) parts = parts.slice(1);
  return parts.map((t) => SPELLING[spellNumber(t)] ?? spellNumber(t));
}

/** The entry as one normalised string, words joined by a single space. */
export function normalize(raw: string): string {
  return tokens(raw).join(" ");
}

/**
 * Every base form a single word might be taken for: itself, and what the
 * lemmatiser makes of it as a noun, a verb and an adjective. An entry has no
 * part of speech, so all three are tried, and two words are the same word when
 * they share a base form.
 */
export function lemmas(token: string): Set<string> {
  const out = new Set<string>([token]);
  const irregular = IRREGULAR_NOUNS[token];
  if (irregular) out.add(irregular);
  const n = noun(token);
  out.add(n);
  // An irregular verb form that is also a common noun keeps its noun reading:
  // a rose is not a rising.
  if (!HOMOGRAPHS.has(token)) {
    out.add(verb(token));
    out.add(adjective(token));
  } else {
    // A regular inflection of a homograph still counts ("roses" is "rose").
    out.add(n);
  }
  return out;
}

/** The entry with its spaces taken out: "ice cream" and "icecream" are one word. */
function joined(parts: readonly string[]): string {
  return parts.join("");
}

/**
 * Are these two entries the same word?
 *
 * Yes for capitals, accents, punctuation, a leading article, plural and tense,
 * British and American spelling, a digit and its word, and a compound written
 * apart or together. No for a typo, a synonym, or a different word that merely
 * sounds alike - those are exactly the misses that make the game.
 */
export function sameWord(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  if (joined(ta) === joined(tb)) return true;

  // A compound is matched word by word when they split the same way, and as a
  // single joined word otherwise ("ice cream" against "icecreams").
  if (ta.length === tb.length) {
    if (ta.every((t, i) => share(lemmas(t), lemmas(tb[i]!)))) return true;
  }
  // The last word carries the inflection, so the front of a compound is joined
  // and the last is lemmatised.
  const headA = ta[ta.length - 1]!;
  const headB = tb[tb.length - 1]!;
  const frontA = joined(ta.slice(0, -1));
  const frontB = joined(tb.slice(0, -1));
  const wholeA = frontA + headA;
  const wholeB = frontB + headB;
  if (wholeA === wholeB) return true;
  for (const la of lemmas(headA)) {
    for (const lb of lemmas(headB)) {
      if (frontA + la === frontB + lb) return true;
    }
  }
  return false;
}

function share(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/** Is `word` the same word as any of these? */
export function sameAsAny(word: string, others: Iterable<string>): boolean {
  for (const other of others) if (sameWord(word, other)) return true;
  return false;
}

/**
 * Damerau-Levenshtein distance: insertions, deletions, substitutions and the
 * swap of two neighbouring letters, which is what a fast typist does.
 */
export function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => {
    const row = new Array<number>(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j++) d[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      }
    }
  }
  return d[rows - 1]![cols - 1]!;
}

/**
 * Were these two almost the same word - a letter out, a pair swapped - without
 * being the same word? That is the moment a table groans, and all it earns is a
 * flourish: it is NEVER a match.
 *
 * Short words are left alone ("cat" and "car" are different words, not a typo),
 * and the tolerance grows with the length.
 */
export function soClose(a: string, b: string): boolean {
  if (sameWord(a, b)) return false;
  const x = joined(tokens(a));
  const y = joined(tokens(b));
  if (x.length < 4 || y.length < 4) return false;
  const limit = Math.min(x.length, y.length) >= 9 ? 2 : 1;
  return distance(x, y) <= limit;
}

/** Why an entry may not be locked in, or null when it may. */
export function refusal(raw: string): string | null {
  if (typeof raw !== "string") return "Type a word";
  const text = raw.trim();
  if (text.length === 0) return "Type a word";
  if (text.length > MAX_LENGTH) return `That is too long - ${MAX_LENGTH} letters at most`;
  const parts = tokens(text);
  if (parts.length === 0) return "Use letters or numbers";
  if (parts.length > MAX_WORDS) return `${MAX_WORDS} words at most`;
  return null;
}
