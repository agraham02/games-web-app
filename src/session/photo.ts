/**
 * A member's photo — optional, for as long as they are in the room (the
 * user, 2026-09-29: no accounts, nothing kept between sessions).
 *
 * The browser crops and shrinks the picture itself, so what crosses the wire
 * is a small square JPEG, never whatever the camera took. The server keeps
 * it in memory against the member, under a random id, and serves it back
 * from `photoUrl` — the room's roster, which goes to everybody on every
 * change, carries only the id.
 */

/** The square the browser draws a photo into, in px. Retina-sharp at 64px. */
export const PHOTO_PX = 128;

/** What the browser aims for; it lowers the quality until it fits. */
export const PHOTO_TARGET_BYTES = 16 * 1024;

/** What the server will take, decoded. Room over the target, for slack. */
export const PHOTO_MAX_BYTES = 32 * 1024;

export const PHOTO_PATH = "/api/photo/";

/**
 * Where a member's photo is served. The id is random and changes with every
 * new photo, so it is the version (it can be cached for ever) and the only
 * way to reach it: an `<img>` cannot send the token a header would need.
 */
export function photoUrl(id: string): string {
  return `${PHOTO_PATH}${id}`;
}
