/**
 * Loads Mind Meld's real brain from disk, for the server.
 *
 * A separate module, imported only by `server.ts`, because it reads files:
 * `node:fs` must never reach the browser bundle, and the engine imports
 * `brain.ts`, which does not know a file system exists. A table that starts
 * before this has run, or on a machine where the files are missing, plays with
 * the small built-in brain instead - a worse partner, never a broken game.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { installBrain } from "./brain";
import { vectorBrainFrom } from "./vectorBrain";

/** Where the build script put them, relative to the project root. */
const DIR = join(process.cwd(), "public", "mindmeld");

export async function loadServerBrain(): Promise<boolean> {
  try {
    const [vocab, vectors] = await Promise.all([
      readFile(join(DIR, "vocab-v1.json"), "utf8"),
      readFile(join(DIR, "vectors-v1.bin")),
    ]);
    installBrain(vectorBrainFrom(vocab, vectors));
    return true;
  } catch {
    installBrain(null);
    return false;
  }
}
