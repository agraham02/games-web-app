"use client";

/**
 * Turning a picked picture into a member's photo, in the browser.
 *
 * The picker is a plain `<input type="file" accept="image/*">` on every
 * device (the user, 2026-09-29): a phone's own picker already offers the
 * camera, and a laptop gets its files. What it hands back can be a
 * 12-megapixel photo, so it is cropped to the middle square and drawn into
 * `PHOTO_PX` here, and only that small JPEG ever leaves the device.
 *
 * Kept for the session (`sessionStorage`), and offered again to the next
 * room joined in it — never beyond, and never on the server past the room.
 */

import { PHOTO_PX, PHOTO_TARGET_BYTES } from "@/session/photo";

const STORE_KEY = "table-games.photo";

/** The largest centred square in a `w`×`h` picture: `[x, y, side]`. */
export function squareCrop(w: number, h: number): [number, number, number] {
  const side = Math.min(w, h);
  return [Math.round((w - side) / 2), Math.round((h - side) / 2), side];
}

/** Bytes a base64 data URL decodes to, near enough. */
function dataUrlBytes(url: string): number {
  const comma = url.indexOf(",");
  return Math.floor(((url.length - comma - 1) * 3) / 4);
}

/**
 * A square JPEG data URL for this picture, at most `PHOTO_TARGET_BYTES`.
 *
 * Throws when the browser cannot read the file at all — most often an HEIC
 * from an iPhone's library, which desktop Chrome cannot decode.
 */
export async function photoFromFile(file: Blob): Promise<string> {
  // `from-image` honours the EXIF rotation, so a portrait taken on a phone
  // is not drawn lying on its side.
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = PHOTO_PX;
    canvas.height = PHOTO_PX;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d canvas");
    const [x, y, side] = squareCrop(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, x, y, side, side, 0, 0, PHOTO_PX, PHOTO_PX);
    for (const quality of [0.82, 0.7, 0.58, 0.46]) {
      const url = canvas.toDataURL("image/jpeg", quality);
      if (dataUrlBytes(url) <= PHOTO_TARGET_BYTES) return url;
    }
    return canvas.toDataURL("image/jpeg", 0.35);
  } finally {
    bitmap.close();
  }
}

export function readSavedPhoto(): string | null {
  try {
    return window.sessionStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}

export function savePhoto(url: string | null): void {
  try {
    if (url) window.sessionStorage.setItem(STORE_KEY, url);
    else window.sessionStorage.removeItem(STORE_KEY);
  } catch {
    // A locked-down browser: the photo simply is not carried to the next room.
  }
}
