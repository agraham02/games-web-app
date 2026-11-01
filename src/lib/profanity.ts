/**
 * The profanity filter, shared by everything that has to keep a table family-safe:
 * Mind Meld's words and the room's chat. The leader switches it on or off for the
 * whole room (`Room.profanityFilter`); this module only answers the question.
 *
 * Mind Meld refuses a rude word at the door rather than masking it after the
 * reveal: a rude word shown to a table cannot be unshown, and the player who
 * typed it loses nothing by being told to pick another before anybody has seen
 * it. Chat has no such moment, so it masks. `obscenity` reads through the usual
 * disguises (leetspeak, repeated letters), which a plain word list does not, and
 * leaves "Scunthorpe" and "class" alone.
 *
 * A separate module so the matcher stays small and pure, and so a table that
 * turns the filter off pays for nothing.
 */

import { RegExpMatcher, TextCensor, asteriskCensorStrategy, englishDataset, englishRecommendedTransformers } from "obscenity";

let matcher: RegExpMatcher | null = null;

/** Built on first use: the dataset is big and a table with the filter off never needs it. */
function engine(): RegExpMatcher {
  matcher ??= new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });
  return matcher;
}

const censor = new TextCensor().setStrategy(asteriskCensorStrategy());

/** Would this entry embarrass a family table? */
export function isProfane(raw: string): boolean {
  return typeof raw === "string" && raw.length > 0 && engine().hasMatch(raw);
}

/**
 * The same text with each rude word starred out, everything else untouched
 * (`"sh1t happens"` reads `"**** happens"`). Returns the very string it was given when there is
 * nothing to mask, so a caller can compare by identity.
 */
export function maskProfanity(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) return raw;
  const matches = engine().getAllMatches(raw);
  return matches.length === 0 ? raw : censor.applyTo(raw, matches);
}
