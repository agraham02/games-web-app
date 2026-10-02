/**
 * Members' photos, server side: checking what arrives, and serving it back.
 *
 * Checked by its bytes, never its label. A client says "image/jpeg" and can
 * send anything; an SVG in particular is a document that can run script if
 * it is ever opened directly. So a photo is accepted only if it starts the
 * way a JPEG or a WebP starts, and it is served with `nosniff` and a
 * sandboxing CSP besides, so even a file that fooled the check could do
 * nothing when opened.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { PHOTO_MAX_BYTES, PHOTO_PATH } from "@/session/photo";
import type { RoomRegistry } from "./RoomRegistry";

export type PhotoMime = "image/jpeg" | "image/webp";

export interface StoredPhoto {
  /** Random, and new with every photo — see `photoUrl`. */
  id: string;
  bytes: Buffer;
  mime: PhotoMime;
}

const DATA_URL = /^data:(image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * A photo from the wire, or null if it is not one we will keep: a data URL
 * of a JPEG or WebP, whose bytes really are one, no bigger than
 * `PHOTO_MAX_BYTES`.
 */
export function decodePhoto(image: unknown): { bytes: Buffer; mime: PhotoMime } | null {
  if (typeof image !== "string") return null;
  // Base64 is 4 characters per 3 bytes: anything longer than this cannot
  // decode to an allowed size, and is refused before it is decoded.
  if (image.length > Math.ceil((PHOTO_MAX_BYTES * 4) / 3) + 64) return null;
  const match = DATA_URL.exec(image);
  if (!match) return null;
  const mime = match[1] as PhotoMime;
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length === 0 || bytes.length > PHOTO_MAX_BYTES) return null;
  const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isWebp =
    bytes.length > 12 &&
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP";
  if (mime === "image/jpeg" ? !isJpeg : !isWebp) return null;
  return { bytes, mime };
}

export function newPhotoId(): string {
  return randomBytes(16).toString("base64url");
}

/** `GET /api/photo/:id`. False when the request is not for this route. */
export function handlePhotoRequest(
  req: IncomingMessage,
  res: ServerResponse,
  registry: RoomRegistry,
): boolean {
  const [path] = (req.url ?? "").split("?");
  if (!path?.startsWith(PHOTO_PATH)) return false;

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return true;
  }

  const id = path.slice(PHOTO_PATH.length);
  const photo = /^[A-Za-z0-9_-]{16,64}$/.test(id) ? registry.findPhoto(id) : null;
  if (!photo) {
    // Gone with the member, or the room, or never there: the same answer.
    res.writeHead(404, { "cache-control": "no-store" });
    res.end();
    return true;
  }

  res.writeHead(200, {
    "content-type": photo.mime,
    "content-length": String(photo.bytes.length),
    // The id changes with every new photo, so this one never will.
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
  });
  res.end(req.method === "HEAD" ? undefined : photo.bytes);
  return true;
}
