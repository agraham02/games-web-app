/**
 * The end of a round in a room: how long the finished board is left on
 * screen, and how long the scorecard then waits for somebody to continue.
 *
 * Shared by both ends so the server can count from where a player's screen
 * actually is. The browser shows the scorecard `ROUND_END_HOLD_MS` after the
 * round's last move has played; the server adds that to the frame's own
 * playback before it starts the `AUTO_CONTINUE_MS` it gives the leader.
 */

/** The finished board, left on screen before the scorecard covers it. */
export const ROUND_END_HOLD_MS = 1_000;

/**
 * How long the scorecard waits for Continue before the next round deals
 * itself — the user's call (2026-09-29): a constant 20s, with or without
 * the turn timer, so a leader who has walked off cannot hold the table.
 */
export const AUTO_CONTINUE_MS = 20_000;

/**
 * How much later than the ring on screen the server deals anyway. The
 * leader's own screen sends Continue when its ring empties, so the round
 * normally starts on time; this is the backstop for a leader whose tab is
 * hidden or gone, and it waits long enough never to beat a screen that is
 * running on time.
 */
export const AUTO_CONTINUE_GRACE_MS = 900;
