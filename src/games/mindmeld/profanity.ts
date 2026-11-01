/**
 * The family-safe filter: a word that is refused before it is locked in.
 *
 * Refused at the door rather than masked after the reveal. A rude word shown to
 * a table cannot be unshown, and the player who typed it loses nothing by being
 * told to pick another before anybody has seen it. `obscenity` reads through the
 * usual disguises (leetspeak, repeated and separated letters), which a plain word
 * list does not.
 *
 * A separate module so the matcher stays small and pure, and so a table that
 * turns the filter off pays for nothing.
 */

import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from "obscenity";

let matcher: RegExpMatcher | null = null;

/** Built on first use: the dataset is big and a table with the filter off never needs it. */
function engine(): RegExpMatcher {
  matcher ??= new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });
  return matcher;
}

/** Would this entry embarrass a family table? */
export function isProfane(raw: string): boolean {
  return typeof raw === "string" && raw.length > 0 && engine().hasMatch(raw);
}
