// @vitest-environment node

/**
 * Members' photos: what the server will keep, and how it serves them.
 *
 * Checked by bytes, never by label — a client can call anything a JPEG, and
 * an SVG in particular is a document that can run script if opened.
 */

import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PHOTO_MAX_BYTES, photoUrl } from "@/session/photo";
import { TestClock } from "@/session/clock";
import { decodePhoto, handlePhotoRequest } from "./photo";
import { RoomRegistry } from "./RoomRegistry";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(100, 3)]);
const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString("base64")}`;

describe("decodePhoto", () => {
  it("keeps a JPEG or a WebP that really is one", () => {
    expect(decodePhoto(dataUrl("image/jpeg", JPEG))?.mime).toBe("image/jpeg");
    expect(decodePhoto(dataUrl("image/webp", WEBP))?.bytes.equals(WEBP)).toBe(true);
  });

  it("refuses anything that only claims to be one", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(decodePhoto(dataUrl("image/jpeg", svg))).toBeNull();
    expect(decodePhoto(dataUrl("image/svg+xml", svg))).toBeNull();
    // A WebP labelled as a JPEG is not a JPEG.
    expect(decodePhoto(dataUrl("image/jpeg", WEBP))).toBeNull();
  });

  it("refuses the malformed and the oversized", () => {
    expect(decodePhoto(null)).toBeNull();
    expect(decodePhoto(42)).toBeNull();
    expect(decodePhoto("data:image/jpeg;base64,")).toBeNull();
    expect(decodePhoto("data:image/jpeg;base64,not*base64")).toBeNull();
    const huge = Buffer.concat([JPEG, Buffer.alloc(PHOTO_MAX_BYTES)]);
    expect(decodePhoto(dataUrl("image/jpeg", huge))).toBeNull();
  });
});

/** Just enough of Node's request and response for the handler. */
function request(url: string, method = "GET") {
  const req = { url, method, headers: {} } as unknown as IncomingMessage;
  const out: { status?: number; headers?: Record<string, string>; body?: Buffer } = {};
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      out.status = status;
      out.headers = headers;
    },
    end(body?: Buffer) {
      out.body = body;
    },
  } as unknown as ServerResponse;
  return { req, res, out };
}

describe("GET /api/photo/:id", () => {
  function roomWithPhoto() {
    const registry = new RoomRegistry({ clock: new TestClock(), seed: 7 });
    const runtime = registry.create("s-ada", "Ada");
    expect(runtime.setPhoto("s-ada", dataUrl("image/jpeg", JPEG))).toBe(true);
    const id = runtime.viewFor("s-ada").members[0]!.photo!;
    return { registry, runtime, id };
  }

  const fetchPhoto = (registry: RoomRegistry, id: string) => {
    const { req, res, out } = request(photoUrl(id));
    expect(handlePhotoRequest(req, res, registry)).toBe(true);
    return out;
  };

  it("serves the bytes, locked down and cacheable for ever", () => {
    const { registry, id } = roomWithPhoto();
    const out = fetchPhoto(registry, id);
    expect(out.status).toBe(200);
    expect(out.body?.equals(JPEG)).toBe(true);
    expect(out.headers).toMatchObject({
      "content-type": "image/jpeg",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=31536000, immutable",
    });
    expect(out.headers?.["content-security-policy"]).toContain("sandbox");
  });

  it("gives a new photo a new address, and forgets the old one", () => {
    const { registry, runtime, id } = roomWithPhoto();
    runtime.setPhoto("s-ada", dataUrl("image/webp", WEBP));
    const next = runtime.viewFor("s-ada").members[0]!.photo!;
    expect(next).not.toBe(id);
    expect(fetchPhoto(registry, id).status).toBe(404);
    expect(fetchPhoto(registry, next).status).toBe(200);
  });

  it("forgets a photo taken down, or whose owner has left", () => {
    const { registry, runtime, id } = roomWithPhoto();
    runtime.setPhoto("s-ada", null);
    expect(fetchPhoto(registry, id).status).toBe(404);

    runtime.setPhoto("s-ada", dataUrl("image/jpeg", JPEG));
    const again = runtime.viewFor("s-ada").members[0]!.photo!;
    runtime.command("s-ada", { t: "leave" });
    expect(fetchPhoto(registry, again).status).toBe(404);
  });

  it("keeps a photo only for somebody in the room", () => {
    const { runtime } = roomWithPhoto();
    expect(runtime.setPhoto("s-stranger", dataUrl("image/jpeg", JPEG))).toBe(false);
  });

  it("answers only its own path, and only reads", () => {
    const { registry, id } = roomWithPhoto();
    const other = request("/api/rejoin");
    expect(handlePhotoRequest(other.req, other.res, registry)).toBe(false);
    const post = request(photoUrl(id), "POST");
    handlePhotoRequest(post.req, post.res, registry);
    expect(post.out.status).toBe(405);
    // Not a shape an id can have: not even looked up.
    expect(fetchPhoto(registry, "../../etc/passwd").status).toBe(404);
  });
});
