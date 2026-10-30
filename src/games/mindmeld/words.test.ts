import { describe, expect, it } from "vitest";
import { distance, normalize, refusal, sameAsAny, sameWord, soClose, tokens } from "./words";

/**
 * The corpus IS the specification. Every pair below is a call somebody made
 * about what a person would say is "the same word", and every change to
 * `words.ts` runs against all of them. The "must not" list matters as much as
 * the other: a matcher that forgives too much ends the game on a synonym, and
 * the user's whole point (2026-10-24) is that a typo is a miss.
 */

const MATCH: ReadonlyArray<readonly [string, string]> = [
  // Capitals, spacing, punctuation.
  ["Dog", "dog"],
  ["DOG", "dog"],
  ["  dog  ", "dog"],
  ["dog.", "dog"],
  ["dog!", "dog"],
  ["\"dog\"", "dog"],
  ["Ice Cream", "ice cream"],
  ["ice   cream", "ice cream"],
  // Accents.
  ["café", "cafe"],
  ["Café", "cafe"],
  ["naïve", "naive"],
  ["jalapeño", "jalapeno"],
  ["résumé", "resume"],
  ["piñata", "pinata"],
  ["crème brûlée", "creme brulee"],
  // Plurals.
  ["dogs", "dog"],
  ["cats", "cat"],
  ["boxes", "box"],
  ["buses", "bus"],
  ["berries", "berry"],
  ["cities", "city"],
  ["babies", "baby"],
  ["wishes", "wish"],
  ["churches", "church"],
  ["potatoes", "potato"],
  ["tomatoes", "tomato"],
  ["heroes", "hero"],
  ["mice", "mouse"],
  ["geese", "goose"],
  ["feet", "foot"],
  ["teeth", "tooth"],
  ["men", "man"],
  ["women", "woman"],
  ["children", "child"],
  ["people", "person"],
  ["knives", "knife"],
  ["wolves", "wolf"],
  ["leaves", "leaf"],
  ["shelves", "shelf"],
  ["cacti", "cactus"],
  ["fungi", "fungus"],
  ["analyses", "analysis"],
  ["criteria", "criterion"],
  ["sheep", "sheep"],
  ["fish", "fish"],
  ["deer", "deer"],
  // Possessives.
  ["dog's", "dog"],
  ["dog’s", "dog"],
  ["dogs'", "dog"],
  ["Mom's", "mom"],
  // Tense and -ing.
  ["running", "run"],
  ["ran", "run"],
  ["runs", "run"],
  ["swimming", "swim"],
  ["swam", "swim"],
  ["jumped", "jump"],
  ["jumping", "jump"],
  ["jumps", "jump"],
  ["danced", "dance"],
  ["dancing", "dance"],
  ["stopped", "stop"],
  ["stopping", "stop"],
  ["cried", "cry"],
  ["flies", "fly"],
  ["flew", "fly"],
  ["flown", "fly"],
  ["went", "go"],
  ["gone", "go"],
  ["eating", "eat"],
  ["ate", "eat"],
  ["eaten", "eat"],
  ["sleeping", "sleep"],
  ["slept", "sleep"],
  ["thought", "think"],
  ["bought", "buy"],
  ["brought", "bring"],
  ["caught", "catch"],
  ["taught", "teach"],
  ["wrote", "write"],
  ["written", "write"],
  ["drove", "drive"],
  ["driven", "drive"],
  ["sang", "sing"],
  ["sung", "sing"],
  ["swept", "sweep"],
  ["built", "build"],
  // Comparatives.
  ["bigger", "big"],
  ["biggest", "big"],
  ["happier", "happy"],
  ["happiest", "happy"],
  ["better", "good"],
  ["best", "good"],
  ["worse", "bad"],
  // Compounds, apart and together and hyphenated.
  ["ice-cream", "ice cream"],
  ["ice-cream", "icecream"],
  ["ice cream", "icecream"],
  ["icecreams", "ice cream"],
  ["hot dog", "hotdog"],
  ["hot-dog", "hot dog"],
  ["pop corn", "popcorn"],
  ["butter fly", "butterfly"],
  ["sea shell", "seashell"],
  ["fire fly", "firefly"],
  ["fireflies", "fire fly"],
  ["post card", "postcard"],
  ["birth day", "birthday"],
  ["birthdays", "birthday"],
  ["birth-day", "birthday"],
  ["T-shirt", "tshirt"],
  ["t shirt", "t-shirt"],
  ["Mother-in-law", "mother in law"],
  // Articles.
  ["the beach", "beach"],
  ["a dog", "dog"],
  ["an apple", "apple"],
  ["The Beach", "beach"],
  ["the ice cream", "ice cream"],
  // Numbers.
  ["2", "two"],
  ["10", "ten"],
  ["0", "zero"],
  ["7", "seven"],
  ["20", "twenty"],
  ["two", "2"],
  // Spelling.
  ["colour", "color"],
  ["colours", "color"],
  ["coloured", "colored"],
  ["grey", "gray"],
  ["theatre", "theater"],
  ["centre", "center"],
  ["favourite", "favorite"],
  ["neighbour", "neighbor"],
  ["flavour", "flavor"],
  ["honour", "honor"],
  ["jewellery", "jewelry"],
  ["tyre", "tire"],
  ["pyjamas", "pajamas"],
  ["mum", "mom"],
  ["organise", "organize"],
  ["realise", "realize"],
  ["catalogue", "catalog"],
  ["programme", "program"],
  ["cheque", "check"],
  ["litre", "liter"],
  ["metre", "meter"],
  ["fibre", "fiber"],
  ["mould", "mold"],
  ["plough", "plow"],
  ["kerb", "curb"],
  ["learnt", "learned"],
  ["towards", "toward"],
  // Combinations.
  ["The COLOURS", "color"],
  ["Café-au-lait", "cafe au lait"],
  ["running shoes", "run shoe"],
  ["Hot Dogs", "hotdog"],
  ["  The   Greys ", "gray"],
];

const NO_MATCH: ReadonlyArray<readonly [string, string]> = [
  // Different words, one letter apart - the typos that must stay misses.
  ["cat", "car"],
  ["cat", "cut"],
  ["dog", "dig"],
  ["dog", "log"],
  ["bat", "bag"],
  ["hat", "hot"],
  ["pen", "pan"],
  ["bed", "bad"],
  ["sun", "son"],
  ["beach", "bench"],
  ["house", "horse"],
  ["mouse", "moose"],
  ["bear", "beer"],
  ["tree", "three"],
  ["night", "light"],
  // Homophones.
  ["read", "red"],
  ["ant", "aunt"],
  ["plane", "plain"],
  ["right", "write"],
  ["sea", "see"],
  ["bare", "bear"],
  ["flower", "flour"],
  ["knight", "night"],
  ["whole", "hole"],
  ["son", "sun"],
  ["tail", "tale"],
  ["pair", "pear"],
  ["steal", "steel"],
  ["wait", "weight"],
  // Typos - a letter dropped, doubled, swapped, or wrong.
  ["recieve", "receive"],
  ["definately", "definitely"],
  ["seperate", "separate"],
  ["beleive", "believe"],
  ["wierd", "weird"],
  ["freind", "friend"],
  ["tomorow", "tomorrow"],
  ["elephnt", "elephant"],
  ["banana", "bananna"],
  ["dolphin", "dolphine"],
  ["pizza", "pitza"],
  ["chocolate", "choclate"],
  ["restaurant", "restraunt"],
  ["umbrella", "umbrela"],
  // Synonyms and relatives.
  ["happy", "glad"],
  ["big", "large"],
  ["small", "tiny"],
  ["car", "automobile"],
  ["sofa", "couch"],
  ["dog", "puppy"],
  ["dog", "cat"],
  ["sun", "moon"],
  ["hot", "cold"],
  ["up", "down"],
  ["king", "queen"],
  ["salt", "pepper"],
  ["beach", "sand"],
  ["ocean", "sea"],
  ["house", "home"],
  // A homograph's irregular verb form must not drag in its verb.
  ["rose", "rise"],
  ["saw", "see"],
  ["ground", "grind"],
  ["left", "leave"],
  ["bored", "bear"],
  ["lay", "lie"],
  // A word and a longer word that merely starts with it.
  ["car", "carpet"],
  ["can", "candle"],
  ["sun", "sunflower"],
  ["rain", "rainbow"],
  ["ice", "ice cream"],
  ["hot", "hot dog"],
  ["tooth", "toothbrush"],
  ["snow", "snowman"],
  // Numbers that are not each other's words.
  ["2", "too"],
  ["4", "for"],
  ["8", "ate"],
  ["1", "won"],
  ["2", "three"],
  ["21", "twenty"],
  // Different forms of different words.
  ["leaves", "leave"],
  ["lives", "live"],
  ["saws", "see"],
  ["flower", "flow"],
  ["better", "bet"],
  ["bus", "bust"],
  ["bell", "belt"],
  // Empty and noise.
  ["", "dog"],
  ["???", "dog"],
  ["dog", ""],
  ["   ", "   "],
];

describe("words that are the same word", () => {
  for (const [a, b] of MATCH) {
    it(`${JSON.stringify(a)} and ${JSON.stringify(b)}`, () => {
      expect(sameWord(a, b), `${a} / ${b} -> ${tokens(a).join("+")} / ${tokens(b).join("+")}`).toBe(true);
      // Symmetric, always: who typed which must never decide it.
      expect(sameWord(b, a)).toBe(true);
    });
  }
});

describe("words that are not", () => {
  for (const [a, b] of NO_MATCH) {
    it(`${JSON.stringify(a)} and ${JSON.stringify(b)}`, () => {
      expect(sameWord(a, b), `${a} / ${b} -> ${tokens(a).join("+")} / ${tokens(b).join("+")}`).toBe(false);
      expect(sameWord(b, a)).toBe(false);
    });
  }
});

describe("a word is always itself", () => {
  it("matches itself, however it is typed", () => {
    for (const w of ["dog", "Ice Cream", "café", "2", "running", "the beach", "T-shirt"]) {
      expect(sameWord(w, w)).toBe(true);
      expect(sameWord(w, ` ${w.toUpperCase()}. `)).toBe(true);
    }
  });
});

describe("normalize", () => {
  it("folds capitals, accents, punctuation and a leading article", () => {
    expect(normalize("  The Café-Noir! ")).toBe("cafe noir");
    expect(normalize("2 Dogs")).toBe("two dogs");
    expect(normalize("COLOUR")).toBe("color");
  });

  it("keeps a lone article, which is not an article there", () => {
    expect(normalize("the")).toBe("the");
    expect(normalize("A")).toBe("a");
  });

  it("is idempotent", () => {
    for (const w of ["The Dogs", "Café", "ice-cream", "2", "T-shirt"]) {
      expect(normalize(normalize(w))).toBe(normalize(w));
    }
  });
});

describe("so close", () => {
  it("is a letter out, a letter extra, or a swapped pair, in a word long enough to be a typo", () => {
    expect(soClose("recieve", "receive")).toBe(true);
    expect(soClose("elephnt", "elephant")).toBe(true);
    expect(soClose("teh", "the")).toBe(false); // too short
    expect(soClose("banana", "bananna")).toBe(true);
    expect(soClose("freind", "friend")).toBe(true);
  });

  it("is never a match, and a match is never so close", () => {
    expect(soClose("dog", "dogs")).toBe(false);
    expect(sameWord("recieve", "receive")).toBe(false);
  });

  it("leaves short words alone: cat and car are different words, not a typo", () => {
    expect(soClose("cat", "car")).toBe(false);
    expect(soClose("pen", "pan")).toBe(false);
  });

  it("allows two letters in a long word, and not three", () => {
    expect(soClose("chocolatte", "chocolate")).toBe(true);
    expect(soClose("chokolatte", "chocolate")).toBe(true);
    expect(soClose("restraunt", "restaurant")).toBe(false); // three edits away
    expect(soClose("umbrella", "umbrellas")).toBe(false);
  });

  it("is not for words that are merely related", () => {
    expect(soClose("happy", "glad")).toBe(false);
    expect(soClose("beach", "sand")).toBe(false);
  });
});

describe("distance", () => {
  it("counts a swap of neighbours as one", () => {
    expect(distance("ab", "ba")).toBe(1);
    expect(distance("recieve", "receive")).toBe(1);
    expect(distance("kitten", "sitting")).toBe(3);
    expect(distance("", "abc")).toBe(3);
    expect(distance("same", "same")).toBe(0);
  });
});

describe("the already-said check shares the matcher", () => {
  it("refuses a word in any form it has already been said in", () => {
    const said = ["Ice Cream", "beach", "colour"];
    expect(sameAsAny("icecreams", said)).toBe(true);
    expect(sameAsAny("the beaches", said)).toBe(true);
    expect(sameAsAny("COLOR", said)).toBe(true);
    expect(sameAsAny("sand", said)).toBe(false);
  });
});

describe("what may be locked in", () => {
  it("accepts an ordinary word and a short phrase", () => {
    expect(refusal("dog")).toBeNull();
    expect(refusal("ice cream cone")).toBeNull();
    expect(refusal("café")).toBeNull();
    expect(refusal("2")).toBeNull();
  });

  it("refuses nothing, too long, too many words, and no letters at all", () => {
    expect(refusal("")).toMatch(/type a word/i);
    expect(refusal("   ")).toMatch(/type a word/i);
    expect(refusal("x".repeat(31))).toMatch(/too long/i);
    expect(refusal("one two three four")).toMatch(/3 words/i);
    expect(refusal("???")).toMatch(/letters or numbers/i);
  });

  it("does not throw on something that is not a string", () => {
    expect(refusal(undefined as never)).toMatch(/type a word/i);
    expect(refusal(42 as never)).toMatch(/type a word/i);
  });
});

/**
 * Where the matcher is more forgiving than the rule, written down so it is a
 * decision rather than a surprise.
 *
 * The lemmatiser works from a short exception list and suffix rules, with no
 * dictionary, so it cannot know which stems double their last letter before
 * "-ed". "occured" and "occurred" are both taken for "occur" and match; a typo
 * that famous is the one the friend who cannot spell would make. A dictionary
 * (the bot's vocabulary is one) could close it, at the price of rejecting every
 * word not in it. Left open on purpose until a playtest says it matters.
 */
describe("known leniencies", () => {
  it("forgives a missing doubled letter before -ed or -ing", () => {
    expect(sameWord("occured", "occurred")).toBe(true);
    expect(sameWord("stoped", "stopped")).toBe(true);
  });

  it("leaves 'meaning' and 'mean' as one word, because the verb is 'mean'", () => {
    expect(sameWord("meaning", "mean")).toBe(true);
  });
});
