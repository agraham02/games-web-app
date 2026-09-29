/**
 * The app's icon, in every size and shape the platforms ask for.
 *
 *   npx tsx scripts/app-icons.ts
 *
 * One drawing (a domino over the ace of spades, on felt inside a brass rim —
 * the home page's own pieces) rendered by `sharp` into:
 *
 * - `public/icons/icon-192.png`, `icon-512.png` — the manifest's `any`
 *   icons: a rounded square, for launchers that show an icon as it is.
 * - `public/icons/icon-maskable-512.png` — full bleed, pieces inside the
 *   centre 80% circle, for Android to cut into its own shape.
 * - `src/app/apple-icon.png` — 180px, full bleed and opaque: iOS rounds the
 *   corners itself, and paints transparent ones black.
 * - `src/app/favicon.ico` — 16, 32 and 48px, replacing Next's default.
 *
 * Rerun after changing the drawing, and commit what it writes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import sharp from "sharp";

const ROOT = join(__dirname, "..");

const FELT_HI = "#245c45";
const FELT_MID = "#143528";
const FELT_LO = "#071310";
const BRASS = "#d4af6a";
const PIP = "#101512";

/** A spade in a 100×100 box, point up, stem down. */
const SPADE =
  "M50 4 C44 16 8 42 8 64 C8 80 20 89 33 89 C41 89 46 85 49 80 C48 89 44 95 36 98 L64 98 C56 95 52 89 51 80 C54 85 59 89 67 89 C80 89 92 80 92 64 C92 42 56 16 50 4 Z";

interface Shape {
  /** Corner radius of the felt, as a share of the side. 0 is full bleed. */
  round: number;
  /** How big the pieces are drawn: 1 fills the icon, smaller insets them. */
  scale: number;
  /** Draw the brass rim. Too fine to read at favicon sizes. */
  rim: boolean;
}

function drawing({ round, scale, rim }: Shape): string {
  const r = 512 * round;
  const pip = (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="15" fill="${PIP}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="felt" cx="50%" cy="38%" r="78%">
      <stop offset="0" stop-color="${FELT_HI}"/>
      <stop offset="0.55" stop-color="${FELT_MID}"/>
      <stop offset="1" stop-color="${FELT_LO}"/>
    </radialGradient>
    <linearGradient id="bone" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fbf8f1"/>
      <stop offset="1" stop-color="#e2dccd"/>
    </linearGradient>
    <filter id="lift" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.5"/>
    </filter>
  </defs>
  <rect width="512" height="512" rx="${r}" fill="url(#felt)"/>
  ${rim ? `<rect x="26" y="26" width="460" height="460" rx="${Math.max(0, r - 22)}" fill="none" stroke="${BRASS}" stroke-opacity="0.6" stroke-width="5"/>` : ""}
  <g transform="translate(256 262) scale(${scale})">
    <g transform="translate(62 -14) rotate(13)" filter="url(#lift)">
      <rect x="-104" y="-146" width="208" height="292" rx="20" fill="url(#bone)"/>
      <path d="${SPADE}" transform="translate(-62 -64) scale(1.24)" fill="${PIP}"/>
    </g>
    <g transform="translate(-70 12) rotate(-11)" filter="url(#lift)">
      <rect x="-78" y="-154" width="156" height="308" rx="20" fill="url(#bone)"/>
      <line x1="-50" y1="0" x2="50" y2="0" stroke="#a69d89" stroke-width="6" stroke-linecap="round"/>
      ${pip(-38, -116)}${pip(38, -116)}${pip(0, -77)}${pip(-38, -38)}${pip(38, -38)}
      ${pip(38, 38)}${pip(-38, 116)}
    </g>
  </g>
</svg>`;
}

const ANY: Shape = { round: 0.22, scale: 0.98, rim: true };
// The maskable safe zone is a circle of 40% radius; the pieces stay in it.
const MASKABLE: Shape = { round: 0, scale: 0.8, rim: false };
const APPLE: Shape = { round: 0, scale: 0.94, rim: true };
const FAVICON: Shape = { round: 0.2, scale: 1.08, rim: false };

async function png(shape: Shape, size: number): Promise<Buffer> {
  return sharp(Buffer.from(drawing(shape))).resize(size, size).png().toBuffer();
}

function write(path: string, data: Buffer): void {
  const full = join(ROOT, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, data);
  console.log(`${path}  ${data.length} bytes`);
}

/** An .ico holding PNGs, which every current browser reads. */
function ico(images: Array<{ size: number; data: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

async function main(): Promise<void> {
  write("public/icons/icon-192.png", await png(ANY, 192));
  write("public/icons/icon-512.png", await png(ANY, 512));
  write("public/icons/icon-maskable-512.png", await png(MASKABLE, 512));
  write("src/app/apple-icon.png", await png(APPLE, 180));
  const favicon = await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(FAVICON, size) })));
  write("src/app/favicon.ico", ico(favicon));
}

void main();
