/**
 * Whether the lab exists on this build.
 *
 * The lab is for building the game, not for playing it: fixtures, motion
 * tuning, a redaction inspector that shows every hand. So it is on the dev
 * server only (the user, 2026-09-28). In production every /lab route is a
 * 404 and nothing links to it, the same way `/debug/*` is refused there (see
 * `server/debug.ts`). `NODE_ENV` is inlined at build time, so a production
 * bundle carries the answer rather than asking at runtime.
 */
export function labEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}
