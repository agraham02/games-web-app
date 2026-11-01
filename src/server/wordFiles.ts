/**
 * Serves Mind Meld's word files, small and cacheable.
 *
 * Answered here, before Next, for two reasons that both come from the host
 * being Render's free tier (it sleeps when idle, so every byte and every round
 * trip after a wake-up is felt):
 *
 *  - The vectors are `application/octet-stream`, which Next does not compress,
 *    so a first-time solo player fetched 2.2 MB. The build script writes a
 *    gzipped copy beside each file (`vectors-v2.bin.gz`); a browser that accepts
 *    gzip gets that, as `Content-Encoding: gzip`, and decompresses it on its
 *    own — no client code, every browser. One that does not gets the raw file.
 *  - The names carry a version, so they never change: `immutable` for a year
 *    means a returning player never asks again, instead of revalidating against
 *    a server that may have to wake up to say "304". Change the data, change the
 *    name (`VECTORS_FILE` in `games/mindmeld/vectorBrain.ts`).
 *
 * Only exact `vectors|vocab-v<N>.bin|json` names are answered, so nothing else
 * under `public/` is reachable through here and a path cannot walk out of it.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream";

const NAME = /^\/mindmeld\/((?:vectors|vocab)-v\d+\.(?:bin|json))$/;
const TYPE: Record<string, string> = { bin: "application/octet-stream", json: "application/json; charset=utf-8" };

/** Answers the request and returns true if it was for a word file; false to leave it to Next. */
export function serveWordFile(req: IncomingMessage, res: ServerResponse, dir: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const name = NAME.exec((req.url ?? "").split("?")[0]!)?.[1];
  if (!name) return false;

  const raw = join(dir, name);
  const packed = `${raw}.gz`;
  if (!existsSync(raw)) return false;

  const gzip = /\bgzip\b/i.test(String(req.headers["accept-encoding"] ?? "")) && existsSync(packed);
  const file = gzip ? packed : raw;
  res.writeHead(200, {
    "content-type": TYPE[name.split(".").pop()!]!,
    "content-length": statSync(file).size,
    "cache-control": "public, max-age=31536000, immutable",
    // The same URL answers two ways; a cache in between must keep them apart.
    vary: "Accept-Encoding",
    ...(gzip ? { "content-encoding": "gzip" } : {}),
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  pipeline(createReadStream(file), res, () => {
    /* A client that hung up mid-download is not an error worth a log line. */
  });
  return true;
}
