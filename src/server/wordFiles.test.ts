// @vitest-environment node

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gunzipSync, gzipSync } from "node:zlib";
import { VECTORS_FILE, VOCAB_FILE } from "@/games/mindmeld/vectorBrain";
import { serveWordFile } from "./wordFiles";

/**
 * Mind Meld's word files are cached for good and sent gzipped to a browser that
 * accepts it, from a host that sleeps when idle — so what they answer with is
 * the thing worth holding to.
 */

const RAW = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 251));
let dir: string;
let server: Server;
let port: number;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "words-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "vectors-v2.bin"), RAW);
  writeFileSync(join(dir, "vectors-v2.bin.gz"), gzipSync(RAW));
  writeFileSync(join(dir, "vocab-v2.json"), "[\"a\"]");
  // No .gz for this one: it must still be served, raw.
  writeFileSync(join(dir, "secret.txt"), "not for you");
  server = createServer((req, res) => {
    if (!serveWordFile(req, res, dir)) {
      res.writeHead(404);
      res.end("next");
    }
  });
  await new Promise<void>((done) => server.listen(0, done));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));

function get(path: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    const req = request({ port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("serving Mind Meld's word files", () => {
  it("sends the gzipped copy to a browser that accepts it, marked as such", async () => {
    const r = await get("/mindmeld/vectors-v2.bin", { "accept-encoding": "gzip, deflate, br" });
    expect(r.status).toBe(200);
    expect(r.headers["content-encoding"]).toBe("gzip");
    expect(Buffer.compare(gunzipSync(r.body), RAW)).toBe(0);
    expect(Number(r.headers["content-length"])).toBe(r.body.length);
    expect(r.body.length).toBeLessThan(RAW.length);
  });

  it("sends the raw file to one that does not", async () => {
    const r = await get("/mindmeld/vectors-v2.bin", { "accept-encoding": "identity" });
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(Buffer.compare(r.body, RAW)).toBe(0);
  });

  it("sends the raw file when there is no gzipped copy", async () => {
    const r = await get("/mindmeld/vocab-v2.json", { "accept-encoding": "gzip" });
    expect(r.status).toBe(200);
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.body.toString()).toBe('["a"]');
  });

  it("caches for good and says the answer depends on the encoding", async () => {
    const r = await get("/mindmeld/vectors-v2.bin", { "accept-encoding": "gzip" });
    expect(r.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(r.headers.vary).toMatch(/accept-encoding/i);
  });

  it("answers a HEAD without a body", async () => {
    const r = await get("/mindmeld/vectors-v2.bin", { "accept-encoding": "gzip" }, "HEAD");
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(0);
    expect(Number(r.headers["content-length"])).toBeGreaterThan(0);
  });

  it("leaves everything else to Next, and cannot be walked out of", async () => {
    for (const path of [
      "/mindmeld/secret.txt",
      "/mindmeld/../secret.txt",
      "/mindmeld/%2e%2e/secret.txt",
      "/mindmeld/vectors-v2.bin.gz",
      "/mindmeld/NOTICE.txt",
      "/other/vectors-v2.bin",
      "/mindmeld/vectors-v9.bin",
    ]) {
      const r = await get(path, { "accept-encoding": "gzip" });
      expect([path, r.body.toString()]).toEqual([path, "next"]);
    }
    expect((await get("/mindmeld/vectors-v2.bin", {}, "POST")).body.toString()).toBe("next");
  });

  it("ignores a query string", async () => {
    expect((await get("/mindmeld/vectors-v2.bin?x=1", { "accept-encoding": "gzip" })).status).toBe(200);
  });
});

describe("the shipped word files", () => {
  const dirShipped = join(process.cwd(), "public", "mindmeld");

  it.each([VECTORS_FILE, VOCAB_FILE])("%s has a gzipped copy that is exactly it", (name) => {
    const raw = readFileSync(join(dirShipped, name));
    const packed = readFileSync(join(dirShipped, `${name}.gz`));
    expect(Buffer.compare(gunzipSync(packed), raw), `${name}.gz is stale: rerun scripts/build-mindmeld-numberbatch.ts`).toBe(0);
    expect(packed.length).toBeLessThan(raw.length);
  });
});
