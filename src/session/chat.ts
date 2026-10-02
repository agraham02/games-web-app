/**
 * Chat in a room: what may be said, and when (the user, 2026-09-29).
 *
 * Shared by both ends. The server is the authority — it cleans every message
 * and refuses what breaks the rules — and the composer uses the same
 * functions to count and to grey out, so it never offers what would be
 * refused.
 *
 * ## Table talk
 *
 * In a partnership game it is the custom not to talk during a hand, and
 * above all for partners not to talk to each other: a word can say what a
 * card cannot. So while a hand of Spades (or of dominoes played in teams) is
 * being played, the people IN it may send only the table-safe quick replies
 * — social noise that can neither praise nor warn a partner. Free text comes
 * back between hands. Spectators and anybody in the lobby are not limited:
 * they see no hidden cards, so they have nothing to give away.
 */

import type { SessionId } from "./room";

/** The most a message may be, in characters as a person counts them. */
export const CHAT_MAX_CHARS = 120;

/** And in bytes, whatever those characters are made of. */
export const CHAT_MAX_BYTES = 600;

/** How many messages a room keeps, for anybody who arrives later. */
export const CHAT_HISTORY = 50;

/** At most this many messages per person per window. */
export const CHAT_RATE = { count: 5, windowMs: 10_000 } as const;

/** One message, as everybody in the room is shown it. */
export interface ChatMessage {
  /** Increasing within a room: order, and what has been seen. */
  id: number;
  session: SessionId;
  /** As they were called when they said it; they may since have left. */
  name: string;
  text: string;
  /** The quick reply this was, if it was one. */
  quick?: string;
  /** Server time, ms. */
  at: number;
}

/** Whether this person may type, or only send the table-safe quick replies. */
export type ChatMode = "open" | "quick-only";

export interface QuickReply {
  id: string;
  text: string;
  /** Sendable during a partnership hand. See the header. */
  tableSafe: boolean;
}

/**
 * The row above the keyboard. Emoji first — one tap, no reading — then
 * words. Table-safe means purely social: a laugh, a wave, good luck,
 * thanks, stepping away and back. Nothing that can react to a partner's
 * card ("Nice one!", 👍, 😬) or hurry them.
 */
export const QUICK_REPLIES: readonly QuickReply[] = [
  { id: "thumbs", text: "👍", tableSafe: false },
  { id: "clap", text: "👏", tableSafe: false },
  { id: "laugh", text: "😂", tableSafe: true },
  { id: "wow", text: "😮", tableSafe: false },
  { id: "grimace", text: "😬", tableSafe: false },
  { id: "fire", text: "🔥", tableSafe: false },
  { id: "please", text: "🙏", tableSafe: false },
  { id: "deal", text: "🤝", tableSafe: false },
  { id: "wave", text: "👋", tableSafe: true },
  { id: "luck", text: "Good luck!", tableSafe: true },
  { id: "nice", text: "Nice one!", tableSafe: false },
  { id: "played", text: "Well played", tableSafe: false },
  { id: "gg", text: "Good game", tableSafe: false },
  { id: "thanks", text: "Thanks!", tableSafe: true },
  { id: "sorry", text: "Sorry!", tableSafe: false },
  { id: "oops", text: "Oops", tableSafe: false },
  { id: "hurry", text: "Hurry up 😅", tableSafe: false },
  { id: "again", text: "One more?", tableSafe: false },
  { id: "brb", text: "brb", tableSafe: true },
  { id: "back", text: "Back!", tableSafe: true },
];

export function quickReply(id: string): QuickReply | null {
  return QUICK_REPLIES.find((q) => q.id === id) ?? null;
}

/**
 * Characters as a person counts them: 👍🏽 is one, not four. Falls back to
 * code points where `Intl.Segmenter` is missing (older Firefox), which
 * over-counts a few emoji and never under-counts.
 */
export function charCount(text: string): number {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    let n = 0;
    for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) n++;
    return n;
  }
  return [...text].length;
}

/**
 * A message as it will be shown: controls and direction overrides removed
 * (the latter can make a name appear to say something it does not),
 * stacked accents capped (so one character cannot climb over the lines
 * above it), every run of whitespace one space, and trimmed.
 */
export function cleanChatText(raw: string): string {
  return (
    raw
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "")
      .replace(/[‪-‮⁦-⁩]/g, "")
      .replace(/(\p{M}{3})\p{M}+/gu, "$1")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Why this (cleaned) text cannot be sent, or null when it can. */
export function chatTextProblem(text: string): "empty" | "too-long" | null {
  if (!text) return "empty";
  if (charCount(text) > CHAT_MAX_CHARS) return "too-long";
  if (new TextEncoder().encode(text).length > CHAT_MAX_BYTES) return "too-long";
  return null;
}
