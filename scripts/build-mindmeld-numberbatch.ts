/**
 * Builds Mind Meld's word vectors from ConceptNet Numberbatch:
 *
 *   npx tsx scripts/build-mindmeld-numberbatch.ts <numberbatch-en.txt.gz> <words.json> [dims] [outDir]
 *
 * Run by hand, with the output committed (`public/mindmeld/`). The input is the
 * 325 MB `numberbatch-en-19.08.txt.gz` from
 * https://conceptnet.s3.amazonaws.com/downloads/2019/numberbatch/ — kept in the
 * git-ignored `.cache/mindmeld/`, never committed.
 *
 * Why Numberbatch and not GloVe (which `build-mindmeld-words.ts` used): GloVe
 * learns which words appear near each other in news, so for "beach" and "sun"
 * it offered "palm" and "phoenix". Numberbatch is built from ConceptNet — what
 * people say things are related to — retrofitted onto text vectors, and it
 * beats word2vec and GloVe on word-relatedness benchmarks. And its licence
 * (CC BY-SA 4.0) allows commercial use, which the human free-association norms
 * (Small World of Words: NC-ND; Edinburgh: NC-SA) do not (the user, 2026-10-30).
 *
 * LICENCE OF THE OUTPUT: the vector file this writes is a transformed version
 * of Numberbatch, so it is CC BY-SA 4.0 too, and the app credits it
 * (`ui/primitives/Credit.tsx`): "This data contains semantic vectors from
 * ConceptNet Numberbatch, by Luminoso Technologies, Inc." The app's own code
 * is not affected by share-alike.
 *
 * `words.json` is the vocabulary, MOST COMMON FIRST — the bot reads a word's
 * position as how common it is. The current one came from GloVe's frequency
 * order with the filters in `build-mindmeld-words.ts` (dictionary words, no
 * stop words, nothing rude); pass the shipped `vocab-v2.json` to rebuild. A
 * word Numberbatch does not know is dropped.
 *
 * `dims` (default 300, Numberbatch's own): fewer is a smaller download. The
 * vectors are reduced by PCA — the directions the kept words vary along most —
 * not truncated, because Numberbatch's dimensions are not ordered by importance.
 *
 * Output: `vectors-v2.bin` (words x dims signed bytes, each vector unit length
 * after the mean is taken out) and `vocab-v2.json`, in the same order.
 */

import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

const [SOURCE, WORDS, DIMS_ARG, OUT_ARG] = process.argv.slice(2);
if (!SOURCE || !WORDS) {
  throw new Error("usage: build-mindmeld-numberbatch.ts <numberbatch-en.txt.gz> <words.json> [dims] [outDir]");
}
const OUT = OUT_ARG ?? new URL("../public/mindmeld/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SOURCE_DIM = 300;
const DIMS = Number(DIMS_ARG ?? SOURCE_DIM);
if (!Number.isInteger(DIMS) || DIMS < 16 || DIMS > SOURCE_DIM) throw new Error(`dims must be 16..${SOURCE_DIM}`);

async function main() {
  const order = JSON.parse(readFileSync(WORDS, "utf8")) as string[];
  const wanted = new Set(order);
  const found = new Map<string, Float64Array>();

  const lines = createInterface({ input: createReadStream(SOURCE).pipe(createGunzip()), crlfDelay: Infinity });
  let header = true;
  for await (const line of lines) {
    if (header) {
      header = false;
      continue;
    }
    const space = line.indexOf(" ");
    // The English-only file has bare words; the multilingual one has /c/en/ URIs.
    const word = line.slice(0, space).replace(/^\/c\/en\//, "");
    if (!wanted.has(word) || found.has(word)) continue;
    const parts = line.slice(space + 1).split(" ").map(Number);
    if (parts.length !== SOURCE_DIM || parts.some((x) => !Number.isFinite(x))) continue;
    found.set(word, Float64Array.from(parts));
  }

  const words = order.filter((w) => found.has(w));
  const rows = words.map((w) => found.get(w)!);

  // Centre on the mean of the kept words.
  const mean = new Float64Array(SOURCE_DIM);
  for (const r of rows) for (let i = 0; i < SOURCE_DIM; i++) mean[i]! += r[i]! / rows.length;
  for (const r of rows) for (let i = 0; i < SOURCE_DIM; i++) r[i]! -= mean[i]!;

  const reduced = DIMS === SOURCE_DIM ? rows : project(rows, principalAxes(rows, DIMS));

  const bytes = new Int8Array(words.length * DIMS);
  reduced.forEach((v, n) => {
    let length = 0;
    for (let i = 0; i < DIMS; i++) length += v[i]! * v[i]!;
    length = Math.sqrt(length) || 1;
    for (let i = 0; i < DIMS; i++) bytes[n * DIMS + i] = Math.round((v[i]! / length) * 127);
  });

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "vectors-v2.bin"), bytes);
  writeFileSync(join(OUT, "vocab-v2.json"), JSON.stringify(words));
  const missing = order.filter((w) => !found.has(w));
  console.log(`kept ${words.length} of ${order.length} words at ${DIMS} dims -> ${(bytes.length / 1024).toFixed(0)} KB`);
  console.log(`not in Numberbatch (${missing.length}): ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ", ..." : ""}`);
}

/**
 * The `k` directions the rows vary along most: the top eigenvectors of their
 * covariance, by Jacobi rotation (exact, and quick at 300 x 300).
 */
function principalAxes(rows: Float64Array[], k: number): Float64Array[] {
  const n = SOURCE_DIM;
  const a = Array.from({ length: n }, () => new Float64Array(n));
  for (const r of rows) {
    for (let i = 0; i < n; i++) {
      const ri = r[i]!;
      const ai = a[i]!;
      for (let j = i; j < n; j++) ai[j]! += ri * r[j]!;
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) a[i]![j] = a[j]![i]!;

  const v = Array.from({ length: n }, (_, i) => {
    const row = new Float64Array(n);
    row[i] = 1;
    return row;
  });
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p]![q]! ** 2;
    if (off < 1e-18) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p]![q]!;
        if (Math.abs(apq) < 1e-15) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let i = 0; i < n; i++) {
          const aip = a[i]![p]!;
          const aiq = a[i]![q]!;
          a[i]![p] = c * aip - s * aiq;
          a[i]![q] = s * aip + c * aiq;
        }
        for (let i = 0; i < n; i++) {
          const api = a[p]![i]!;
          const aqi = a[q]![i]!;
          a[p]![i] = c * api - s * aqi;
          a[q]![i] = s * api + c * aqi;
        }
        for (let i = 0; i < n; i++) {
          const vip = v[i]![p]!;
          const viq = v[i]![q]!;
          v[i]![p] = c * vip - s * viq;
          v[i]![q] = s * vip + c * viq;
        }
      }
    }
  }
  // Column j of `v` is the eigenvector for eigenvalue a[j][j]; largest first.
  const order = Array.from({ length: n }, (_, j) => j).sort((x, y) => a[y]![y]! - a[x]![x]!);
  const total = order.reduce((t, j) => t + a[j]![j]!, 0);
  const kept = order.slice(0, k).reduce((t, j) => t + a[j]![j]!, 0);
  console.log(`PCA: ${k} of ${n} directions keep ${((100 * kept) / total).toFixed(1)}% of the variance`);
  return order.slice(0, k).map((j) => Float64Array.from({ length: n }, (_, i) => v[i]![j]!));
}

function project(rows: Float64Array[], axes: Float64Array[]): Float64Array[] {
  return rows.map((r) =>
    Float64Array.from(axes, (axis) => {
      let dot = 0;
      for (let i = 0; i < r.length; i++) dot += r[i]! * axis[i]!;
      return dot;
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
