"use client";

/**
 * What the home page hands the room screen, and what the two share.
 *
 * Making or joining a room used to take two forms: the home page asked
 * which, then `/room` asked for a name and asked "make or join?" all over
 * again — with Make the louder button, right beside the name, even for
 * somebody who had just typed a code to join. Now the home page takes the
 * name too, and says what it wants done as an INTENT; the room screen acts
 * on it the moment the server is listening, so one press is one action.
 *
 * The intent goes through `sessionStorage` rather than the URL: it is
 * consumed once (a refresh must not make a second room), and it never
 * lands in the history or in a link somebody copies.
 */

import { TOKEN_KEY } from "./connection";

export const NAME_KEY = "table-games.display-name";
const INTENT_KEY = "table-games.entry-intent";

export type EntryIntent = { t: "make" } | { t: "join"; code: string };

/** The name typed last time, or "". Storage can be locked down; then "". */
export function readSavedName(): string {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveName(name: string): void {
  try {
    window.localStorage.setItem(NAME_KEY, name.trim());
  } catch {
    /* Not remembered; the name still goes in the message being sent. */
  }
}

/**
 * This browser's identity token, if it has one — never minting it, unlike
 * `sessionToken`. A browser with none has never been in a room.
 */
export function storedSessionToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setEntryIntent(intent: EntryIntent): void {
  try {
    window.sessionStorage.setItem(INTENT_KEY, JSON.stringify(intent));
  } catch {
    /* Without storage the room screen simply shows its own form. */
  }
}

/** Reads the intent and removes it, so it is acted on once at most. */
export function takeEntryIntent(): EntryIntent | null {
  try {
    const raw = window.sessionStorage.getItem(INTENT_KEY);
    window.sessionStorage.removeItem(INTENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EntryIntent;
    if (parsed?.t === "make") return parsed;
    if (parsed?.t === "join" && typeof parsed.code === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}
